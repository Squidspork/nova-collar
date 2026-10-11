import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { AnalysisManager, analysisBundle } = await import(process.env.NOVA_ANALYSIS_MODULE
  ? pathToFileURL(resolve(process.env.NOVA_ANALYSIS_MODULE)).href
  : new URL('../src/main/analysis-runtime.js', import.meta.url).href);

const out = resolve(process.env.NOVA_ANALYSIS_TEST_DIR || 'work/analysis-verification');
mkdirSync(out, { recursive: true });
const manager = new AnalysisManager({ home: join(out, 'investigations') });
const receipt = { bundle: analysisBundle(), checks: {}, started: new Date().toISOString() };
assert.equal(receipt.bundle.ok, true, receipt.bundle.error);
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  for (const relative of receipt.bundle.manifest.native_tools || []) {
    if (!relative.includes('demangler_gnu')) continue;
    const result = execFileSync(join(receipt.bundle.root, relative), ['_ZN4Nova7inspectEi'], { encoding: 'utf8' });
    assert.match(result, /Nova::inspect\(int\)/);
  }
  receipt.checks.gnu_demanglers_work = receipt.bundle.manifest.native_tools?.filter(p => p.includes('demangler_gnu')).length === 2;
  assert.equal(receipt.checks.gnu_demanglers_work, true);
  for (const [dir, value] of [['js-before', 3], ['js-after', 7]]) {
    const target = join(out, dir); mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: dir, version: '1.0.0', type: 'module', main: 'index.js' }));
    writeFileSync(join(target, 'index.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(out, 'TARGET-WAS-EXECUTED'))}, 'bad');\nexport function novaAdd(x) { return x + ${value}; }\n`);
  }
  const js = await manager.open(join(out, 'js-before'), { kind: 'javascript' });
  assert.equal(js.ok, true, JSON.stringify(js));
  receipt.javascript = js;
  receipt.checks.javascript_static_analysis = true;
  assert.equal(existsSync(join(out, 'TARGET-WAS-EXECUTED')), false);
  const next = await manager.call(js.session_id, 'analyze_javascript_application', { input_path: join(out, 'js-after'), detail: 'summary' });
  assert.equal(next.ok, true, JSON.stringify(next));
  receipt.javascript_after = next;
  const catalogue = manager.tools(js.session_id, { tool: 'compare_application_versions' });
  assert.equal(catalogue.tool.name, 'compare_application_versions');
  receipt.checks.complete_tool_schema_discovery = true;
  const left = JSON.parse(readFileSync(js.result_path)).normalized_result.parent_evidence_id;
  const right = JSON.parse(readFileSync(next.result_path)).normalized_result.parent_evidence_id;
  assert(left && right);
  const comparison = await manager.call(js.session_id, 'compare_application_versions', {
    left: { kind: 'retained-evidence', evidence_id: left },
    right: { kind: 'retained-evidence', evidence_id: right },
  });
  assert.equal(comparison.ok, true, JSON.stringify(comparison));
  receipt.comparison = comparison;
  receipt.checks.javascript_version_comparison = true;
  const jsClose = await manager.close(js.session_id);
  assert.equal(jsClose.ok, true, JSON.stringify(jsClose));
  assert.equal(existsSync(jsClose.evidence_path), true);
  receipt.checks.evidence_saved_on_close = true;
  const c = join(out, 'fixture.cpp'); const binary = join(out, 'fixture');
  writeFileSync(c, 'extern "C" int nova_add(int x) { return x + 17; }\nnamespace Nova { int inspect(int x) { return x * 9 + 6; } }\nint main(void) { return nova_add(2) + Nova::inspect(3); }\n');
  execFileSync(process.env.CXX || 'c++', ['-O0', c, '-o', binary]);
  const originalHash = hash(binary);
  const native = await manager.open(binary);
  assert.equal(native.ok, true, JSON.stringify(native));
  console.log('Native target opened; starting bundled headless analysis.');
  const overview = await manager.call(native.session_id, 'binary_overview');
  assert.equal(overview.ok, true, JSON.stringify(overview));
  receipt.native_overview = overview;
  const functions = await manager.call(native.session_id, 'list_procedures');
  assert.equal(functions.ok, true, JSON.stringify(functions));
  const functionData = JSON.parse(readFileSync(functions.result_path));
  const text = JSON.stringify(functionData);
  assert.match(text, /nova_add/);
  assert.match(text, /Nova::inspect/);
  receipt.checks.cpp_symbols_demangled_in_ghidra = true;
  const detail = await manager.call(native.session_id, 'analyze_function', { procedure: functionData.normalized_result.find(row => row.value.includes('nova_add')).address });
  assert.equal(detail.ok, true, JSON.stringify(detail));
  assert.match(readFileSync(detail.result_path, 'utf8'), /17|0x11/);
  receipt.native_function = detail;
  receipt.checks.real_native_decompilation = true;
  receipt.checks.target_bytes_unchanged = originalHash === hash(binary);
  assert.equal(receipt.checks.target_bytes_unchanged, true);
  const status = await manager.call(native.session_id, 'binary_session');
  receipt.native_status_path = status.result_path;
  const processBefore = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const owned = processBefore.split('\n').filter(line => line.includes(receipt.bundle.root) && !line.includes('verify-analysis'));
  receipt.processes_during_analysis = owned;
  assert(owned.some(line => line.includes('/java/') && line.includes('headless')));
  assert(!owned.some(line => line.includes('/opt/homebrew/')));
  receipt.checks.bundled_java_used = true;
  const close = await manager.close(native.session_id);
  assert.equal(close.ok, true, JSON.stringify(close));
  await new Promise(r => setTimeout(r, 1000));
  const after = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const pids = owned.map(line => Number(line.trim().split(/\s+/)[0]));
  const survivors = after.split('\n').filter(line => pids.includes(Number(line.trim().split(/\s+/)[0])));
  assert.deepEqual(survivors, []);
  receipt.checks.all_owned_helpers_stopped = true;
  const canceled = await manager.open(binary);
  assert.equal(canceled.ok, true, JSON.stringify(canceled));
  const controller = new AbortController();
  const pending = manager.call(canceled.session_id, 'binary_overview', {}, { signal: controller.signal });
  // Attach a handler immediately while waiting to observe the real JVM startup.
  const outcome = pending.then(value => ({ value }), error => ({ error: error.message }));
  const started = Date.now();
  let cancelOwned = [];
  while (Date.now() - started < 15000) {
    const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
    cancelOwned = ps.split('\n').filter(line => line.includes(receipt.bundle.root) && !line.includes('verify-analysis'));
    if (cancelOwned.some(line => line.includes('/java/') && line.includes('headless'))) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert(cancelOwned.some(line => line.includes('/java/') && line.includes('headless')), 'Real JVM must start before cancellation');
  controller.abort(new Error('Verification canceled native analysis'));
  assert.match((await outcome).error || '', /cancel|abort/i);
  await manager.close(canceled.session_id);
  await new Promise(r => setTimeout(r, 1000));
  const cancelAfter = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const cancelPids = cancelOwned.map(line => Number(line.trim().split(/\s+/)[0]));
  assert.deepEqual(cancelAfter.split('\n').filter(line => cancelPids.includes(Number(line.trim().split(/\s+/)[0]))), []);
  receipt.checks.real_native_cancellation_and_cleanup = true;
  receipt.checks.target_was_never_executed = !existsSync(join(out, 'TARGET-WAS-EXECUTED'));
  console.log('Live static JavaScript, native decompilation, evidence export, and cleanup passed.');
} finally {
  await manager.closeAll();
  receipt.finished = new Date().toISOString();
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
}
