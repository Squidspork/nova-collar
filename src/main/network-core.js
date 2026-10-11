import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, lstatSync, realpathSync, chmodSync, renameSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { denySecretPath } from './safe.js';
import { NETWORK_COVERAGE, NETWORK_PRIVACY, validateNetworkArgs } from './network-tools.js';

const MAX_BYTES = 32 * 1024 * 1024;
const ID = /^[a-f0-9-]{36}$/;
export const PACKET_FIELDS = ['frame.number', 'frame.time_relative', 'frame.len', 'frame.cap_len', '_ws.col.Protocol',
  'ip.src', 'ip.dst', 'ipv6.src', 'ipv6.dst', 'eth.src', 'eth.dst', 'tcp.srcport', 'tcp.dstport', 'udp.srcport', 'udp.dstport',
  'tcp.analysis.retransmission', 'tcp.analysis.lost_segment', 'tcp.flags.reset', 'dns.flags.response', 'dns.flags.rcode',
  'arp.opcode', 'arp.src.proto_ipv4', 'arp.src.hw_mac', '_ws.expert.severity'];
const PACKET_KEYS = ['frame', 'seconds', 'bytes', 'captured_bytes', 'protocol', 'ipv4_src', 'ipv4_dst', 'ipv6_src', 'ipv6_dst',
  'mac_src', 'mac_dst', 'tcp_srcport', 'tcp_dstport', 'udp_srcport', 'udp_dstport', 'retransmission', 'lost_segment', 'tcp_reset',
  'dns_response', 'dns_rcode', 'arp_opcode', 'arp_ip', 'arp_mac', 'expert_severity'];

// Pass only operating-system configuration to helpers, never model/API credentials.
export function networkEnv(env = process.env) {
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA',
    'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'];
  return Object.fromEntries([...allowed.filter(k => env[k]).map(k => [k, env[k]]), ['LC_ALL', 'C'], ['LANG', 'C']]);
}

export function findNetworkProgram(name, platform = process.platform, env = process.env) {
  const candidates = [];
  const exe = platform === 'win32' ? `${name}.exe` : name;
  if (platform === 'darwin' && name !== 'nmap') candidates.push(`/Applications/Wireshark.app/Contents/MacOS/${name}`);
  if (platform === 'win32') for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) candidates.push(join(root, name === 'nmap' ? 'Nmap' : 'Wireshark', exe));
  for (const dir of (env.PATH || '').split(delimiter).filter(p => isAbsolute(p))) candidates.push(join(dir, exe));
  if (platform !== 'win32') for (const dir of ['/usr/bin', '/usr/sbin', '/usr/local/bin', '/opt/homebrew/bin']) candidates.push(join(dir, exe));
  return candidates.find(path => { try { accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK); return statSync(path).isFile(); } catch { return false; } }) || '';
}

export function runNetworkProcess(command, args, { signal, timeout = 20000, maxOutput = 12 * 1024 * 1024, onSpawn, env = networkEnv() } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Stopped'));
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    onSpawn?.(child);
    let out = '', err = '', bytes = 0, failure = '', killTimer;
    const stop = reason => {
      if (failure) return;
      failure = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1500);
    };
    const abort = () => stop('Stopped');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Helper timed out'), timeout);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxOutput) stop('Helper output exceeded its limit'); else out += chunk.toString(); });
    child.stderr.on('data', chunk => { if (err.length < 8192) err += chunk.toString().slice(0, 8192 - err.length); });
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => { cleanup(); resolve({ code, stdout: out, stderr: err, error: failure }); });
  });
}

