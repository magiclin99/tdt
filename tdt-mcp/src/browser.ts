// Connection to the QA Chrome over CDP, plus TDT's own tab registry.
// TDT only acts on tabs it created (or that those tabs opened as popups).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type Page } from 'playwright-core';

export const CDP_URL = process.env.TDT_CDP_URL ?? 'http://127.0.0.1:9222';
const PROFILE_DIR = process.env.TDT_PROFILE_DIR ?? path.join(homedir(), '.tdt', 'chrome-profile');
const AUTO_LAUNCH = process.env.TDT_AUTO_LAUNCH !== '0';
const EXTRA_ARGS = (process.env.TDT_CHROME_ARGS ?? '').split(' ').filter(Boolean);
const ALLOWED = (process.env.TDT_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);

let browser: Browser | null = null;
let connecting: Promise<Browser> | null = null;
let launchedPage: Page | null = null;

const tabs = new Map<number, Page>();
const tabIds = new WeakMap<Page, number>();
const sessions = new WeakMap<Page, CDPSession>();
// Open JS dialogs, held until handle_dialog answers them. Registering a 'dialog'
// listener also stops Playwright from auto-dismissing them.
const dialogs = new Map<number, Dialog>();
const notices: string[] = [];
let nextTabId = 1;

function chromeExecutable(): string {
  if (process.env.TDT_CHROME_PATH) return process.env.TDT_CHROME_PATH;
  switch (platform()) {
    case 'darwin':
      return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'win32':
      return path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
    default:
      return 'google-chrome';
  }
}

async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function launchChrome(): Promise<void> {
  const exe = chromeExecutable();
  if (path.isAbsolute(exe) && !existsSync(exe)) {
    throw new Error(`Chrome not found at ${exe}. Set TDT_CHROME_PATH.`);
  }
  mkdirSync(PROFILE_DIR, { recursive: true });
  const port = new URL(CDP_URL).port || '9222';
  const child = spawn(exe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...EXTRA_ARGS,
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await cdpAlive()) return;
  }
  throw new Error(`Launched Chrome but ${CDP_URL} did not respond within 20s.`);
}

async function connect(): Promise<Browser> {
  let launched = false;
  if (!(await cdpAlive())) {
    if (!AUTO_LAUNCH) throw new Error(`No Chrome is listening on ${CDP_URL} (auto-launch disabled by TDT_AUTO_LAUNCH=0).`);
    await launchChrome();
    launched = true;
  }
  const b = await chromium.connectOverCDP(CDP_URL);
  b.on('disconnected', () => {
    browser = null;
    tabs.clear();
    launchedPage = null;
  });
  // The blank tab of a Chrome we just launched becomes TDT's first tab.
  if (launched) launchedPage = b.contexts()[0]?.pages()[0] ?? null;
  return b;
}

export async function getContext(): Promise<BrowserContext> {
  if (!browser) {
    connecting ??= connect().finally(() => { connecting = null; });
    browser = await connecting;
  }
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('Connected Chrome has no default browser context.');
  return ctx;
}

// ---- origin allowlist (TDT_ALLOWED_ORIGINS="https://*.stage.example.com,http://localhost:*") ----

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*') + '$');
}
const allowedPatterns = ALLOWED.map(globToRegExp);

export function isAllowed(url: string): boolean {
  if (!allowedPatterns.length) return true;
  if (url === 'about:blank') return true;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return allowedPatterns.some(re => re.test(origin));
}

export function assertAllowed(url: string) {
  if (!isAllowed(url)) {
    throw new Error(`${url} is outside TDT_ALLOWED_ORIGINS (${ALLOWED.join(', ')}).`);
  }
}

// ---- tabs ----

