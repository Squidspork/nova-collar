export function createTimeline() {
  const rows = [];
  let buf = "";

  function flush() {
    const text = buf.replace(/^\n+|\n+$/g, "");
    buf = "";
    if (text.trim()) rows.push({ role: "assistant", content: text });
  }

  return {
    delta(text) {
      buf += String(text || "");
    },
    retract() {
      buf = "";
    },
    step(row) {
      flush();
      if (!row?.name) return;
      rows.push({
        role: "step",
        name: row.name,
        pack: row.pack || "",
        ok: row.ok !== false,
        blurb: row.blurb || "",
        detail: row.detail || "",
      });
    },
    finish(finalText) {
      flush();
      const last = [...rows].reverse().find((row) => row.role === "assistant");
      const text = String(finalText || "").trim();
      if (text && last) last.content = text;
      else if (text) rows.push({ role: "assistant", content: text });
      return rows;
    },
  };
}

export function mergeAssistants(rows, limit = 24) {
  const out = [];
  for (const row of rows || []) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const prev = out[out.length - 1];
    if (row.role === "assistant" && prev?.role === "assistant") {
      prev.content = `${prev.content}\n${row.content}`.trim();
    } else {
      out.push({ role: row.role, content: String(row.content || "") });
    }
  }
  return out.slice(-Math.max(1, limit));
}
