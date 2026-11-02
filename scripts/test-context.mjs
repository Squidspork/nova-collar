import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const home = mkdtempSync(join(tmpdir(), "nova-context-test-"));
process.env.NOVAPUP_HOME = home;
const { budgetContext, readContextSummary } = await import("../src/main/context.js");
test("compaction reserves reply tokens, keeps complete tool groups and persists quoted continuity", () => {
  const chain = n => [{ role: "user", content: `Goal ${n}: ` + "A".repeat(500) }, { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "tool", tool_call_id: `c${n}`, content: "unverified " + "B".repeat(500) }];
  const rows = [{ role: "system", content: "policy" }, ...chain(1), ...chain(2), ...chain(3), { role: "user", content: "Continue the original goal." }];
  const result = budgetContext(rows, { contextTokens: 2000, outputTokens: 400, sessionId: "chat" });
  assert(result.compacted > 0);
  assert(result.estimatedInputTokens + result.reservedOutputTokens + 512 <= 2000);
  assert.equal(result.messages.at(-1).content, "Continue the original goal.");
  for (const row of result.messages.filter(row => row.tool_calls)) for (const call of row.tool_calls) assert(result.messages.some(next => next.tool_call_id === call.id));
  assert(readContextSummary("chat").some(row => row.text.includes("Goal 1")));
  assert.equal(readContextSummary("another-chat").length, 0);
  const restored = budgetContext([{ role: "system", content: "policy" }, { role: "user", content: "Next" }], { sessionId: "chat" });
  assert(restored.messages.some(row => String(row.content).includes("not fresh evidence")));
});
test("a single oversized tool result fails closed without truncating call JSON", () => {
  assert.throws(() => budgetContext([{ role: "user", content: "x".repeat(10000) }], { contextTokens: 1000, outputTokens: 400 }), /exceed/);
});
test("schemas and reply cannot consume the window even with a tiny message", () => {
  const messages = [{ role: "user", content: "x" }];
  const tools = [{ type: "function", function: { name: "read", description: "x".repeat(2000) } }];
  assert.throws(() => budgetContext(messages, { contextTokens: 1000, outputTokens: 400, tools }), /exceed/);
  const preview = budgetContext(messages, { contextTokens: 1000, outputTokens: 400, tools, allowOverflow: true, persist: false });
  assert.equal(preview.overBudget, true);
  assert(preview.estimatedInputTokens + preview.reservedOutputTokens + 512 > 1000);
  assert.deepEqual(preview.messages, messages);
});
test.after(() => rmSync(home, { recursive: true, force: true }));
