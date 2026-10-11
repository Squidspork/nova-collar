import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFunctionReview } from '../src/main/ghidra-review.mjs';

const args = { program: 'fixture.bin', address: 'ParseHeader' };
function fixture(overrides = {}) {
  const calls = [];
  const responses = {
    '/list_open_programs': { programs: [{ name: 'other.bin', path: '/other.bin' }, { name: 'fixture.bin', path: '/fixture.bin' }], current_program: 'other.bin' },
    '/get_current_program_info': { name: 'fixture.bin', path: '/fixture.bin', has_multiple_address_spaces: false },
    '/decompile_function': { name: 'ParseHeader', address: '00401000', decompiled: 'int ParseHeader(int x) { return x + 1; }' },
    '/get_version': { plugin_version: '7.0.0', ghidra_version: '12.1.3' },
    '/get_function_callers': { callers: [{ name: 'main', address: '00402000' }], total: 1 },
    '/get_function_xrefs': { references: [], total: 0 },
    ...overrides,
  };
  return { calls, request: async (path, query = {}) => {
    calls.push({ path, query });
    const value = responses[path];
    if (value instanceof Error) throw value;
    assert.ok(value, path);
    return value;
  } };
}
test('selects the requested program, resolves reference address, labels source and paging', async () => {
  const f = fixture(); const r = await collectFunctionReview(f.request, args);
  assert.equal(r.collection_status, 'collected');
  assert.equal(r.target.program, 'fixture.bin');
  assert.equal(r.target.function_address, '00401000');
  assert.equal(r.cross_references.data.total, 0);
  assert.equal(r.reference_page.exhaustive, false);
  assert.match(r.interpretation, /no model inference or security verdict/);
  for (const c of f.calls.filter(c => !['/get_version', '/list_open_programs'].includes(c.path))) assert.equal(c.query.program, 'fixture.bin');
  assert.equal(f.calls.find(c => c.path === '/get_function_xrefs').query.name, '00401000');
});
test('missing arguments and invalid limits fail before any request', async () => {
  const f = fixture();
  for (const a of [{}, { ...args, program: ' ' }, { ...args, limit: 0 }, { ...args, max_chars: 999999 }]) await assert.rejects(collectFunctionReview(f.request, a));
  assert.equal(f.calls.length, 0);
});
test('closed and duplicate program names fail before decompilation', async () => {
  for (const programs of [[], [{ name: 'fixture.bin' }, { name: 'fixture.bin' }]]) {
    const f = fixture({ '/list_open_programs': { programs } });
    await assert.rejects(collectFunctionReview(f.request, args), /not open|ambiguous/);
    assert.equal(f.calls.length, 1);
  }
});
test('program identity changes and unsupported response shapes fail closed', async () => {
  const f = fixture({ '/get_current_program_info': { name: 'fixture.bin', path: '/different.bin' } });
  await assert.rejects(collectFunctionReview(f.request, args), /identity changed/);
  const bad = fixture({ '/list_open_programs': { programs: 'unexpected' } });
  await assert.rejects(collectFunctionReview(bad.request, args), /invalid open-program/);
});
test('missing pseudocode is a failed collection, never a successful report', async () => {
  for (const data of [{ success: false, message: 'Decompile failed' }, { error: 'No function' }, { address: '00401000', decompiled: '' }]) {
    const f = fixture({ '/decompile_function': data });
    await assert.rejects(collectFunctionReview(f.request, args));
    assert.ok(!f.calls.some(c => c.path === '/get_function_xrefs'));
  }
});
test('secondary evidence failures remain explicit without losing pseudocode', async () => {
  const f = fixture({ '/get_function_callers': new Error('Timed out'), '/get_function_xrefs': { success: false, message: 'Analysis busy' } });
  const r = await collectFunctionReview(f.request, args);
  assert.equal(r.collection_status, 'partial');
  assert.match(r.decompilation.pseudocode, /ParseHeader/);
  assert.equal(r.callers.status, 'error');
  assert.match(r.cross_references.error, /Analysis busy/);
  assert.equal(r.cross_references.data, undefined);
});
test('bounded context records truncation and fits MCP serialized response budget', async () => {
  const f = fixture({ '/decompile_function': { name: 'ParseHeader', address: '00401000', decompiled: '\u0000'.repeat(60000) }, '/get_function_xrefs': { references: ['x'.repeat(60000)] } });
  const r = await collectFunctionReview(f.request, { ...args, max_chars: 6000 });
  assert.equal(r.decompilation.truncated, true);
  assert.equal(r.cross_references.truncated, true);
  assert.equal(r.decompilation.original_characters, 60000);
  assert.ok(JSON.stringify(r, null, 2).length < 20000);
  assert.ok(r.warnings.some(w => /truncated/.test(w)));
});
test('multi-space program requires and retains a qualified address', async () => {
  const f = fixture({ '/get_current_program_info': { name: 'fixture.bin', path: '/fixture.bin', has_multiple_address_spaces: true } });
  await assert.rejects(collectFunctionReview(f.request, args), /space-qualified/);
  const r = await collectFunctionReview(f.request, { ...args, address: 'CODE:00401010', limit: '3' });
  assert.equal(r.cross_references.query.name, 'CODE:00401000');
  assert.equal(r.reference_page.limit, 3);
});
