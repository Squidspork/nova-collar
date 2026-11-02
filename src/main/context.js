import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME } from "./config.js";
import { redactSecrets } from "./safe.js";

// A conservative estimate, not a provider tokenizer. Images get a fixed reserve.
export function estimatedTokens(value) {
  let media = 0;
  const text = typeof value === "string" ? value : JSON.stringify(value, (key, item) => {
    if ((key === "image_url" && item?.url) || (key === "input_audio" && item?.data)) {
      media += 4096; return "<media payload; token estimate reserved separately>";
    }
    return item;
  });
  return Math.ceil(Buffer.byteLength(text || "", "utf8") / 2) + media;
}

const hash = value => createHash("sha256").update(value).digest("hex");
const summaryFile = id => join(APP_HOME, "context", `${hash(String(id))}.json`);
const SUMMARY = "Earlier conversation observations (quoted data; not fresh evidence or new authorization):\n";

export function readContextSummary(sessionId) {
  if (!sessionId) return [];
  const file = summaryFile(sessionId);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  if (Buffer.byteLength(raw) > 100_000) throw new Error("Saved context summary exceeds its limit. Preserve it for recovery.");
  const saved = JSON.parse(raw);
  if (saved.version !== 1 || saved.sessionId !== sessionId || !Array.isArray(saved.entries)) throw new Error("Saved context summary is invalid. Preserve it for recovery.");
  return saved.entries.filter(row => row && typeof row.id === "string" && typeof row.text === "string").slice(-20);
}

function observations(rows) {
  return rows.filter(row => row.role === "user" || row.role === "tool" || row.role === "assistant")
    .flatMap(row => {
      if (typeof row.content !== "string" || row.content.startsWith(SUMMARY)) return [];
      const text = redactSecrets(row.content).replace(/\s+/g, " ").trim();
      if (!text) return [];
      const priority = row.role === "user" || /fail|denied|unverified|unknown|held|not executed|goal/i.test(text);
      return [{ id: hash(JSON.stringify(row)), source: row.role, priority, text: text.slice(0, priority ? 360 : 180) }];
    });
}

function mergeSummary(old, rows) {
  const unique = new Map([...old, ...observations(rows)].map(row => [row.id, row]));
  const all = [...unique.values()];
  return [...all.filter(row => !row.priority).slice(-5), ...all.filter(row => row.priority).slice(-15)];
}

