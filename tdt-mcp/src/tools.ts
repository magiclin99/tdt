import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ElementHandle, Page } from 'playwright-core';
import { z } from 'zod';
import { assertAllowed, cdp, closeTab, createTab, getTab, listTabIds, raceDialog, takeDialog } from './browser.js';
import { tdtCall } from './page-scripts.js';

export type Content = CallToolResult['content'][number];

export interface Tool {
  description: string;
  schema: z.ZodObject<any>;
  // Returns the content and, when it acted on one tab, that tab's id for the context footer.
  run(args: any): Promise<{ content: Content[]; tabId?: number }>;
}

const OUTPUT_DIR = process.env.TDT_OUTPUT_DIR ?? path.join(process.cwd(), 'tdt-output');
const UPLOAD_ROOTS = (process.env.TDT_UPLOAD_ROOTS ?? process.cwd()).split(',').map(s => s.trim()).filter(Boolean);
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const text = (t: string): Content => ({ type: 'text', text: t });
const tabIdArg = z.number().int().describe('TDT tab ID (from tabs_context_mcp / tabs_create_mcp).');
const point = z.array(z.number()).min(2).max(2);

// page.evaluate errors come back as "page.evaluate: Error: <message>\n    at ..."; keep just the message.
function pageError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.replace(/^[\w.]+: (Error: )?/, '').split('\n    at ')[0]);
}

async function inPage<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  try {
    return await page.evaluate(tdtCall(method, ...args)) as T;
  } catch (e) {
    throw pageError(e);
  }
}

// ---- screenshots ----

