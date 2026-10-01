/** /goal sets a standing outcome. An open goal is not a reason to stop. */

import { watchJailbreak } from "./laya-steer.js";
import { rewriteAsk, tunnelAsk } from "./serve.js";

const PORT_NOISE = /^(rapportd|controlce|controlcenter|sharingd|identitys|ipnextens|steam_osx|cursor)$/i;

export function parseGoal(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/^\/goal\b([\s\S]*)$/i);
  if (!match) return null;
  const rest = match[1].trim().replace(/\s+/g, " ");
  if (!rest) return { action: "show" };
  if (/^(clear|off|none)$/i.test(rest)) return { action: "clear" };
  if (watchJailbreak(rest)) return { action: "refuse" };
  return { action: "set", text: rest.slice(0, 400) };
}

/** A goal said in a normal sentence, not only on a /goal line. */
export function spokenGoal(text) {
  const raw = String(text || "").trim();
  if (!raw || /^\/goal\b/i.test(raw)) return "";
  const quoted = raw.match(/\byour goal is(?:\s+to)?\s+["“]([^"”]+)["”]/i);
  const plain = quoted || raw.match(/\byour goal is(?:\s+to)?\s+(.+)$/i);
  const goal = String(plain?.[1] || "").replace(/\s+/g, " ").trim();
  if (goal.length < 8 || watchJailbreak(goal)) return "";
  return goal.slice(0, 400);
}

/** A shell transcript or a pasted tool card is not a reply. */
export function looksLikeToolPaste(text) {
  const line = String(text || "");
  if (!line.trim()) return false;
  if (/ssh -o\b|BatchMode|host tunnels:|net report:|host run:/i.test(line)) return true;
  return /^DNS\b/m.test(line) && /\bHTTP\b/.test(line);
}

/** A closing line that names no result from the tools. */
export function dodgesResult(text) {
  const line = String(text || "").trim();
  if (!line) return true;
  if (/is a tool\. Call /.test(line)) return true;
  if (looksLikeToolPaste(line)) return true;
  return /\bstopped\b|next step is the edit|have not called a tool|same call already ran|^i have the data\b/i.test(line);
}

/** A short note stored beside a tool result, for the closing report. */
export function toolNote(result) {
  const raw = String(result?.stdout || result?.text || result?.error || "").trim();
  if (!raw) return "";
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (/^bad request\.?$/i.test(lines[0] || "") || /could not find service/i.test(raw)) return "no matching service";
  return lines.slice(0, 6).join("\n").slice(0, 700);
}

/** Turn a raw disk table into one readable line. Other notes pass through. */
export function plainResult(text) {
  const raw = String(text || "").trim();
  const parts = [];
  for (const line of raw.split("\n")) {
    const match = line.match(/^\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)%\s+\S+\s+\S+\s+\S+\s+(\/\S*)\s*$/);
    if (!match) continue;
    const mount = match[5] === "/" ? "System volume" : /\/Data$/.test(match[5]) ? "Data volume" : match[5];
    parts.push(`${mount} ${match[4]}% (${match[2]} used, ${match[3]} free of ${match[1]})`);
  }
  if (!parts.length) return raw;
  const other = raw.split("\n\n").map((block) => block.trim()).filter((block) => block && !/Filesystem/.test(block) && !/^host disk:/.test(block));
  return [parts.join(". ") + ".", ...other].join("\n\n");
}

