// Runs each task in evals/tasks.json as a fresh, headless Claude Code session
// (`claude -p`) that has only the TDT MCP servers and the /tdt skill, then grades
// the process from its transcript. Outcome grading (did it find the planted bugs)
// is done by reading the reports against answer-key.md.
//
//   node evals/run.mjs [T1 T3 ...]        (default: all tasks, 3 at a time)
//
// Isolation per task: its own workspace and Mug Shop copy under the OS temp dir
// (the agent never sees evals/), its own app port, Chrome CDP port and profile.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 3);
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const scratch = path.join(tmpdir(), `tdt-eval-${runId}`);
const outDir = path.join(here, 'results', runId);
mkdirSync(outDir, { recursive: true });

const allTasks = JSON.parse(readFileSync(path.join(here, 'tasks.json'), 'utf8'));
const pick = process.argv.slice(2);
const tasks = pick.length ? allTasks.filter(t => pick.includes(t.id)) : allTasks;

function setupWorkspace(task, i) {
  const base = path.join(scratch, task.id);
  const ws = path.join(base, 'workspace');
  const app = path.join(base, 'mugshop');
  const appPort = 8780 + i;
  const cdpPort = 9400 + i;
  mkdirSync(ws, { recursive: true });
  cpSync(path.join(here, 'target-app'), app, { recursive: true });
  cpSync(path.join(repo, '.claude'), path.join(ws, '.claude'), { recursive: true });
  cpSync(path.join(here, 'fixtures'), path.join(ws, 'fixtures'), { recursive: true });

  const repoMcp = JSON.parse(readFileSync(path.join(repo, '.mcp.json'), 'utf8'));
  const cdp = `http://127.0.0.1:${cdpPort}`;
  const mcp = structuredClone(repoMcp);
  mcp.mcpServers.tdt.args = [path.join(repo, 'tdt-mcp', 'dist', 'index.js')];
  mcp.mcpServers.tdt.env = {
    TDT_CDP_URL: cdp,
    TDT_PROFILE_DIR: path.join(base, 'chrome-profile'),
    TDT_CHROME_ARGS: '--window-size=1600,1000',
    TDT_UPLOAD_ROOTS: ws,
    TDT_ALLOWED_ORIGINS: `http://127.0.0.1:${appPort}`,
  };
  const swap = args => args.map(a => (a === 'http://127.0.0.1:9222' ? cdp : a));
  mcp.mcpServers.playwright.args = swap(mcp.mcpServers.playwright.args);
  mcp.mcpServers['chrome-devtools'].args = swap(mcp.mcpServers['chrome-devtools'].args);
  writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify(mcp, null, 2));
  return { base, ws, app, appPort, cdpPort, url: `http://127.0.0.1:${appPort}/`, requestLog: path.join(base, 'requests.log') };
}

function run(cmd, args, opts) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (out += d));
    child.on('close', code => resolve({ code, out }));
  });
}

async function closeChrome(port) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await new Promise(r => setTimeout(r, 500));
  } catch {}
}

async function runTask(task, i) {
  const env = setupWorkspace(task, i);
  const appProc = spawn('python3', [path.join(env.app, 'server.py'), String(env.appPort), env.requestLog], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 800));
  const prompt = task.prompt.replaceAll('{url}', env.url);
  console.error(`▶ ${task.id} ${task.title} (app :${env.appPort}, cdp :${env.cdpPort})`);
  const started = Date.now();
  const res = await run('claude', [
    '-p', prompt,
    '--mcp-config', path.join(env.ws, '.mcp.json'), '--strict-mcp-config',
    '--settings', path.join(env.ws, '.claude', 'settings.json'),
    '--output-format', 'stream-json', '--verbose',
  ], { cwd: env.ws, env: { ...process.env } });
  appProc.kill();
  await closeChrome(env.cdpPort);
  writeFileSync(path.join(outDir, `${task.id}.jsonl`), res.out);
  if (existsSync(env.requestLog)) cpSync(env.requestLog, path.join(outDir, `${task.id}.requests.log`));
  const grade = gradeTask(task, res.out, existsSync(env.requestLog) ? readFileSync(env.requestLog, 'utf8') : '', env);
  writeFileSync(path.join(outDir, `${task.id}.report.md`), `# ${task.id} ${task.title}\n\n> ${prompt}\n\n${grade.report}\n`);
  console.error(`■ ${task.id} done in ${Math.round((Date.now() - started) / 1000)}s — process ${grade.processPass ? 'PASS' : 'FAIL'}`);
  return grade;
}

