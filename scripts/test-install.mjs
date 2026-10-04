import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const home = mkdtempSync(join(tmpdir(), "np-install-"));
process.env.NOVAPUP_HOME = home;

const { applyEndpoint, choiceList, parseChoice } = await import("../src/main/install.js");

const info = {
  found: [{ name: "Ollama", url: "http://127.0.0.1:11434/v1", models: ["demo"], kind: "ollama" }],
  localFit: { name: "qwen2.5:14b", diskGb: 9, runGb: 12 },
};
assert.equal(parseChoice("", info).source, "found");
assert.equal(parseChoice("", { found: [], localFit: info.localFit }).source, "endpoint");
if (process.platform === "win32") assert.match(parseChoice("2", info).error, /macOS and Linux/);
else assert.equal(parseChoice("2", info).model, "qwen2.5:14b");
assert.equal(parseChoice("3", info).error, "Choose 1 or 2.");
assert.ok(choiceList(info).some((line) => line.startsWith("1. Bring your own")));
assert.equal(choiceList(info).some((line) => /gateway|HNL27b/i.test(line)), false);

const own = applyEndpoint({ url: "https://example.com/v1", model: "my-model" });
assert.equal(own.ok, true);
assert.equal(own.model, "my-model");
assert.equal(own.chatUrl, "https://example.com/v1");
const local = applyEndpoint({ url: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" });
assert.equal(local.localModel, "qwen2.5:7b");
const blocked = applyEndpoint({ url: "http://10.0.0.5:11434/v1", model: "x" });
assert.equal(blocked.ok, false);
const env = readFileSync(join(home, "env"), "utf8");
assert.equal(/hungrynova\.com|HNL27b/.test(env), false);
process.stdout.write("install ok\n");
