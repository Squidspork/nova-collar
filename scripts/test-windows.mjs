import { createServer } from "node:net";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOVAPUP_HOME = mkdtempSync(join(tmpdir(), "nova-windows-test-"));
const { ensureHome, saveLocalModel, saveKeys, chatTarget, loadConfig } = await import("../src/main/config.js");
const { lanesFrom } = await import("../src/main/split.js");
ensureHome();
const { layaVenvPython } = await import("../src/main/laya.js");
assert.equal(layaVenvPython(), join(process.env.NOVAPUP_HOME, "laya", ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"])));
writeFileSync(join(process.env.NOVAPUP_HOME, "env"), [
  "HNL_CHAT_URL=https://ai.hungrynova.com/v1", "HNL_CHAT_KEY=test-key",
  "HNL_FAST_URL=https://ai.hungrynova.com/v1", "HNL_FAST_MODEL=fast",
  "HNL_THINK_URL=https://ai.hungrynova.com/v1", "HNL_THINK_MODEL=think",
].join("\n"));
saveLocalModel({ url: "http://127.0.0.1:11434/v1", model: "qwen3.8:27b" });
let cfg = loadConfig();
assert.equal(chatTarget(cfg).local, true);
assert.equal(chatTarget(cfg).model, "qwen3.8:27b");
assert.equal(lanesFrom(cfg, chatTarget(cfg)).on, false);
assert.equal(cfg.chatKey, "test-key");
saveKeys({ model: "nova-pup:4b" });
assert.equal(chatTarget().local, false);
assert.equal(chatTarget().url, "https://ai.hungrynova.com/v1");
saveKeys({ model: "local-3.8" });
assert.equal(chatTarget().local, true);
console.log("PASS local selection clears remote lanes and preserves selectable Hungry Nova");

if (process.platform === "win32") {
  const { runWatched } = await import("../src/main/guard.js");
  const { runPack } = await import("../src/main/packs.js");
  const { cdCommand } = await import("../src/main/platform.js");
  const { denySecretPath, denySecretCommand } = await import("../src/main/safe.js");
  const dir = mkdtempSync(join(tmpdir(), "nova spaces ' $ "));
  let result = await runWatched(`${cdCommand(dir)}; (Get-Location).Path`, tmpdir());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.stdout.includes(dir));
  result = await runWatched("Write-Output 'NOVA_POWERSHELL_OK'", dir);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.stdout, /NOVA_POWERSHELL_OK/);
  result = await runWatched("throw 'EXPECTED_ERROR'", dir);
  assert.equal(result.ok, false);
  result = await runWatched("Start-Sleep -Seconds 30", dir, { timeoutMs: 500 });
  assert.equal(result.killed, "timeout");
  const unrelated = join(tmpdir(), `nova-unrelated-${Date.now()}.tmp`);
  const readOnly = runWatched("Start-Sleep -Milliseconds 1000; 'TEMP_ISOLATION_OK'", dir);
  try {
    writeFileSync(unrelated, Buffer.alloc(17 * 1024 * 1024));
    result = await readOnly;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(existsSync(unrelated), true, "must not delete another program's temp file");
  } finally {
    if (existsSync(unrelated)) unlinkSync(unrelated);
  }
  assert.ok(denySecretPath("C:\\Users\\test\\.env"));
  assert.ok(denySecretCommand("Get-Content $HOME\\.novapup\\env"));
  result = await runPack("host_facts", {});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.stdout, /Windows/);
  result = await runPack("host_disk", {});
  assert.equal(result.ok, true, JSON.stringify(result));
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  try {
    result = await runPack("host_listen_ports", {});
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.stdout.includes(String(listener.address().port)), "the fixture listener must appear without requiring Ollama");
  } finally { await new Promise(resolve => listener.close(resolve)); }
  const log = join(dir, "sample.txt");
  writeFileSync(log, "alpha\nbeta\n");
  result = await runPack("host_tail_log", { path: log, lines: 1 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.stdout, /beta/);
  assert.doesNotMatch(result.stdout, /alpha/);
  console.log("PASS PowerShell execution, quoted paths, errors, timeout, secrets paths, host facts, disk, ports and logs");
}