function ipv4(value) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) throw new Error('Expected an IPv4 address');
  const octets = value.split('.').map(Number);
  if (octets.some(n => n > 255)) throw new Error('Invalid IPv4 address');
  return octets.reduce((n, octet) => n * 256 + octet, 0) >>> 0;
}
const address = n => [24, 16, 8, 0].map(bits => (n >>> bits) & 255).join('.');
function range(cidr) {
  const parts = String(cidr).split('/');
  if (parts.length !== 2 || !/^\d{1,2}$/.test(parts[1])) throw new Error('Expected an IPv4 CIDR');
  const prefix = Number(parts[1]);
  if (prefix < 1 || prefix > 32) throw new Error('Invalid IPv4 prefix');
  const start = (ipv4(parts[0]) & (0xffffffff << (32 - prefix))) >>> 0;
  return { start, end: start + 2 ** (32 - prefix) - 1, prefix, cidr: `${address(start)}/${prefix}` };
}
function privateAddress(n) {
  return n >>> 24 === 10 || n >>> 20 === 0xac1 || n >>> 16 === 0xc0a8 || n >>> 16 === 0xa9fe;
}
export function discoveryScope(row) {
  try {
    if (row.internal || (row.family !== 'IPv4' && row.family !== 4) || !privateAddress(ipv4(row.address))) return null;
    const subnet = range(row.cidr);
    return range(`${row.address}/${Math.max(24, subnet.prefix)}`).cidr;
  } catch { return null; }
}
export function checkDiscoveryScope(cidr, addresses) {
  const target = range(cidr);
  if (target.prefix < 24 || !privateAddress(target.start) || !privateAddress(target.end)) throw new Error('Discovery is limited to a private, directly connected scope of at most 256 addresses');
  const contained = addresses.some(row => {
    if (!discoveryScope(row)) return false;
    const local = range(row.cidr);
    return target.start >= local.start && target.end <= local.end;
  });
  if (!contained) throw new Error('Discovery scope is not on the selected local interface');
  return target.cidr;
}

export function parseCaptureInterfaces(raw, osRows = networkInterfaces(), aliases = {}) {
  return String(raw).split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\d+\. (\S+)(?: \((.*)\))?$/);
    if (!match) return [];
    const name = match[1], label = match[2] || name;
    const osName = aliases[name.toLowerCase()] || name;
    const addresses = osRows[osName];
    // dumpcap also lists extcaps; only interfaces confirmed by the OS are eligible.
    if (!addresses || /^(?:rpcap:|TCP@|UDP@)/i.test(name)) return [];
    let kind = /wi-?fi|wireless|^wl/i.test(label) ? 'wireless' : /loopback|^lo\d?$/i.test(label) ? 'loopback' :
      /ethernet|^eth\d|^enp\d|^eno\d|^ens\d/i.test(label) ? 'wired' : 'unknown';
    if (process.platform === 'linux' && existsSync(`/sys/class/net/${osName}/wireless`)) kind = 'wireless';
    return [{ name, label, kind, addresses: addresses.map(({ address, family, cidr, internal }) => ({ address, family, cidr, internal })),
      discovery_cidrs: [...new Set(addresses.map(discoveryScope).filter(Boolean))] }];
  });
}