function listenRows(note) {
  const found = [];
  const seen = new Set();
  for (const line of String(note || "").split("\n")) {
    const lsof = line.match(/^(\S+)\s+\d+\s+.*\bTCP\s+(\S+)\s+\(LISTEN\)/);
    const ss = line.match(/LISTEN\s+\S+\s+\S+\s+\S+\s+(\S+)\s+.*\(\("([^"]+)"/);
    const cmd = lsof?.[1] || ss?.[2] || "";
    const addr = lsof?.[2] || ss?.[1] || "";
    if (!cmd || !addr) continue;
    const port = addr.replace(/^.*:/, "");
    const key = `${cmd}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ cmd, port, noise: PORT_NOISE.test(cmd) });
  }
  return found;
}

const PORT_RANK = ["sshd", "ssh", "node", "cloudflar", "nginx", "caddy", "ollama", "postgres", "redis", "docker", "adb"];

function portRank(cmd) {
  const name = String(cmd || "").toLowerCase();
  const index = PORT_RANK.findIndex((row) => name.startsWith(row));
  return index < 0 ? PORT_RANK.length : index;
}

function portLabel(cmd, ports) {
  if (ports.length === 1) return `${cmd} ${ports[0]}`;
  if (ports.length === 2) return `${cmd} ${ports[0]} and ${ports[1]}`;
  return `${cmd} on ${ports.length} ports`;
}

function portsLine(note) {
  const text = String(note || "").trim();
  if (text.startsWith("Listening:")) return text;
  const rows = listenRows(text);
  const services = rows.filter((row) => !row.noise);
  const ranked = services.length ? services : rows;
  const groups = new Map();
  for (const row of ranked) {
    const ports = groups.get(row.cmd) || [];
    ports.push(row.port);
    groups.set(row.cmd, ports);
  }
  const ordered = [...groups.entries()].sort((a, b) => portRank(a[0]) - portRank(b[0]) || a[1].length - b[1].length);
  const shown = ordered.slice(0, 4).map(([cmd, ports]) => portLabel(cmd, ports));
  if (!shown.length) return "";
  const extra = ordered.length - shown.length;
  const more = extra > 0 ? `, and ${extra} more` : "";
  return `Listening: ${shown.join(", ")}${more}.`;
}

/** The last assistant sentence, for a plain-language follow-up. */
export function earlierAnswer(history) {
  const row = [...(history || [])].reverse().find((item) => item?.role === "assistant" && String(item.content || "").trim());
  return String(row?.content || "").replace(/\s+/g, " ").trim();
}

function interpretInfo(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (/TCP\s+\S+\s+\(LISTEN\)/.test(text) || /^LISTEN\s/m.test(text)) return portsLine(text);
  if (/^DNS\b/m.test(text) && /\bHTTP\b/.test(text)) return netLine(text, "");
  const tunnels = tunnelSentence(text);
  if (tunnels) return tunnels;
  if (/ssh -o\b|BatchMode|(?:^|\s)-[LRD]\s/m.test(text)) {
    const lined = text.split("\n").map((line) => line.trim()).filter(Boolean)
      .map((line) => (line.startsWith("live ") || line.startsWith("config ") ? line : `live 0 ${line}`))
      .join("\n");
    const said = tunnelSentence(summarizeTunnels(lined));
    if (said) return said;
  }
  return diskLine(text);
}

/** Inlet is words plus raw info. Outlet is one human sentence. Data is interpreted only when it is not already a sentence. */
export function toPlain({ words = "", info = "" } = {}) {
  const said = String(words || "").replace(/\s+/g, " ").trim();
  const fromInfo = interpretInfo(info);
  if (fromInfo) return fromInfo;
  if (said && !looksLikeToolPaste(said)) return said;
  const fromWords = interpretInfo(said);
  if (fromWords) return fromWords;
  const raw = String(info || "").replace(/\s+/g, " ").trim();
  if (raw && !looksLikeToolPaste(raw)) return raw.slice(0, 420);
  return said || "I don't have anything to say in plain language.";
}

/** Keep a restate when it is a sentence. Otherwise keep the facts. */
export function acceptRestate(facts, said, personality) {
  const base = String(facts || "").replace(/\s+/g, " ").trim() || "I don't have an earlier answer to rephrase.";
  const line = String(said || "").replace(/\s+/g, " ").trim();
  if (!line || looksLikeToolPaste(line) || dodgesResult(line) || line.length > 420) return base;
  const numbers = base.match(/\d+/g) || [];
  if (numbers.some((num) => !line.includes(num))) return base;
  const voice = String(personality || "").replace(/\s+/g, " ").trim().slice(0, 48);
  if (voice && line.includes(voice)) return base;
  return line;
}

function factsLine(note) {
  const text = String(note || "");
  const ver = text.match(/ProductVersion:\s*(\S+)/);
  const cores = text.match(/cores=(\d+)/);
  const mem = text.match(/mem_gb=(\d+)/);
  const bits = [ver && `macOS ${ver[1]}`, cores && `${cores[1]} cores`, mem && `${mem[1]} GB`].filter(Boolean);
  return bits.length ? `${bits.join(", ")}.` : "";
}

function processLine(note) {
  const rows = [];
  for (const line of String(note || "").split("\n")) {
    const match = line.match(/^\s*\d+\s+([\d.]+)\s+[\d.]+\s+\S+\s+(\S+)/);
    if (!match) continue;
    rows.push(`${match[2].split("/").pop()} ${match[1]}%`);
    if (rows.length === 3) break;
  }
  return rows.length ? `Busiest: ${rows.join(", ")}.` : "";
}

function diskLine(note) {
  const pretty = plainResult(String(note || ""));
  const first = pretty.split("\n\n")[0];
  return /volume \d+%/.test(first) ? first : "";
}

function hostFromArgs(args) {
  const raw = String(args || "");
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.host || parsed.url || "").replace(/^https?:\/\//, "").split("/")[0];
  } catch {
    return raw.match(/"host"\s*:\s*"([^"]+)"/)?.[1] || "";
  }
}

function netLine(note, args) {
  const text = String(note || "");
  const host = hostFromArgs(args) || "That host";
  const code = text.match(/^HTTP\s*\n\s*(\d{3})/m)?.[1] || text.match(/\bHTTP\s+(\d{3})/)?.[1] || "";
  const cn = text.match(/subject=CN=([^\s\n]+)/)?.[1] || "";
  if (code === "200") return `Yes. ${cn || host} answered HTTP 200.`;
  if (!code || code === "000" || /could not resolve/i.test(text)) return `No. ${host} did not answer.`;
  return `${host} answered HTTP ${code}.`;
}

function tunnelSentence(note) {
  const text = String(note || "").trim();
  if (/^\d+ SSH tunnel/.test(text) || /^No SSH tunnels\b/.test(text)) return text;
  return "";
}

function dockerLine(note, ok) {
  const text = String(note || "");
  if (/not running|cannot connect to the docker daemon|no such file or directory/i.test(text)) {
    return "No. Docker is not running on this computer.";
  }
  if (ok === false) return "";
  const names = text.split("\n").map((line) => line.trim()).filter((line) => line && !/^NAMES\b/i.test(line) && !/^CONTAINER ID\b/i.test(line));
  const shown = names.slice(0, 4).map((line) => line.split(/\s+/)[0]).filter(Boolean);
  if (!shown.length) return "Docker is running. No containers are listed.";
  return shown.length === 1
    ? `Docker is running. ${shown[0]} is listed.`
    : `Docker is running. ${shown.join(", ")} are listed.`;
}

function shortFailure(trail) {
  const row = (trail || []).find((item) => item && item.ok === false && item.name && item.name !== "laya" && item.name !== "term_send" && item.name !== "term_read");
  if (!row) return "";
  if (row.name === "net_report") return netLine(row.note, row.args);
  const note = String(row.note || "").replace(/\s+/g, " ").trim();
  const label = String(row.name).replaceAll("_", " ");
  if (!note || /is a tool\. Call /.test(note) || note.length > 120 || looksLikeToolPaste(note)) return `${label} failed.`;
  return `${label} failed: ${note}`;
}

/** A short answer for what was asked. Raw tables stay in the tool cards. */
export function answerFromAsk(ask, trail) {
  const q = String(ask || "").toLowerCase();
  const rows = [];
  for (const row of trail || []) {
    if (!row?.note || row.ok === false) continue;
    if (row.name === "laya" || row.name === "term_send" || row.name === "term_read") continue;
    rows.push(row);
  }
  const notes = new Map(rows.map((row) => [row.name, row.note]));
  const said = {
    host_listen_ports: portsLine(notes.get("host_listen_ports")),
    host_disk: diskLine(notes.get("host_disk")),
    host_facts: factsLine(notes.get("host_facts")),
    host_processes: processLine(notes.get("host_processes")),
  };
  let keys = [...notes.keys()];
  if (/\bports?\b|\blisten/.test(q)) keys = ["host_listen_ports"];
  else if (/\bdisk|storage|full\b/.test(q)) keys = ["host_disk"];
  else if (/\bprocess|cpu|busy\b/.test(q)) keys = ["host_processes"];
  const narrow = /\bports?\b|\blisten/.test(q) || /\bdisk|storage|full\b/.test(q) || /\bprocess|cpu|busy\b/.test(q);
  const lines = keys.map((key) => said[key] || "").filter(Boolean);
  if (narrow && lines.length) return lines.join(" ");
  if (rewriteAsk(ask)) return String(notes.get("say_plain") || "").trim();
  if (/\bdocker\b/.test(q)) {
    const docker = (trail || []).find((row) => row?.name === "docker_ps");
    const line = dockerLine(docker?.note, docker?.ok);
    if (line) return line;
  }
  const tunnels = tunnelSentence(notes.get("host_tunnels"));
  if (tunnels && tunnelAsk(ask)) return tunnels;
  const parts = [...lines];
  if (tunnels) parts.push(tunnels);
  const net = (trail || []).find((row) => row?.name === "net_report");
  if (net) {
    const line = netLine(net.note, net.args);
    if (line && (net.ok !== false || !parts.length)) parts.push(line);
  }
  if (parts.length) return parts.join(" ");
  if (!rows.length) return shortFailure(trail);
  return "";
}

function forwardBits(spec) {
  const parts = String(spec || "").split(":");
  if (parts.length >= 4) return { from: parts[1], to: parts[parts.length - 1] };
  if (parts.length === 3) return { from: parts[0], to: parts[2] };
  if (parts.length === 1) return { from: parts[0], to: parts[0] };
  return null;
}

function liveFacts(line) {
  const text = String(line || "").replace(/^\d+\s+/, "");
  let dest = text.trim().split(/\s+/).pop() || "";
  if (!dest || dest.includes(":") || dest.startsWith("-")) dest = "the far side";
  const locals = [];
  const remotes = [];
  const socks = [];
  for (const match of text.matchAll(/(?:^|\s)-L\s*(\S+)/g)) {
    const bit = forwardBits(match[1]);
    if (bit) locals.push(bit);
  }
  for (const match of text.matchAll(/(?:^|\s)-R\s*(\S+)/g)) {
    const bit = forwardBits(match[1]);
    if (bit) remotes.push(bit);
  }
  for (const match of text.matchAll(/(?:^|\s)-D\s*(\S+)/g)) socks.push(match[1].replace(/.*:/, ""));
  return { dest, locals, remotes, socks };
}

/** Turn host_tunnels script lines into a plain sentence. */
export function summarizeTunnels(stdout) {
  const live = [];
  const config = [];
  for (const line of String(stdout || "").split("\n")) {
    const text = line.trim();
    if (text.startsWith("live ")) live.push(text.slice(5).trim());
    else if (text.startsWith("config ")) config.push(text.slice(7).trim());
  }
  const groups = new Map();
  for (const row of live.map(liveFacts)) {
    const cur = groups.get(row.dest) || { locals: [], remotes: [], socks: [] };
    cur.locals.push(...row.locals);
    cur.remotes.push(...row.remotes);
    cur.socks.push(...row.socks);
    groups.set(row.dest, cur);
  }
  const sentences = [];
  for (const [dest, row] of groups) {
    const bits = [];
    for (const item of row.locals) bits.push(`local port ${item.from} goes to port ${item.to} there`);
    for (const item of row.remotes) bits.push(`their port ${item.from} comes back to port ${item.to} here`);
    for (const port of row.socks) bits.push(`a local proxy on port ${port}`);
    if (bits.length) sentences.push(`Through ${dest}, ${bits.join(", and ")}.`);
  }
  for (const line of config) {
    const [hostPart, rule] = line.split("|").map((part) => part.trim());
    const host = String(hostPart || "").replace(/^Host\s+/, "") || "a host";
    const kind = String(rule || "").match(/^(LocalForward|RemoteForward|DynamicForward|ProxyJump)\s+(\S+)/);
    if (!kind) continue;
    if (kind[1] === "ProxyJump") sentences.push(`${host} is set to jump through ${kind[2]}.`);
    else sentences.push(`${host} config has a ${kind[1]} ${kind[2]}.`);
  }
  if (!sentences.length) {
    return "No SSH tunnels are running, and ~/.ssh/config has no LocalForward, RemoteForward, DynamicForward, or ProxyJump lines.";
  }
  const count = live.length || config.length;
  const lead = live.length
    ? `${live.length} SSH tunnel${live.length === 1 ? " is" : "s are"} active.`
    : `${count} SSH forward${count === 1 ? " is" : "s are"} in the config, and none are running.`;
  return `${lead} ${sentences.join(" ")}`;
}

/** One note per tool, in the order they first succeeded. */
export function evidenceDraft(trail) {
  const seen = new Map();
  for (const row of trail || []) {
    if (!row || row.name === "laya" || row.name === "term_send" || row.name === "term_read") continue;
    if (/is a tool\. Call /.test(String(row.note || ""))) continue;
    if (row.name === "net_report" && row.ok === false) continue;
    if (row.ok === false) {
      if (!seen.has(row.name)) seen.set(row.name, row.note || "failed");
      continue;
    }
    if (row.note) seen.set(row.name, row.note);
  }
  const lines = [...seen.entries()].map(([name, note]) => `${String(name).replaceAll("_", " ")}: ${note}`);
  return lines.join("\n\n");
}

/** Why a failed tool matters to the goal that is already open. */
export function failureGoal({ name = "", detail = "", goal = "" } = {}) {
  const tool = String(name || "a tool").replace(/_/g, " ");
  const why = String(detail || "it failed").replace(/\s+/g, " ").trim().slice(0, 160);
  const main = String(goal || "").replace(/\s+/g, " ").trim();
  const line = main
    ? `Find why ${tool} failed (${why}), and whether that blocks this goal: ${main}`
    : `Find why ${tool} failed (${why}), and what still serves the ask.`;
  return line.slice(0, 400);
}

export function applyGoalCommand(text, current = "") {
  const parsed = parseGoal(text);
  const goal = String(current || "").trim();
  if (!parsed) return { handled: false, goal, runText: String(text || "") };
  if (parsed.action === "show") {
    return {
      handled: true,
      goal,
      reply: goal ? `Goal: ${goal}` : "No goal. Set one with /goal and the outcome you want.",
    };
  }
  if (parsed.action === "clear") {
    return { handled: true, goal: "", reply: "Goal cleared.", changed: true };
  }
  if (parsed.action === "refuse") {
    return { handled: true, goal, reply: "I won't do that. Ask for the job itself." };
  }
  return { handled: false, goal: parsed.text, runText: parsed.text, changed: true, set: true };
}

export function goalTrace({ goal, ask, trail, why } = {}) {
  const asked = String(ask || "").replace(/\s+/g, " ").trim().slice(0, 400);
  const lines = (trail || []).slice(-8).map((row, i) => {
    const flag = row.ok === false ? "fail" : "ok";
    return `${i + 1}. ${row.name} ${row.args || "{}"} -> ${flag}`;
  });
  const reason = String(why || "answering before the goal is checked").replace(/\s+/g, " ").trim().slice(0, 180);
  return `Goal: ${String(goal || "").replace(/\s+/g, " ").trim().slice(0, 400)}\n\nUser asked: ${asked}\n\nTools already run this turn:\n${lines.join("\n") || "(none)"}\n\nAbout to stop because: ${reason}`;
}

export function goalFromLaya(read) {
  if (!read || !["keep", "done", "stuck"].includes(read.choice)) return null;
  const confidence = Number(read.confidence) || 0;
  if (confidence < 0.6) return null;
  const detail = `${read.choice} ${Math.round(confidence * 100)}%`;
  return { action: read.choice, detail };
}

/** A repeated tool is always skipped. An open goal ends the turn only when Laya says done or stuck. */
export function goalHalt({ goal = "", why = "", verdict = null, trust = false } = {}) {
  if (watchJailbreak(goal)) return "goal blocked";
  if (!why) return "";
  if (!String(goal || "").trim()) return why;
  if (trust && verdict?.action === "done") return "goal met";
  if (trust && verdict?.action === "stuck") return verdict.detail || "goal blocked";
  return "";
}

export function goalNudge(goal) {
  return `Goal still open: ${goal}. Take a different step, or say what is done and what is left. Do not answer with only Stopped.`;
}

export const GOAL_STEP_SYSTEM = "You sit after Laya. Laya already classified this turn. Decide whether the standing goal is accomplished. First line PASS only when the tool notes already fulfill the goal, then the answer. First line FAIL when something that serves the goal is still missing, then the one next action. Do not say only Stopped.";

/** Prompt for the model that sits after Laya. */
export function goalStepTrace({ goal = "", ask = "", laya = "", why = "", trail = [] } = {}) {
  const notes = (trail || []).slice(-8).map((row) => {
    const flag = row.ok === false ? "fail" : "ok";
    const note = String(row.note || "").replace(/\s+/g, " ").trim().slice(0, 180);
    return `${row.name || "tool"} ${flag}${note ? `: ${note}` : ""}`;
  });
  return [
    `Goal: ${String(goal).replace(/\s+/g, " ").trim().slice(0, 400)}`,
    `User asked: ${String(ask).replace(/\s+/g, " ").trim().slice(0, 300)}`,
    `Laya: ${String(laya || "none").slice(0, 80)}`,
    `About to stop because: ${String(why || "the model answered").replace(/\s+/g, " ").trim().slice(0, 180)}`,
    `Tool notes:\n${notes.join("\n") || "(none)"}`,
  ].join("\n\n");
}

/** A PASS or FAIL first line from the layer after Laya. The older decision: done|next and step: form still reads. */
export function goalStepFromText(text) {
  const raw = String(text || "").trim();
  const decision = raw.match(/decision:\s*(done|next)\b/i);
  if (decision) {
    const step = String(raw.match(/step:\s*([\s\S]*)/i)?.[1] || "").trim().slice(0, 2000);
    return { action: decision[1].toLowerCase(), step };
  }
  const verdict = raw.match(/^(pass|fail|done|not done)\b[.:,]?\s*/i);
  if (!verdict) return null;
  if (/^(pass|done)$/i.test(verdict[1])) return { action: "done", step: raw.slice(0, 2000) };
  return { action: "next", step: raw.slice(verdict[0].length).trim().slice(0, 2000) };
}

/** A done line that dodges the goal, or has no tool note behind it, stays open. */
export function settleGoalStep(parsed, { goal = "", trail = [] } = {}) {
  const fallback = goal
    ? `Finish the open goal from the tool notes already collected: ${goal}`
    : "Take a different step that has not already run.";
  if (!parsed || (parsed.action !== "done" && parsed.action !== "next")) return { action: "next", step: fallback };
  if (!parsed.step || dodgesResult(parsed.step)) return { action: "next", step: fallback };
  const proved = (trail || []).some((row) => row && row.ok !== false && row.note && row.name !== "laya" && row.name !== "term_send" && row.name !== "term_read");
  if (parsed.action === "done" && !proved) return { action: "next", step: fallback };
  return { action: parsed.action, step: parsed.step };
}

const HONEST = /\b(don'?t know|do not know|not sure|what is left|cannot prove|can'?t prove|not proven|FAIL)\b/i;
const CLAIM = /\b(pass(?:ed|es)?|works|worked|fixed|done|running|listening|wrote|written|created|is up|answers|clean|met)\b/i;
const CHECK = /^(host_run|host_disk|host_listen_ports|host_tunnels|web_search|docs_search|dns_lookup|http_check|ping_check|tls_inspect|whois_lookup|computer_exec|term_read|docker_ps|docker_logs|mac_screenshot)$/;
const FILE_ACT = /^(host_file_read|host_file_write)$/;
const FILE_CLAIM = /\b(wrote|written|read it back)\b/i;

export function oppositeOf(claim) {
  const text = String(claim || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!text) return "";
  return `It is not true that ${text.replace(/[.?!]$/, "")}.`;
}

export function claimLine(draft) {
  const line = String(draft || "").split("\n").map((part) => part.trim()).find(Boolean) || "";
  return line.replace(/\s+/g, " ").slice(0, 240);
}

/** The agent's own goal: disprove the opposite of the claim it wants to give. */
export function planAudit({ claim = "", goal = "", trail = [], failure = "", checked = false } = {}) {
  const text = String(claim || "").trim();
  const steps = Array.isArray(trail) ? trail : [];
  const fileDone = FILE_CLAIM.test(text) && steps.some((row) => row && row.ok !== false && FILE_ACT.test(String(row.name || "")));
  const proven = checked || fileDone || steps.some((row) => row && row.ok !== false && CHECK.test(String(row.name || "")));
  const failed = steps.some((row) => row && row.ok === false && CHECK.test(String(row.name || "")));
  if (/\bstopped\b/i.test(text) && (String(goal || "").trim() || String(failure || "").trim())) {
    const internalGoal = String(failure || "").trim()
      || `Finish the open goal instead of stopping: ${String(goal).trim()}`;
    return { action: "retry", opposite: oppositeOf(text), internalGoal, reason: "stopped before the goal", proven: false };
  }
  if (!text || text.length < 8 || HONEST.test(text)) {
    return { action: "skip", opposite: "", internalGoal: "", reason: "no claim to disprove", proven: false };
  }
  if (/^(Running \d+:|Config \d+:|Listening:|No SSH tunnels\b|\d+ SSH tunnels are active\b)/.test(text)
    && steps.some((row) => row && row.ok !== false && row.name === "host_tunnels")) {
    return { action: "skip", opposite: "", internalGoal: "", reason: "tunnel readout", proven: true };
  }
  if (/^(No\. Docker is not running\b|Docker is running\b)/.test(text)
    && steps.some((row) => row && row.name === "docker_ps")) {
    return { action: "skip", opposite: "", internalGoal: "", reason: "docker readout", proven: true };
  }
  if (!CLAIM.test(text)) {
    return { action: "skip", opposite: "", internalGoal: "", reason: "no outcome claimed", proven };
  }
  const opposite = oppositeOf(text);
  const internalGoal = `Disprove: ${opposite}`;
  if (!proven || (failed && !proven)) {
    return { action: "retry", opposite, internalGoal, reason: "the opposite is not disproved", proven: false };
  }
  return { action: "held", opposite, internalGoal, reason: "a tool result disproves the opposite", proven: true };
}

export function settleAudit({ plan, verdict = null, trust = false } = {}) {
  if (!plan || plan.action === "skip") return { action: "skip", reason: plan?.reason || "skip" };
  if (trust && verdict?.action === "retry") return { action: "retry", reason: verdict.detail || plan.reason };
  if (trust && verdict?.action === "held" && plan.action === "held") return { action: "held", reason: verdict.detail || plan.reason };
  if (verdict?.action === "held" && plan.action !== "held") {
    return { action: "retry", reason: "the opposite is not disproved" };
  }
  return { action: plan.action, reason: plan.reason };
}

export function auditTrace({ goal, claim, opposite, internalGoal, ask, trail } = {}) {
  const lines = (trail || []).slice(-8).map((row, i) => {
    const flag = row.ok === false ? "fail" : "ok";
    return `${i + 1}. ${row.name} ${row.args || "{}"} -> ${flag}`;
  });
  return [
    `User goal: ${String(goal || "none").replace(/\s+/g, " ").trim().slice(0, 240)}`,
    `Wants to say: ${String(claim || "").replace(/\s+/g, " ").trim().slice(0, 240)}`,
    `Opposite: ${String(opposite || "").replace(/\s+/g, " ").trim().slice(0, 280)}`,
    `Internal goal: ${String(internalGoal || "").replace(/\s+/g, " ").trim().slice(0, 320)}`,
    `User asked: ${String(ask || "").replace(/\s+/g, " ").trim().slice(0, 240)}`,
    "Tools already run this turn:",
    lines.join("\n") || "(none)",
  ].join("\n\n");
}

export function auditFromLaya(read) {
  if (!read || !["held", "retry", "skip"].includes(read.choice)) return null;
  const confidence = Number(read.confidence) || 0;
  if (confidence < 0.6) return null;
  return { action: read.choice, detail: `${read.choice} ${Math.round(confidence * 100)}%` };
}

export function auditNudge({ opposite, internalGoal, goal }) {
  const main = goal ? ` User goal still open: ${goal}.` : "";
  return `Internal goal: ${internalGoal}. You wanted the opposite of this to be false, and you have not disproved it: ${opposite} Take a different step that could disprove it. If this path cannot, drop it and try another.${main} Do not tell the user the claim yet.`;
}

export function unprovenAnswer(draft, opposite) {
  const body = String(draft || "").trim();
  return `Not proven. I could not disprove the opposite: ${opposite}\n\n${body}`.slice(0, 4000);
}
