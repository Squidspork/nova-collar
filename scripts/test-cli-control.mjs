import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const home = mkdtempSync(join(tmpdir(), "collar-cli-control-"));
process.env.NOVAPUP_HOME = home;
process.env.NP_LAYA_MODEL = join(home, "no-model");
const { saveKeys } = await import("../src/main/config.js");
const { bootSessions, readSession, saveSession } = await import("../src/main/sessions.js");
const { createConversationCoordinator } = await import("../src/main/conversation.js");
const { setWorkdir } = await import("../src/main/workdir.js");
saveKeys({ chatUrl: "https://fixture.example/v1", chatKey: "fixture-key", model: "fixture-model" });
setWorkdir(home);
const { session } = bootSessions();
const coordinator = createConversationCoordinator();
const run = (...args) => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15000, env: { ...process.env, NOVAPUP_HOME: home, NP_LAYA_MODEL: join(home, "no-model") } });

test("CLI mutations respect a live foreign lead while context inspection stays read-only", () => {
  const owner = coordinator.start(session.id);
  const file = join(home, "sessions", `${session.id}.json`), env = join(home, "env");
  const original = readFileSync(file, "utf8"), settings = readFileSync(env, "utf8");
  try {
    for (const command of ["/goal overwrite", "/new", "/open 1", `/cd ${home}`, "/model changed", "/facts"]) {
      const child = run("src/cli/np.js", command);
      assert.notEqual(child.status, 0, command);
      assert.match(child.stdout + child.stderr, /already|working|owns|lead/i);
      assert.equal(readFileSync(file, "utf8"), original, command);
      assert.equal(readFileSync(env, "utf8"), settings, command);
    }
    const context = run("src/cli/np.js", "/context");
    assert.equal(context.status, 0, context.stderr);
    assert.equal(readFileSync(file, "utf8"), original);
  } finally { coordinator.finish(owner); }
});

test("CLI refreshes saved evidence under ownership and does not replay an acknowledged queue row", () => {
  const row = coordinator.enqueue(session.id, "PERSISTED_GUIDANCE");
  saveSession(session.id, [{ role: "user", content: row.content }], {
    modelMessages: [{ role: "user", content: row.content }], inputIds: [row.id], turnState: { active: false, inFlight: "" },
  });
  const file = join(home, "sessions", `${session.id}.json`), capture = join(home, "request.json"), preload = join(home, "fixture.mjs");
  writeFileSync(preload, `import fs from 'node:fs';
const originalWrite=process.stdout.write.bind(process.stdout);let updated=false;
process.stdout.write=function(chunk,...args){if(!updated&&String(chunk).includes('chat')){updated=true;const p=${JSON.stringify(file)};const saved=JSON.parse(fs.readFileSync(p,'utf8'));saved.messages.push({role:'assistant',content:'NEW_WINDOW_EVIDENCE'});saved.modelMessages.push({role:'assistant',content:'NEW_WINDOW_EVIDENCE'});fs.writeFileSync(p,JSON.stringify(saved));}return originalWrite(chunk,...args);};
globalThis.fetch=async(url,init)=>{if(!String(url).endsWith('/chat/completions'))throw Error('No network in fixture');fs.writeFileSync(${JSON.stringify(capture)},init.body);return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Hello.'}}]})+'\\n\\ndata: [DONE]\\n\\n');};
`);
  const child = run("--import", preload, "src/cli/np.js", "Say hello.");
  assert.equal(child.status, 0, child.stderr);
  const sent = JSON.parse(readFileSync(capture, "utf8"));
  assert(sent.messages.some(row => row.content === "NEW_WINDOW_EVIDENCE"));
  assert.equal(sent.messages.filter(row => row.content === "PERSISTED_GUIDANCE").length, 1);
  assert(readSession(session.id).messages.some(row => row.content === "NEW_WINDOW_EVIDENCE"));
});
test.after(() => rmSync(home, { recursive: true, force: true }));
