import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { NetworkCore, findNetworkProgram, checkDiscoveryScope, discoveryScope, networkEnv, parseCaptureInterfaces, runNetworkProcess } from '../src/main/network-core.js';
import { NetworkRuntime } from '../src/main/network-runtime.js';
import { networkPack, runNetwork, steerNetwork } from '../src/main/network-pack.js';
import { validateNetworkArgs } from '../src/main/network-tools.js';
import { inferPack } from '../src/main/packs.js';
import { toolsForPack } from '../src/main/subagent.js';
import { toolsForAsk, servesAsk } from '../src/main/serve.js';
import { assessAction, setApprovalNotifier, resolveApproval } from '../src/main/approvals.js';
import { executeTool, toolDefs } from '../src/main/tools.js';
import { syntheticCapture } from './fixtures/network-capture.mjs';

const local = { address: '192.168.88.4', family: 'IPv4', cidr: '192.168.88.4/24', internal: false };
const setup = options => { const dir = mkdtempSync(join(tmpdir(), 'nova-network-test-')); return { dir, core: new NetworkCore({ home: join(dir, 'captures'), ...options }) }; };

test('routing preserves Wireshark tools, limits, binary routing and refusal', () => {
  assert.equal(inferPack('Inspect my wired network for anomalies'), 'wireshark');
  assert.equal(inferPack('Scan my network'), 'wireshark');
  assert.notEqual(inferPack('What is Wireshark?'), 'wireshark');
  assert.equal(inferPack('Inspect network ports in this binary'), 'analysis');
  assert.equal(steerNetwork('use Wireshark', { action: 'refuse' }).action, 'refuse');
  assert.equal(steerNetwork('use Wireshark', { pack: 'host' }, { locked: true }).pack, 'host');
  const defs = toolsForPack('wireshark'), names = new Set(defs.map(d => d.function.name));
  assert.equal(defs.length, networkPack().tools.length);
  assert.equal(toolsForAsk(defs, 'Check DNS problems in this capture', [], names).length, defs.length);
  assert(servesAsk('Inspect my local network connectivity', 'network_analyze'));
  const capture = toolDefs({ local: true }).find(d => d.function.name === 'network_capture');
  assert.equal(capture.function.parameters.properties.seconds.maximum, 60);
  assert.throws(() => validateNetworkArgs('network_capture', { interface: 'eth0', seconds: 999 }), /1–60/);
  assert.throws(() => validateNetworkArgs('network_discover', { interface: 'eth0', cidr: 'x', ports: 'all' }), /Unknown argument/);
});

test('discovery scopes must be bounded and on the selected connected private subnet', () => {
  assert.equal(discoveryScope(local), '192.168.88.0/24');
  assert.equal(discoveryScope({ ...local, cidr: '192.168.88.4/16' }), '192.168.88.0/24');
  assert.equal(discoveryScope({ ...local, address: '203.0.113.1' }), null);
  assert.equal(checkDiscoveryScope('192.168.88.9/32', [local]), '192.168.88.9/32');
  for (const cidr of ['192.168.0.0/16', '192.168.89.0/24', '8.8.8.8/32', '127.0.0.1/32', 'example.com', '192.168.88.0/24;echo x']) assert.throws(() => checkDiscoveryScope(cidr, [local]));
  const rows = parseCaptureInterfaces('1. eth0 (Ethernet)\n2. rpcap://remote\n3. sshdump (Remote SSH capture)', { eth0: [local] });
  assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'wired');
  const windows = parseCaptureInterfaces('1. \\Device\\NPF_{ABC} (Ethernet)', { Ethernet: [local] }, { '\\device\\npf_{abc}': 'Ethernet' });
  assert.equal(windows.length, 1);
});

test('effects fail closed without approval, phone role is denied, exact scope changes approval', async () => {
  assert.equal((await runNetwork('network_capture', { interface: 'eth0' })).held, true);
  assert.equal((await runNetwork('network_status', {}, { role: 'phone' })).ok, false);
  assert.equal(assessAction('network_analyze', { capture_id: 'fixture' }), null);
  const a = assessAction('network_capture', { interface: 'eth0' });
  const b = assessAction('network_capture', { interface: 'eth1' });
  assert.notEqual(a.fingerprint, b.fingerprint); assert.match(a.reason, /remote/); assert.match(a.detail, /128|seconds/);
  setApprovalNotifier(event => { if (event.type === 'approval') resolveApproval(event.request.id, false); });
  try { const r = await executeTool('network_capture', { interface: 'eth0' }, {}); assert.equal(r.held, true); }
  finally { setApprovalNotifier(null); }
});

