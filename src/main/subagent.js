import { buildHelperContext, searchHelperHistory, HELPER_HISTORY_TOOL } from "./helper-context.js";
import { shellHint } from "./platform.js";
import { isLocalModel } from "./config.js";
import { FACT_LAW } from "./ground.js";
import { compactResult, executeTool, toolDefs } from "./tools.js";
import { packFor } from "./packs.js";

import { analysisPack, ANALYSIS_DOCTRINE } from "./analysis-pack.js";
import { ghidraPack, ghidraReady } from "./ghidra-mcp.js";
import { networkPack, NETWORK_DOCTRINE } from './network-pack.js';

const PACKS = {
  wireshark: networkPack().tools.map(row => row.name),
  analysis: analysisPack().tools.map(row => row.name),
  host: ["host_facts", "host_disk", "host_processes", "host_listen_ports", "host_run", "host_file_read", "host_file_write"],
  net: ["net_report", "http_check", "dns_lookup", "tls_inspect"],
  docker: ["docker_ps", "docker_logs"],
  incident: ["incident_open", "incident_gather", "incident_note", "incident_close"],
  hnl: ["web_search", "extract", "memory_search", "memory_remember"],
  computer: ["computer_exec", "computer_read", "computer_write"],
  desk: ["mac_info", "mac_screenshot"],
  term: ["term_read", "term_send"],
};

const FIRST_TOOL = {
  wireshark: 'network_status',
  analysis: "analysis_status",
  ghidra: "ghidra_status",
  host: "host_facts",
  net: "net_report",
  docker: "docker_ps",
  incident: "incident_open",
  hnl: "web_search",
  computer: "computer_exec",
  desk: "mac_info",
  term: "term_read",
};

export function subagentPacks() {
  return ghidraReady() ? [...Object.keys(PACKS), "ghidra"] : Object.keys(PACKS);
}

export function toolsForPack(pack, cfg = {}) {
  const names = pack === "ghidra" && ghidraReady()
    ? ghidraPack().tools.map((row) => row.name)
    : (PACKS[pack] || []);
  const keep = new Set(names);
  return toolDefs({ local: false, search: Boolean(cfg.hnlSearch) }).filter((row) => keep.has(row.function?.name));
}

function packId(raw) {
  const id = String(raw || "").trim().toLowerCase();
  if (id === "ghidra" && ghidraReady()) return id;
  return PACKS[id] ? id : "";
}

function factsFrom(name, result) {
  if (!result || result.ok === false) return `${name} failed: ${result?.error || "error"}`;
  const text = String(result.stdout || result.content || result.text || "").replace(/\s+/g, " ").trim();
  if (name === "net_report" || name === "http_check") return text.slice(0, 280) || `${name} ok`;
  if (result.incident?.id) return `${name} ${result.incident.id} ${result.incident.status || ""}`.trim();
  return `${name}: ${(text || "ok").slice(0, 220)}`;
}