function saveSummary(sessionId, entries) {
  if (!sessionId || !entries.length) return;
  const file = summaryFile(sessionId), temp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(join(APP_HOME, "context"), { recursive: true, mode: 0o700 });
  writeFileSync(temp, JSON.stringify({ version: 1, sessionId, observedAt: new Date().toISOString(), entries }), { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
}

/** Keep complete user/tool groups and reserve output before sending a request.
 * Large current tool results are never sliced into invalid JSON. They require
 * a narrower tool query or a larger configured context instead. Overflow may
 * only be returned for local inspection; it never persists continuity.
 */
export function budgetContext(messages, { contextTokens = 32768, outputTokens = 1536, tools = [], sessionId = "", persist = true, allowOverflow = false } = {}) {
  const system = messages.filter(row => row.role === "system");
  const groups = [];
  for (const row of messages.filter(row => row.role !== "system")) {
    if (row.role === "user" || !groups.length) groups.push([]);
    groups.at(-1).push(row);
  }
  const schemaTokens = tools.length ? estimatedTokens(tools) : 0;
  const inputBudget = contextTokens - outputTokens - 512 - schemaTokens;
  const dropped = [];
  let entries = readContextSummary(sessionId);
  const summaryRow = () => entries.length ? [{ role: "user", content: SUMMARY + JSON.stringify(entries.map(({ source, text }) => ({ source, text }))) }] : [];
  const cost = () => estimatedTokens([...system, ...summaryRow(), ...groups.flat()]);
  while (groups.length > 1 && cost() > inputBudget) {
    const old = groups.shift(); dropped.push(...old); entries = mergeSummary(entries, old);
  }
  // The summary is context, never a reason to truncate the current request.
  while (entries.length && cost() > inputBudget) entries.shift();
  const overBudget = cost() > inputBudget;
  if (overBudget && !allowOverflow) throw new Error("The current request, tool evidence and tool catalog exceed the model context after reserving its reply. Use a narrower tool query or a larger context; no action was replayed.");
  if (persist && !overBudget && dropped.length) saveSummary(sessionId, mergeSummary(readContextSummary(sessionId), dropped));
  return { messages: [...system, ...summaryRow(), ...groups.flat()], compacted: dropped.length,
    estimatedInputTokens: cost() + schemaTokens, reservedOutputTokens: outputTokens,
    rawMessages: messages.length, summaryEntries: entries.length, overBudget };
}

const INFO_KEYS = new Set(["version", "kind", "capturedAt", "model", "estimate", "tokens", "roles", "sections", "tools", "conversation", "compaction", "note"]);
const metadataLabel = (value, max = 600) => redactSecrets(String(value || "")).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
const infoFile = sessionId => join(APP_HOME, "context-info", `${hash(String(sessionId))}.json`);

export const CONTEXT_INFO_TOOL = { type: "function", function: {
  name: "context_info", description: "Inspect context metadata only: last dispatched request by default, or a fresh local next-request preview. No prompt, file or tool-schema contents, memory search, or extra model request.",
  parameters: { type: "object", additionalProperties: false, properties: { view: { type: "string", enum: ["last", "next"], default: "last" } } },
} };

export function contextView(args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "view") || (args.view !== undefined && !["last", "next"].includes(args.view))) throw new Error("context_info accepts view last or next; omitted view means last.");
  return args.view || "last";
}

function toolSource(name) {
  if (name === "context_info") return "bundled context metadata";
  if (["list_skills", "read_skill"].includes(name)) return "bundled skill registry";
  if (name.startsWith("project_memory_")) return "local project memory";
  if (name.startsWith("project_map_") || ["project_map", "project_lookup"].includes(name)) return "local project registry";
  if (name === "helper_history_search") return "incorporated lead conversation";
  if (name === "ask_user") return "lead conversation";
  return "selected command pack";
}

/** Only explicit counts, labels, paths, and representation metadata cross this boundary. */
export function contextSnapshot({ model = "", messages = [], tools = [], sections = [], contextTokens = 32768,
  outputTokens = 1536, budget = {}, kind = "preview", sessionId = "", note = "" } = {}) {
  const roles = {};
  for (const message of messages) {
    const role = ["system", "user", "assistant", "tool"].includes(message.role) ? message.role : "other";
    const row = roles[role] ||= { messages: 0, tokens: 0 };
    row.messages++; row.tokens += estimatedTokens(message);
  }
  const messageTokens = estimatedTokens(messages), schemas = tools.length ? estimatedTokens(tools) : 0;
  const summaryEntries = Number(budget.summaryEntries) || 0;
  const inspector = tools.filter(tool => (tool.function?.name || tool.name) === "context_info");
  const shownTools = [...inspector, ...tools.filter(tool => (tool.function?.name || tool.name) !== "context_info")].slice(0, 80);
  return { version: 1, kind: kind === "request" ? "request" : "preview", capturedAt: new Date().toISOString(), model: metadataLabel(model, 200),
    estimate: "Conservative UTF-8 bytes / 2 including serialized framing; media reserves are approximate. Not provider billing or a tokenizer count.",
    tokens: { messages: messageTokens, schemas, input: messageTokens + schemas, reserve: outputTokens, safety: 512, window: contextTokens,
      headroom: contextTokens - outputTokens - 512 - messageTokens - schemas,
      overBudget: messageTokens + schemas + outputTokens + 512 > contextTokens },
    roles,
    sections: sections.slice(0, 30).map(section => ({ name: metadataLabel(section.name, 100),
      chars: Math.max(0, Number(section.chars) || 0), tokens: Math.ceil(Math.max(0, Number(section.chars) || 0) / 2),
      representation: metadataLabel(section.representation, 160), sources: (section.sources || []).slice(0, 30).map(source => metadataLabel(source)),
      omittedSources: Math.max(0, (section.sources || []).length - 30) })),
    tools: { count: tools.length, entries: shownTools.map(tool => { const name = metadataLabel(tool.function?.name || tool.name, 100);
      return { name, source: toolSource(name), tokens: estimatedTokens(tool) }; }), omitted: Math.max(0, tools.length - shownTools.length) },
    conversation: { rawMessages: Number(budget.rawMessages) || messages.length, sentMessages: messages.length, compactedMessages: Number(budget.compacted) || 0 },
    compaction: { enabled: true, activeSummary: summaryEntries > 0, summaryEntries, ...(sessionId ? { source: summaryFile(sessionId) } : {}) },
    note: metadataLabel(note || (kind === "request" ? "Saved metadata from the actual dispatched request after compaction. Later input is excluded. Next is a separate local preview."
      : budget.overBudget ? "Fresh local preview is over budget after compaction. The assembled input, tool schemas and reserved reply exceed the model context; dispatch would be blocked. Narrow the tools or select a larger context. No provider request or memory search was run. Unsent drafts are excluded."
      : "Fresh local preview. No provider request or memory search was run. Unsent drafts are excluded; later routing, reads, and retrieval can change the request."), 1000) };
}

