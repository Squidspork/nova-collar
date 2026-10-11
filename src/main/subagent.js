import { shellHint } from "./platform.js";
import { isLocalModel } from "./config.js";
import { FACT_LAW } from "./ground.js";
import { compactResult, executeTool, toolDefs } from "./tools.js";
import { packFor } from "./packs.js";

import { analysisPack, ANALYSIS_DOCTRINE } from "./analysis-pack.js";
import { ghidraPack, ghidraReady } from "./ghidra-mcp.js";

const PACKS = {
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

export async function runSubagent(args, cfg, ctx = {}) {
  if (ctx.depth) return { ok: false, error: "subagent cannot nest" };
  const pack = packId(args.pack);
  if (!pack) return { ok: false, error: `pack must be ${Object.keys(PACKS).join(", ")}` };
  if (pack === "computer" && ctx.role !== "phone" && !ctx.remote) {
    return { ok: false, error: "The remote computer was not asked for. Use the host pack on this computer." };
  }
  const task = String(args.task || "").trim().slice(0, 4000);
  if (!task) return { ok: false, error: "task required" };

  const tools = toolsForPack(pack, cfg);
  if (!tools.length) return { ok: false, error: `no tools for ${pack}` };
  const emit = ctx.emit || (() => {});
  const signal = ctx.signal;
  const complete = ctx.complete;
  if (!complete) return { ok: false, error: "subagent runner missing" };

  const first = FIRST_TOOL[pack];
  const used = [];
  const notes = [];
  const messages = [
    {
      role: "system",
      content: [
        `Nova Collar ${pack} sub-agent. Tools only from this pack.`,
        shellHint,
        pack === "analysis" ? ANALYSIS_DOCTRINE : "",
        `First action: call ${first}. Then only extra tools if the result is not enough.`,
        `After tools, 3 short factual lines. No preamble. ${FACT_LAW}`,
      ].join(" "),
    },
    { role: "user", content: task },
  ];

  const local = isLocalModel(cfg.model);
  const extra = { tools, predict: pack === "analysis" ? 1200 : 420, ctx: pack === "analysis" ? 16384 : 8192, temperature: 0.2 };

  for (let round = 0; round < (pack === "analysis" ? 10 : 3); round += 1) {
    const reply = await complete(messages, cfg, null, signal, {
      ...extra,
      toolChoice: round === 0 ? "required" : "auto",
    });
    if (!reply.tool_calls.length) {
      const summary = String(reply.content || "").trim();
      if (round === 0) {
        return { ok: false, pack, error: "sub-agent spoke without tools", summary, used, notes };
      }
      return { ok: true, pack, summary: (summary || notes.join("\n")).slice(0, 1200), used, notes };
    }
    messages.push({ role: "assistant", content: reply.content || "", tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      const name = call.function.name;
      if (name === "subagent" || !tools.some(t => t.function?.name === name)) {
        notes.push(`skipped ${name}`);
        continue;
      }
      emit({ type: "tool", name, pack: packFor(name) || pack, args: call.function.arguments });
      const result = await executeTool(name, call.function.arguments, cfg, {
        ...ctx,
        depth: 1,
        signal,
        emit,
        bot: ctx.bot || null,
        role: ctx.role || "",
        remote: Boolean(ctx.remote),
      });
      used.push(name);
      notes.push(factsFrom(name, result));
      emit({
        type: "tool_result",
        role: "step",
        name,
        pack: packFor(name) || pack,
        ok: result?.ok !== false,
        blurb: notes[notes.length - 1].slice(0, 90),
        detail: compactResult(result, { max: 1600 }),
      });
      if (result.held) return { ok: false, held: true, error: result.error, used, notes };
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: compactResult(result, { max: pack === "analysis" ? 24_000 : (local ? 1800 : 2500) }),
      });
    }
  }
  return { ok: true, pack, summary: notes.slice(0, 4).join("\n"), used, notes };
}
