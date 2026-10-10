import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "collar-models-"));
process.env.NOVAPUP_HOME = home;
const { catalogModels, refreshCatalog, getCatalog, catalogState } = await import("../src/main/model-catalog.js");
const { saveKeys, loadConfig, publicState, chatTarget, saveLane } = await import("../src/main/config.js");
const { complete } = await import("../src/main/agent.js");
const originalFetch = globalThis.fetch;
const mimo = "MiMo-V2.6-Flash-RL-MLX-4bit-MTP";
try {
  saveKeys({ chatUrl: "https://models.example/v1", chatKey: "test-credential", model: mimo });
  const cfg = loadConfig();
  const wire = { data: [
    { id: mimo, description: "MiMo V2.6 Flash — test model", tool_call: true, limit: { output: 32768 } },
    { id: "future-model", tool_call: false, limit: { output: 512 } },
    { id: "local-3.8" }, { id: "" }, { id: "bad\nmodel" }, { id: 42 },
  ] };
  assert.equal(catalogModels(wire).length, 2);
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, cfg.chatUrl + "/models");
    assert.equal(init.headers.authorization, "Bearer test-credential");
    return Response.json(wire);
  };
  await Promise.all([refreshCatalog(cfg), refreshCatalog(cfg)]);
  assert.equal(requests, 1, "concurrent discovery shares one request");
  await refreshCatalog(cfg);
  assert.equal(requests, 1, "fresh catalog is reused");
  assert.equal(publicState(cfg).models.find(row => row.id === mimo).label, "MiMo V2.6 Flash");
  assert.ok(!publicState(cfg).models.some(row => row.id === "Grove:27b"), "retired defaults are replaced");
  assert.ok(publicState({ ...cfg, model: "custom-saved", fastModel: "old-lane" }).models.some(row => row.id === "custom-saved"));
  assert.ok(publicState({ ...cfg, fastModel: "old-lane" }).models.some(row => row.id === "old-lane"));
  assert.ok(!readFileSync(join(home, "model-catalog.json"), "utf8").includes("test-credential"));
  const restarted = await import("../src/main/model-catalog.js?restart");
  assert.equal(restarted.getCatalog(cfg).models[0].id, mimo, "catalog survives a restart");
  assert.equal(restarted.getCatalog(cfg).models[1].tools, false);
  assert.equal(restarted.getCatalog(cfg).models[1].output, 512);
  assert.equal(getCatalog({ ...cfg, chatKey: "other-account" }), null, "account changes cannot reuse the catalog");
  assert.equal(getCatalog({ ...cfg, chatUrl: "https://other.example/v1" }), null);
  globalThis.fetch = async () => new Response("secret server error", { status: 503 });
  await refreshCatalog(cfg, { force: true });
  assert.equal(getCatalog(cfg).models[0].id, mimo, "offline refresh retains last good catalog");
  assert.match(catalogState(cfg).modelScanError, /503/);
  assert.ok(!catalogState(cfg).modelScanError.includes("secret"));
  globalThis.fetch = async () => Response.json({ data: [] });
  await refreshCatalog(cfg, { force: true });
  assert.equal(getCatalog(cfg).models.length, 2, "empty response cannot erase catalog");
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  };
  const noTools = { ...cfg, model: "future-model" };
  const reply = await complete([{ role: "user", content: "hello" }], noTools, null, null, { predict: 1000 });
  assert.equal(reply.content, "ok");
  assert.equal(sent.model, "future-model");
  assert.equal(sent.max_tokens, 512);
  assert.ok(!("tools" in sent) && !("tool_choice" in sent), "chat-only models omit unsupported tool fields");
  await complete([{ role: "user", content: "hello" }], cfg, null, null);
  assert.equal(sent.model, mimo);
  assert.equal(sent.max_tokens, 8192);
  assert.ok(sent.tools.length > 0);
  saveLane({ lane: "fast", model: "nova-pup:4b" });
  saveKeys({ model: mimo });
  assert.equal(publicState().split.on, false, "selecting MiMo turns off old split routing");
  assert.equal(chatTarget().model, mimo);
  console.log("PASS models: discovery, restart, account/provider isolation, offline fallback, future IDs, capabilities, token limits, MiMo routing");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
}