export function parsePacketRows(text) {
  return text.trimEnd().split('\n').filter(Boolean).map(line => {
    const cols = line.replace(/\r$/, '').split('\t');
    const packet = Object.fromEntries(PACKET_KEYS.map((key, i) => [key, (key === 'expert_severity' ? cols[i] || '' : (cols[i] || '').split(',')[0]).slice(0, 256)]));
    const endpoint = side => ({ address: packet[`ipv4_${side}`] || packet[`ipv6_${side}`] || packet[`mac_${side}`] || null,
      port: Number(packet[`tcp_${side}port`] || packet[`udp_${side}port`]) || null });
    const severity = Math.max(0, ...packet.expert_severity.split(',').map(Number));
    return { ...packet, source: endpoint('src'), destination: endpoint('dst'),
      expert_level: ({ 8388608: 'error', 6291456: 'warning', 4194304: 'note', 2097152: 'chat', 1048576: 'comment' })[severity] || 'none' };
  });
}
export function summarizePackets(rows) {
  const flag = value => /^(?:1|true)$/i.test(value);
  const counts = { packets: rows.length, bytes: 0, truncated: 0, retransmissions: 0, missing_segments: 0, resets: 0, dns_responses: 0, dns_errors: 0, expert_warnings: 0 };
  const protocols = new Map(), conversations = new Map(), mappings = new Map(), changed = new Map();
  for (const p of rows) {
    counts.bytes += Number(p.bytes) || 0;
    if (Number(p.captured_bytes) < Number(p.bytes)) counts.truncated++;
    protocols.set(p.protocol || 'unknown', (protocols.get(p.protocol || 'unknown') || 0) + 1);
    const src = p.ipv4_src || p.ipv6_src || p.mac_src, dst = p.ipv4_dst || p.ipv6_dst || p.mac_dst;
    const key = JSON.stringify([src, dst, p.protocol]);
    conversations.set(key, (conversations.get(key) || 0) + 1);
    if (flag(p.retransmission)) counts.retransmissions++;
    if (flag(p.lost_segment)) counts.missing_segments++;
    if (flag(p.tcp_reset)) counts.resets++;
    if (flag(p.dns_response)) { counts.dns_responses++; if (Number(p.dns_rcode) > 0) counts.dns_errors++; }
    if ((p.expert_severity || '').split(',').some(value => Number(value) >= 6291456)) counts.expert_warnings++;
    if (p.arp_opcode === '2' && p.arp_ip && p.arp_ip !== '0.0.0.0' && p.arp_mac) {
      if (!mappings.has(p.arp_ip)) mappings.set(p.arp_ip, new Set());
      mappings.get(p.arp_ip).add(p.arp_mac);
      if (mappings.get(p.arp_ip).size > 1) changed.set(p.arp_ip, [...mappings.get(p.arp_ip)]);
    }
  }
  const findings = [];
  if (counts.retransmissions || counts.missing_segments) findings.push({ kind: 'tcp_delivery', evidence: { retransmissions: counts.retransmissions, missing_segments: counts.missing_segments }, interpretation: 'Possible loss, congestion, or capture gaps; not evidence of an attack by itself.' });
  if (counts.resets) findings.push({ kind: 'tcp_resets', count: counts.resets, interpretation: 'Connections were reset. Normal connection rejection and application behavior can cause this.' });
  if (counts.dns_errors) findings.push({ kind: 'dns_errors', count: counts.dns_errors, responses: counts.dns_responses, interpretation: 'DNS returned nonzero response codes. Failed names are common; investigate repeated failures against a baseline.' });
  if (changed.size) findings.push({ kind: 'arp_mapping_change', addresses: [...changed].slice(0, 30).map(([ip, macs]) => ({ ip, macs,
    reply_frames: rows.filter(p => p.arp_opcode === '2' && p.arp_ip === ip).slice(0, 20).map(p => Number(p.frame)) })), interpretation: 'Separate ARP reply frames associate the same IP with different MAC addresses. Check DHCP, failover and duplicate addresses before considering spoofing.' });
  if (counts.expert_warnings) findings.push({ kind: 'wireshark_expert', count: counts.expert_warnings, interpretation: 'TShark marked warning/error packets. Inspect matching frames in Wireshark; this is a diagnostic flag, not a verdict.' });
  const top = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 20);
  return { counts, protocols: top(protocols).map(([protocol, packets]) => ({ protocol, packets })),
    conversations: top(conversations).map(([key, packets]) => { const [source, destination, protocol] = JSON.parse(key); return { source, destination, protocol, packets }; }),
    findings, conclusion: findings.length ? 'Diagnostic symptoms observed; causes require investigation.' : 'No selected diagnostic symptoms found in the observed packets. This is not a security clearance.' };
}