function jpegSize(b64: string): { w: number; h: number } | null {
  const buf = Buffer.from(b64, 'base64');
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

async function capture(page: Page, opts: { region?: number[]; scale?: number; saveToDisk?: boolean }): Promise<Content[]> {
  const session = await cdp(page);
  // From the page rather than Page.getLayoutMetrics, which misreports under device emulation.
  const vv = await page.evaluate(`(() => {
    const v = window.visualViewport;
    return { pageX: v.pageLeft, pageY: v.pageTop, clientWidth: v.width, clientHeight: v.height, dpr: window.devicePixelRatio };
  })()`) as { pageX: number; pageY: number; clientWidth: number; clientHeight: number; dpr: number };
  const dpr = vv.dpr;
  const scale = Math.min(1, Math.max(0.1, opts.scale ?? 1));
  const vw = Math.round(vv.clientWidth);
  const vh = Math.round(vv.clientHeight);

  let clip: { x: number; y: number; width: number; height: number; scale: number };
  let summary: string;
  if (opts.region) {
    const [x0, y0, x1, y1] = opts.region;
    const width = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) throw new Error('region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0.');
    // Magnify small regions so detail is readable, capped at 4x.
    const mag = Math.min(4, Math.max(1, 1200 / width)) * scale;
    clip = { x: vv.pageX + x0, y: vv.pageY + y0, width, height, scale: mag / dpr };
    summary = `Zoomed region (${x0},${y0})-(${x1},${y1}) at ${mag.toFixed(2)}x → ${Math.round(width * mag)}x${Math.round(height * mag)} image. Coordinates for actions stay in the ${vw}x${vh} viewport frame.`;
  } else {
    clip = { x: vv.pageX, y: vv.pageY, width: vw, height: vh, scale: scale / dpr };
    summary = scale === 1
      ? `Screenshot ${vw}x${vh} (jpeg). Image pixels = viewport CSS pixels, so use them directly as coordinates.`
      : `Screenshot at ${scale}x → ${Math.round(vw * scale)}x${Math.round(vh * scale)} image. Coordinate frame: ${vw}x${vh} — divide image pixels by ${scale}.`;
  }
  const wantWidth = Math.round(clip.width * clip.scale * dpr);
  let shot = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip, captureBeyondViewport: false });
  // The output size is clip.width * clip.scale * <device scale>, and the device scale the
  // compositor uses can differ from devicePixelRatio (e.g. emulation set by another CDP client).
  // Measure and recapture once so image pixels keep matching the coordinate frame.
  const got = jpegSize(shot.data);
  if (got && Math.abs(got.w - wantWidth) > 2) {
    clip = { ...clip, scale: clip.scale * (wantWidth / got.w) };
    shot = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip, captureBeyondViewport: false });
  }
  const content: Content[] = [text(summary), { type: 'image', data: shot.data, mimeType: 'image/jpeg' }];
  if (opts.saveToDisk) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const file = path.join(OUTPUT_DIR, `${opts.region ? 'zoom' : 'screenshot'}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    content.push(text(`Saved to ${file}`));
  }
  return content;
}

// ---- keyboard ----

const MODIFIER: Record<string, string> = {
  cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', windows: 'Meta', super: 'Meta',
  ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift',
};
const KEY: Record<string, string> = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: ' ',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
};

function toPlaywrightKey(combo: string): string {
  return combo.split('+').map((part, i, all) => {
    const lower = part.toLowerCase();
    if (i < all.length - 1 && MODIFIER[lower]) return MODIFIER[lower];
    if (MODIFIER[lower]) return MODIFIER[lower];
    if (KEY[lower]) return KEY[lower];
    if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
    return part;
  }).join('+');
}

function parseModifiers(mods?: string): string[] {
  if (!mods) return [];
  return mods.split('+').map(m => {
    const key = MODIFIER[m.trim().toLowerCase()];
    if (!key) throw new Error(`Unknown modifier "${m}". Use ctrl, shift, alt, cmd/meta, win.`);
    return key;
  });
}

// ---- computer ----

const computerSchema = z.object({
  action: z.enum([
    'left_click', 'right_click', 'double_click', 'triple_click', 'type', 'key', 'screenshot', 'zoom',
    'scroll', 'scroll_to', 'hover', 'left_click_drag', 'wait',
  ]).describe([
    'left_click / right_click / double_click / triple_click: click at `coordinate` or on `ref` (optional `modifiers`).',
    'type: type `text` into the focused element.',
    'key: press space-separated keys/combos in `text`, e.g. "Enter", "cmd+a", "ArrowLeft ArrowLeft"; `repeat` repeats the sequence.',
    'screenshot: capture the viewport (`scale` shrinks the image, `save_to_disk` keeps a file).',
    'zoom: magnified capture of `region` [x0,y0,x1,y1] for reading small text/icons.',
    'scroll: wheel at `coordinate` in `scroll_direction` by `scroll_amount` ticks (100px each); returns a screenshot.',
    'scroll_to: scroll `ref` into view.',
    'hover: move the mouse to `coordinate` or `ref` without clicking.',
    'left_click_drag: drag from `start_coordinate` to `coordinate`.',
    'wait: sleep `duration` seconds (max 10).',
  ].join('\n')),
  tabId: tabIdArg,
  coordinate: point.optional().describe('[x, y] in viewport CSS pixels (same as screenshot pixels at scale 1). End point for left_click_drag.'),
  start_coordinate: point.optional().describe('[x, y] start point for left_click_drag.'),
  ref: z.string().optional().describe('Element ref from read_page (e.g. "ref_3"). Alternative to coordinate for clicks/hover; required for scroll_to.'),
  text: z.string().optional().describe('Text for `type`, or keys for `key`.'),
  modifiers: z.string().optional().describe('Modifier keys held during a click, e.g. "shift", "cmd+alt". Note: on macOS ctrl+click opens the context menu.'),
  repeat: z.number().int().min(1).max(100).optional().describe('Times to repeat the `key` sequence (default 1).'),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  scroll_amount: z.number().int().min(1).max(20).optional().describe('Wheel ticks, 100px each (default 3).'),
  duration: z.number().min(0).max(10).optional().describe('Seconds for `wait`.'),
  region: z.array(z.number()).min(4).max(4).optional().describe('[x0, y0, x1, y1] viewport rectangle for `zoom`.'),
  scale: z.number().min(0.1).max(1).optional().describe('screenshot/zoom: shrink the returned image (fewer tokens). Coordinates stay in the full viewport frame.'),
  save_to_disk: z.boolean().optional().describe('screenshot/zoom: also save the image under TDT_OUTPUT_DIR and return its path.'),
});

async function targetPoint(page: Page, args: z.infer<typeof computerSchema>): Promise<{ x: number; y: number; note: string }> {
  if (args.ref) {
    const p = await inPage<{ x: number; y: number; covered: string | null }>(page, 'pointOf', args.ref);
    return { x: p.x, y: p.y, note: p.covered ? ` ⚠️ point is covered by ${p.covered}; the click may hit that element instead.` : '' };
  }
  if (args.coordinate) return { x: args.coordinate[0], y: args.coordinate[1], note: '' };
  throw new Error(`${args.action} needs \`coordinate\` or \`ref\`.`);
}

