import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { AnalysisManager, checkedAnalysisPath } from '../src/main/analysis-runtime.js';
import { analysisAsk, analysisPack, steerAnalysis, runAnalysis } from '../src/main/analysis-pack.js';
import { inferPack, runPack } from '../src/main/packs.js';
import { safePack } from '../src/main/safe.js';
import { toolsForPack } from '../src/main/subagent.js';
import { toolsForAsk, servesAsk } from '../src/main/serve.js';
import { assessAction } from '../src/main/approvals.js';
const fixture = resolve('scripts/fixtures/analysis-server.mjs');
// An empty fixture root keeps absolute paths intact on Windows, including when
// Node and the checkout are on different drives. Real bundles use relative paths.
const bundle = () => ({ ok: true, root: '', manifest: { node: process.execPath, entry: fixture, java_home: '/unused', ghidra: '/unused', versions: { test: '1' } } });
function setup(idleMs = 60_000) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'collar-analysis-test-')));
  const path = join(dir, 'target'); writeFileSync(path, 'inert fixture');
  return { dir, path, manager: new AnalysisManager({ home: join(dir, 'results'), bundle, idleMs }) };
}

test('default routing uses bundled analysis; explicit desktop project stays on Ghidra', () => {
  assert.equal(inferPack('Decompile this binary'), 'analysis');
  assert.equal(inferPack('Inspect this Electron application'), 'analysis');
  assert.equal(inferPack('How does this app work?'), 'analysis');
  assert.equal(inferPack('Analyze my open Ghidra project'), 'ghidra');
  assert.equal(analysisAsk('What is Ghidra?'), false);
  assert.equal(safePack('analysis'), 'analysis');
  assert.equal(steerAnalysis('Decompile this binary', { action: 'refuse' }).action, 'refuse');
  assert.equal(steerAnalysis('Decompile this binary', { pack: 'host' }, { locked: true }).pack, 'host');
  const defs = toolsForPack('analysis');
  assert.equal(defs.length, analysisPack().tools.length);
  const names = new Set(defs.map(x => x.function.name));
  assert.equal(toolsForAsk(defs, 'Inspect network ports in this binary', [], names).length, defs.length);
  assert(servesAsk('Inspect network ports in this binary', 'analysis_call', []));
});
test('paths and effect routes retain Collar boundaries', async () => {
  assert.throws(() => checkedAnalysisPath('relative.bin'), /absolute/);
  await assert.rejects(runAnalysis('analysis_call', { tool: 'capture_process_scenario', arguments_json: '{}' }), /analysis_run/);
  await assert.rejects(runAnalysis('analysis_call', { tool: 'open_binary', arguments_json: '{}' }), /analysis_open/);
  await assert.rejects(runAnalysis('analysis_call', { tool: 'recover_javascript_sources', arguments_json: '{}' }), /analysis_run/);
  assert.equal((await runAnalysis('analysis_run', { tool: 'capture_process_scenario', arguments_json: '{}' }, { tasker: 'user' })).held, true);
  assert.equal((await runAnalysis('analysis_status', {}, { role: 'phone' })).ok, false);
  assert.equal(assessAction('analysis_call', { tool: 'binary_overview' }), null);
  const review = assessAction('analysis_run', { session_id: 'fixture', tool: 'capture_process_scenario', arguments_json: '{}' });
  assert(review?.fingerprint);
  assert.match(review.detail, /capture_process_scenario/);
});
test('desktop Ghidra tools still dispatch to the existing project bridge', async () => {
  const fetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return Response.json({ count: 1, current_program: 'existing-project-fixture' });
  };
  try {
    const status = await runPack('ghidra_status', {});
    assert.equal(status.ok, true);
    assert.equal(status.current, 'existing-project-fixture');
    assert.equal(urls.length, 3);
    assert(urls.every(url => url.startsWith('http://127.0.0.1:8089/')));
  } finally { globalThis.fetch = fetch; }
});
test('unavailable bundle fails before starting any helper', async () => {
  const s = setup(); s.manager.bundle = () => ({ ok: false, error: 'bundle missing' });
  try { await assert.rejects(s.manager.open(s.path), /bundle missing/); assert.equal(s.manager.sessions.size, 0); }
  finally { rmSync(s.dir, { recursive: true, force: true }); }
});
test('separate investigations preserve target identity and save evidence on close', async () => {
  const s = setup(); const secondPath = join(s.dir, 'second'); writeFileSync(secondPath, 'other');
  try {
    const [one, two] = await Promise.all([s.manager.open(s.path), s.manager.open(secondPath)]);
    assert(one.ok && two.ok); assert.notEqual(one.session_id, two.session_id);
    const result = await s.manager.call(one.session_id, 'echo', { meaning: 42 });
    assert.equal(result.data.path, s.path); assert.equal(result.data.args.meaning, 42);
    assert.equal((await s.manager.call(two.session_id, 'echo')).data.path, secondPath);
    const pid = s.manager.get(one.session_id).transport.pid;
    const close = await s.manager.close(one.session_id);
    assert.equal(close.ok, true); assert(existsSync(close.evidence_path));
    assert.equal(JSON.parse(readFileSync(close.evidence_path)).path, s.path);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(s.manager.read(one.session_id, result.result_id).next_offset, null);
  } finally { await s.manager.closeAll(); rmSync(s.dir, { recursive: true, force: true }); }
});
test('errors stay errors, large results remain readable, cancellation leaves session usable', async () => {
  const s = setup();
  try {
    const opened = await s.manager.open(s.path);
    assert.equal((await s.manager.call(opened.session_id, 'fail')).ok, false);
    const large = await s.manager.call(opened.session_id, 'large');
    assert.equal(large.truncated, true);
    let offset = 0, combined = '';
    do { const page = s.manager.read(opened.session_id, large.result_id, offset); combined += page.text; offset = page.next_offset; } while (offset !== null);
    assert.equal(JSON.parse(combined).text.length, 81000);
    const abort = new AbortController();
    const waiting = s.manager.call(opened.session_id, 'wait', {}, { signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(waiting, /abort|cancel/i);
    assert.equal((await s.manager.call(opened.session_id, 'echo')).ok, true);
  } finally { await s.manager.closeAll(); rmSync(s.dir, { recursive: true, force: true }); }
});
test('idle investigations export and stop without an always-on service', async () => {
  const s = setup(100);
  try {
    const opened = await s.manager.open(s.path);
    for (let i = 0; i < 50 && s.manager.sessions.size; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(s.manager.sessions.size, 0);
    assert(existsSync(join(s.dir, 'results', opened.session_id, 'evidence.json')));
  } finally { await s.manager.closeAll(); rmSync(s.dir, { recursive: true, force: true }); }
});
test('app shutdown cancels work without a foreground turn signal and stops all helpers', async () => {
  const s = setup();
  try {
    const opened = await s.manager.open(s.path);
    const pid = s.manager.get(opened.session_id).transport.pid;
    const pending = s.manager.call(opened.session_id, 'wait');
    const canceled = assert.rejects(pending, /closed|cancel/i);
    await new Promise(r => setTimeout(r, 100));
    await s.manager.closeAll();
    await canceled;
    assert.equal(s.manager.sessions.size, 0);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    await assert.rejects(s.manager.open(s.path), /shutting down/);
  } finally { await s.manager.closeAll(); rmSync(s.dir, { recursive: true, force: true }); }
});