export class NetworkCore {
  constructor({ home = join(homedir(), '.novapup', 'network'), run = runNetworkProcess, find = findNetworkProgram, interfaces = networkInterfaces } = {}) {
    this.home = home; this.run = run; this.find = find; this.osInterfaces = interfaces; this.active = null; this.controllers = new Set();
  }
  store() {
    if (existsSync(this.home) && lstatSync(this.home).isSymbolicLink()) throw new Error('Capture directory must not be a symlink');
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    chmodSync(this.home, 0o700);
  }
  save(record) {
    this.store();
    const path = join(this.home, `${record.capture_id}.json`), temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600, flag: 'wx' }); renameSync(temp, path);
  }
  records() {
    if (!existsSync(this.home)) return [];
    return readdirSync(this.home).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).slice(-500).flatMap(n => {
      try {
        const r = JSON.parse(readFileSync(join(this.home, n), 'utf8'));
        if (!ID.test(r.capture_id)) return [];
        if (r.status === 'capturing' && this.active?.id !== r.capture_id) { r.status = 'interrupted'; this.save(r); }
        return [r];
      } catch { return []; }
    }).sort((a, b) => b.created.localeCompare(a.created));
  }
  record(id) {
    if (!ID.test(String(id))) throw new Error('Invalid capture_id');
    const record = this.records().find(r => r.capture_id === id);
    if (!record) throw new Error('Capture not found');
    if (record.status === 'capturing') throw new Error('Stop the capture before reading it');
    const path = join(this.home, `${id}.pcapng`);
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || statSync(path).size > MAX_BYTES + 65536) throw new Error('Invalid or oversized capture');
    return { record, path };
  }
  program(name) {
    const path = this.find(name);
    if (!path) throw new Error(`${name} is not installed. Install Wireshark/TShark and its capture helper; Nmap is optional for device discovery.`);
    return path;
  }
  async command(command, args, signal, options = {}) {
    const controller = new AbortController(); this.controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try { return await this.run(command, args, { ...options, signal: controller.signal }); }
    finally { this.controllers.delete(controller); signal?.removeEventListener('abort', abort); }
  }
  async status(signal) {
    const programs = {};
    for (const name of ['tshark', 'dumpcap', 'wireshark', 'nmap']) {
      const path = this.find(name);
      programs[name] = { installed: Boolean(path) };
      if (path && name !== 'wireshark') {
        const r = await this.command(path, ['--version'], signal, { timeout: 5000, maxOutput: 64000 });
        programs[name].version = (r.stdout || r.stderr).split('\n')[0].slice(0, 200);
        programs[name].working = r.code === 0 && !r.error;
      }
    }
    return { ok: true, programs, captures: this.records().slice(0, 50), active_capture: this.active?.id || null,
      capture_permissions: 'Not verified until a capture succeeds. Run Collar as your normal user; grant capture access to dumpcap/Npcap using the Wireshark installer or your OS package instructions.',
      coverage: NETWORK_COVERAGE, privacy: NETWORK_PRIVACY };
  }
  async interfaces(signal) {
    const result = await this.command(this.program('dumpcap'), ['-D'], signal);
    if (result.code || result.error) throw new Error(result.error || result.stderr || 'Cannot enumerate capture interfaces');
    const aliases = {};
    if (process.platform === 'win32') {
      const r = await this.command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetAdapter | Select-Object Name,InterfaceGuid | ConvertTo-Json -Compress'], signal);
      if (r.code || r.error) throw new Error('Cannot map Windows capture adapters');
      const adapters = JSON.parse(r.stdout || '[]');
      for (const row of Array.isArray(adapters) ? adapters : [adapters]) aliases[`\\device\\npf_{${String(row.InterfaceGuid).replace(/[{}]/g, '')}}`.toLowerCase()] = row.Name;
    }
    return { ok: true, interfaces: parseCaptureInterfaces(result.stdout, this.osInterfaces(), aliases), coverage: NETWORK_COVERAGE };
  }
  async interface(name, signal) {
    const row = (await this.interfaces(signal)).interfaces.find(r => r.name === name);
    if (!row) throw new Error('Choose an exact local OS interface from network_interfaces');
    return row;
  }
  async capture(args, signal) {
    if (this.active) throw new Error('A capture is already running; stop it first');
    // Reserve the slot before the first await so concurrent MCP requests cannot race.
    const controller = new AbortController(), id = randomUUID();
    this.active = { id, controller };
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    let record;
    try {
      const row = await this.interface(args.interface, controller.signal);
      this.store();
      record = { capture_id: id, created: new Date().toISOString(), status: 'capturing', interface: row.name, kind: row.kind,
        limits: { seconds: args.seconds, packets: args.max_packets, mib: args.max_mib, snaplen: 128 }, filter: args.filter || null };
      this.save(record);
      const path = join(this.home, `${id}.pcapng`);
      writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
      const argv = ['-i', row.name, '-p', '-s', '128', '-a', `duration:${args.seconds}`, '-a', `filesize:${args.max_mib * 1024}`,
        '-c', String(args.max_packets), '-w', path];
      if (args.filter) argv.push('-f', args.filter);
      const result = await this.command(this.program('dumpcap'), argv, controller.signal, { timeout: (args.seconds + 5) * 1000 });
      chmodSync(path, 0o600);
      record.status = result.error === 'Stopped' ? 'stopped' : result.code === 0 && !result.error ? 'complete' : 'failed';
      record.bytes = statSync(path).size;
      record.finished = new Date().toISOString();
      if (record.status === 'failed') record.error = result.error || result.stderr.slice(0, 1500);
      this.save(record);
      return { ok: record.status !== 'failed', ...record, coverage: NETWORK_COVERAGE, privacy: NETWORK_PRIVACY };
    } catch (error) {
      if (record) { record.status = 'failed'; record.error = error.message; this.save(record); }
      throw error;
    } finally { this.active = null; signal?.removeEventListener('abort', abort); }
  }
  async import(path) {
    if (!isAbsolute(path) || !['.pcap', '.pcapng'].includes(extname(path).toLowerCase())) throw new Error('Choose an absolute .pcap or .pcapng file');
    const resolved = realpathSync(path);
    if (denySecretPath(path) || denySecretPath(resolved)) throw new Error('Private configuration paths cannot be imported');
    // Open once and bound every read, including if a file changes during import.
    const fd = openSync(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    let bytes;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_BYTES || st.size < 12) throw new Error('Capture must be a regular file between 12 bytes and 32 MiB');
      bytes = Buffer.alloc(st.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, null);
        if (!count) throw new Error('Capture changed while importing');
        offset += count;
      }
      if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error('Capture grew while importing');
      const magic = bytes.subarray(0, 4).toString('hex');
      if (!['0a0d0d0a', 'd4c3b2a1', 'a1b2c3d4', '4d3cb2a1', 'a1b23c4d'].includes(magic)) throw new Error('Not a recognized pcap/pcapng capture');
    } finally { closeSync(fd); }
    this.store(); const id = randomUUID(), dest = join(this.home, `${id}.pcapng`);
    writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
    const record = { capture_id: id, created: new Date().toISOString(), status: 'imported', bytes: bytes.length, kind: 'imported', coverage: 'Imported capture: interface, vantage point, filters and duration may be unknown.' };
    this.save(record); return { ok: true, ...record, privacy: NETWORK_PRIVACY };
  }
  async packets(id, filter, signal) {
    const { path, record } = this.record(id);
    const args = ['-n', '-r', path, '-c', '20000', '-T', 'fields', '-E', 'separator=/t', '-E', 'occurrence=a', '-E', 'quote=n'];
    if (filter) args.push('-Y', filter);
    for (const field of PACKET_FIELDS) args.push('-e', field);
    const result = await this.command(this.program('tshark'), args, signal, { timeout: 30000 });
    if (result.code || result.error) throw new Error(result.error || result.stderr || 'TShark could not read this capture');
    return { rows: parsePacketRows(result.stdout), record };
  }
  async discover(args, signal) {
    const row = await this.interface(args.interface, signal);
    const cidr = checkDiscoveryScope(args.cidr, row.addresses);
    const nmap = this.program('nmap');
    let device = row.name;
    if (process.platform === 'win32') {
      const listed = await this.command(nmap, ['--iflist'], signal);
      const localAddresses = new Set(row.addresses.map(a => a.address));
      const candidates = listed.stdout.split(/\r?\n/).map(line => line.match(/^(\S+)\s+\(\S+\)\s+(\d+\.\d+\.\d+\.\d+)\//)).filter(m => m && localAddresses.has(m[2]));
      if (listed.code || listed.error || candidates.length !== 1) throw new Error('Cannot uniquely map the selected adapter to an Nmap interface');
      device = candidates[0][1];
    }
    const result = await this.command(nmap, ['-sn', '-n', '-e', device, '--max-retries', '1', '--host-timeout', '3s', '-oX', '-', cidr], signal, { timeout: 45000, maxOutput: 1024 * 1024 });
    if (result.code || result.error) throw new Error(result.error || result.stderr || 'Device discovery failed');
    const hosts = [...result.stdout.matchAll(/<host(?:\s[^>]*)?>[\s\S]*?<\/host>/g)].flatMap(([xml]) => {
      if (!/<status\s[^>]*state="up"/.test(xml)) return [];
      return [{ addresses: [...xml.matchAll(/<address\s[^>]*addr="([^"]+)"[^>]*addrtype="([^"]+)"/g)].map(m => ({ address: m[1], type: m[2] })) }];
    });
    return { ok: true, interface: row.name, cidr, hosts, coverage: 'Host discovery only; no ports scanned. Nonresponding or sleeping devices can be missed. Results do not establish device trust.' };
  }
  async neighbors(signal) {
    const command = process.platform === 'linux' ? 'ip' : 'arp';
    const args = process.platform === 'linux' ? ['-j', 'neigh', 'show'] : process.platform === 'win32' ? ['-a'] : ['-an'];
    const r = await this.command(command, args, signal, { maxOutput: 256000 });
    if (r.code || r.error) throw new Error(r.error || r.stderr || 'Neighbor cache is unavailable');
    return { ok: true, entries: r.stdout, coverage: 'Passive neighbor cache, possibly stale or incomplete; no probes were sent.' };
  }
  async open(id, signal) {
    const { path } = this.record(id);
    this.program('wireshark');
    if (process.platform === 'darwin') {
      const result = await this.command('/usr/bin/open', ['-a', '/Applications/Wireshark.app', path], signal);
      if (result.code || result.error) throw new Error(result.error || result.stderr || 'Could not open Wireshark');
    } else {
      await new Promise((resolve, reject) => {
        const child = spawn(this.program('wireshark'), ['-r', path], { stdio: 'ignore', env: networkEnv(), detached: true, shell: false });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
      });
    }
    return { ok: true, capture_id: id, opened: 'Wireshark' };
  }
  stop() { const id = this.active?.id || null; this.active?.controller.abort(); return { ok: true, capture_id: id, stopping: Boolean(id) }; }
  close() { this.stop(); for (const controller of this.controllers) controller.abort(); }
  async call(name, input, { signal } = {}) {
    const args = validateNetworkArgs(name, input);
    if (name === 'network_status') return this.status(signal);
    if (name === 'network_interfaces') return this.interfaces(signal);
    if (name === 'network_neighbors') return this.neighbors(signal);
    if (name === 'network_discover') return this.discover(args, signal);
    if (name === 'network_capture') return this.capture(args, signal);
    if (name === 'network_stop') return this.stop();
    if (name === 'network_import') return this.import(args.path);
    if (name === 'network_open') return this.open(args.capture_id, signal);
    const { rows, record } = await this.packets(args.capture_id, args.filter, signal);
    const coverage = [record.coverage || NETWORK_COVERAGE, 'Analysis reads at most the first 20,000 input packets. Live captures are truncated to 128 bytes per packet; dissector warnings can reflect truncation.'].join(' ');
    if (name === 'network_packets') return { ok: true, capture_id: args.capture_id, packets: rows.slice(args.offset, args.offset + args.limit), matching_rows_in_sample: rows.length, next_offset: args.offset + args.limit < rows.length ? args.offset + args.limit : null, coverage };
    const report = { ok: true, capture_id: args.capture_id, capture: record, ...summarizePackets(rows),
      observed_seconds: rows.length ? Math.max(0, Number(rows.at(-1).seconds) - Number(rows[0].seconds)) : 0, coverage, privacy: NETWORK_PRIVACY };
    const reportPath = join(this.home, `${args.capture_id}.report.json`), temp = `${reportPath}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' }); renameSync(temp, reportPath);
    return report;
  }
}