async function withModifiers<T>(page: Page, mods: string[], fn: () => Promise<T>): Promise<T> {
  for (const m of mods) await page.keyboard.down(m);
  try {
    return await fn();
  } finally {
    for (const m of [...mods].reverse()) await page.keyboard.up(m);
  }
}

async function runComputer(args: z.infer<typeof computerSchema>): Promise<Content[]> {
  const page = getTab(args.tabId);
  const where = (p: { x: number; y: number }) => (args.ref ? `${args.ref} at (${p.x}, ${p.y})` : `(${p.x}, ${p.y})`);

  switch (args.action) {
    case 'screenshot':
      return capture(page, { scale: args.scale, saveToDisk: args.save_to_disk });

    case 'zoom':
      if (!args.region) throw new Error('zoom needs `region` [x0, y0, x1, y1].');
      return capture(page, { region: args.region, scale: args.scale, saveToDisk: args.save_to_disk });

    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click': {
      const p = await targetPoint(page, args);
      const mods = parseModifiers(args.modifiers);
      const button = args.action === 'right_click' ? 'right' : 'left';
      const clickCount = args.action === 'double_click' ? 2 : args.action === 'triple_click' ? 3 : 1;
      await withModifiers(page, mods, async () => {
        await page.mouse.move(p.x, p.y);
        for (let i = 1; i <= clickCount; i++) {
          await page.mouse.down({ button, clickCount: i });
          await page.mouse.up({ button, clickCount: i });
        }
      });
      const label = { left_click: 'Clicked', right_click: 'Right-clicked', double_click: 'Double-clicked', triple_click: 'Triple-clicked' }[args.action];
      return [text(`${label} ${where(p)}${mods.length ? ` with ${mods.join('+')}` : ''}${p.note}`)];
    }

    case 'hover': {
      const p = await targetPoint(page, args);
      await page.mouse.move(p.x, p.y, { steps: 3 });
      return [text(`Hovered ${where(p)}${p.note}`)];
    }

    case 'left_click_drag': {
      if (!args.start_coordinate || !args.coordinate) throw new Error('left_click_drag needs `start_coordinate` and `coordinate`.');
      const [sx, sy] = args.start_coordinate;
      const [ex, ey] = args.coordinate;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(ex, ey, { steps: 12 });
      await page.mouse.up();
      return [text(`Dragged from (${sx}, ${sy}) to (${ex}, ${ey})`)];
    }

    case 'type':
      if (args.text === undefined) throw new Error('type needs `text`.');
      await page.keyboard.type(args.text);
      return [text(`Typed ${JSON.stringify(args.text)}`)];

    case 'key': {
      if (!args.text) throw new Error('key needs `text`, e.g. "Enter" or "cmd+a".');
      const keys = args.text.trim().split(/\s+/).map(toPlaywrightKey);
      const repeat = args.repeat ?? 1;
      for (let r = 0; r < repeat; r++) for (const k of keys) await page.keyboard.press(k);
      return [text(`Pressed ${keys.length} key(s): ${args.text}${repeat > 1 ? ` (repeated ${repeat} times)` : ''}`)];
    }

    case 'scroll': {
      if (!args.coordinate) throw new Error('scroll needs `coordinate`.');
      if (!args.scroll_direction) throw new Error('scroll needs `scroll_direction`.');
      const px = (args.scroll_amount ?? 3) * 100;
      const [dx, dy] = { up: [0, -px], down: [0, px], left: [-px, 0], right: [px, 0] }[args.scroll_direction];
      await page.mouse.move(args.coordinate[0], args.coordinate[1]);
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(300);
      const pos = await page.evaluate('[Math.round(scrollX), Math.round(scrollY)]') as number[];
      return [
        text(`Scrolled ${args.scroll_direction} ${px}px at (${args.coordinate[0]}, ${args.coordinate[1]}); window scroll is now ${pos[0]},${pos[1]}`),
        ...(await capture(page, {})).slice(1),
      ];
    }

    case 'scroll_to':
      if (!args.ref) throw new Error('scroll_to needs `ref`.');
      return [text(await inPage<string>(page, 'scrollTo', args.ref))];

    case 'wait': {
      const s = args.duration ?? 1;
      await page.waitForTimeout(s * 1000);
      return [text(`Waited ${s} second(s)`)];
    }
  }
}

