import { denySecretPath } from "./safe.js";
import { expandPath, getWorkdir } from "./workdir.js";
import { quoteShell as q } from "./platform.js";
import { runBash } from "./files.js";
import { resolve4 } from "node:dns/promises";
import { connect } from "node:tls";

function tlsInfo(host, port = 443) {
  return new Promise((resolve) => {
    const socket = connect({ host, port, servername: host });
    const finish = (result) => { clearTimeout(timer); socket.destroy(); resolve(result); };
    const timer = setTimeout(() => finish({ ok: false, error: "TLS check timed out" }), 8000);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      finish({ ok: true, stdout: `${socket.getProtocol()} · ${cert.subject?.CN || host}\nIssuer: ${cert.issuer?.CN || "unknown"}\nValid: ${cert.valid_from} – ${cert.valid_to}` });
    });
    socket.once("error", (error) => finish({ ok: false, error: error.message }));
  });
}

async function networkReport(host) {
  const results = await Promise.allSettled([
    resolve4(host),
    fetch(`https://${host}`, { method: "HEAD", signal: AbortSignal.timeout(8000) }).then((res) => `HTTP ${res.status}`),
    tlsInfo(host),
  ]);
  const stdout = results.map((result, i) => `${["DNS", "HTTP", "TLS"][i]}: ${result.status === "rejected" ? result.reason.message : typeof result.value === "object" && !Array.isArray(result.value) ? result.value.stdout || result.value.error : String(result.value)}`).join("\n");
  return { ok: results.every((result) => result.status === "fulfilled" && result.value?.ok !== false), stdout };
}

// Native PowerShell implementations of the host and basic network packs.
// Values are literal strings, never interpolated as PowerShell code.
export function runWindowsPack(name, args = {}) {
  const count = (value, fallback) => Math.max(1, Math.min(200, Math.trunc(Number(value) || fallback)));
  let script;
  if (["docker_ps", "docker_inspect", "docker_logs", "docker_stats", "docker_compose_ps", "docker_restart", "docker_exec"].includes(name)) {
    const commands = {
      docker_ps: "docker.exe ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Image}}'",
      docker_inspect: `docker.exe inspect ${q(args.name || "")}`,
      docker_logs: `docker.exe logs --tail ${count(args.lines, 80)} ${q(args.name || "")}`,
      docker_stats: `docker.exe stats --no-stream ${args.name ? q(args.name) : ""}`,
      docker_compose_ps: "docker.exe compose ps",
      docker_restart: `docker.exe restart ${q(args.name || "")}`,
      docker_exec: `docker.exe exec ${q(args.name || "")} sh -lc ${q(args.command || "")}`,
    };
    return runBash(`if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Docker CLI is not installed.' }; ${commands[name]}`, name === "docker_compose_ps" ? args.dir : undefined);
  }
  switch (name) {
    case "whois_lookup":
      script = `if (-not (Get-Command whois.exe -ErrorAction SilentlyContinue)) { throw 'whois.exe is not installed. Use net_report for DNS, HTTP and TLS details.' }; whois.exe ${q(args.query)} | Select-Object -First 80`; break;
    case "net_report": return networkReport(String(args.host || "").replace(/[^a-zA-Z0-9.-]/g, ""));
    case "tls_inspect": return tlsInfo(String(args.host || ""), Number(args.port) || 443);
    case "host_list":
      script = `'local this-system'; if (Test-Path "$HOME/.ssh/config") { Get-Content "$HOME/.ssh/config" | Select-String '^Host ' | Select-Object -First 40 }`; break;
    case "host_facts":
      script = `Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture; Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | Format-List; Get-CimInstance Win32_ComputerSystem | Select-Object Name,TotalPhysicalMemory | Format-List; Get-CimInstance Win32_VideoController | Select-Object Name | Format-Table; Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace | Format-Table`; break;
    case "host_processes":
      script = `Get-Process | Sort-Object CPU -Descending | Select-Object -First ${count(args.limit, 15)} Id,ProcessName,CPU,WorkingSet64 | Format-Table`; break;
    case "host_service_status":
      script = `Get-Service -Name ${q(args.name)} | Format-List Name,DisplayName,Status,StartType`; break;
    case "host_tail_log": {
      const full = expandPath(args.path, getWorkdir());
      const blocked = denySecretPath(full);
      if (blocked) return Promise.resolve({ ok: false, error: blocked });
      script = `Get-Content -LiteralPath ${q(full)} -Tail ${count(args.lines, 80)}`; break;
    }
    case "host_disk":
      script = `Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName,Size,FreeSpace | Format-Table`; break;
    case "host_listen_ports":
      script = `Get-NetTCPConnection -State Listen | Select-Object -First 200 LocalAddress,LocalPort,OwningProcess | Format-Table`; break;
    case "host_tunnels":
      script = `Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object { $_.CommandLine -match ' -[LRD]' } | ForEach-Object { 'live ' + $_.ProcessId + ' ' + $_.CommandLine }; if (Test-Path "$HOME/.ssh/config") { $hostLine=''; Get-Content "$HOME/.ssh/config" | ForEach-Object { if ($_ -match '^Host\\s') { $hostLine=$_ }; if ($_ -match '^\\s*(LocalForward|RemoteForward|DynamicForward|ProxyJump)\\s') { 'config ' + $hostLine + ' | ' + $_.Trim() } } }`; break;
    case "dns_lookup":
      script = `Resolve-DnsName -Name ${q(args.name)} -Type ${q(args.type || "A")} | Format-Table`; break;
    case "http_check":
      script = `curl.exe -sSI -m 12 -o NUL -w '%{http_code} %{url_effective} time=%{time_total}' -- ${q(/^https?:\/\//i.test(args.url || "") ? args.url : `https://${args.url}`)}`; break;
    case "tcp_check":
      script = `$c=New-Object Net.Sockets.TcpClient; try { $t=$c.ConnectAsync(${q(args.host)}, ${Number(args.port) || 443}); if ($t.Wait(3000) -and $c.Connected) { 'open' } else { 'closed' } } catch { 'closed' } finally { $c.Dispose() }`; break;
    case "ping_check":
      script = `ping.exe -n 3 -w 2000 ${q(args.host)}`; break;
    case "trace_path":
      script = `tracert.exe -d -h 12 -w 2000 ${q(args.host)}`; break;
    default: return null;
  }
  return runBash(script);
}
