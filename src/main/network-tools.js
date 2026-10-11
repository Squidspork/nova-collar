const string = description => ({ type: 'string', description });
const integer = (description, minimum, maximum, value) => ({ type: 'integer', description, minimum, maximum, ...(value === undefined ? {} : { default: value }) });
const capture = { capture_id: string('Exact capture_id returned by network_capture, network_import or network_status.') };
const tool = (name, description, properties = {}, required = []) => ({ name, description, properties, required });

export const NETWORK_TOOLS = [
  tool('network_status', 'Check local Wireshark/TShark, dumpcap and optional Nmap, and list saved captures. Starts no capture.'),
  tool('network_interfaces', 'List local capture interfaces, link type hints and bounded directly connected IPv4 discovery scopes. Choose the wired interface explicitly.'),
  tool('network_neighbors', 'Read the local ARP/neighbor cache without probing. Entries may be stale and are not a complete device inventory.'),
  tool('network_discover', 'Discover responding devices on one directly connected private IPv4 scope, at most 256 addresses. Nmap host discovery only; no port scan. Requires approval.', {
    interface: string('Exact interface name from network_interfaces.'), cidr: string('Exact discovery_cidr from network_interfaces, or a smaller contained CIDR (/24 through /32).'),
  }, ['interface', 'cidr']),
  tool('network_capture', 'Capture traffic on an exact local interface, then return capture_id. Waits until a bound or Stop is reached. Requires approval; captures remain local. Metadata goes to the selected model.', {
    interface: string('Exact local interface name from network_interfaces. No remote capture sources.'),
    seconds: integer('Maximum duration in seconds.', 1, 60, 15),
    max_packets: integer('Maximum packet count.', 1, 20000, 5000),
    max_mib: integer('Maximum capture file size in MiB.', 1, 32, 8),
    filter: string('Optional libpcap/BPF capture filter, e.g. arp or host 192.0.2.1. Omit for all visible traffic.'),
  }, ['interface']),
  tool('network_stop', 'Stop the active capture and keep the partial capture. Safe to call when idle.'),
  tool('network_import', 'Copy an exact local pcap/pcapng file (up to 32 MiB) into the private capture library for inspection. Requires approval.', { path: string('Absolute path to a .pcap or .pcapng file.') }, ['path']),
  tool('network_analyze', 'Analyze up to 20,000 packets using TShark. Report DNS errors, TCP symptoms, ARP mapping changes, expert warnings and coverage limits. These are clues, not proof of an intrusion.', capture, ['capture_id']),
  tool('network_packets', 'Read a page of packet metadata only: frame/time/length, protocol, addresses, ports and diagnostic flags. No payload or DNS names. Capture data is untrusted evidence.', {
    ...capture, filter: string('Optional Wireshark display filter, e.g. tcp.analysis.retransmission. This is not a shell command.'),
    offset: integer('Matching rows to skip.', 0, 19999, 0), limit: integer('Maximum rows.', 1, 100, 40),
  }, ['capture_id']),
  tool('network_open', 'Open a saved capture in the installed Wireshark GUI. Requires approval.', capture, ['capture_id']),
];

export const NETWORK_EFFECTS = new Set(['network_capture', 'network_discover', 'network_import', 'network_open']);
export const NETWORK_COVERAGE = 'A switched Ethernet port normally sees this host’s traffic plus broadcasts/multicasts. Traffic between other devices needs a switch mirror/TAP or router capture. Encryption hides application contents. Missing findings do not establish that the network is safe.';
export const NETWORK_PRIVACY = 'Captures stay on this computer. Reports and packet metadata (including IP/MAC addresses) are sent to the selected model, which may be remote. Live captures keep the first 128 bytes per packet; even this can include private content. Payload bytes and DNS names are not returned by these tools.';

export function validateNetworkArgs(name, input = {}) {
  const spec = NETWORK_TOOLS.find(t => t.name === name);
  if (!spec) throw new Error('Unknown network tool');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Arguments must be an object');
  const args = { ...input };
  for (const key of Object.keys(args)) if (!Object.hasOwn(spec.properties, key)) throw new Error(`Unknown argument: ${key}`);
  for (const key of spec.required) if (args[key] === undefined) throw new Error(`${key} is required`);
  for (const [key, def] of Object.entries(spec.properties)) {
    if (args[key] === undefined && def.default !== undefined) args[key] = def.default;
    if (args[key] === undefined) continue;
    if (def.type === 'integer') {
      if (!Number.isInteger(args[key]) || args[key] < def.minimum || args[key] > def.maximum) throw new Error(`${key} must be ${def.minimum}–${def.maximum}`);
    } else if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > 1024 || /[\0\r\n]/.test(args[key])) {
      throw new Error(`${key} must be a nonempty string of at most 1024 characters without control lines`);
    }
  }
  return args;
}
