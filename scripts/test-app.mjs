// Exercise the real Electron window and PTY without any model/GPU calls.
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "nova-app-test-"));
process.env.NOVAPUP_HOME = join(home, "settings");
process.env.NP_LAYA_MODEL = join(home, "no-model");
app.setPath("userData", join(home, "electron"));
app.setPath("sessionData", join(home, "electron"));
// Model discovery is a deterministic fixture; inference is forbidden in this test.
const mimo = "MiMo-V2.6-Flash-RL-MLX-4bit-MTP";
let modelScans = 0;
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/api/tags")) return Response.json({ models: [{ name: "qwen3.8:27b" }, { name: "custom:test" }] });
  if (String(url).endsWith("/models")) {
    modelScans++;
    return Response.json({ data: [{ id: "nova-pup:4b" }, { id: "nova-pup:27b" }, { id: mimo, description: "MiMo V2.6 Flash — fixture" }, ...(modelScans > 1 ? [{ id: "brand-new-model" }] : [])] });
  }
  throw new Error(`Unexpected network request in app smoke test: ${url}`);
};
const deadline = setTimeout(() => { console.error("App smoke test timed out"); app.exit(1); }, 60_000);
const until = async (fn) => { for (let n = 0; n < 120; n++) { if (await fn()) return; await delay(100); } throw new Error("Timed out waiting for app state"); };
async function testApp() {
try {
  const { ensureHome, loadConfig, saveKeys } = await import("../src/main/config.js");
  ensureHome();
  saveKeys({ chatUrl: "https://ai.hungrynova.com/v1", chatKey: "fixture-key", model: "nova-pup:27b" });
  const cwd = join(home, "project with spaces"); mkdirSync(cwd);
  writeFileSync(join(process.env.NOVAPUP_HOME, "workdir.json"), JSON.stringify({ path: cwd }));
  await import("../src/main/index.js");
  await until(() => BrowserWindow.getAllWindows().some(w => !w.webContents.isLoading()));
  const win = BrowserWindow.getAllWindows()[0];
  const js = source => win.webContents.executeJavaScript(source);
  await until(() => js('Boolean(window.pup && document.getElementById("approval-dialog"))'));
  const state = await js('window.pup.state()');
  assert.ok(state.localModels.some(m => m.model === "qwen3.8:27b"));
  await until(() => js(`window.pup.state().then(s => s.models.some(m => m.id === ${JSON.stringify(mimo)}))`));
  await js('document.getElementById("model-btn").click()');
  await until(() => js('document.getElementById("models-list").textContent.includes("MiMo V2.6 Flash")'));
  await js(`Array.from(document.querySelectorAll("#models-list button")).find(b => b.textContent.includes("MiMo V2.6 Flash")).click()`);
  await until(() => loadConfig().model === mimo);
  assert.equal((await js('window.pup.state()')).split.on, false);
  await js('window.pup.refreshModels()');
  assert.ok((await js('window.pup.state()')).models.some(m => m.id === "brand-new-model"));
  await js('window.hidePanels()');
  await js('window.pup.setupSkip()');
  await js('window.pup.setupUse({url:"http://127.0.0.1:11434/v1",model:"custom:test"})');
  const selected = await js('window.pup.state()');
  assert.equal(selected.localModel, "custom:test");
  const { readTerminal, sendTerminal } = await import("../src/main/term-bridge.js");
  const marker = "NOVA_PTY_" + Date.now();
  const command = process.platform === "win32" ? `Write-Output ('${marker.slice(0,9)}' + '${marker.slice(9)}')` : `printf '%s%s\\n' '${marker.slice(0,9)}' '${marker.slice(9)}'`;
  assert.equal(sendTerminal(command).ok, true);
  await until(() => readTerminal().includes(marker));
  const file = join(cwd, "fixture.txt");
  const original = Array.from({length:40}, (_, i) => `Keep line ${i}`).join("\n");
  const { executeTool } = await import("../src/main/tools.js");
  for (const allowed of [false, true]) {
    writeFileSync(file, original);
    const pending = executeTool("host_file_write", {path:file, content:""}, loadConfig());
    await until(() => js('document.getElementById("approval-dialog").open'));
    assert.equal(readFileSync(file,"utf8"), original);
    assert.ok(await js('document.getElementById("approval-detail").textContent.includes("fixture.txt")'));
    if (process.env.NOVA_TEST_SCREENSHOT) writeFileSync(process.env.NOVA_TEST_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    await js(`document.getElementById("approval-${allowed ? "allow" : "deny"}").click()`);
    const result = await pending;
    assert.equal(allowed ? result.ok : result.held, true);
    assert.equal(readFileSync(file,"utf8"), allowed ? "" : original);
    await until(() => js('!document.getElementById("approval-dialog").open'));
  }
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, "window must not overflow horizontally");
  console.log(`PASS ${process.platform}: Electron window, model picker, native PTY, approval deny/allow, empty write, layout`);
  clearTimeout(deadline);
  app.quit();
} catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }

}
void testApp();
