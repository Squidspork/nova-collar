import assert from "node:assert/strict";
import fs, { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "nova-context-info-"));
process.env.NOVAPUP_HOME = join(home, "profile");
const { instructionContext } = await import("../src/main/instruction-context.js");
const { CONTEXT_INFO_TOOL, budgetContext, contextSnapshot, contextView, describeContext, lastContextSnapshot, saveContextSnapshot } = await import("../src/main/context.js");
const { complete, previewContextInfo } = await import("../src/main/agent.js");
const { ensureHome, loadConfig, saveKeys } = await import("../src/main/config.js");
const { refreshCatalog } = await import("../src/main/model-catalog.js");
const { bootSessions } = await import("../src/main/sessions.js");
ensureHome();

test("instruction files are complete, scoped and truthfully represented; referenced documents stay out", () => {
  const root = join(home, "project"), nested = join(root, "child"); mkdirSync(nested, { recursive: true });
  const instructions = join(home, "operator"); mkdirSync(instructions);
  writeFileSync(join(instructions, "personality.md"), "voice");
  const fullRule = "Long operator rule ".repeat(80) + "END_OF_FULL_RULE";
  writeFileSync(join(instructions, "rules.md"), fullRule);
  writeFileSync(join(instructions, "AGENTS.md"), "Global scope instruction.");
  writeFileSync(join(root, "AGENTS.md"), "Read private-reference.txt only when relevant.");
  writeFileSync(join(root, "private-reference.txt"), "REFERENCED_BODY_MUST_NOT_LOAD");
  writeFileSync(join(nested, "AGENTS.md"), "Nearer scoped instruction.");
  const result = instructionContext(nested, { home: instructions });
  assert(result.text.includes(fullRule)); assert(!result.text.includes("REFERENCED_BODY_MUST_NOT_LOAD"));
  assert(result.sections.some(row => row.sources.includes(join(nested, "AGENTS.md")) && row.representation === "full instruction file"));
  assert(result.text.indexOf("Global scope") < result.text.indexOf("Nearer scoped"));
  mkdirSync(join(nested, ".nova"));
  writeFileSync(join(nested, ".nova/SYSTEM.md"), "<!-- replace -->\nMy chosen system wording.");
  const replaced = instructionContext(nested, { home: instructions });
  assert(replaced.replaceDefaults); assert(!replaced.text.includes(fullRule)); assert(replaced.text.includes("Nearer scoped instruction"));
  assert(replaced.sections.some(row => row.representation.includes("retains harness policy")));
  writeFileSync(join(nested, ".nova/SYSTEM.md"), "x".repeat(65537));
  assert.throws(() => instructionContext(nested, { home: instructions }), /not truncated/);
});

test("metadata reports costs, source representations and its own schema without duplicating contents", () => {
  const secretText = "PROMPT_BODY_SENTINEL", schemaText = "SCHEMA_BODY_SENTINEL";
  const tools = [CONTEXT_INFO_TOOL, { type: "function", function: { name: "fixture", description: schemaText, parameters: { type: "object", properties: { value: { type: "string", description: schemaText } } } } }];
  const messages = [{ role: "system", content: secretText }, { role: "user", content: "FILE_BODY_SENTINEL" }];
  const budget = budgetContext(messages, { tools, contextTokens: 20000, outputTokens: 500, persist: false });
  const snapshot = contextSnapshot({ model: "fixture", messages: budget.messages, tools, budget, contextTokens: 20000, outputTokens: 500, kind: "request",
    sections: [{ name: "Project instructions", chars: 1000, representation: "full instruction file", sources: ["/project/AGENTS.md"] }] });
  const serialized = JSON.stringify(snapshot);
  for (const text of [secretText, schemaText, "FILE_BODY_SENTINEL", "parameters", "description"]) assert(!serialized.includes(text));
  assert(snapshot.tokens.schemas > 0); assert.equal(snapshot.tools.count, 2);
  assert(snapshot.tools.entries.some(row => row.name === "context_info" && row.tokens > 0));
  const provenance = contextSnapshot({ tools: ["project_lookup", "helper_history_search"].map(name => ({ type: "function", function: { name } })) });
  assert.equal(provenance.tools.entries.find(row => row.name === "project_lookup").source, "local project registry");
  assert.equal(provenance.tools.entries.find(row => row.name === "helper_history_search").source, "incorporated lead conversation");
  assert.equal(snapshot.sections[0].sources[0], "/project/AGENTS.md");
  assert.equal(contextView({}), "last"); assert.equal(contextView({ view: "next" }), "next");
  assert.throws(() => contextView({ view: "all", prompt: true }), /last or next/);
  assert(describeContext(snapshot).includes("Last dispatched request"));
  saveContextSnapshot("privacy", snapshot);
  assert.deepEqual(lastContextSnapshot("privacy"), snapshot);
  assert.throws(() => saveContextSnapshot("privacy", { ...snapshot, kind: "preview" }), /Only dispatched/);
});

