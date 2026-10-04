import { realToolName, TOOL_ALIAS, toolDefs } from "./tools.js";

let names = null;

export function knownToolNames() {
  if (!names) {
    names = new Set(toolDefs({ local: false, search: true }).map((row) => row.function?.name).filter(Boolean));
    for (const alias of Object.keys(TOOL_ALIAS)) names.add(alias);
  }
  return names;
}

export function mergeName(prev, incoming) {
  const next = String(incoming || "");
  const cur = String(prev || "");
  if (!next) return cur;
  if (!cur || next === cur) return next || cur;
  if (next.startsWith(cur)) return next;
  if (cur.startsWith(next)) return cur;
  if (cur.endsWith(next)) return cur;
  return `${cur}${next}`;
}

export function mergeArgs(prev, incoming) {
  const next = String(incoming || "");
  const cur = String(prev || "");
  if (!next) return cur;
  if (!cur || next === cur) return next || cur;
  if (next.startsWith(cur)) return next;
  if (cur.startsWith(next)) return cur;
  if (cur.endsWith(next)) return cur;
  return `${cur}${next}`;
}

function nextIndex(calls) {
  let i = 0;
  while (calls.has(i)) i += 1;
  return i;
}

export function applyToolDelta(calls, part) {
  const incomingName = part?.function?.name || "";
  const incomingArgs = part?.function?.arguments || "";
  const incomingId = part?.id || "";
  let index = Number.isInteger(part?.index) ? part.index : null;
  if (index == null) {
    const match = incomingId ? [...calls.entries()].find(([, row]) => row.id === incomingId) : null;
    index = match ? match[0] : nextIndex(calls);
  }
  let current = calls.get(index);
  if (!current) {
    current = { id: incomingId, name: "", arguments: "" };
    calls.set(index, current);
  }
  if (incomingId && current.id && incomingId !== current.id && (current.name || current.arguments)) {
    calls.set(nextIndex(calls), current);
    current = { id: incomingId, name: "", arguments: "" };
    calls.set(index, current);
  }
  if (incomingId) current.id = incomingId;
  if (incomingName) {
    const known = knownToolNames();
    if (current.name && current.name !== incomingName && known.has(current.name) && known.has(incomingName)) {
      calls.set(nextIndex(calls), current);
      current = { id: incomingId || "", name: incomingName, arguments: "" };
      calls.set(index, current);
    } else {
      current.name = mergeName(current.name, incomingName);
    }
  }
  if (incomingArgs) current.arguments = mergeArgs(current.arguments, incomingArgs);
}

export function splitToolName(raw, known = knownToolNames()) {
  const text = String(raw || "");
  if (!text) return [];
  if (known.has(text)) return [text];
  const sorted = [...known].sort((a, b) => b.length - a.length);
  const out = [];
  let rest = text;
  while (rest) {
    const hit = sorted.find((name) => rest.startsWith(name));
    if (!hit) break;
    out.push(hit);
    rest = rest.slice(hit.length);
  }
  return rest ? [] : out;
}

/** Required argument names for one offered tool. */
export function requiredFields(tools, name) {
  const row = (tools || []).find((item) => item?.function?.name === name);
  const required = row?.function?.parameters?.required;
  return Array.isArray(required) ? required.filter((key) => typeof key === "string") : [];
}

/** Why a tool call cannot run yet. Empty means the arguments are finished. */
export function unfinishedArgs(raw, required = []) {
  const text = String(raw ?? "").trim();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    return "arguments are not finished JSON";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "arguments are not an object";
  const missing = required.filter((key) => {
    const value = parsed[key];
    return value == null || (key !== "content" && typeof value === "string" && !value.trim());
  });
  return missing.length ? `missing ${missing.join(", ")}` : "";
}

export function finishToolCalls(calls, { max = 3 } = {}) {
  const known = knownToolNames();
  const rows = [];
  for (const call of calls.values()) {
    if (!call.name) continue;
    const parts = splitToolName(call.name, known);
    const names = parts.length ? parts : [call.name];
    names.forEach((name, i) => {
      rows.push({
        id: i === 0 ? call.id : `${call.id || "call"}_${i}`,
        type: "function",
        function: { name: realToolName(name), arguments: i === 0 ? call.arguments || "{}" : "{}" },
      });
    });
  }
  return rows.slice(0, Math.max(1, max));
}
