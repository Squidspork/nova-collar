import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeWatched, beginTurn, endTurn, runWatched } from "../src/main/guard.js";
import { quoteShell } from "../src/main/platform.js";
const cwd = mkdtempSync(join(tmpdir(), "collar-processes-"));

test("pre-cancelled work never starts a shell or writes a file", async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runWatched(`echo no > ${quoteShell(join(cwd, "no"))}`, cwd, { signal: controller.signal });
  assert.equal(result.killed, "stop"); assert.equal(existsSync(join(cwd, "no")), false);
});
test("tracked commands disappear from ownership when they finish", async () => {
  beginTurn({ workdir: cwd });
  const pending = runWatched(`${quoteShell(process.execPath)} -e ${quoteShell('setTimeout(()=>console.log("ok"),100)')}`, cwd);
  assert.equal(activeWatched(cwd).length, 1);
  assert.equal((await pending).ok, true);
  assert.equal(activeWatched(cwd).length, 0);
  assert.deepEqual(endTurn(), []);
});
test("a successful shell cannot leave an unowned descendant writer behind", { skip: process.platform === "win32" }, async () => {
  const pidFile = join(cwd, "child-pid");
  const script = `const {spawn}=require("child_process");const fs=require("fs");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref();`;
  const result = await runWatched(`${quoteShell(process.execPath)} -e ${quoteShell(script)}`, cwd);
  assert.equal(result.ok, true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise(resolve => setTimeout(resolve, 100));
  let state = "";
  try { state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { /* exited */ }
  assert(!state || state.startsWith("Z"), `descendant ${pid} remained active: ${state}`);
});
test.after(() => rmSync(cwd, { recursive: true, force: true }));