// ---- tool table ----

function normalizeUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  // Local dev hosts default to http, everything else to https.
  return /^(localhost|127\.0\.0\.1|\[::1\]|[^/]+\.(localhost|test))(:\d+)?(\/|$)/i.test(url) ? `http://${url}` : `https://${url}`;
}

// page.goBack()/goForward() wait for load events that never fire when Chrome
// restores the page from the back/forward cache, so step through history via CDP.
async function historyStep(page: Page, direction: 'back' | 'forward'): Promise<string> {
  const session = await cdp(page);
  const { currentIndex, entries } = await session.send('Page.getNavigationHistory');
  const target = entries[currentIndex + (direction === 'back' ? -1 : 1)];
  if (!target) throw new Error(`No ${direction} history entry.`);
  await session.send('Page.navigateToHistoryEntry', { entryId: target.id });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const now = await session.send('Page.getNavigationHistory');
    if (now.entries[now.currentIndex]?.id === target.id) break;
    await page.waitForTimeout(100);
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  // Playwright's page.url() can lag behind a bfcache restore; report the history entry.
  return `Navigated ${direction} to ${target.url}`;
}

function dialogOpened(action: string, dialog: string): string {
  return `${action} opened a ${dialog}. The tab is blocked until you answer it with handle_dialog (accept or dismiss).`;
}

async function resolveTab(tabId?: number): Promise<number> {
  if (tabId !== undefined) return tabId;
  return listTabIds()[0] ?? createTab();
}

