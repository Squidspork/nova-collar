import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestBudget } from "../src/main/request-budget.js";
import { refreshCatalog } from "../src/main/model-catalog.js";

const home = mkdtempSync(join(tmpdir(), "nova-request-budget-"));
const cfg = { home, chatUrl: "https://budget-fixture.invalid/v1", chatKey: "fixture-key" };
const target = model => ({ url: cfg.chatUrl, key: cfg.chatKey, model, local: false });
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  return Response.json({ data: [
    { id: "large-fixture", limit: { context: 128000, output: 32768 } },
    { id: "short-output-fixture", limit: { context: 4096, output: 512 } },
    { id: "small-fixture:4b", limit: { context: 65536, output: 4096 } },
    { id: "invalid-fixture", limit: { context: "NaN", output: -400 } },
    { id: "infinite-fixture", limit: { context: "Infinity", output: "Infinity" } },
    { id: "numeric-fixture", limit: { context: "8192", output: "900" } },
  ] });
};
await refreshCatalog(cfg, { force: true });
globalThis.fetch = async () => { requests++; throw new Error("Budget calculation must stay local"); };

test("local request budgets match the configured server window", () => {
  const local = { ...target("local-fixture:27b"), local: true };
  assert.deepEqual(requestBudget(cfg, local), { contextTokens: 12288, outputTokens: 1536, lean: true });
  assert.deepEqual(requestBudget(cfg, local, { ctx: 8192, predict: 9000 }), { contextTokens: 8192, outputTokens: 2048, lean: true });
  assert.deepEqual(requestBudget(cfg, local, { ctx: 65536, predict: 65536 }), { contextTokens: 65536, outputTokens: 16384, lean: true });
  assert.deepEqual(requestBudget(cfg, { ...target("short-output-fixture"), local: true }), { contextTokens: 12288, outputTokens: 1536, lean: true }, "local targets intentionally do not borrow hosted catalog limits");
});

test("normalized hosted catalog limits bound replies and retain context precedence", () => {
  assert.deepEqual(requestBudget(cfg, target("large-fixture")), { contextTokens: 128000, outputTokens: 8192, lean: false });
  assert.deepEqual(requestBudget(cfg, target("large-fixture"), { ctx: 4096, predict: 60000 }), { contextTokens: 128000, outputTokens: 32000, lean: false });
  assert.deepEqual(requestBudget(cfg, target("short-output-fixture"), { predict: 1200 }), { contextTokens: 4096, outputTokens: 512, lean: false });
  assert.deepEqual(requestBudget(cfg, target("small-fixture:4b")), { contextTokens: 65536, outputTokens: 1536, lean: true });
  assert.deepEqual(requestBudget(cfg, target("numeric-fixture")), { contextTokens: 8192, outputTokens: 900, lean: false }, "wire numeric strings are normalized by the catalog");
});

test("missing or invalid catalog limits keep existing hosted and small-model fallbacks", () => {
  for (const model of ["unknown-fixture", "invalid-fixture", "infinite-fixture"]) {
    assert.deepEqual(requestBudget(cfg, target(model)), { contextTokens: 32768, outputTokens: 8192, lean: false });
    assert.deepEqual(requestBudget(cfg, target(model), { ctx: 4096, predict: 9000 }), { contextTokens: 4096, outputTokens: 1024, lean: false });
  }
  assert.deepEqual(requestBudget(cfg, target("unknown-fixture:4b")), { contextTokens: 12288, outputTokens: 1536, lean: true });
});

test("invalid explicit limits cannot produce nonfinite or negative budgets", () => {
  for (const invalid of [NaN, Infinity, -Infinity, -1, 0, 0.5, "bad", true, null]) {
    assert.deepEqual(requestBudget(cfg, target("unknown-fixture"), { ctx: invalid, predict: invalid }), { contextTokens: 32768, outputTokens: 8192, lean: false });
    assert.deepEqual(requestBudget(cfg, { ...target("unknown-fixture"), local: true }, { ctx: invalid, predict: invalid }), { contextTokens: 12288, outputTokens: 1536, lean: true });
  }
  assert.deepEqual(requestBudget(cfg, target("unknown-fixture"), { ctx: 8192.9, predict: 400.9 }), { contextTokens: 8192, outputTokens: 400, lean: false });
  assert.deepEqual(requestBudget(cfg, target("unknown-fixture"), { ctx: 512 }), { contextTokens: 512, outputTokens: 256, lean: false }, "tiny contexts retain the existing minimum reserve for dispatch validation");
});

test("budget lookup does not discover models or mutate its inputs", () => {
  const cfgBefore = structuredClone(cfg), current = target("large-fixture"), extra = { predict: 700, ctx: 6000 };
  const currentBefore = structuredClone(current), extraBefore = structuredClone(extra);
  requestBudget(cfg, current, extra);
  assert.deepEqual(cfg, cfgBefore); assert.deepEqual(current, currentBefore); assert.deepEqual(extra, extraBefore);
  assert.equal(requests, 1, "only the test's explicit catalog setup made a request");
});

test.after(() => { globalThis.fetch = originalFetch; rmSync(home, { recursive: true, force: true }); });