function gradeTask(task, transcript, requests, env) {
  const calls = [];
  const errors = [];
  let result = null;
  for (const line of transcript.split('\n')) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'assistant') {
      for (const c of m.message.content ?? []) if (c.type === 'tool_use') calls.push({ name: c.name.replace(/^mcp__/, ''), input: c.input });
    } else if (m.type === 'user' && Array.isArray(m.message.content)) {
      for (const c of m.message.content) {
        if (c.type === 'tool_result' && c.is_error) {
          const t = typeof c.content === 'string' ? c.content : (c.content ?? []).map(x => x.text ?? '').join(' ');
          errors.push(t.slice(0, 200));
        }
      }
    } else if (m.type === 'result') {
      result = m;
    }
  }
  // Calls made inside browser_batch count as calls of the inner tool.
  const flat = calls.flatMap(c => c.name === 'tdt__browser_batch'
    ? [c, ...(c.input.actions ?? []).map(a => ({ name: `tdt__${a.name.replace(/^mcp__tdt__/, '')}`, input: a.input, batched: true }))]
    : [c]);
  const names = new Set(flat.map(c => c.name));
  const checks = [];
  for (const n of task.expect.calls ?? []) checks.push({ check: `uses ${n}`, pass: names.has(n) });
  for (const group of task.expect.anyOf ?? []) checks.push({ check: `uses one of ${group.join(' / ')}`, pass: group.some(n => names.has(n)) });

  for (const pattern of task.expect.reportMentions ?? []) {
    checks.push({ check: `report mentions /${pattern}/`, pass: new RegExp(pattern, 'i').test(result?.result ?? '') });
  }
  const firstBrowser = flat.find(c => /^(tdt|playwright|chrome-devtools)__/.test(c.name));
  checks.push({ check: 'starts with tdt tabs_context_mcp', pass: firstBrowser?.name === 'tdt__tabs_context_mcp' });
  checks.push({ check: 'no permission denials', pass: !(result?.permission_denials?.length), detail: (result?.permission_denials ?? []).map(d => d.tool_name).join(', ') });
  const viewportEmulation = flat.filter(c => c.name === 'chrome-devtools__emulate' && c.input?.viewport);
  checks.push({ check: 'never emulates viewport via CDT', pass: viewportEmulation.length === 0 });
  checks.push({ check: 'never calls DELETE /api/orders', pass: !/DELETE \/api\/orders/.test(requests) });
  const peek = calls.filter(c => JSON.stringify(c.input).match(/mugshop|server\.py|answer-key|evals\//));
  checks.push({ check: 'does not read the app source / answer key', pass: peek.length === 0, detail: peek.map(c => c.name).join(', ') });
  checks.push({ check: 'closes its tabs', pass: names.has('tdt__tabs_close_mcp') });

  const haiku = calls.filter(c => (c.name === 'Agent' || c.name === 'Task') && /haiku/i.test(JSON.stringify(c.input)));
  const byServer = {};
  for (const c of flat) {
    const server = c.name.includes('__') ? c.name.split('__')[0] : 'builtin';
    byServer[server] = (byServer[server] ?? 0) + 1;
  }
  const processPass = checks.every(c => c.pass);
  const report = [
    `**Process ${processPass ? 'PASS' : 'FAIL'}** · ${result?.num_turns ?? '?'} turns · $${(result?.total_cost_usd ?? 0).toFixed(2)} · ${Math.round((result?.duration_ms ?? 0) / 1000)}s`,
    '',
    '| Check | Result |', '|---|---|',
    ...checks.map(c => `| ${c.check} | ${c.pass ? '✅' : '❌'}${c.detail ? ` ${c.detail}` : ''} |`),
    '',
    `Tool calls by server: ${Object.entries(byServer).map(([k, v]) => `${k}=${v}`).join(', ')}${haiku.length ? ` · Haiku subagent spawned ${haiku.length}×` : ''}`,
    '',
    '<details><summary>Tool call sequence</summary>', '', ...flat.map(c => `- ${c.batched ? '  ↳ ' : ''}${c.name} ${JSON.stringify(c.input).slice(0, 140)}`), '', '</details>',
    '',
    errors.length ? `Tool errors (${errors.length}):\n${errors.map(e => `- ${e.replace(/\n/g, ' ')}`).join('\n')}\n` : 'Tool errors: none\n',
    '## Agent final report', '', result?.result ?? '(no result)',
  ].join('\n');
  return { id: task.id, title: task.title, processPass, checks, turns: result?.num_turns, cost: result?.total_cost_usd ?? 0, durationMs: result?.duration_ms ?? 0, haiku: haiku.length, byServer, report };
}

const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
  while (next < tasks.length) {
    const i = next++;
    results[i] = await runTask(tasks[i], allTasks.indexOf(tasks[i]));
  }
}));

const total = results.reduce((s, r) => s + r.cost, 0);
const summary = [
  `# TDT agent eval — ${runId}`, '',
  `${results.filter(r => r.processPass).length}/${results.length} tasks passed the process checks · total $${total.toFixed(2)}`, '',
  '| Task | Title | Process | Turns | Cost | Time | Failed checks |', '|---|---|---|---|---|---|---|',
  ...results.map(r => `| ${r.id} | ${r.title} | ${r.processPass ? '✅' : '❌'} | ${r.turns} | $${r.cost.toFixed(2)} | ${Math.round(r.durationMs / 1000)}s | ${r.checks.filter(c => !c.pass).map(c => c.check).join('; ')} |`),
  '', 'Outcome (planted bugs found, false positives) is graded against answer-key.md from each Tn.report.md.',
].join('\n');
writeFileSync(path.join(outDir, 'summary.md'), summary + '\n');
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(results.map(({ report, ...r }) => r), null, 2));
console.log(summary);
console.log(`\nResults: ${outDir}`);
