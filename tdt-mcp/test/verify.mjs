// End-to-end verification of every TDT tool against ../testbench.
//
//   cd testbench && python3 -m http.server 8765 --bind 127.0.0.1   (in another shell)
//   node test/verify.mjs
//
// Drives tdt-mcp over MCP stdio, and checks effects through an independent CDP
// connection that reads the testbench event log and DOM state.
// Uses its own Chrome profile and port so it never touches a real QA session.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const testbench = path.resolve(root, '..', 'testbench');
const BENCH = process.env.BENCH_URL ?? '127.0.0.1:8765';
const PORT = process.env.VERIFY_CDP_PORT ?? '9333';
const CDP = `http://127.0.0.1:${PORT}`;
const work = mkdtempSync(path.join(tmpdir(), 'tdt-verify-'));

const results = [];
function check(id, name, expected, actual, pass) {
  results.push({ id, name, expected, actual: String(actual).replace(/\n/g, ' ').slice(0, 160), pass: !!pass });
  console.error(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} — ${String(actual).replace(/\n/g, ' ').slice(0, 120)}`);
}

async function startServer(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(root, 'dist', 'index.js')],
    cwd: root,
    env: {
      ...process.env,
      TDT_CDP_URL: CDP,
      TDT_PROFILE_DIR: path.join(work, 'profile'),
      TDT_OUTPUT_DIR: path.join(work, 'out'),
      TDT_UPLOAD_ROOTS: `${testbench},${root}`,
      TDT_CHROME_ARGS: '--window-size=1600,1000',
      ...extraEnv,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'tdt-verify', version: '0' });
  await client.connect(transport);
  return client;
}

let client;
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const texts = r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  const images = r.content.filter(c => c.type === 'image');
  return { isError: !!r.isError, text: texts, images, raw: r };
}

function jpegSize(b64) {
  const buf = Buffer.from(b64, 'base64');
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

const refOf = (tree, re) => tree.split('\n').find(l => re.test(l))?.match(/\[(ref_\d+)\]/)?.[1];

// ---- independent observer ----
let observer;
async function benchPage(marker = 'tdtverify=1') {
  for (const ctx of observer.contexts()) for (const p of ctx.pages()) if (p.url().includes(marker)) return p;
  throw new Error(`observer cannot find the testbench page (${marker})`);
}
const log = async () => (await benchPage()).evaluate(() => document.getElementById('log').textContent);
const lastLog = async (n = 1) => (await log()).trim().split('\n').slice(-n).join(' | ');
const center = async sel => (await benchPage()).evaluate(s => {
  const r = document.querySelector(s).getBoundingClientRect();
  return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
}, sel);
const evalBench = async fn => (await benchPage()).evaluate(fn);

async function main() {
  client = await startServer();
  const list = await client.listTools();
  const names = list.tools.map(t => t.name).sort();
  check('0.1', 'tools/list', '11 tools', names.join(','), names.length === 11);

  // ---- tabs ----
  let r = await call('tabs_context_mcp', {});
  check('1.1', 'tabs_context_mcp (no tabs)', 'auto-launch Chrome, list (none)', r.text, !r.isError && /\(none\)/.test(r.text));
  r = await call('tabs_context_mcp', { createIfEmpty: true });
  const tab = Number(r.text.match(/tabId (\d+)/)?.[1]);
  check('1.2', 'tabs_context_mcp createIfEmpty', 'creates tab 1', r.text, tab === 1);
  observer = await chromium.connectOverCDP(CDP);
  // A Playwright client without a dialog listener auto-dismisses dialogs; keep the observer passive.
  observer.contexts()[0].on('dialog', () => {});

  r = await call('tabs_create_mcp');
  const tab2 = Number(r.text.match(/Created tab (\d+)/)?.[1]);
  check('1.3', 'tabs_create_mcp', 'new tab id', r.text, tab2 === 2);
  r = await call('tabs_close_mcp', { tabId: tab2 });
  check('1.4', 'tabs_close_mcp', 'closed, 1 remains', r.text, /1 tab\(s\) remain/.test(r.text));
  r = await call('tabs_close_mcp', { tabId: 999 });
  check('1.5', 'tabs_close_mcp invalid', 'error not TDT tab', r.text, r.isError && /not one of TDT's tabs/.test(r.text));

  // ---- navigate ----
  r = await call('navigate', { url: `${BENCH}/?tdtverify=1`, tabId: tab });
  check('2.1', 'navigate (no scheme → http for local)', `http://${BENCH}/?tdtverify=1`, r.text, r.text.includes(`http://${BENCH}/?tdtverify=1`) && /HTTP 200/.test(r.text));
  await new Promise(res => setTimeout(res, 300));

  // ---- read_page ----
  r = await call('read_page', { tabId: tab, filter: 'interactive' });
  const tree = r.text;
  const refs = {
    btnL: refOf(tree, /button "Left Button"/), btnR: refOf(tree, /button "Right Target"/),
    btnD: refOf(tree, /button "Double Target"/), btnMod: refOf(tree, /button "Modifier Button"/),
    txt: refOf(tree, /textbox "Name field"/), ta: refOf(tree, /textbox "Notes"/), cb: refOf(tree, /checkbox/),
    sel: refOf(tree, /combobox/), num: refOf(tree, /spinbutton/), file: refOf(tree, /"File picker"/),
  };
  check('3.1', 'read_page interactive', 'all controls with refs, no hidden file input', Object.entries(refs).map(([k, v]) => `${k}=${v}`).join(' '),
    Object.values(refs).every(Boolean) && !/Hidden file/.test(tree));
  const tree2 = (await call('read_page', { tabId: tab, filter: 'interactive' })).text;
  check('3.2', 'read_page ref stability', 'same refs on second read', refOf(tree2, /button "Left Button"/), refOf(tree2, /button "Left Button"/) === refs.btnL && refOf(tree2, /combobox/) === refs.sel);
  const all = (await call('read_page', { tabId: tab })).text;
  const hiddenFile = refOf(all, /"Hidden file"/);
  check('3.3', 'read_page all', 'includes hidden input marked (hidden), headings, text', all.split('\n').find(l => /Hidden file/.test(l)),
    /"Hidden file".*\(hidden\)/.test(all) && /heading "Article"/.test(all) && /PINEAPPLE-42/.test(all) && /Viewport: \d+x\d+/.test(all));
  const articleRef = refOf(all, /^article/);
  r = await call('read_page', { tabId: tab, ref_id: articleRef });
  check('3.4', 'read_page ref_id', 'only article subtree', r.text.split('\n').slice(0, 3).join(' / '), /^article/.test(r.text) && !/Left Button/.test(r.text));
  r = await call('read_page', { tabId: tab, max_chars: 300 });
  check('3.5', 'read_page max_chars', 'truncation note', r.text.match(/\[output truncated[^\]]*\]/)?.[0], /output truncated at 300 of \d+/.test(r.text));
  r = await call('read_page', { tabId: tab, depth: 1 });
  check('3.6', 'read_page depth=1', 'no nested lines', `${r.text.split('\n').filter(l => l.startsWith(' ')).length} indented lines`, !r.text.split('\n').some(l => /^ \S/.test(l) && !/^ option/.test(l)));

  // ---- get_page_text ----
  r = await call('get_page_text', { tabId: tab });
  check('4.1', 'get_page_text', 'article text, source <article>', r.text.slice(0, 120), /Source element: <article>/.test(r.text) && /PINEAPPLE-42/.test(r.text));

  // ---- clicks ----
  let [x, y] = await center('#btnL');
  r = await call('computer', { action: 'left_click', coordinate: [x, y], tabId: tab });
  check('5.1', 'left_click coordinate', 'left_click btnL mods=none', await lastLog(), /left_click btnL mods=none/.test(await lastLog()));
  r = await call('computer', { action: 'left_click', ref: refs.btnL, tabId: tab });
  check('5.2', 'left_click ref', 'left_click btnL', r.text.split('\n')[0] + ' → ' + await lastLog(), /left_click btnL/.test(await lastLog()) && /Clicked ref_/.test(r.text));
  r = await call('computer', { action: 'right_click', ref: refs.btnR, tabId: tab });
  check('5.3', 'right_click', 'right_click btnR', await lastLog(), /right_click btnR/.test(await lastLog()));
  r = await call('computer', { action: 'double_click', ref: refs.btnD, tabId: tab });
  check('5.4', 'double_click', 'double_click btnD', await lastLog(), /double_click btnD/.test(await lastLog()));
  [x, y] = await center('#para');
  r = await call('computer', { action: 'triple_click', coordinate: [x, y], tabId: tab });
  check('5.5', 'triple_click', 'whole paragraph selected', await lastLog(), /triple_click para sel="Triple click selects this whole paragraph text."/.test(await lastLog()));
  r = await call('computer', { action: 'left_click', ref: refs.btnMod, modifiers: 'shift', tabId: tab });
  check('5.6', 'click modifiers shift', 'mods=shift', await lastLog(), /btnMod mods=shift/.test(await lastLog()));
  r = await call('computer', { action: 'left_click', ref: refs.btnMod, modifiers: 'cmd+alt', tabId: tab });
  check('5.7', 'click modifiers cmd+alt', 'mods=alt+meta', await lastLog(), /btnMod mods=alt\+meta/.test(await lastLog()));
  r = await call('computer', { action: 'left_click', ref: refs.btnMod, modifiers: 'hyper', tabId: tab });
  check('5.8', 'click unknown modifier', 'error', r.text, r.isError && /Unknown modifier/.test(r.text));
  [x, y] = await center('#hoverT');
  r = await call('computer', { action: 'hover', coordinate: [x, y], tabId: tab });
  const tipShown = await evalBench(() => getComputedStyle(document.getElementById('tip')).display);
  check('5.9', 'hover', 'hover enter + CSS :hover tooltip', `${await lastLog()} tip=${tipShown}`, /hover enter hoverT/.test(await lastLog()) && tipShown === 'block');
  r = await call('computer', { action: 'left_click', tabId: tab });
  check('5.10', 'left_click without target', 'error', r.text, r.isError && /needs `coordinate` or `ref`/.test(r.text));

  // ---- keyboard ----
  await call('computer', { action: 'left_click', ref: refs.txt, tabId: tab });
  await call('computer', { action: 'type', text: 'Hello 你好 123', tabId: tab });
  let v = await evalBench(() => document.getElementById('txt').value);
  check('6.1', 'type unicode', 'Hello 你好 123', v, v === 'Hello 你好 123');
  await call('computer', { action: 'key', text: 'cmd+a', tabId: tab });
  await call('computer', { action: 'key', text: 'Backspace', tabId: tab });
  v = await evalBench(() => document.getElementById('txt').value);
  check('6.2', 'key cmd+a + Backspace', 'empty', JSON.stringify(v), v === '');
  await call('computer', { action: 'type', text: 'abcdef', tabId: tab });
  await call('computer', { action: 'key', text: 'Backspace', repeat: 3, tabId: tab });
  await call('computer', { action: 'key', text: 'ArrowLeft ArrowLeft x', tabId: tab });
  v = await evalBench(() => document.getElementById('txt').value);
  check('6.3', 'key repeat + multi-key', 'axbc', v, v === 'axbc');
  await call('computer', { action: 'left_click', coordinate: [700, 600], tabId: tab });
  await call('computer', { action: 'key', text: 'shift+a', tabId: tab });
  const k1 = await lastLog();
  await call('computer', { action: 'key', text: 'esc', tabId: tab });
  check('6.4', 'key on body (shift+a, esc alias)', 'keydown a mods=shift, keydown Escape', `${k1} | ${await lastLog()}`, /keydown A mods=shift|keydown a mods=shift/.test(k1) && /keydown Escape/.test(await lastLog()));

  // ---- form_input ----
  r = await call('form_input', { tabId: tab, ref: refs.ta, value: 'multi\nline note' });
  check('7.1', 'form_input textarea', 'value set + previous', r.text.split('\n')[0], /Set textarea value/.test(r.text) && (await evalBench(() => document.getElementById('ta').value)) === 'multi\nline note');
  r = await call('form_input', { tabId: tab, ref: refs.cb, value: true });
  check('7.2', 'form_input checkbox', 'checked, change event', r.text.split('\n')[0], (await evalBench(() => document.getElementById('cb').checked)) && /change cb=true/.test(await log()));
  r = await call('form_input', { tabId: tab, ref: refs.sel, value: 'Green' });
  check('7.3', 'form_input select by text', 'sel=g', r.text.split('\n')[0], /change sel=g/.test(await log()));
  r = await call('form_input', { tabId: tab, ref: refs.sel, value: 'b' });
  check('7.4', 'form_input select by value', 'sel=b', r.text.split('\n')[0], /change sel=b/.test(await log()));
  r = await call('form_input', { tabId: tab, ref: refs.num, value: 7 });
  check('7.5', 'form_input number', 'num=7', r.text.split('\n')[0], /change num=7/.test(await log()));
  r = await call('form_input', { tabId: tab, ref: refs.sel, value: 'Purple' });
  check('7.6', 'form_input bad option', 'error lists options', r.text.split('\n')[0], r.isError && /No option matching "Purple"/.test(r.text));
  r = await call('form_input', { tabId: tab, ref: refs.btnL, value: 'x' });
  check('7.7', 'form_input non-control', 'error', r.text.split('\n')[0], r.isError && /not a form control/.test(r.text));

  // ---- drag (coordinates are viewport pixels 1:1) ----
  const [sx, sy] = await center('#drag');
  const target = await evalBench(() => { const r = document.getElementById('dropT').getBoundingClientRect(); return [Math.round(r.left + 20), Math.round(r.top + 20)]; });
  await call('computer', { action: 'left_click_drag', start_coordinate: [sx, sy], coordinate: target, tabId: tab });
  const dragLog = await lastLog();
  check('8.1', 'left_click_drag exact coords', `mouseup at ${target.join(',')} onDropTarget=true`, dragLog, dragLog.includes(`mouseup at ${target.join(',')} onDropTarget=true`));

  // ---- screenshots ----
  const vp = await evalBench(() => [document.documentElement.clientWidth, document.documentElement.clientHeight]);
  r = await call('computer', { action: 'screenshot', tabId: tab });
  let size = jpegSize(r.images[0]?.data ?? '');
  check('9.1', 'screenshot size = viewport', `${vp.join('x')}`, `${size?.w}x${size?.h}`, size && size.w === vp[0] && size.h === vp[1]);
  r = await call('computer', { action: 'screenshot', tabId: tab, scale: 0.5 });
  size = jpegSize(r.images[0]?.data ?? '');
  check('9.2', 'screenshot scale 0.5', `${Math.round(vp[0] / 2)}x${Math.round(vp[1] / 2)}`, `${size?.w}x${size?.h}`, size && Math.abs(size.w - vp[0] / 2) <= 1 && Math.abs(size.h - vp[1] / 2) <= 1);
  r = await call('computer', { action: 'zoom', region: [0, 0, 300, 150], tabId: tab });
  size = jpegSize(r.images[0]?.data ?? '');
  check('9.3', 'zoom region 300x150', '1200x600 (4x)', `${size?.w}x${size?.h}`, size && size.w === 1200 && size.h === 600);
  r = await call('computer', { action: 'screenshot', tabId: tab, save_to_disk: true });
  const saved = r.text.match(/Saved to (\S+)/)?.[1];
  check('9.4', 'screenshot save_to_disk', 'file exists', saved, saved && existsSync(saved));
  r = await call('computer', { action: 'zoom', tabId: tab });
  check('9.5', 'zoom without region', 'error', r.text.split('\n')[0], r.isError);

  // ---- scrolling ----
  const [wx, wy] = await center('#wide');
  await call('computer', { action: 'scroll', coordinate: [wx, wy], scroll_direction: 'right', scroll_amount: 2, tabId: tab });
  v = await evalBench(() => document.getElementById('wide').scrollLeft);
  check('10.1', 'scroll right in container', 'scrollLeft=200', v, v === 200);
  r = await call('computer', { action: 'scroll', coordinate: [500, 400], scroll_direction: 'down', tabId: tab });
  let sy1 = await evalBench(() => Math.round(scrollY));
  check('10.2', 'scroll down default 3 ticks', 'scrollY=300 + screenshot', `scrollY=${sy1} images=${r.images.length}`, sy1 === 300 && r.images.length === 1);
  await call('computer', { action: 'scroll', coordinate: [500, 400], scroll_direction: 'down', scroll_amount: 10, tabId: tab });
  sy1 = await evalBench(() => Math.round(scrollY));
  check('10.3', 'scroll down 10', 'scrollY=1300', sy1, sy1 === 1300);
  await call('computer', { action: 'scroll', coordinate: [500, 400], scroll_direction: 'up', scroll_amount: 5, tabId: tab });
  sy1 = await evalBench(() => Math.round(scrollY));
  check('10.4', 'scroll up 5', 'scrollY=800', sy1, sy1 === 800);
  r = await call('computer', { action: 'screenshot', tabId: tab });
  size = jpegSize(r.images[0]?.data ?? '');
  check('10.5', 'screenshot while scrolled', 'still viewport-sized', `${size?.w}x${size?.h}`, size && size.w === vp[0] && size.h === vp[1]);
  const bottomRef = refOf(all, /BOTTOM SECTION/);
  r = await call('computer', { action: 'scroll_to', ref: bottomRef, tabId: tab });
  const inView = await evalBench(() => { const r = document.getElementById('bottom').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  check('10.6', 'scroll_to ref', 'bottom section in view', r.text.split('\n')[0], inView);
  r = await call('computer', { action: 'left_click', ref: refs.btnL, tabId: tab });
  check('10.7', 'click ref far off-screen', 'auto-scrolls then clicks', await lastLog(), /left_click btnL/.test(await lastLog()));

  // ---- wait ----
  const t0 = Date.now();
  await call('computer', { action: 'wait', duration: 1, tabId: tab });
  check('11.1', 'wait 1s', '~1000ms', `${Date.now() - t0}ms`, Date.now() - t0 >= 950);

  // ---- file_upload ----
  r = await call('file_upload', { tabId: tab, ref: refs.file, paths: [path.join(testbench, 'sample.txt'), path.join(testbench, 'data.json')] });
  check('12.1', 'file_upload 2 files', 'sample.txt(13),data.json(28)', await lastLog(), /file input: sample\.txt\(13\),data\.json\(28\)/.test(await lastLog()));
  r = await call('file_upload', { tabId: tab, ref: hiddenFile, paths: [path.join(root, 'package.json')] });
  check('12.2', 'file_upload hidden input', 'hidden file input: package.json', await lastLog(), /hidden file input: package\.json/.test(await lastLog()));
  r = await call('file_upload', { tabId: tab, ref: hiddenFile, paths: ['/etc/hosts'] });
  check('12.3', 'file_upload outside roots', 'rejected', r.text.split('\n')[0], r.isError && /outside TDT_UPLOAD_ROOTS/.test(r.text));
  r = await call('file_upload', { tabId: tab, ref: refs.btnL, paths: [path.join(testbench, 'sample.txt')] });
  check('12.4', 'file_upload non-file element', 'error', r.text.split('\n')[0], r.isError);

  // ---- batch ----
  [x, y] = await center('#btnL');
  r = await call('browser_batch', { actions: [
    { name: 'computer', input: { action: 'left_click', ref: refs.btnL, tabId: tab } },
    { name: 'form_input', input: { ref: refs.txt, value: 'batched', tabId: tab } },
    { name: 'mcp__tdt__computer', input: { action: 'screenshot', tabId: tab, scale: 0.3 } },
    { name: 'read_page', input: { tabId: tab, filter: 'interactive', max_chars: 200 } },
  ] });
  check('13.1', 'browser_batch 4 steps', 'labelled outputs + image', r.text.split('\n').filter(l => l.startsWith('[')).join(' / '),
    !r.isError && /\[computer:left_click\] Clicked/.test(r.text) && /\[form_input\] Set/.test(r.text) && r.images.length === 1 && /\[read_page\]/.test(r.text));
  r = await call('browser_batch', { actions: [
    { name: 'computer', input: { action: 'wait', duration: 0.1, tabId: tab } },
    { name: 'form_input', input: { ref: 'ref_99999', value: 'x', tabId: tab } },
    { name: 'computer', input: { action: 'wait', duration: 0.1, tabId: tab } },
  ] });
  check('13.2', 'browser_batch stops on error', '1 completed, 1 not run', r.text.match(/failed:.*not run\)/)?.[0], r.isError && /\(1 completed, 1 not run\)/.test(r.text) && /ref_99999 not found/.test(r.text));
  r = await call('browser_batch', { actions: [{ name: 'browser_batch', input: {} }] });
  check('13.3', 'browser_batch nested', 'rejected', r.text.split('\n')[0], r.isError && /cannot be nested/.test(r.text));
  r = await call('browser_batch', { actions: [{ name: 'computer', input: { action: 'left_click' } }] });
  check('13.4', 'browser_batch schema validation', 'invalid input (tabId)', r.text.split('\n')[0], r.isError && /tabId/.test(r.text));

  // ---- dialogs ----
  const confirmRef = refOf((await call('read_page', { tabId: tab, filter: 'interactive' })).text, /"Confirm dialog"/);
  r = await call('computer', { action: 'left_click', ref: confirmRef, tabId: tab });
  check('17.1', 'click opening confirm()', 'returns, announces dialog', r.text.split('\n')[0], !r.isError && /opened a confirm dialog: "Delete item\?"/.test(r.text));
  r = await call('computer', { action: 'screenshot', tabId: tab });
  check('17.2', 'tab blocked while dialog open', 'error asks for handle_dialog', r.text.split('\n')[0], r.isError && /blocked by an open confirm dialog/.test(r.text));
  r = await call('handle_dialog', { tabId: tab, accept: true });
  await new Promise(res => setTimeout(res, 300));
  check('17.3', 'handle_dialog accept', 'confirm result=true', `${r.text.split('\n')[0]} → ${await lastLog(3)}`, /confirm result=true/.test(await lastLog(3)));
  await call('computer', { action: 'left_click', ref: confirmRef, tabId: tab });
  r = await call('handle_dialog', { tabId: tab, accept: false });
  await new Promise(res => setTimeout(res, 300));
  check('17.4', 'handle_dialog dismiss', 'confirm result=false', `${r.text.split('\n')[0]} → ${await lastLog(3)}`, /confirm result=false/.test(await lastLog(3)));
  r = await call('handle_dialog', { tabId: tab, accept: true });
  check('17.5', 'handle_dialog with no dialog', 'error', r.text.split('\n')[0], r.isError && /no open dialog/.test(r.text));
  r = await call('browser_batch', { actions: [
    { name: 'computer', input: { action: 'left_click', ref: confirmRef, tabId: tab } },
    { name: 'handle_dialog', input: { tabId: tab, accept: true } },
    { name: 'computer', input: { action: 'wait', duration: 0.3, tabId: tab } },
  ] });
  check('17.6', 'dialog inside browser_batch', 'click → accept → continues', `${r.text.split('\n').filter(l => l.startsWith('[')).join(' / ')} → ${await lastLog()}`, !r.isError && /confirm result=true/.test(await lastLog(3)));

  // ---- popup ----
  const popupRef = refOf((await call('read_page', { tabId: tab, filter: 'interactive' })).text, /link "Open popup"/);
  r = await call('computer', { action: 'left_click', ref: popupRef, tabId: tab });
  await new Promise(res => setTimeout(res, 800));
  r = await call('tabs_context_mcp');
  const popupTab = Number(r.text.match(/tabId (\d+): "[^"]*" \([^)]*popup=1\)/)?.[1]);
  check('14.1', 'popup auto-registered', 'popup becomes a TDT tab', r.text.replace(/\n/g, ' '), popupTab > 0);
  if (popupTab) await call('tabs_close_mcp', { tabId: popupTab });

  // ---- navigation history & stale refs ----
  r = await call('navigate', { url: `http://${BENCH}/data.json?tdtverify=2`, tabId: tab });
  r = await call('navigate', { url: 'back', tabId: tab });
  check('15.1', 'navigate back', 'back to bench', r.text.split('\n')[0], /Navigated back to .*tdtverify=1/.test(r.text));
  r = await call('navigate', { url: 'forward', tabId: tab });
  check('15.2', 'navigate forward', 'forward to data.json', r.text.split('\n')[0], /Navigated forward to .*data\.json/.test(r.text));
  await call('navigate', { url: 'back', tabId: tab });
  r = await call('computer', { action: 'left_click', ref: refs.btnMod, tabId: tab });
  check('15.3', 'ref after bfcache back (same document)', 'ref still valid', await lastLog(), !r.isError && /click btnMod/.test(await lastLog()));
  await call('navigate', { url: `${BENCH}/?tdtverify=1&fresh=1`, tabId: tab });
  r = await call('computer', { action: 'left_click', ref: refs.btnMod, tabId: tab });
  check('15.4', 'stale ref after fresh navigation', 'clear error, no click', r.text.split('\n')[0], r.isError && /not found/.test(r.text));
  r = await call('navigate', { url: 'back', tabId: 1 });
  await call('navigate', { url: 'back', tabId: 1 });
  await call('navigate', { url: 'back', tabId: 1 });
  r = await call('navigate', { url: 'back', tabId: 1 });
  check('15.5', 'back past start of history', 'error', r.text.split('\n')[0], r.isError && /No back history entry/.test(r.text));

  // ---- hash navigation vs reload ----
  await call('navigate', { url: `${BENCH}/?tdtverify=1`, tabId: tab });
  await evalBench(() => { window.__marker = 42; });
  r = await call('navigate', { url: `${BENCH}/?tdtverify=1#section`, tabId: tab });
  let marker = await evalBench(() => window.__marker);
  check('15.7', 'hash-only navigate', 'same document, says NOT reloaded', `${r.text.split('\n')[0]} marker=${marker}`, /NOT reloaded/.test(r.text) && marker === 42);
  r = await call('navigate', { url: 'reload', tabId: tab });
  marker = await evalBench(() => window.__marker);
  check('15.8', 'navigate reload', 'new document, state reset', `${r.text.split('\n')[0]} marker=${marker}`, /Reloaded .*HTTP 200/.test(r.text) && marker === undefined);

  // ---- navigate without tabId ----
  r = await call('navigate', { url: `${BENCH}/?tdtverify=3` });
  check('15.6', 'navigate without tabId', 'uses first TDT tab', r.text.replace(/\n/g, ' '), /Executed on tabId: 1/.test(r.text));

  await client.close();

  // ---- allowlist (separate server instance) ----
  client = await startServer({ TDT_ALLOWED_ORIGINS: 'http://127.0.0.1:*' });
  await call('tabs_context_mcp', { createIfEmpty: true });
  const t = Number((await call('tabs_context_mcp')).text.match(/tabId (\d+)/)?.[1]);
  r = await call('navigate', { url: 'example.com', tabId: t });
  check('16.1', 'allowlist blocks navigate', 'rejected', r.text.split('\n')[0], r.isError && /outside TDT_ALLOWED_ORIGINS/.test(r.text));
  r = await call('navigate', { url: `${BENCH}/?tdtverify=4`, tabId: t });
  check('16.2', 'allowlist allows bench', 'navigated', r.text.split('\n')[0], !r.isError);
  await (await benchPage('tdtverify=4')).evaluate(() => { location.href = 'https://example.com/'; });
  await new Promise(res => setTimeout(res, 2500));
  r = await call('tabs_context_mcp');
  check('16.3', 'allowlist catches in-page navigation', 'redirected to about:blank + notice', r.text.replace(/\n/g, ' '), /outside TDT_ALLOWED_ORIGINS; TDT sent it to about:blank/.test(r.text));
  await client.close();
}

try {
  await main();
} catch (e) {
  check('X', 'harness crashed', 'no crash', e.stack ?? e, false);
} finally {
  await observer?.close().catch(() => {});
  // Shut down the verification Chrome (its own port and profile).
  try {
    const b = await chromium.connectOverCDP(CDP);
    const s = await b.newBrowserCDPSession();
    await s.send('Browser.close');
  } catch {}
}

const pass = results.filter(r => r.pass).length;
const md = [
  `# TDT verification — ${new Date().toISOString()}`,
  '',
  `${pass}/${results.length} passed`,
  '',
  '| # | Case | Expected | Actual | Result |',
  '|---|---|---|---|---|',
  ...results.map(r => `| ${r.id} | ${r.name} | ${r.expected} | ${r.actual.replace(/\|/g, '\\|')} | ${r.pass ? '✅' : '❌'} |`),
].join('\n');
const outFile = path.join(root, 'test', 'last-run.md');
writeFileSync(outFile, md + '\n');
console.log(md);
process.exit(pass === results.length ? 0 : 1);