test("actual post-compaction requests persist metadata, cap small-model output, and helpers cannot replace lead metadata", async () => {
  saveKeys({ chatUrl: "https://fixture.invalid/v1", chatKey: "fixture-key", model: "context-fixture" });
  let context = 4096;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "context-fixture", tool_call: true, limit: { context, output: 8192 } }] });
    assert(String(url).endsWith("/chat/completions")); requests.push(JSON.parse(options.body));
    return new Response('data: {"choices":[{"delta":{"content":"fixture"}}]}\n\ndata: [DONE]\n\n');
  };
  await refreshCatalog(loadConfig(), { force: true });
  const messages = [{ role: "system", content: "policy" }];
  for (let i = 0; i < 8; i++) messages.push({ role: "user", content: `Old goal ${i} ` + "A".repeat(800) }, { role: "assistant", content: "B".repeat(600) });
  messages.push({ role: "user", content: "Current request" });
  await complete(messages, loadConfig(), null, undefined, { sessionId: "actual", tools: [CONTEXT_INFO_TOOL], contextSections: [{ name: "Fixture", chars: 6, representation: "built in", sources: [] }] });
  assert.equal(requests[0].max_tokens, 1024, "valid small contexts reserve a bounded reply rather than exceeding the window");
  const snapshot = lastContextSnapshot("actual");
  assert.equal(snapshot.kind, "request"); assert(snapshot.conversation.compactedMessages > 0);
  assert.equal(snapshot.conversation.sentMessages, requests[0].messages.length);
  assert.equal(snapshot.roles.user.messages, requests[0].messages.filter(row => row.role === "user").length);
  const previous = JSON.stringify(snapshot);
  await complete([{ role: "user", content: "helper-only content" }], loadConfig(), null, undefined, { sessionId: "actual", requestKind: "helper", tools: [] });
  assert.equal(JSON.stringify(lastContextSnapshot("actual")), previous);
  const count = requests.length;
  previewContextInfo([], { sessionId: "actual", assembledMessages: [{ role: "user", content: "fresh preview" }], tools: [CONTEXT_INFO_TOOL] });
  assert.equal(requests.length, count); assert.equal(JSON.stringify(lastContextSnapshot("actual")), previous);
  context = 128000; await refreshCatalog(loadConfig(), { force: true });
  let memoryReads = 0;
  const originalRead = fs.readFileSync;
  fs.readFileSync = function(path, ...args) { if (String(path).includes("/project-memory/")) memoryReads++; return originalRead.call(this, path, ...args); };
  syncBuiltinESMExports();
  try {
    const preview = previewContextInfo([], { sessionId: "actual" });
    assert.equal(preview.kind, "preview"); assert(preview.sections.some(row => row.name === "Deferred retrieval"));
    assert.equal(memoryReads, 0, "inspection must not perform a project memory search");
    assert.equal(requests.length, count);
  } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
});

test("context commands inspect saved metadata locally without displaying prompt contents", () => {
  const session = bootSessions().session;
  const snapshot = contextSnapshot({ kind: "request", model: "context-fixture", messages: [{ role: "user", content: "PRIVATE_BODY_NEVER_IN_REPORT" }], tools: [CONTEXT_INFO_TOOL] });
  saveContextSnapshot(session.id, snapshot);
  const guard = join(home, "no-network.cjs"); writeFileSync(guard, "globalThis.fetch=async()=>{throw new Error('NETWORK_FORBIDDEN')};");
  const child = spawnSync(process.execPath, ["src/cli/np.js", "/context"], { cwd: new URL("..", import.meta.url), env: { ...process.env, NODE_OPTIONS: `--require=${guard}` }, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); assert(child.stdout.includes("Last dispatched request"));
  assert(!child.stdout.includes("PRIVATE_BODY_NEVER_IN_REPORT")); assert(!child.stdout.includes("NETWORK_FORBIDDEN"));
});

test.after(() => rmSync(home, { recursive: true, force: true }));
