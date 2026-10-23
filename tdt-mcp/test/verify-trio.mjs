// TDT + Playwright MCP + Chrome DevTools MCP sharing one QA Chrome.
//
//   cd testbench && python3 -m http.server 8765 --bind 127.0.0.1   (in another shell)
//   node test/verify-trio.mjs
//
// Checks the hand-offs the /tdt skill relies on: each server finds TDT's tab,
// sees what TDT did there, and TDT keeps working after the others act.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const BENCH = process.env.BENCH_URL ?? '127.0.0.1:8765';
const PORT = process.env.VERIFY_CDP_PORT ?? '9335';
const CDP = `http://127.0.0.1:${PORT}`;
const PW_VERSION = process.env.PW_MCP_VERSION ?? '0.0.83';
const CDT_VERSION = process.env.CDT_MCP_VERSION ?? '1.12.0';
const work = mkdtempSync(path.join(tmpdir(), 'tdt-trio-'));

const results = [];
function check(id, name, expected, actual, pass) {
  const a = String(actual).replace(/\s+/g, ' ').slice(0, 200);
  results.push({ id, name, expected, actual: a, pass: !!pass });
  console.error(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} — ${a.slice(0, 140)}`);
}

async function start(name, command, args, env = {}) {
  const transport = new StdioClientTransport({ command, args, cwd: root, env: { ...process.env, ...env }, stderr: 'ignore' });
  const client = new Client({ name: `trio-${name}`, version: '0' });
  await client.connect(transport);
  return client;
}

function jpegSize(b64) {
  const buf = Buffer.from(b64, 'base64');
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))]);

async function call(client, name, args = {}, ms = 60_000) {
  const r = await withTimeout(client.callTool({ name, arguments: args }), ms, name);
  const text = r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { isError: !!r.isError, text, images: r.content.filter(c => c.type === 'image') };
}

let observer;
const bench = () => observer.contexts()[0].pages().find(p => p.url().includes('tdttrio'));
const lastLog = async () => (await bench().evaluate(() => document.getElementById('log').textContent)).trim().split('\n').pop();

const tdt = await start('tdt', 'node', [path.join(root, 'dist', 'index.js')], {
  TDT_CDP_URL: CDP, TDT_PROFILE_DIR: path.join(work, 'profile'), TDT_CHROME_ARGS: '--window-size=1600,1000',
});
let pw, cdt;

try {
  // TDT launches the QA Chrome; the other two attach to it.
  await call(tdt, 'tabs_context_mcp', { createIfEmpty: true });
  await call(tdt, 'navigate', { url: `${BENCH}/?tdttrio=1`, tabId: 1 });
  observer = await chromium.connectOverCDP(CDP);
  // A Playwright client without a dialog listener auto-dismisses dialogs; keep the observer passive.
  observer.contexts()[0].on('dialog', () => {});

  pw = await start('pw', 'npx', ['-y', `@playwright/mcp@${PW_VERSION}`, '--cdp-endpoint', CDP, '--caps', 'testing,network,storage,devtools']);
  cdt = await start('cdt', 'npx', ['-y', `chrome-devtools-mcp@${CDT_VERSION}`, '--browserUrl', CDP,
    '--categoryInput=false', '--categoryMemory=false', '--no-usage-statistics']);

  const pwTools = (await pw.listTools()).tools.map(t => t.name);
  const cdtTools = (await cdt.listTools()).tools.map(t => t.name);
  writeFileSync(path.join(here, 'trio-tools.json'), JSON.stringify({ playwright: { version: PW_VERSION, tools: pwTools }, devtools: { version: CDT_VERSION, tools: cdtTools } }, null, 2) + '\n');
  check('0.1', 'Playwright MCP tools', 'listed', `${pwTools.length}: ${pwTools.join(',')}`, pwTools.length > 0);
  check('0.2', 'DevTools MCP tools (input/memory off)', 'listed, no click', `${cdtTools.length}: ${cdtTools.join(',')}`,
    cdtTools.length > 0 && !cdtTools.includes('click') && cdtTools.includes('list_pages'));

  // ---- Playwright finds TDT's tab ----
  let r = await call(pw, 'browser_tabs', { action: 'list' });
  const tabLine = r.text.split('\n').find(l => l.includes('tdttrio'));
  const pwIndex = Number(tabLine?.match(/(\d+)/)?.[1]);
  check('1.1', 'PW browser_tabs list sees TDT tab', 'tdttrio tab listed', tabLine, tabLine !== undefined);
  r = await call(pw, 'browser_tabs', { action: 'select', index: pwIndex });
  check('1.2', 'PW browser_tabs select', 'selected tdttrio tab', r.text.split('\n').find(l => /current/i.test(l)) ?? r.text.slice(0, 150), !r.isError && /tdttrio/.test(r.text));

  // ---- DevTools finds TDT's tab ----
  r = await call(cdt, 'list_pages');
  const cdtLine = r.text.split('\n').find(l => l.includes('tdttrio'));
  const pageId = cdtLine?.match(/^\s*(\d+)/)?.[1] ?? cdtLine?.match(/(\d+)/)?.[1];
  check('1.3', 'CDT list_pages sees TDT tab', 'tdttrio page listed', cdtLine, cdtLine !== undefined);

  // ---- TDT acts, the others observe ----
  const tree = (await call(tdt, 'read_page', { tabId: 1, filter: 'interactive' })).text;
  const ref = re => tree.split('\n').find(l => re.test(l))?.match(/\[(ref_\d+)\]/)?.[1];
  await call(tdt, 'computer', { action: 'left_click', ref: ref(/"Emit console"/), tabId: 1 });
  await call(tdt, 'computer', { action: 'left_click', ref: ref(/"Fetch data"/), tabId: 1 });
  await call(tdt, 'computer', { action: 'wait', duration: 1, tabId: 1 });

  r = await call(pw, 'browser_console_messages', { level: 'error' });
  check('2.1', 'PW console sees TDT-triggered error', '[APP] error message', r.text, /\[APP\] error message/.test(r.text));
  r = await call(pw, 'browser_network_requests', {});
  check('2.2', 'PW network sees TDT-triggered fetch', 'data.json?from=btn', r.text.split('\n').filter(l => /data\.json|missing/.test(l)).join(' / '), /data\.json\?from=btn/.test(r.text));

  r = await call(cdt, 'list_console_messages', { pageId: Number(pageId) });
  check('2.3', 'CDT console sees TDT-triggered messages', '[APP] messages', r.text.split('\n').filter(l => /APP/.test(l)).join(' / '), /\[APP\] error message/.test(r.text));
  r = await call(cdt, 'list_network_requests', { pageId: Number(pageId) });
  const reqLine = r.text.split('\n').find(l => /data\.json\?from=btn/.test(l));
  check('2.4', 'CDT network sees TDT-triggered fetch', 'data.json?from=btn', reqLine, reqLine !== undefined);
  const reqid = reqLine?.match(/reqid=(\d+)/)?.[1];
  if (reqid) {
    r = await call(cdt, 'get_network_request', { pageId: Number(pageId), reqid: Number(reqid) });
    check('2.5', 'CDT request body', 'response body {"ok":true...}', r.text.slice(0, 200), /"user":\s*"tester"/.test(r.text));
  } else {
    check('2.5', 'CDT request body', 'response body', 'no reqid parsed from: ' + reqLine, false);
  }

  // ---- dialogs: TDT owns them (its CDP client must, or Playwright auto-dismisses) ----
  const confirmRef = ref(/"Confirm dialog"/);
  r = await call(tdt, 'computer', { action: 'left_click', ref: confirmRef, tabId: 1 }, 8_000);
  check('3.1', 'TDT click opening confirm() with PW + CDT attached', 'returns, announces dialog', r.text.split('\n')[0], /opened a confirm dialog/.test(r.text));
  r = await call(tdt, 'handle_dialog', { tabId: 1, accept: true });
  await new Promise(res => setTimeout(res, 500));
  check('3.2', 'TDT handle_dialog accept', 'confirm result=true', `${r.text.split('\n')[0]} → ${await lastLog()}`, /confirm result=true/.test(await lastLog()));

  // ---- TDT still works afterwards ----
  r = await call(tdt, 'computer', { action: 'screenshot', tabId: 1, scale: 0.3 });
  check('4.1', 'TDT screenshot after other servers acted', 'image returned', `${r.images.length} image(s)`, r.images.length === 1);

  // ---- assertions & codegen ----
  r = await call(pw, 'browser_verify_text_visible', { text: 'PINEAPPLE-42' });
  check('5.1', 'PW verify_text_visible', 'pass', r.text.split('\n')[0], !r.isError);
  r = await call(pw, 'browser_verify_text_visible', { text: 'NOT-ON-PAGE-123' });
  check('5.2', 'PW verify_text_visible negative', 'error', r.text.split('\n')[0], r.isError);
  r = await call(pw, 'browser_start_recording', {});
  const recStart = r.text.split('\n')[0];
  await call(tdt, 'computer', { action: 'left_click', ref: ref(/"Left Button"/), tabId: 1 });
  await call(tdt, 'form_input', { ref: ref(/"Name field"/), value: 'recorded', tabId: 1 });
  await call(tdt, 'computer', { action: 'left_click', ref: ref(/"Name field"/), tabId: 1 });
  await call(tdt, 'computer', { action: 'type', text: 'XYZ', tabId: 1 });
  r = await call(pw, 'browser_stop_recording', {});
  check('5.3', 'PW recording captures TDT actions as code', 'code mentions Left Button / fill', `start="${recStart}" code="${r.text.slice(0, 300)}"`, /Left Button|getByRole|click\(/.test(r.text));

  // ---- responsive: DevTools resizes the real window, TDT keeps coordinates right ----
  r = await call(cdt, 'resize_page', { pageId: Number(pageId), width: 800, height: 600 }).catch(e => ({ isError: true, text: e.message }));
  await new Promise(res => setTimeout(res, 800));
  let shot = await call(tdt, 'computer', { action: 'screenshot', tabId: 1 });
  let size = jpegSize(shot.images[0]?.data ?? '');
  let vv = await bench().evaluate(() => [Math.round(visualViewport.width), Math.round(visualViewport.height)]);
  check('6.1', 'CDT resize_page → TDT screenshot = new viewport', `${vv.join('x')} (≈800 wide)`, `resize="${r.text.split('\n')[0]}" image=${size?.w}x${size?.h}`,
    size && Math.abs(size.w - vv[0]) <= 1 && Math.abs(size.h - vv[1]) <= 1 && vv[0] <= 800);
  let [bx, by] = await bench().evaluate(() => { const r = document.getElementById('btnL').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; });
  await call(tdt, 'computer', { action: 'left_click', coordinate: [bx, by], tabId: 1 });
  check('6.2', 'coordinate click after resize_page', 'hits Left Button', await lastLog(), /left_click btnL/.test(await lastLog()));

  // Known limitation (not tested): a device/viewport override set by another CDP client
  // (CDT `emulate viewport`) is not applied consistently to TDT's screenshots and input.
  // The /tdt skill routes responsive testing to CDT resize_page instead.
  await call(cdt, 'resize_page', { pageId: Number(pageId), width: 1600, height: 1000 }).catch(() => {});
} catch (e) {
  check('X', 'harness crashed', 'no crash', e.stack ?? e, false);
} finally {
  for (const c of [pw, cdt, tdt]) await c?.close().catch(() => {});
  await observer?.close().catch(() => {});
  try {
    const b = await chromium.connectOverCDP(CDP);
    await (await b.newBrowserCDPSession()).send('Browser.close');
  } catch {}
}

const pass = results.filter(r => r.pass).length;
const md = [
  `# TDT trio verification — ${new Date().toISOString()}`,
  '',
  `Playwright MCP ${PW_VERSION} · Chrome DevTools MCP ${CDT_VERSION} · ${pass}/${results.length} passed`,
  '',
  '| # | Case | Expected | Actual | Result |',
  '|---|---|---|---|---|',
  ...results.map(r => `| ${r.id} | ${r.name} | ${r.expected} | ${r.actual.replace(/\|/g, '\\|')} | ${r.pass ? '✅' : '❌'} |`),
].join('\n');
writeFileSync(path.join(here, 'last-run-trio.md'), md + '\n');
console.log(md);
process.exit(pass === results.length ? 0 : 1);
