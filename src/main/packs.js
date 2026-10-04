import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME } from "./config.js";
import { runBash } from "./files.js";
import { factAsk } from "./ground.js";
import { denySecretPath, redactSecrets } from "./safe.js";
import { summarizeTunnels } from "./goal.js";
import { expandPath, getWorkdir } from "./workdir.js";

function incidentDir() {
  const dir = join(APP_HOME, "incidents");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function incidentPath(id) {
  return join(incidentDir(), `${String(id).replace(/[^\w.-]/g, "_")}.json`);
}

function loadIncident(id) {
  const path = incidentPath(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveIncident(doc) {
  writeFileSync(incidentPath(doc.id), JSON.stringify(doc, null, 2));
  return doc;
}

function tool(name, description, properties = {}, required = []) {
  return { name, description, properties, required };
}

export const PACKS = [
  {
    id: "term",
    title: "term",
    blurb: "Shell on the computer running Nova Collar",
    tools: [
      tool("term_read", "Read the live terminal in this window (what the user typed and saw)."),
      tool("term_send", "Type into the live terminal in this window.", { text: { type: "string" }, enter: { type: "boolean" } }, ["text"]),
    ],
  },
  {
    id: "host",
    title: "host",
    blurb: "Files, disk, and ports on the computer running Nova Collar",
    tools: [
      tool("host_list", "List this system and SSH Host aliases from ~/.ssh/config."),
      tool("host_tunnels", "SSH tunnels on this computer: live ssh -L/-R/-D, config forwards, and ports ssh is listening on. Not a website check."),
      tool("host_facts", "Facts for this system: OS, CPU, memory, disk."),
      tool("host_processes", "Top processes on this system.", { limit: { type: "integer" } }),
      tool("host_service_status", "Status of a service. macOS uses launchd or Homebrew. Linux uses systemd.", { name: { type: "string" } }, ["name"]),
      tool("host_tail_log", "Tail a log file.", { path: { type: "string" }, lines: { type: "integer" } }, ["path"]),
      tool("host_disk", "Disk usage on this system. Fast — does not scan the whole home folder."),
      tool("host_listen_ports", "Listening TCP/UDP ports on this system."),
      tool("host_run_plan", "Propose a shell command. Does not run it.", { command: { type: "string" }, why: { type: "string" } }, ["command"]),
      tool("host_run", "Run a command on this system.", { command: { type: "string" } }, ["command"]),
      tool("host_file_read", "Read a local file.", { path: { type: "string" } }, ["path"]),
      tool("host_file_write_plan", "Propose a file write. Does not write.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      tool("host_file_write", "Write a local file.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    ],
  },
  {
    id: "net",
    title: "net",
    blurb: "DNS, HTTP, TLS, ping, traceroute, whois",
    tools: [
      tool("dns_lookup", "DNS lookup.", { name: { type: "string" }, type: { type: "string" } }, ["name"]),
      tool("http_check", "HTTP HEAD/GET status.", { url: { type: "string" } }, ["url"]),
      tool("tls_inspect", "TLS cert inspect.", { host: { type: "string" }, port: { type: "integer" } }, ["host"]),
      tool("tcp_check", "TCP connect check.", { host: { type: "string" }, port: { type: "integer" } }, ["host", "port"]),
      tool("ping_check", "Ping a host.", { host: { type: "string" } }, ["host"]),
      tool("trace_path", "Traceroute.", { host: { type: "string" } }, ["host"]),
      tool("whois_lookup", "WHOIS lookup.", { query: { type: "string" } }, ["query"]),
      tool("net_report", "Short net report: DNS + HTTP + TLS.", { host: { type: "string" } }, ["host"]),
    ],
  },
  {
    id: "docker",
    title: "docker",
    blurb: "Containers on this system (clean miss if Docker is not here)",
    tools: [
      tool("docker_ps", "Docker containers."),
      tool("docker_inspect", "Inspect a container.", { name: { type: "string" } }, ["name"]),
      tool("docker_logs", "Container logs.", { name: { type: "string" }, lines: { type: "integer" } }, ["name"]),
      tool("docker_stats", "Container stats snapshot.", { name: { type: "string" } }),
      tool("docker_compose_ps", "Compose services.", { dir: { type: "string" } }),
      tool("docker_restart_plan", "Propose a container restart. Does not restart.", { name: { type: "string" } }, ["name"]),
      tool("docker_restart", "Restart a container.", { name: { type: "string" } }, ["name"]),
      tool("docker_exec", "Exec in a container.", { name: { type: "string" }, command: { type: "string" } }, ["name", "command"]),
    ],
  },
  {
    id: "incident",
    title: "incident",
    blurb: "Open, gather, hypothesize, page, close",
    tools: [
      tool("incident_open", "Open an incident.", { title: { type: "string" }, summary: { type: "string" } }, ["title"]),
      tool("incident_note", "Add a note to an incident.", { id: { type: "string" }, note: { type: "string" } }, ["id", "note"]),
      tool("incident_gather", "List incidents or read one.", { id: { type: "string" } }),
      tool("incident_hypotheses", "Record hypotheses.", { id: { type: "string" }, hypotheses: { type: "string" } }, ["id", "hypotheses"]),
      tool("incident_runbook_get", "Read incident runbook notes.", { id: { type: "string" } }, ["id"]),
      tool("incident_checklist", "Set a checklist item.", { id: { type: "string" }, item: { type: "string" }, done: { type: "boolean" } }, ["id", "item"]),
      tool("incident_page", "Mark an incident as paged / needs a human.", { id: { type: "string" }, message: { type: "string" } }, ["id"]),
      tool("incident_close", "Close an incident.", { id: { type: "string" }, resolution: { type: "string" } }, ["id"]),
    ],
  },
];

const PACK_BY_TOOL = Object.fromEntries(
  PACKS.flatMap((pack) => pack.tools.map((row) => [row.name, pack.id])),
);

export function packPublic() {
  return PACKS.map(({ id, title, blurb }) => ({ id, title, blurb }));
}

export function packFor(name) {
  return PACK_BY_TOOL[name] || "";
}

export function packToolNames(id) {
  const pack = PACKS.find((row) => row.id === id);
  return new Set((pack?.tools || []).map((row) => row.name));
}

export function inferPack(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(docker|container|compose)\b/.test(t)) return "docker";
  if (/\b(incident|outage|sev[1-4]|on-call)\b/.test(t)) return "incident";
  if (/\b(dns|tls|cert|ping|traceroute|whois|http[s]? status)\b/.test(t)) return "net";
  if (/\b(screenshot|click|front app|this screen)\b/.test(t)) return "desk";
  if (/\b(hnl computer|remote workspace|remote computer)\b/.test(t)) return "computer";
  if (factAsk(text) || /\b(search the web|look up|honcho|docs search)\b/.test(t)) return "hnl";
  if (/\b(this window'?s (shell|term)|in the terminal|type in (the )?term)\b/.test(t)) return "term";
  if (/\b(disk|cpu|ram|process(?:es)?|listen(?:ing)? ports|this mac|this system)\b/.test(t)) return "host";
  return "";
}

export function isPackTool(name) {
  return Boolean(PACK_BY_TOOL[name]);
}

export const LOCAL_PACK_TOOLS = new Set([
  "term_read",
  "term_send",
  "host_facts",
  "host_disk",
  "host_processes",
  "host_listen_ports",
  "host_tunnels",
  "host_run",
  "say_plain",
  "host_file_read",
  "host_file_write",
  "net_report",
  "docker_ps",
  "incident_open",
  "incident_note",
  "incident_gather",
  "incident_close",
]);

function leanProps(properties = {}) {
  return Object.fromEntries(
    Object.entries(properties).map(([key, spec]) => [key, { type: spec.type }]),
  );
}

export function packToolDefs(fn, { lean = false } = {}) {
  return PACKS.flatMap((pack) =>
    pack.tools
      .filter((row) => !lean || LOCAL_PACK_TOOLS.has(row.name))
      .map((row) =>
        fn(
          row.name,
          lean ? `${pack.title}: ${row.description}` : `${pack.title} pack: ${row.description}`,
          lean ? leanProps(row.properties) : row.properties,
          row.required,
        ),
      ),
  );
}

function safeHost(raw) {
  return String(raw || "").trim().replace(/[^a-zA-Z0-9.-]/g, "");
}

function safeService(raw) {
  return String(raw || "").replace(/[^A-Za-z0-9.@_-]/g, "");
}

function hostFactsScript() {
  return `uname -a; echo '---'
if [ "$(uname -s)" = Darwin ]; then
  sw_vers
  echo '---'
  sysctl -n machdep.cpu.brand_string
  echo cores=$(sysctl -n hw.ncpu)
  echo mem_gb=$(($(sysctl -n hw.memsize)/1024/1024/1024))
  echo '---'
  df -h / /System/Volumes/Data 2>/dev/null | head -8
else
  if [ -r /etc/os-release ]; then . /etc/os-release; echo "$PRETTY_NAME"; else uname -s; fi
  echo '---'
  if [ -r /proc/cpuinfo ]; then awk -F: '/model name/ {gsub(/^ +/,"",$2); print $2; exit}' /proc/cpuinfo; fi
  echo cores=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)
  if [ -r /proc/meminfo ]; then awk '/MemTotal/ {printf "mem_gb=%.0f\\n", $2/1024/1024}' /proc/meminfo; fi
  echo '---'
  df -h / | head -8
fi`;
}

function hostProcessScript(limit) {
  const lines = Number(limit) > 0 ? Number(limit) + 1 : 16;
  return `if [ "$(uname -s)" = Darwin ]; then ps -Aro pid,pcpu,pmem,user,comm | head -n ${lines}; else ps -eo pid,pcpu,pmem,user,comm --sort=-pcpu | head -n ${lines}; fi`;
}

function hostServiceScript(name) {
  const service = safeService(name);
  if (!service) return "echo 'missing service name'";
  const quoted = JSON.stringify(service);
  return `if [ "$(uname -s)" = Darwin ]; then
  launchctl print "gui/$(id -u)/${service}" 2>&1 | head -40
  echo '---'
  if command -v brew >/dev/null; then brew services info ${quoted} 2>&1 | head -20; else echo 'brew not installed'; fi
else
  if command -v systemctl >/dev/null; then
    systemctl status ${quoted} --no-pager 2>&1 | head -30
    echo '---'
    systemctl --user status ${quoted} --no-pager 2>&1 | head -20
  else
    echo 'no service manager on this system'
  fi
fi`;
}

function hostTunnelsScript() {
  return `ps -axww -o pid=,command= 2>/dev/null | awk '
    {
      line = $0
      sub(/^[[:space:]]*[0-9]+[[:space:]]*/, "", line)
      cmd = line
      sub(/ .*/, "", cmd)
      base = cmd
      sub(/.*\\//, "", base)
      if (base == "ssh" && (line ~ / -L/ || line ~ / -R/ || line ~ / -D/)) print "live " $1 " " line
    }
  '
  awk '
    /^Host[[:space:]]/ { host = $0; next }
    /^[[:space:]]*(LocalForward|RemoteForward|DynamicForward|ProxyJump)[[:space:]]/ {
      gsub(/^[[:space:]]+/, "")
      print "config " host " | " $0
    }
  ' "$HOME/.ssh/config" 2>/dev/null
  if command -v lsof >/dev/null; then
    lsof -nP -a -iTCP -sTCP:LISTEN -c ssh 2>/dev/null | awk 'NR>1 && $1 ~ /^ssh/ { print "listen " $1 " " $9 }'
  fi`;
}

function hostDiskScript() {
  return `if [ "$(uname -s)" = Darwin ]; then
  df -h / /System/Volumes/Data 2>/dev/null
  echo '---'
  du -sh ~/.novapup "$HOME/Library/Application Support/novapup" 2>/dev/null
else
  df -h /
  echo '---'
  du -sh ~/.novapup "\${XDG_DATA_HOME:-$HOME/.local/share}/novapup" 2>/dev/null
fi`;
}

function listenPortsScript() {
  return `if [ "$(uname -s)" = Darwin ]; then
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -200
elif command -v ss >/dev/null; then
  ss -lntup | head -200
elif command -v lsof >/dev/null; then
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -200
else
  echo 'no ss or lsof on this system'
fi`;
}

function httpUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

async function needDocker() {
  const check = await runBash("command -v docker >/dev/null && docker info >/dev/null");
  if (!check.ok) {
    return { ok: false, error: "Docker is not running on this computer." };
  }
  return null;
}

export async function runPack(name, args) {
  if (process.platform === "win32") {
    const { runWindowsPack } = await import("./windows-packs.js");
    const result = runWindowsPack(name, args);
    if (result) return result;
  }
  switch (name) {
    case "host_list":
      return runBash("echo 'local this-system'; awk '/^Host / {print}' ~/.ssh/config 2>/dev/null | head -40");
    case "host_tunnels": {
      const raw = await runBash(hostTunnelsScript());
      const stdout = redactSecrets(summarizeTunnels(raw.stdout));
      if (!raw.ok && !String(raw.stdout || "").trim()) return raw;
      return { ...raw, ok: true, stdout, error: "" };
    }
    case "host_facts":
      return runBash(hostFactsScript());
    case "host_processes":
      return runBash(hostProcessScript(args.limit));
    case "host_service_status": {
      const status = await runBash(hostServiceScript(args.name));
      if (status.ok && /could not find service/i.test(String(status.stdout || ""))) {
        return { ...status, ok: false, error: "No service by that name." };
      }
      return status;
    }
    case "host_tail_log": {
      const full = expandPath(args.path, getWorkdir());
      const blocked = denySecretPath(full);
      if (blocked) return { ok: false, error: blocked };
      return runBash(`tail -n ${Number(args.lines) > 0 ? Number(args.lines) : 80} ${JSON.stringify(full)}`);
    }
    case "host_disk":
      return runBash(hostDiskScript());
    case "host_listen_ports":
      return runBash(listenPortsScript());
    case "host_run_plan":
      return { ok: true, plan: true, command: args.command, why: args.why || "", note: "Not run. Call host_run to execute." };
    case "host_run":
      return runBash(args.command);
    case "dns_lookup":
      return runBash(`dig +short ${JSON.stringify(args.type || "A")} ${JSON.stringify(args.name)} ; echo '---'; dig +nocmd +noall +answer ${JSON.stringify(args.name)}`);
    case "http_check":
      return runBash(`curl -sSI -m 12 -o /dev/null -w '%{http_code} %{url_effective} time=%{time_total}\\n' ${JSON.stringify(httpUrl(args.url))}`);
    case "tls_inspect":
      return runBash(`echo | openssl s_client -servername ${JSON.stringify(args.host)} -connect ${JSON.stringify(args.host)}:${args.port || 443} 2>/dev/null | openssl x509 -noout -subject -issuer -dates`);
    case "tcp_check":
      return runBash(`if [ "$(uname -s)" = Darwin ]; then nc -z -G 3 ${JSON.stringify(safeHost(args.host))} ${Number(args.port)}; else nc -z -w 3 ${JSON.stringify(safeHost(args.host))} ${Number(args.port)}; fi && echo open || echo closed`);
    case "ping_check":
      return runBash(`if [ "$(uname -s)" = Darwin ]; then ping -c 3 -W 2000 ${JSON.stringify(safeHost(args.host))}; else ping -c 3 -W 2 ${JSON.stringify(safeHost(args.host))}; fi`);
    case "trace_path":
      return runBash(`traceroute -m 12 -w 2 -q 1 ${JSON.stringify(args.host)}`);
    case "whois_lookup":
      return runBash(`whois ${JSON.stringify(args.query)} | head -80`);
    case "host_file_write_plan":
      return { ok: true, plan: true, path: args.path, bytes: String(args.content || "").length, note: "Not written. Call host_file_write to apply." };
    case "net_report": {
      const host = safeHost(args.host);
      return runBash(`echo DNS; dig +short "${host}"; echo HTTP; curl -sSI -m 10 -o /dev/null -w '%{http_code} %{time_total}\\n' "https://${host}"; echo TLS; echo | openssl s_client -servername "${host}" -connect "${host}:443" 2>/dev/null | openssl x509 -noout -subject -dates`);
    }
    case "docker_ps":
    case "docker_inspect":
    case "docker_logs":
    case "docker_stats":
    case "docker_compose_ps":
    case "docker_restart":
    case "docker_exec": {
      const missing = await needDocker();
      if (missing) return missing;
      if (name === "docker_ps") return runBash("docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Image}}'");
      if (name === "docker_inspect") return runBash(`set -o pipefail; docker inspect ${JSON.stringify(args.name)} | head -c 12000`);
      if (name === "docker_logs") return runBash(`docker logs --tail ${Number(args.lines) > 0 ? Number(args.lines) : 80} ${JSON.stringify(args.name)}`);
      if (name === "docker_stats") return runBash(`docker stats --no-stream ${args.name ? JSON.stringify(args.name) : ""}`);
      if (name === "docker_compose_ps") return runBash("docker compose ps", args.dir);
      if (name === "docker_restart") return runBash(`docker restart ${JSON.stringify(args.name)}`);
      return runBash(`docker exec ${JSON.stringify(args.name)} sh -lc ${JSON.stringify(args.command)}`);
    }
    case "docker_restart_plan":
      return { ok: true, plan: true, name: args.name, note: "Not restarted. Call docker_restart to apply." };
    case "incident_open": {
      const id = `inc-${Date.now()}`;
      return { ok: true, incident: saveIncident({ id, title: args.title, summary: args.summary || "", status: "open", notes: [], hypotheses: "", checklist: [], paged: false, created: new Date().toISOString() }) };
    }
    case "incident_note": {
      const doc = loadIncident(args.id);
      if (!doc) return { ok: false, error: "unknown incident" };
      doc.notes.push({ at: new Date().toISOString(), note: args.note });
      return { ok: true, incident: saveIncident(doc) };
    }
    case "incident_gather":
      if (args.id) return { ok: true, incident: loadIncident(args.id) || { error: "missing" } };
      return { ok: true, incidents: readdirSync(incidentDir()).map((name) => name.replace(/\.json$/, "")) };
    case "incident_hypotheses": {
      const doc = loadIncident(args.id);
      if (!doc) return { ok: false, error: "unknown incident" };
      doc.hypotheses = args.hypotheses;
      return { ok: true, incident: saveIncident(doc) };
    }
    case "incident_runbook_get":
      return { ok: true, incident: loadIncident(args.id), runbook: loadIncident(args.id)?.notes || [] };
    case "incident_checklist": {
      const doc = loadIncident(args.id);
      if (!doc) return { ok: false, error: "unknown incident" };
      const item = doc.checklist.find((row) => row.item === args.item);
      if (item) item.done = Boolean(args.done);
      else doc.checklist.push({ item: args.item, done: Boolean(args.done) });
      return { ok: true, incident: saveIncident(doc) };
    }
    case "incident_page": {
      const doc = loadIncident(args.id);
      if (!doc) return { ok: false, error: "unknown incident" };
      doc.paged = true;
      doc.notes.push({ at: new Date().toISOString(), note: `PAGE: ${args.message || ""}` });
      return { ok: true, incident: saveIncident(doc) };
    }
    case "incident_close": {
      const doc = loadIncident(args.id);
      if (!doc) return { ok: false, error: "unknown incident" };
      doc.status = "closed";
      doc.resolution = args.resolution || "";
      doc.closed = new Date().toISOString();
      return { ok: true, incident: saveIncident(doc) };
    }
    default:
      return null;
  }
}