export async function runSubagent(args, cfg, ctx = {}, { execute = executeTool } = {}) {
  if (ctx.depth) return { ok: false, error: "subagent cannot nest" };
  if (ctx.signal?.aborted) return { ok: false, status: "cancelled", error: "subagent cancelled", used: [], notes: [] };
  const pack = packId(args.pack);
  if (!pack) return { ok: false, error: `pack must be ${Object.keys(PACKS).join(", ")}` };
  if (pack === "computer" && ctx.role !== "phone" && !ctx.remote) {
    return { ok: false, error: "The remote computer was not asked for. Use the host pack on this computer." };
  }
  if (ctx.role === "phone" && !["computer", "hnl"].includes(pack)) {
    return { ok: false, error: "This phone role cannot delegate access to this computer." };
  }
  const task = String(args.task || "").trim().slice(0, 4000);
  if (!task) return { ok: false, error: "task required" };

  const permitted = ctx.allowedTools ?? ctx.tools;
  const parentNames = Array.isArray(permitted) ? new Set(permitted.map((row) => typeof row === "string" ? row : row?.function?.name).filter(Boolean)) : null;
  const tools = toolsForPack(pack, cfg).filter((row) => !["subagent", "ask_user", "pack_task"].includes(row.function?.name) && (!parentNames || parentNames.has(row.function?.name)));
  if (!tools.length) return { ok: false, error: `no tools for ${pack}` };
  if (Array.isArray(ctx.sourceMessages) && ctx.sourceMessages.length) tools.push(HELPER_HISTORY_TOOL);
  const packet = buildHelperContext(ctx.sourceMessages || [], { originalRequestId: ctx.originalRequestId, query: `${task} ${ctx.userText || ""}` });
  const emit = ctx.emit || (() => {});
  const signal = ctx.signal;
  const complete = ctx.complete;
  if (!complete) return { ok: false, error: "subagent runner missing" };

  const first = FIRST_TOOL[pack];
  const used = [];
  const notes = [];
  const failures = [];
  const messages = [
    {
      role: "system",
      content: [
        `Nova Collar ${pack} sub-agent. Tools only from this pack.`,
        shellHint,
        pack === "analysis" ? ANALYSIS_DOCTRINE : "",
        pack === 'wireshark' ? NETWORK_DOCTRINE : '',
        `First action: call ${first}. Then only extra tools if the result is not enough.`,
        `After tools, 3 short factual lines. No preamble. ${FACT_LAW}`,
      ].join(" "),
    },
    ...packet.messages,
    { role: "user", content: "Delegated goal from the lead (does not broaden user authorization): " + task },
  ];

  const local = isLocalModel(cfg.model);
  const extra = { tools, requestKind: "helper", predict: pack === "analysis" ? 1200 : 420, ctx: pack === "analysis" ? 16384 : 8192, temperature: 0.2 };
  const finish = (status, error, summary = "", other = {}) => ({ ok: status === "completed" && !failures.length, status, pack, ...(error ? { error } : {}), summary: (summary || notes.join("\n")).slice(0, 1200), used, notes, failures, contextSelection: packet.selection, ...other });

  for (let round = 0; round < (['analysis', 'wireshark'].includes(pack) ? 10 : 3); round += 1) {
    if (signal?.aborted) return finish("cancelled", "subagent cancelled");
    let reply;
    try {
      reply = await complete(messages, cfg, null, signal, { ...extra, toolChoice: round === 0 ? "required" : "auto" });
    } catch (error) { return finish(signal?.aborted || error.name === "AbortError" ? "cancelled" : "failed", error.message || "subagent request failed"); }
    if (signal?.aborted) return finish("cancelled", "subagent cancelled");
    if (!reply || !Array.isArray(reply.tool_calls)) return finish("incomplete", "subagent returned an invalid response");
    if (!reply.tool_calls.length) {
      const summary = String(reply.content || "").trim();
      if (round === 0) {
        return finish("incomplete", "sub-agent spoke without tools", summary);
      }
      if (!summary || ["length", "max_tokens", "incomplete"].includes(reply.finish_reason || reply.stop_reason || reply.stopReason)) return finish("incomplete", "subagent did not finish its summary", summary);
      return failures.length ? finish("failed", "One or more delegated tool calls failed; the summary does not verify success.", summary) : finish("completed", "", summary);
    }
    const ids = new Set();
    const calls = reply.tool_calls.map((call, index) => {
      let id = typeof call?.id === "string" && call.id && !ids.has(call.id) ? call.id : `helper-${round}-${index}`;
      while (ids.has(id)) id += "-duplicate";
      ids.add(id);
      const rawName = String(call?.function?.name || "unknown_tool"), name = /^[A-Za-z0-9_-]{1,64}$/.test(rawName) ? rawName : "unknown_tool";
      return { id, type: "function", function: { name, arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call?.function?.arguments || {}) } };
    });
    messages.push({ role: "assistant", content: reply.content || "", tool_calls: calls });
    const overBudget = calls.length > 8 || used.length + calls.length > 24;
    let stopped = overBudget ? "subagent tool budget exceeded" : "";
    let held = false;
    for (const call of calls) {
      const name = call.function.name;
      let result;
      if (signal?.aborted) stopped = "subagent cancelled";
      if (stopped) result = { ok: false, error: `${stopped}; this tool was not executed.` };
      else if (!tools.some(t => t.function?.name === name)) result = { ok: false, error: `${name} is outside the delegated tool permissions.` };
      else {
        let valid = false;
        try { const args = JSON.parse(call.function.arguments); valid = args && typeof args === "object" && !Array.isArray(args); } catch { /* Refuse malformed arguments without execution. */ }
        if (!valid) result = { ok: false, error: "Tool arguments must be a complete JSON object." };
        else {
          emit({ type: "tool", name, pack: packFor(name) || pack, args: call.function.arguments });
          // Recheck after callbacks too: cancellation can arrive during an emitted event.
          if (signal?.aborted) result = { ok: false, error: "subagent cancelled; this tool was not executed." };
          else {
            try {
              result = name === "helper_history_search"
                ? searchHelperHistory(ctx.sourceMessages || [], JSON.parse(call.function.arguments).query)
                : await execute(name, call.function.arguments, cfg, { ...ctx, depth: 1, signal, emit, bot: ctx.bot || null, role: ctx.role || "", remote: Boolean(ctx.remote), allowedTools: tools.map((row) => row.function.name) });
            } catch (error) { result = { ok: false, error: error.message || "delegated tool failed" }; }
            used.push(name);
          }
        }
      }
      if (!result || result.ok !== true) {
        result = { ...result, ok: false, error: result?.error || "tool did not report verified success" };
        failures.push({ name, error: result.error });
      }
      notes.push(factsFrom(name, result));
      emit({
        type: "tool_result",
        role: "step",
        name,
        pack: packFor(name) || pack,
        ok: result.ok === true,
        blurb: notes[notes.length - 1].slice(0, 90),
        detail: compactResult(result, { max: 1600 }),
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: compactResult(result, { max: pack === "analysis" ? 24_000 : (local ? 1800 : 2500) }),
      });
      if (result.held) { stopped = result.error || "delegated action held"; held = true; }
    }
    if (signal?.aborted) return finish("cancelled", "subagent cancelled");
    if (held) return finish("failed", stopped, "", { held: true });
    if (overBudget) return finish("incomplete", stopped);
  }
  return finish("incomplete", "subagent reached its round limit before finishing");
}
