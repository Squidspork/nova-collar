# Wireshark MCP suite

Nova Collar 0.4.0 adds a **Wireshark** pack backed by a local stdio MCP server.
It opens no listening port. Wireshark/TShark, dumpcap, and optional Nmap are
separately installed tools, not bundled in Collar.

Open **Settings → Wireshark → inspect wired network** to prepare a request, or
select the Wireshark pack and ask to inspect your local wired network. Nothing
starts until you submit a request. Collar checks the tools and interfaces, then
shows the exact capture or discovery action for approval. Select the actual wired
interface; an unlabelled adapter needs verification before treating it as Ethernet.

Each network tool call has its own expandable card with arguments and results.
**Check tools & captures** lists saved captures with **analyze** and **open in
Wireshark** actions. **Choose capture** drafts a request to import a local capture.
**Stop capture** interrupts capture and retains the partial file.

## Tools

| Tool | Purpose |
| --- | --- |
| `network_status` | Versions, availability and saved captures; starts no capture |
| `network_interfaces` | Local adapters, link hints, addresses and discovery scopes |
| `network_neighbors` | Existing ARP/neighbor cache; no probes |
| `network_discover` | Host discovery on one connected private IPv4 scope |
| `network_capture` | Bounded dumpcap capture on an exact local adapter |
| `network_stop` | Stop the capture and retain partial evidence |
| `network_import` | Import an exact local pcap/pcapng, at most 32 MiB |
| `network_analyze` | Counts, conversations and diagnostic findings |
| `network_packets` | Page through packet metadata with a display filter |
| `network_open` | Open a saved capture in the installed Wireshark GUI |

Capture, discovery, import and GUI launch use exact-action approval. Phone-role
tools cannot access this suite. Denied actions must not be retried through shell
tools. Shell approval is a separate capability; these controls are not an OS sandbox.

## Scope and findings

Live captures default to 15 seconds, 5,000 packets and 8 MiB. Maximums are 60
seconds, 20,000 packets and 32 MiB. They are non-promiscuous and retain only the
first 128 bytes of each packet. A final packet/block can exceed the file stop
threshold. One capture runs at a time. Stop, turn cancellation and normal app
shutdown stop owned helpers. Following an unexpected interruption, unfinished
captures are marked interrupted when the library is next read.

Discovery uses `nmap -sn -n`: host discovery with reverse DNS disabled, no port
scan, service fingerprinting, NSE scripts or exploitation. Its private/link-local
IPv4 scope must be directly connected and contain at most 256 addresses. Larger
subnets are offered as the local /24 segment; they are not fully inventoried.
IPv6 device discovery is not implemented; captured IPv6 traffic can be analyzed.
Probe types depend on OS permissions. Unprivileged Nmap can use TCP connection
probes, and silent devices can be missed.
[Nmap host discovery](https://nmap.org/book/man-host-discovery.html).

A switched Ethernet port usually exposes this host's traffic plus broadcasts or
multicasts. Traffic between other devices needs a switch mirror, TAP or router
capture. Encryption hides application content.
[Wireshark Ethernet capture guide](https://wiki.wireshark.org/CaptureSetup/Ethernet).

Analysis reads at most the first 20,000 input packets, also when filtering. It
looks for retransmissions, missing TCP segments, resets, DNS error responses,
ARP mapping changes and Wireshark expert warnings/errors. Truncation, capture gaps,
DHCP, failover and normal applications can explain these symptoms. Reports provide
observations and possible causes, not a declaration that a device is malicious or
the network is safe. This version has no continuous monitoring or learned baseline.

## Privacy

Captures and reports live under `~/.novapup/network` (the user's profile on
Windows). On POSIX the directory is mode 0700 and files mode 0600; Windows uses
the user profile's inherited permissions. Captures are retained until you remove
them and their matching JSON files. Never publish private captures or reports.

Even a 128-byte snapshot can contain private data. The suite does not return
payload bytes, DNS names, HTTP headers, TLS names or credentials. It returns frame,
protocol and timing metadata, IP/MAC addresses, ports and diagnostic flags.
Reports and metadata go to the selected model as tool context, which may be
remote. Paths and filters appear in the local conversation. Choose a local model
when this metadata should stay on the computer. Wireshark itself can display
whatever bytes the capture holds.

## Dependencies

Install [Wireshark](https://www.wireshark.org/download.html), including TShark and
its capture helper. macOS detects the standard `/Applications/Wireshark.app`
location; Linux uses distribution packages and PATH; Windows detects the default
Program Files locations and requires Npcap for live captures.
[Nmap](https://nmap.org/download.html) is optional for device discovery.

Use the Wireshark installer or your OS distribution's capture-group/dumpcap setup.
Keep Collar and TShark running as your normal user. The suite reports missing
programs and permission failures; it does not run sudo, change groups/capabilities,
or install drivers automatically.
[Wireshark capture privileges](https://wiki.wireshark.org/CaptureSetup/CapturePrivileges).
Keep the separately installed tools updated. Collar does not redistribute their
executables or change their licenses.

## Standalone MCP

After `npm ci`, configure another MCP client with absolute Node 22.12+ and source
paths (on Windows use equivalent escaped Windows paths):

```json
{
  "mcpServers": {
    "nova-wireshark": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/nova-collar/src/main/network-mcp.js"]
    }
  }
}
```

`NOVA_NETWORK_HOME` selects a separate private capture directory. The stdio server
enforces bounds, path checks and discovery scope. **The connecting client must
supply user authorization and its own confirmation UI**: Collar's approval dialog
belongs to the Collar client, not the standalone server. Capture-derived content
is untrusted data. Remote capture interfaces are not exposed.

## Tests

`npm test` covers routing, approval/role boundaries, imports, subprocess limits,
discovery scopes, concurrency, cancellation and real stdio MCP transport. When
TShark is installed, it also analyzes a generated synthetic capture with known
ARP/DNS/TCP symptoms and checks that a payload marker is absent from tool output.
Linux CI installs TShark for this offline test.

`NOVA_NETWORK_LIVE=1 node --test scripts/test-network.mjs` additionally captures
self-generated loopback UDP and tests MCP cancellation. It does not scan the LAN.
`npm run test:app` checks real Electron controls, MCP status, the capture picker,
and separate tool cards without a model server. Live discovery, capture privileges
and Wireshark GUI launch still need verification on each deployment host.