test('helpers receive OS environment only, timeouts kill processes and arguments are not shell code', async () => {
  assert.deepEqual(networkEnv({ PATH: '/usr/bin', HNL_CHAT_KEY: 'fixture', OPENAI_API_KEY: 'fixture', NODE_OPTIONS: 'evil' }), { PATH: '/usr/bin', LC_ALL: 'C', LANG: 'C' });
  const result = await runNetworkProcess(process.execPath, ['-e', 'console.log(process.argv[1])', '$(do-not-run);hi']);
  assert.match(result.stdout, /\$\(do-not-run\);hi/);
  const timed = await runNetworkProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 });
  assert.equal(timed.error, 'Helper timed out');
});

test('import rejects fake captures and paths, persists private files without original path', async () => {
  const s = setup();
  try {
    await assert.rejects(s.core.call('network_import', { path: 'relative.pcap' }), /absolute/);
    const bad = join(s.dir, 'fake.pcap'); writeFileSync(bad, 'not a capture at all');
    await assert.rejects(s.core.call('network_import', { path: bad }), /recognized/);
    assert.equal(existsSync(s.core.home) ? readdirSync(s.core.home).length : 0, 0);
    const file = join(s.dir, 'fixture.pcap'); writeFileSync(file, syntheticCapture());
    const result = await s.core.call('network_import', { path: file });
    const saved = JSON.parse(readFileSync(join(s.core.home, `${result.capture_id}.json`)));
    assert.equal(saved.status, 'imported'); assert(!JSON.stringify(saved).includes(s.dir));
    if (process.platform !== 'win32') { assert.equal(statSync(s.core.home).mode & 0o777, 0o700); assert.equal(statSync(join(s.core.home, `${result.capture_id}.pcapng`)).mode & 0o777, 0o600); }
    await assert.rejects(s.core.call('network_analyze', { capture_id: '../../env' }), /Invalid/);
    saved.status = 'capturing'; s.core.save(saved);
    assert.equal(s.core.records()[0].status, 'interrupted');
  } finally { s.core.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('capture is bounded, allows one at a time, stops and preserves partial results', async () => {
  let argv, started = false;
  const s = setup({ find: n => n, interfaces: () => ({ eth0: [local] }), run: async (cmd, args, { signal }) => {
    if (args[0] === '-D') return { code: 0, stdout: '1. eth0 (Ethernet)\n' };
    argv = args; writeFileSync(args[args.indexOf('-w') + 1], syntheticCapture()); started = true;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { code: 0, stdout: '', error: 'Stopped' };
  } });
  // Avoid host-specific adapter enumeration in this subprocess fixture.
  s.core.interfaces = async () => ({ interfaces: [{ name: 'eth0', kind: 'wired', addresses: [local] }] });
  try {
    const pending = s.core.call('network_capture', { interface: 'eth0', seconds: 3, filter: 'udp port 43199' });
    await assert.rejects(s.core.call('network_capture', { interface: 'eth0' }), /already running/);
    for (let n = 0; !started && n < 30; n++) await delay(5);
    assert(started); assert.equal(s.core.stop().stopping, true);
    const result = await pending;
    assert.equal(result.status, 'stopped'); assert(result.bytes > 0);
    assert(argv.includes('duration:3')); assert(argv.includes('filesize:8192')); assert(argv.includes('128')); assert(argv.includes('-p'));
    assert.equal(s.core.active, null);
    await assert.rejects(s.core.call('network_capture', { interface: 'rpcap://remote' }), /exact local/);
  } finally { s.core.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('discovery only invokes Nmap host discovery for the checked scope', async () => {
  let argv;
  const s = setup({ find: n => n, run: async (_cmd, args) => {
    if (args[0] === '--iflist') return { code: 0, stdout: 'eth0 (eth0) 192.168.88.4/24 ethernet up 1500\n' };
    argv = args; return { code: 0, stdout: '<host><status state="up"/><address addr="192.168.88.1" addrtype="ipv4"/></host>' };
  } });
  s.core.interfaces = async () => ({ interfaces: [{ name: 'eth0', addresses: [local] }] });
  try {
    const result = await s.core.call('network_discover', { interface: 'eth0', cidr: '192.168.88.0/24' });
    assert.equal(result.hosts.length, 1); assert(argv.includes('-sn')); assert(argv.includes('-n')); assert(!argv.includes('-sV'));
    argv = null; await assert.rejects(s.core.call('network_discover', { interface: 'eth0', cidr: '192.168.89.0/24' })); assert.equal(argv, null);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('real stdio MCP exposes the suite and returns structured errors', async () => {
  const s = setup(), runtime = new NetworkRuntime({ home: s.core.home });
  try {
    const client = await runtime.connect();
    assert.equal((await client.listTools()).tools.length, networkPack().tools.length);
    const result = await runtime.call('network_capture', { interface: 'fixture', seconds: 999 });
    assert.equal(result.ok, false); assert.match(result.error, /1–60/);
    const stopped = await runtime.call('network_stop'); assert.equal(stopped.stopping, false);
    assert.equal(runtime.transport.pid > 0, true);
  } finally { await runtime.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('real TShark detects synthetic symptoms, pages metadata and excludes payload', { skip: !findNetworkProgram('tshark') }, async () => {
  const s = setup(), runtime = new NetworkRuntime({ home: s.core.home });
  try {
    const file = join(s.dir, 'fixture.pcap'); writeFileSync(file, syntheticCapture());
    const imported = await runtime.call('network_import', { path: file }); assert.equal(imported.ok, true);
    const report = await runtime.call('network_analyze', { capture_id: imported.capture_id });
    assert.equal(report.ok, true, JSON.stringify(report)); assert.equal(report.counts.packets, 6);
    for (const kind of ['arp_mapping_change', 'dns_errors', 'tcp_delivery', 'tcp_resets']) assert(report.findings.some(f => f.kind === kind), kind);
    assert.deepEqual(report.findings.find(f => f.kind === 'arp_mapping_change').addresses[0].reply_frames, [1, 2]);
    const all = await runtime.call('network_packets', { capture_id: imported.capture_id });
    assert.equal(all.packets[2].source.port, 53);
    assert.equal(all.packets[2].destination.port, 53000);
    assert.equal(all.packets[4].expert_level, 'note');
    assert.equal(all.packets[5].expert_level, 'warning');
    const page = await runtime.call('network_packets', { capture_id: imported.capture_id, limit: 1, filter: 'arp' });
    assert.equal(page.packets.length, 1); assert.equal(page.next_offset, 1);
    const page2 = await runtime.call('network_packets', { capture_id: imported.capture_id, limit: 1, offset: 1, filter: 'arp' });
    assert.equal(page2.next_offset, null); assert.notEqual(page.packets[0].arp_mac, page2.packets[0].arp_mac);
    const bad = await runtime.call('network_packets', { capture_id: imported.capture_id, filter: 'not a valid filter ???' }); assert.equal(bad.ok, false);
    assert(!JSON.stringify(report).includes('PRIVATE_PAYLOAD_MARKER')); assert(!JSON.stringify(page).includes('PRIVATE_PAYLOAD_MARKER'));
  } finally { await runtime.close(); rmSync(s.dir, { recursive: true, force: true }); }
});

test('live loopback capture and cancellation over MCP (explicit opt-in)', { skip: process.env.NOVA_NETWORK_LIVE !== '1' }, async () => {
  const s = setup(), runtime = new NetworkRuntime({ home: s.core.home }), socket = createSocket('udp4');
  let timer;
  try {
    const result = await runtime.call('network_interfaces');
    const loop = result.interfaces.find(i => i.kind === 'loopback'); assert(loop, 'No loopback capture interface');
    await new Promise(resolve => socket.bind(43199, '127.0.0.1', resolve));
    timer = setInterval(() => socket.send(Buffer.from('synthetic network smoke test'), 43199, '127.0.0.1'), 100);
    const capture = await runtime.call('network_capture', { interface: loop.name, seconds: 2, filter: 'udp port 43199' });
    assert.equal(capture.status, 'complete', JSON.stringify(capture));
    const report = await runtime.call('network_analyze', { capture_id: capture.capture_id }); assert(report.counts.packets > 0);
    const controller = new AbortController();
    const pending = runtime.call('network_capture', { interface: loop.name, seconds: 60, filter: 'udp port 43199' }, { signal: controller.signal });
    await delay(700); controller.abort(); await assert.rejects(pending);
    for (let n = 0; n < 30; n++) { const status = await runtime.call('network_status'); if (!status.active_capture) break; await delay(100); }
    const status = await runtime.call('network_status'); assert.equal(status.active_capture, null); assert(status.captures.some(c => c.status === 'stopped'));
    const workerPid = runtime.transport.pid;
    const shuttingDown = runtime.call('network_capture', { interface: loop.name, seconds: 60, filter: 'udp port 43199' }).catch(() => null);
    await delay(700); await runtime.close(); await shuttingDown;
    assert.throws(() => process.kill(workerPid, 0), /ESRCH|no such process/i);
    const library = new NetworkCore({ home: s.core.home });
    assert(library.records().filter(c => c.status === 'stopped').length >= 2, 'Shutdown flushed the second partial capture');
  } finally { clearInterval(timer); socket.close(); await runtime.close(); rmSync(s.dir, { recursive: true, force: true }); }
});
