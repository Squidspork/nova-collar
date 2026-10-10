import { redactSecrets } from "./safe.js";

// The visible timeline is not an inference transcript: it omits reasoning,
// tool-call IDs, arguments, and results. Keep the wire conversation separately.
export function assistantMessage(reply) {
  return {
    role: "assistant",
    content: String(reply.content || ""),
    ...(reply.reasoning_content ? { reasoning_content: String(reply.reasoning_content) } : {}),
    ...(reply.tool_calls?.length ? { tool_calls: reply.tool_calls } : {}),
  };
}

export function cleanModelHistory(rows, { maxTurns = 12, maxChars = 240_000 } = {}) {
  if (!Array.isArray(rows)) return [];
  const clean = rows.flatMap((row) => {
    if (!row || !["user", "assistant", "tool"].includes(row.role)) return [];
    const content = Array.isArray(row.content) ? row.content.flatMap((part) => {
      if (part?.type === "text") return [{ type: "text", text: redactSecrets(String(part.text || "")) }];
      if (part?.type === "image_url" && typeof part.image_url?.url === "string") return [{ type: "image_url", image_url: { ...part.image_url } }];
      if (part?.type === "input_audio" && typeof part.input_audio?.data === "string") return [{ type: "input_audio", input_audio: { ...part.input_audio } }];
      return [];
    }) : redactSecrets(String(row.content || ""));
    const next = { role: row.role, content };
    if (row.role === "assistant") {
      if (typeof row.reasoning_content === "string") next.reasoning_content = redactSecrets(row.reasoning_content);
      if (Array.isArray(row.tool_calls)) {
        next.tool_calls = row.tool_calls.filter((call) => call?.id && call.function?.name && typeof call.function.arguments === "string")
          .map((call) => ({ id: String(call.id), type: "function", function: {
            name: String(call.function.name), arguments: redactSecrets(call.function.arguments),
          } }));
        if (!next.tool_calls.length) delete next.tool_calls;
      }
    }
    if (row.role === "tool") {
      if (!row.tool_call_id) return [];
      next.tool_call_id = String(row.tool_call_id);
      if (row.name) next.name = String(row.name);
    }
    return [next];
  });
  // Older transcripts may insert a screenshot between two tool results. Put
  // those attachments after the results so the API receives a contiguous group.
  for (let i = 0; i < clean.length; i += 1) {
    if (!clean[i].tool_calls) continue;
    let end = i + 1;
    while (end < clean.length && (clean[end].role === "tool" || (clean[end].role === "user" && Array.isArray(clean[end].content)))) end += 1;
    const group = clean.slice(i + 1, end);
    clean.splice(i + 1, group.length, ...group.filter(row => row.role === "tool"), ...group.filter(row => row.role !== "tool"));
  }
  // Keep call/result groups intact when an interrupted/held turn had no result.
  for (let i = 0; i < clean.length; i += 1) {
    const row = clean[i];
    if (!row.tool_calls) continue;
    const ids = new Set();
    for (let j = i + 1; j < clean.length && clean[j].role === "tool"; j += 1) ids.add(clean[j].tool_call_id);
    row.tool_calls = row.tool_calls.filter((call) => ids.has(call.id));
    if (!row.tool_calls.length) delete row.tool_calls;
  }
  let pending = new Set();
  const paired = clean.filter((row) => {
    if (row.role !== "tool") { pending = new Set((row.tool_calls || []).map((call) => call.id)); return true; }
    if (!pending.has(row.tool_call_id)) return false;
    pending.delete(row.tool_call_id);
    return true;
  });
  const turns = [];
  for (const row of paired) {
    if (row.role === "user" || !turns.length) turns.push([]);
    turns.at(-1).push(row);
  }
  // Drop whole old turns, never truncate JSON arguments or a reasoning block.
  let size = turns.reduce((n, turn) => n + JSON.stringify(turn).length, 0);
  while (turns.length > 1 && (turns.length > maxTurns || size > maxChars)) size -= JSON.stringify(turns.shift()).length;
  return turns.flat();
}