function register(page: Page): number {
  const existing = tabIds.get(page);
  if (existing) return existing;
  const id = nextTabId++;
  tabs.set(id, page);
  tabIds.set(page, id);
  page.on('close', () => {
    tabs.delete(id);
    dialogs.delete(id);
  });
  page.on('dialog', dialog => {
    dialogs.set(id, dialog);
    notices.push(`Tab ${id} has an open ${describeDialog(dialog)}. Answer it with handle_dialog before doing anything else on that tab.`);
  });
  page.on('popup', popup => {
    const popupId = register(popup);
    notices.push(`Tab ${id} opened a popup, registered as tab ${popupId}.`);
  });
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame() || isAllowed(frame.url())) return;
    notices.push(`Tab ${id} navigated to ${frame.url()}, which is outside TDT_ALLOWED_ORIGINS; TDT sent it to about:blank.`);
    page.goto('about:blank').catch(() => {});
  });
  return id;
}

export async function createTab(): Promise<number> {
  const ctx = await getContext();
  if (launchedPage && !launchedPage.isClosed() && !tabIds.has(launchedPage)) {
    const page = launchedPage;
    launchedPage = null;
    return register(page);
  }
  return register(await ctx.newPage());
}

export function describeDialog(dialog: Dialog): string {
  const def = dialog.type() === 'prompt' && dialog.defaultValue() ? `, default "${dialog.defaultValue()}"` : '';
  return `${dialog.type()} dialog: "${dialog.message()}"${def}`;
}

// The tab's page, refusing while a JS dialog blocks it (unless allowDialog).
export function getTab(tabId: number, allowDialog = false): Page {
  const page = tabs.get(tabId);
  if (!page || page.isClosed()) {
    throw new Error(`Tab ${tabId} is not one of TDT's tabs. Call tabs_context_mcp to list valid tabs, or tabs_create_mcp to add one.`);
  }
  const dialog = dialogs.get(tabId);
  if (dialog && !allowDialog) {
    throw new Error(`Tab ${tabId} is blocked by an open ${describeDialog(dialog)}. Call handle_dialog first.`);
  }
  return page;
}

export function takeDialog(tabId: number): Dialog | undefined {
  const dialog = dialogs.get(tabId);
  dialogs.delete(tabId);
  return dialog;
}

// Runs a page action, returning early if it opens a JS dialog: the browser
// does not finish the input/evaluate call until the dialog is answered.
export async function raceDialog<T>(tabId: number, action: () => Promise<T>): Promise<{ value?: T; dialog?: string }> {
  const page = getTab(tabId);
  let onDialog!: (d: Dialog) => void;
  const opened = new Promise<Dialog>(resolve => {
    onDialog = resolve;
    page.once('dialog', onDialog);
  });
  const run = action();
  try {
    const winner = await Promise.race([run.then(value => ({ value })), opened.then(d => ({ dialog: d }))]);
    if ('dialog' in winner) {
      run.catch(() => {});
      return { dialog: describeDialog(winner.dialog) };
    }
    return { value: winner.value };
  } finally {
    page.off('dialog', onDialog);
  }
}

export function listTabIds(): number[] {
  return [...tabs.keys()];
}

export async function closeTab(tabId: number): Promise<void> {
  takeDialog(tabId);
  await getTab(tabId, true).close({ runBeforeUnload: false });
}

export async function cdp(page: Page): Promise<CDPSession> {
  let s = sessions.get(page);
  if (!s) {
    s = await page.context().newCDPSession(page);
    sessions.set(page, s);
  }
  return s;
}

export function hasBrowser(): boolean {
  return browser !== null;
}

export async function tabContext(executedOn?: number): Promise<string> {
  const lines: string[] = ['Tab Context:'];
  if (executedOn !== undefined) lines.push(`- Executed on tabId: ${executedOn}`);
  lines.push('- Available tabs:');
  if (!tabs.size) lines.push('  (none)');
  for (const [id, page] of tabs) {
    const title = await page.title().catch(() => '');
    lines.push(`  • tabId ${id}: "${title || page.url()}" (${page.url()})`);
  }
  while (notices.length) lines.push(`⚠️ ${notices.shift()}`);
  return lines.join('\n');
}