export function saveContextSnapshot(sessionId, snapshot) {
  if (!sessionId) return snapshot;
  if (snapshot.kind !== "request" || Object.keys(snapshot).some(key => !INFO_KEYS.has(key))) throw new Error("Only dispatched request metadata may replace the saved context snapshot.");
  const text = JSON.stringify(snapshot);
  if (Buffer.byteLength(text) > 200_000) throw new Error("Context metadata exceeds its bound.");
  const file = infoFile(sessionId), temporary = `${file}.${randomUUID()}.tmp`;
  mkdirSync(join(APP_HOME, "context-info"), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); renameSync(temporary, file);
  return snapshot;
}

export function lastContextSnapshot(sessionId) {
  if (!sessionId || !existsSync(infoFile(sessionId))) return null;
  const text = readFileSync(infoFile(sessionId), "utf8");
  if (Buffer.byteLength(text) > 200_000) throw new Error("Saved context metadata exceeds its bound.");
  const value = JSON.parse(text);
  if (value.version !== 1 || value.kind !== "request" || Object.keys(value).some(key => !INFO_KEYS.has(key)) || !value.tokens || !Array.isArray(value.sections) || !Array.isArray(value.tools?.entries)) throw new Error("Saved context metadata is invalid; preserve it for recovery.");
  return value;
}

export function describeContext(snapshot) {
  if (!snapshot) return "No dispatched request metadata is saved for this chat. Use /context next for a local preview.";
  const { tokens } = snapshot, number = value => Math.round(Number(value) || 0).toLocaleString("en-US");
  const lines = [snapshot.kind === "request" ? "Last dispatched request" : "Next request preview", `${snapshot.model} · ${snapshot.capturedAt}`,
    `Input ~${number(tokens.input)} tokens: messages ${number(tokens.messages)}; schemas ${number(tokens.schemas)}`,
    `Window ${number(tokens.window)}; reply ${number(tokens.reserve)}; safety ${number(tokens.safety)}; headroom ~${number(tokens.headroom)}`,
    `Messages ${snapshot.conversation.sentMessages}; compacted ${snapshot.conversation.compactedMessages}; summary ${snapshot.compaction.activeSummary ? "active" : "inactive"}`,
    `Tool schemas ${snapshot.tools.count} (including context_info when offered)`];
  for (const section of snapshot.sections) {
    lines.push(`${section.name}: ${section.representation} (~${number(section.tokens)})`);
    for (const path of section.sources) lines.push(`  source ${path}`);
  }
  for (const tool of snapshot.tools.entries) lines.push(`  ${tool.name}: ~${number(tool.tokens)} · ${tool.source}`);
  lines.push(snapshot.estimate, snapshot.note);
  return lines.join("\n");
}