export const tools: Record<string, Tool> = {
  tabs_context_mcp: {
    description: 'List the tabs TDT controls in the QA Chrome. Call this first. Launches the QA Chrome if it is not running. TDT can only act on its own tabs.',
    schema: z.object({
      createIfEmpty: z.boolean().optional().describe('Create a tab when TDT has none yet.'),
    }),
    async run(args) {
      if (args.createIfEmpty && listTabIds().length === 0) await createTab();
      return { content: [] };
    },
  },

  tabs_create_mcp: {
    description: 'Open a new empty tab in the QA Chrome. Close tabs you no longer need with tabs_close_mcp.',
    schema: z.object({}),
    async run() {
      const id = await createTab();
      return { content: [text(`Created tab ${id}`)], tabId: id };
    },
  },

  tabs_close_mcp: {
    description: 'Close one of TDT\'s tabs.',
    schema: z.object({ tabId: tabIdArg }),
    async run(args) {
      await closeTab(args.tabId);
      return { content: [text(`Closed tab ${args.tabId}. ${listTabIds().length} tab(s) remain.`)] };
    },
  },

  navigate: {
    description: 'Go to a URL, "reload" the page, or "back" / "forward" in history. Without a scheme, local dev hosts get http:// and others https://. A URL that only changes the #hash stays in the same document (no reload) and the result says so; use "reload" to really reload. Without tabId (standalone calls only), uses TDT\'s first tab, creating one if needed.',
    schema: z.object({
      url: z.string().describe('URL, or "reload" / "back" / "forward".'),
      tabId: tabIdArg.optional(),
    }),
    async run(args) {
      const tabId = await resolveTab(args.tabId);
      const page = getTab(tabId);
      const opts = { waitUntil: 'domcontentloaded' as const, timeout: 30_000 };
      if (args.url === 'back' || args.url === 'forward') {
        return { content: [text(await historyStep(page, args.url))], tabId };
      }
      if (args.url === 'reload') {
        const r = await raceDialog(tabId, () => page.reload(opts));
        if (r.dialog) return { content: [text(dialogOpened('reload', r.dialog))], tabId };
        const status = r.value ? ` (HTTP ${r.value.status()})` : '';
        return { content: [text(`Reloaded ${page.url()}${status}. Page state (in-memory data, refs) was reset.`)], tabId };
      }
      const url = normalizeUrl(args.url);
      assertAllowed(url);
      const r = await raceDialog(tabId, () => page.goto(url, opts));
      if (r.dialog) return { content: [text(dialogOpened('navigate', r.dialog))], tabId };
      // goto() returns no response for same-document navigations (hash changes).
      const note = r.value
        ? ` (HTTP ${r.value.status()})`
        : ' (same-document navigation: only the #hash changed, the page was NOT reloaded and in-memory state is kept; use url "reload" to reload)';
      return { content: [text(`Navigated to ${page.url()}${note}`)], tabId };
    },
  },

  computer: {
    description: 'Mouse, keyboard and screenshots on a TDT tab. Take a screenshot (or read_page) before clicking so you know where things are. Click the center of elements. Prefer `ref` from read_page when you have one.',
    schema: computerSchema,
    async run(args) {
      const r = await raceDialog(args.tabId, () => runComputer(args));
      if (r.dialog) return { content: [text(dialogOpened(args.action, r.dialog))], tabId: args.tabId };
      return { content: r.value!, tabId: args.tabId };
    },
  },

  read_page: {
    description: 'Accessibility-style tree of the page with a stable ref for each element (refs survive repeated reads and stay valid until navigation, so another agent can look one up for you). filter:"interactive" lists only visible controls — usually what you want. "all" (default) includes text, headings and hidden elements (marked "(hidden)").',
    schema: z.object({
      tabId: tabIdArg,
      filter: z.enum(['interactive', 'all']).optional(),
      depth: z.number().int().min(1).optional().describe('Maximum tree depth (default 15).'),
      ref_id: z.string().optional().describe('Only read this element and its descendants.'),
      max_chars: z.number().int().min(100).optional().describe('Output limit (default 50000), truncated at a line boundary.'),
    }),
    async run(args) {
      const page = getTab(args.tabId);
      const out = await inPage<string>(page, 'readPage', args.filter ?? 'all', args.depth ?? 15, args.ref_id ?? null, args.max_chars ?? 50_000);
      return { content: [text(out)], tabId: args.tabId };
    },
  },

  get_page_text: {
    description: 'Plain text of the page\'s main content (largest <article>, else <main>, else <body>). Good for reading text-heavy pages cheaply.',
    schema: z.object({
      tabId: tabIdArg,
      max_chars: z.number().int().min(100).optional().describe('Output limit (default 100000).'),
    }),
    async run(args) {
      const page = getTab(args.tabId);
      const r = await inPage<{ title: string; url: string; source: string; text: string }>(page, 'pageText');
      const max = args.max_chars ?? 100_000;
      const body = r.text.length > max ? r.text.slice(0, max) + `\n[truncated at ${max} of ${r.text.length} characters]` : r.text;
      return { content: [text(`Title: ${r.title}\nURL: ${r.url}\nSource element: ${r.source}\n---\n${body}`)], tabId: args.tabId };
    },
  },

  form_input: {
    description: 'Set a form control by ref without typing: text inputs/textareas (string or number), checkboxes/radios (boolean), selects (option value or visible text), contenteditable. Fires input/change events.',
    schema: z.object({
      tabId: tabIdArg,
      ref: z.string().describe('Element ref from read_page.'),
      value: z.union([z.string(), z.boolean(), z.number()]),
    }),
    async run(args) {
      const page = getTab(args.tabId);
      const r = await raceDialog(args.tabId, () => inPage<string>(page, 'formInput', args.ref, args.value));
      return { content: [text(r.dialog ? dialogOpened('form_input', r.dialog) : r.value!)], tabId: args.tabId };
    },
  },

  file_upload: {
    description: 'Put local files into an <input type="file"> by ref (works on hidden inputs). Never click upload buttons: the native file picker cannot be controlled. Files must be under TDT_UPLOAD_ROOTS (default: the project directory).',
    schema: z.object({
      tabId: tabIdArg,
      ref: z.string().describe('Ref of the file input, from read_page (filter "all" shows hidden inputs).'),
      paths: z.array(z.string()).min(1).describe('Absolute file paths.'),
    }),
    async run(args) {
      const page = getTab(args.tabId);
      const roots = UPLOAD_ROOTS.map(r => (existsSync(r) ? realpathSync(r) : path.resolve(r)));
      let total = 0;
      const files = args.paths.map((p: string) => {
        if (!existsSync(p)) throw new Error(`File not found: ${p}`);
        const real = realpathSync(p);
        if (!roots.some(r => real === r || real.startsWith(r + path.sep))) {
          throw new Error(`${p} is outside TDT_UPLOAD_ROOTS (${roots.join(', ')}).`);
        }
        total += statSync(real).size;
        return real;
      });
      if (total > MAX_UPLOAD_BYTES) throw new Error(`Files total ${total} bytes; the limit is ${MAX_UPLOAD_BYTES}.`);
      let handle: ElementHandle | null;
      try {
        handle = (await page.evaluateHandle(tdtCall('lookup', args.ref))).asElement() as ElementHandle | null;
      } catch (e) {
        throw pageError(e);
      }
      if (!handle) throw new Error(`${args.ref} is not an element.`);
      try {
        await handle.setInputFiles(files);
      } catch (e) {
        throw new Error(`${args.ref} could not take files (is it an <input type="file">?): ${pageError(e).message}`);
      } finally {
        await handle.dispose();
      }
      return { content: [text(`Uploaded ${files.length} file(s) to ${args.ref}: ${files.map((f: string) => path.basename(f)).join(', ')} (${Math.ceil(total / 1024)} KB)`)], tabId: args.tabId };
    },
  },

  handle_dialog: {
    description: 'Answer the alert / confirm / prompt / beforeunload dialog blocking a TDT tab. Tool results announce open dialogs; nothing else works on that tab until it is answered.',
    schema: z.object({
      tabId: tabIdArg,
      accept: z.boolean().describe('true = OK/accept, false = Cancel/dismiss.'),
      promptText: z.string().optional().describe('Text to enter for a prompt() dialog when accepting.'),
    }),
    async run(args) {
      getTab(args.tabId, true);
      const dialog = takeDialog(args.tabId);
      if (!dialog) throw new Error(`Tab ${args.tabId} has no open dialog.`);
      const what = `${dialog.type()} "${dialog.message()}"`;
      try {
        if (args.accept) await dialog.accept(args.promptText);
        else await dialog.dismiss();
      } catch (e) {
        throw new Error(`Could not answer ${what} (already closed?): ${e instanceof Error ? e.message : e}`);
      }
      return { content: [text(`${args.accept ? 'Accepted' : 'Dismissed'} ${what}${args.accept && args.promptText !== undefined ? ` with "${args.promptText}"` : ''}`)], tabId: args.tabId };
    },
  },
};
