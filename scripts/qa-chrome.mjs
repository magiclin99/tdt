// Starts the QA Chrome on a named Chrome profile (the "person" inside the QA
// user-data-dir, e.g. the one Chrome shows as "QA"), so /tdt can switch profiles
// without hand-built command lines. The tdt MCP server then attaches over CDP.
//
//   node scripts/qa-chrome.mjs                 list profiles and what is running
//   node scripts/qa-chrome.mjs <name>          (re)start the QA Chrome on that profile
//   node scripts/qa-chrome.mjs <name> --force  restart even if real pages are open
//
// <name> is the display name Chrome shows (case-insensitive) or the directory
// name ("Profile 1"). Reads the same TDT_* env vars as tdt-mcp/src/browser.ts.
// Exit codes: 0 ok, 2 profile not found, 3 pages open (needs --force), 1 other.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';

const CDP_URL = process.env.TDT_CDP_URL ?? 'http://127.0.0.1:9222';
const PORT = new URL(CDP_URL).port || '9222';
const PROFILE_DIR = process.env.TDT_PROFILE_DIR || path.join(homedir(), '.tdt', 'chrome-profile');
const EXTRA_ARGS = (process.env.TDT_CHROME_ARGS ?? '--window-size=1600,1000').split(' ').filter(Boolean);

function chromeExecutable() {
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// { dir, name } for every profile Chrome knows about in PROFILE_DIR.
function listProfiles() {
  try {
    const state = JSON.parse(readFileSync(path.join(PROFILE_DIR, 'Local State'), 'utf8'));
    return Object.entries(state.profile?.info_cache ?? {}).map(([dir, info]) => ({ dir, name: info.name ?? dir }));
  } catch {
    return [];
  }
}

// The browser (not helper) process listening on PORT, with the profile it runs.
function runningChrome() {
  let lines;
  if (platform() === 'win32') {
    const ps = "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }";
    lines = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).split(/\r?\n/);
  } else {
    lines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n');
  }
  for (const line of lines) {
    if (!line.includes(`--remote-debugging-port=${PORT}`) || line.includes('--type=')) continue;
    const [, pid, cmd] = line.trim().match(/^(\d+)\s+(.*)$/) ?? [];
    if (!pid) continue;
    // ps drops the quoting, so "Profile 1" runs up to the next --switch.
    const dir = cmd.match(/--profile-directory="?(.+?)"?(?=\s+--|\s+\S+:|$)/)?.[1] ?? 'Default';
    const userDataDir = cmd.match(/--user-data-dir="?(.+?)"?(?=\s+--|\s+\S+:|$)/)?.[1];
    return { pid: Number(pid), dir, userDataDir };
  }
  return null;
}

async function cdp(pathname) {
  try {
    const res = await fetch(`${CDP_URL}${pathname}`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function label(dir) {
  const p = listProfiles().find(x => x.dir === dir);
  return p ? `"${p.name}" (${dir})` : dir;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const want = args.filter(a => a !== '--force').join(' ').trim();
  const profiles = listProfiles();
  const running = runningChrome();

  if (!want) {
    console.log(`Profiles in ${PROFILE_DIR}:`);
    for (const p of profiles) console.log(`  ${p.name}  ->  ${p.dir}`);
    if (!profiles.length) console.log('  (none yet; Chrome creates "Default" on first launch)');
    console.log(running ? `Running on :${PORT}: ${label(running.dir)}, pid ${running.pid}` : `Nothing running on :${PORT}.`);
    return;
  }

  const target = profiles.find(p => p.name.toLowerCase() === want.toLowerCase())
    ?? profiles.find(p => p.dir.toLowerCase() === want.toLowerCase());
  if (!target) {
    console.error(`No profile named "${want}" in ${PROFILE_DIR}. Available:`);
    for (const p of profiles) console.error(`  ${p.name}  ->  ${p.dir}`);
    process.exit(2);
  }

  if (running) {
    const sameDir = !running.userDataDir || path.resolve(running.userDataDir) === path.resolve(PROFILE_DIR);
    if (sameDir && running.dir === target.dir) {
      console.log(`OK: already running on ${label(target.dir)}, pid ${running.pid}, ${CDP_URL}`);
      return;
    }
    const pages = ((await cdp('/json/list')) ?? [])
      .filter(t => t.type === 'page' && !/^(about:blank|chrome:\/\/(newtab|new-tab-page)\/?)$/.test(t.url));
    if (pages.length && !force) {
      console.error(`QA Chrome is running on ${label(running.dir)} with ${pages.length} open page(s):`);
      for (const t of pages) console.error(`  ${t.url}`);
      console.error('Restarting closes them. Re-run with --force once that is OK.');
      process.exit(3);
    }
    process.kill(running.pid, 'SIGTERM');
    for (let i = 0; i < 40 && runningChrome(); i++) await sleep(250);
    if (runningChrome()) throw new Error(`Chrome pid ${running.pid} did not exit.`);
  }

  const exe = chromeExecutable();
  if (path.isAbsolute(exe) && !existsSync(exe)) throw new Error(`Chrome not found at ${exe}. Set TDT_CHROME_PATH.`);
  const child = spawn(exe, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    `--profile-directory=${target.dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...EXTRA_ARGS,
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await cdp('/json/version')) {
      const now = runningChrome();
      if (now?.dir !== target.dir) throw new Error(`Chrome came up on ${now ? label(now.dir) : 'an unknown profile'}, not ${label(target.dir)}.`);
      console.log(`OK: started on ${label(target.dir)}, pid ${now.pid}, ${CDP_URL}`);
      return;
    }
  }
  throw new Error(`Launched Chrome but ${CDP_URL} did not respond within 20s.`);
}

main().catch(err => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
