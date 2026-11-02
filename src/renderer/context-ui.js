(() => {
  const report = document.getElementById("context-report");
  if (!report || !window.pup.contextInfo) return;
  async function inspect(view) {
    report.textContent = "Reading local context metadata…";
    try {
      const result = await window.pup.contextInfo(view);
      if (!result.ok) throw new Error(result.error || "Context metadata could not be read.");
      const value = result.snapshot;
      if (!value) { report.textContent = "No dispatched request metadata is saved for this chat. Choose next preview to inspect local assembly."; return; }
      const number = n => Math.round(Number(n) || 0).toLocaleString();
      const lines = [value.kind === "request" ? "Last dispatched request" : "Next request preview", `${value.model} · ${value.capturedAt}`,
        `Input ~${number(value.tokens.input)} tokens`, `Message tokens ~${number(value.tokens.messages)} · schema tokens ~${number(value.tokens.schemas)}`,
        `Window ${number(value.tokens.window)} · reply ${number(value.tokens.reserve)} · headroom ~${number(value.tokens.headroom)}`,
        `Sent ${number(value.conversation.sentMessages)} messages · compacted ${number(value.conversation.compactedMessages)} · summary ${value.compaction.activeSummary ? "active" : "inactive"}`,
        `${value.tools.count} tool schemas, including inspection when offered`, ""];
      for (const section of value.sections) {
        lines.push(`${section.name} · ${section.representation} · ~${number(section.tokens)} tokens`);
        for (const path of section.sources) lines.push(`  ${path}`);
        if (section.omittedSources) lines.push(`  ${number(section.omittedSources)} more source paths omitted`);
      }
      lines.push("", "Tool schema costs");
      for (const tool of value.tools.entries) lines.push(`${tool.name} · ~${number(tool.tokens)} tokens · ${tool.source}`);
      if (value.tools.omitted) lines.push(`${number(value.tools.omitted)} more tool schemas included in the total`);
      lines.push("", value.estimate, value.note);
      report.textContent = lines.join("\n");
    } catch (error) { report.textContent = error.message || "Context metadata could not be read."; }
  }
  document.getElementById("context-last")?.addEventListener("click", () => inspect("last"));
  document.getElementById("context-next")?.addEventListener("click", () => inspect("next"));
})();
