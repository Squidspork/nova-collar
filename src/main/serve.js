import { factAsk, folderAsk } from "./ground.js";

/** Gate before a tool runs. A specific question only gets the tool that answers it. */

const FOLDER_TOOLS = new Set(["host_file_read"]);

const BROAD = /\b(status report|full report|everything|overview|how is this (machine|computer|system)|system status)\b/i;

/** SSH tunnels on this computer. A website check does not answer this. */
export function tunnelAsk(text) {
  const q = String(text || "");
  return /\bssh\b/i.test(q) && /\b(tunnels?|forwards?|routes?)\b/i.test(q);
}

/** A request to say the last answer in plain language. */
export function rewriteAsk(text) {
  return /\b(human mode|plain language|in words|crazy text|say it normally|rephrase)\b/i.test(String(text || ""));
}

/** Plain language, and there is already an answer to restate. */
export function plainTurn(ask, history) {
  if (!rewriteAsk(ask) || tunnelAsk(ask)) return false;
  return (history || []).some((row) => row?.role === "assistant" && String(row?.content || "").trim());
}

/** This turn should list SSH tunnels. A rephrase of an earlier answer does not. */
export function tunnelTurn(ask) {
  return tunnelAsk(ask);
}

/** "Are we online?" with no site named. A named host stays that host's check. */
export function onlineAsk(text) {
  const q = String(text || "");
  if (/\bhttps?:\/\/\S+/.test(q)) return false;
  if (/\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(q)) return false;
  return /\b(internet|online|connectivity)\b/i.test(q);
}

/** Connectivity checks use one public site, not an SSH alias. */
export function pinPublicHost(raw) {
  let parsed = {};
  try {
    parsed = JSON.parse(String(raw || "{}"));
  } catch {
    parsed = {};
  }
  parsed.host = "hungrynovalabs.com";
  return JSON.stringify(parsed);
}
const SERVICE = /\b(service|launchctl|brew services|nginx|sshd|launchd)\b/i;
const SCREEN = /\b(screenshot|this screen|on screen|front app|screen recording)\b/i;
const TERM = /\b(terminal|the shell|type this|run this command)\b/i;

const NARROW = [
  { test: /\bdocker\b.*\b(running|up|status|installed|containers?)\b|\b(running|up|status|installed|containers?)\b.*\bdocker\b/i, tools: new Set(["docker_ps"]) },
  { test: /\b(internet|online|connectivity)\b/i, tools: new Set(["net_report"]) },
  { test: /\b(ports?|listening|open ports?)\b/i, tools: new Set(["host_listen_ports"]) },
  { test: /\b(disk|storage|filesystem|how full|disk space)\b/i, tools: new Set(["host_disk"]) },
  { test: /\b(processes|process list|cpu usage|what's running|what is running|busiest)\b/i, tools: new Set(["host_processes"]) },
  { test: SCREEN, tools: new Set(["mac_screenshot", "mac_info"]) },
  { test: SERVICE, tools: new Set(["host_service_status"]) },
  { test: TERM, tools: new Set(["term_send", "term_read"]) },
];

function toolName(row) {
  return row?.function?.name || row?.name || "";
}

/** True when this tool can answer the user's latest line. */
export function servesAsk(ask, name, history) {
  const tool = String(name || "");
  const q = String(ask || "");
  if (!tool) return false;
  if (tool === "say_plain") return plainTurn(q, history);
  if (plainTurn(q, history)) return tool === "say_plain";
  if (tunnelTurn(q)) return tool === "host_tunnels";
  if (folderAsk(q) && factAsk(q)) return FOLDER_TOOLS.has(tool);
  if (BROAD.test(q)) {
    if (tool === "host_service_status") return false;
    if (tool.startsWith("mac_")) return SCREEN.test(q);
    if (tool === "term_send" || tool === "term_read") return TERM.test(q);
    return true;
  }
  const hits = NARROW.filter((row) => row.test.test(q));
  if (hits.length) return hits.some((row) => row.tools.has(tool));
  if (tool === "host_service_status") return false;
  return true;
}

/** Drop tool definitions that cannot answer this ask. An empty cut keeps the original list. */
export function toolsForAsk(tools, ask, history, packNames = null) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  if (plainTurn(ask, history)) {
    const plain = tools.filter((row) => toolName(row) === "say_plain");
    return plain.length ? plain : tools;
  }
  const kept = tools.filter((row) => servesAsk(ask, toolName(row), history));
  if (wantedTools(ask, history).length) return kept.length ? kept : tools;
  if (packNames?.size) {
    const packed = kept.filter((row) => packNames.has(toolName(row)));
    if (packed.length) {
      const run = /\b(run|command|shell)\b/i.test(String(ask || ""));
      const cut = run ? packed : packed.filter((row) => !["host_run", "host_run_plan"].includes(toolName(row)));
      return cut.length ? cut : packed;
    }
  }
  return kept.length ? kept : tools;
}

export function wantedTools(ask, history) {
  const q = String(ask || "");
  if (plainTurn(q, history)) return ["say_plain"];
  if (tunnelTurn(q)) return ["host_tunnels"];
  if (folderAsk(q) && factAsk(q)) return ["host_file_read"];
  if (BROAD.test(q)) return [];
  const names = NARROW.filter((row) => row.test.test(q)).flatMap((row) => [...row.tools]);
  return [...new Set(names)];
}

export function skipNote(name, ask, history) {
  const label = String(name || "that tool").replaceAll("_", " ");
  const want = wantedTools(ask, history);
  const which = want.length
    ? ` Call ${want.join(" or ")}.`
    : " Call the tool that does, or answer with what you have.";
  return `Skipped. ${label} does not answer this question.${which}`;
}
