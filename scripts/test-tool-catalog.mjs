import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "nova-tool-catalog-"));
process.env.NOVAPUP_HOME = join(home, "profile");
process.env.NP_LAYA_MODEL = join(home, "no-model");
const { createToolCatalog } = await import("../src/main/tool-catalog.js");
const { estimatedTokens, lastContextSnapshot } = await import("../src/main/context.js");
const { ensureHome } = await import("../src/main/config.js");
const { runTurn } = await import("../src/main/agent.js");
const tool = (name, description = "", properties = {}) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required: Object.keys(properties) } } });

test("progressive disclosure retains exact schemas, bounded metadata and immutable authority", () => {
  const original = [tool("host_facts"), ...Array.from({ length: 30 }, (_, i) => tool(`private_animation_${i}`, "Animation evidence ".repeat(40), { revision: { type: "integer" }, times: { type: "array", items: { type: "number" } } }))];
  const catalog = createToolCatalog(original, { ask: "Inspect animation", contextTokens: 12288 });
  assert(catalog.progressive); assert(estimatedTokens(catalog.offered()) <= 12288 * .30);
  const pages = [catalog.inspect({ query: "animation" })];
  while (pages.at(-1).nextOffset !== undefined) pages.push(catalog.inspect({ query: "animation", offset: pages.at(-1).nextOffset }));
  assert.equal(pages.flatMap(page => page.tools).length, 30);
  assert(pages.every(page => page.tools.length <= 12));
  assert.equal(catalog.inspect({ names: ["private_animation_29"] }).ok, true);
  assert.deepEqual(catalog.offered().find(row => row.function.name === "private_animation_29"), original.at(-1));
  const before = JSON.stringify(catalog.offered());
  for (const args of [{ names: ["forbidden_write"] }, { names: Array(7).fill("host_facts") }, { query: "x".repeat(121) }, { offset: -1 }]) assert.equal(catalog.inspect(args).ok, false);
  assert.equal(JSON.stringify(catalog.offered()), before);
  const scoped = createToolCatalog([tool("host_facts")], { contextTokens: 12288 });
  assert.equal(scoped.inspect({ names: ["private_animation_29"] }).ok, false);
  assert.deepEqual(createToolCatalog(null).offered(), []);
});

test("an oversized selected schema fails without replacing a usable selection", () => {
  const catalog = createToolCatalog([tool("small"), tool("too_large", "x".repeat(20000))], { contextTokens: 12288 });
  assert(catalog.inspect({ names: ["small"] }).ok);
  const before = JSON.stringify(catalog.offered());
  assert.equal(catalog.inspect({ names: ["too_large"] }).ok, false);
  assert.equal(JSON.stringify(catalog.offered()), before);
});

test("fresh local Hello dispatches once with bounded schemas and matching effective context metadata", async () => {
  ensureHome();
  const cwd = process.cwd(), previousFetch = globalThis.fetch;
  process.chdir(home);
  const requests = [];
  globalThis.fetch = async (url, options) => {
    assert(String(url).endsWith("/chat/completions")); requests.push(JSON.parse(options.body));
    return new Response('data: {"choices":[{"delta":{"content":"Hello."}}]}\n\ndata: [DONE]\n\n');
  };
  try {
    const result = await runTurn([], "Hello.", () => {}, undefined, { sessionId: "hello", askUser: async () => { throw Error("not used"); } });
    assert.equal(result.assistant, "Hello."); assert.equal(requests.length, 1);
    const body = requests[0], snapshot = lastContextSnapshot("hello");
    assert.equal(body.options.num_ctx, 12288); assert.equal(snapshot.tokens.window, body.options.num_ctx);
    assert.equal(snapshot.tokens.overBudget, false); assert(snapshot.tokens.schemas <= body.options.num_ctx * .30);
    assert(body.tools.some(row => row.function.name === "discover_tools"));
    assert(body.tools.some(row => row.function.name === "context_info"));
    assert(body.tools.some(row => row.function.name === "ask_user"));
  } finally { process.chdir(cwd); globalThis.fetch = previousFetch; }
});

test("the lead selects hidden schemas on the next request and rejects out-of-pool execution", async () => {
  const calls = [];
  const tools = [tool("host_facts"), ...Array.from({ length: 24 }, (_, i) => tool(`private_fixture_${i}`, "Optional evidence ".repeat(35), { revision: { type: "integer" } }))];
  const cwd = process.cwd(); process.chdir(home);
  try {
    const result = await runTurn([], "Inspect available capabilities.", () => {}, undefined, { sessionId: "disclosure", tools,
      complete: async (messages, cfg, onDelta, signal, extra) => {
        calls.push(structuredClone(extra.tools));
        if (calls.length === 1) {
          assert(!extra.tools.some(row => row.function.name === "private_fixture_23"));
          return { content: "", tool_calls: [{ id: "load", type: "function", function: { name: "discover_tools", arguments: JSON.stringify({ names: ["private_fixture_23"] }) } }, { id: "premature", type: "function", function: { name: "private_fixture_23", arguments: "{\"revision\":1}" } }] };
        }
        assert.deepEqual(extra.tools.find(row => row.function.name === "private_fixture_23"), tools.at(-1));
        return { content: "Catalog inspected.", tool_calls: [] };
      } });
    assert.equal(calls.length, 2); assert.equal(result.assistant, "Catalog inspected.");
    assert(result.messages.some(row => row.role === "tool" && row.tool_call_id === "load" && JSON.parse(row.content).ok));
    assert(result.messages.some(row => row.tool_call_id === "premature" && /not currently disclosed/.test(row.content)));
    let rounds = 0;
    const forbidden = await runTurn([], "Inspect capabilities.", () => {}, undefined, { sessionId: "scoped", tools: [tool("host_facts")],
      complete: async () => ++rounds === 1 ? { content: "", tool_calls: [{ id: "bad", function: { name: "host_file_write", arguments: JSON.stringify({ path: join(home, "not-written"), content: "bad" }) } }] } : { content: "Unavailable.", tool_calls: [] } });
    assert(forbidden.messages.some(row => row.tool_call_id === "bad" && /permitted catalog/.test(row.content)));
    assert.equal(existsSync(join(home, "not-written")), false);
  } finally { process.chdir(cwd); }
});

test.after(() => rmSync(home, { recursive: true, force: true }));
