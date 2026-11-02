// Real Electron renderer + coordinator, deterministic IPC lead. No model, GPU,
// network provider, PTY, credentials, or owner app data participates in this test.
import { app, BrowserWindow, ipcMain } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), "nova-conversation-ui-"));
process.env.NOVAPUP_HOME = join(home, "settings");
app.setPath("userData", join(home, "electron"));
app.setPath("sessionData", join(home, "electron"));
globalThis.fetch = async () => { throw new Error("Inference and network access are forbidden in the conversation UI fixture."); };
const deadline = setTimeout(() => { console.error("Conversation UI test timed out"); app.exit(1); }, 45_000);
const until = async (fn) => { for (let n = 0; n < 100; n++) { if (await fn()) return; await delay(30); } throw new Error("Timed out waiting for conversation UI"); };

async function testConversationApp() {
try {
  await app.whenReady();
  const { createConversationCoordinator } = await import("../src/main/conversation.js");
  let win, run = null, finishLead = null, rejectAnswer = false;
  const calls = [], answered = [], history = [];
  let resumeCount = 0, stopCount = 0;
  const send = (event) => win?.webContents.send("fixture:event", event);
  const coordinator = createConversationCoordinator({ file: join(home, "conversation.json"),
    onChange: (snapshot) => send({ type: "conversation", ...snapshot }) });
  const state = () => ({ ready: true, setupDone: true, os: process.platform, model: "fixture", models: [], packs: [],
    workdir: home, messages: history, approvals: [], session: { current: "chat", chats: [] },
    conversation: coordinator.snapshot("chat") });
  const finish = (text = "Stopped.") => {
    coordinator.finish(run, { reason: "stopped" }); run = null;
    send({ type: "done", text }); finishLead?.({ ok: true }); finishLead = null;
  };
  ipcMain.handle("fixture:state", state);
  ipcMain.handle("fixture:chat", (_event, content) => {
    calls.push(content);
    if (run) {
      const message = coordinator.enqueue("chat", content);
      history.push({ role: "user", content, inputId: message.id });
      send({ type: "user_input", id: message.id, text: content });
      return { ok: true, queued: true };
    }
    run = coordinator.start("chat", { resume: true });
    history.push({ role: "user", content });
    return new Promise((resolve) => { finishLead = resolve; });
  });
  ipcMain.handle("fixture:stop", () => { stopCount++; coordinator.pause(run); finish(); return { ok: true }; });
  ipcMain.handle("fixture:resume", () => {
    resumeCount++; run = coordinator.start("chat", { resume: true });
    const batch = coordinator.peek(run);
    if (batch) coordinator.ack(run, batch.receipt);
    send({ type: "incorporated" });
    return { ok: true };
  });
  ipcMain.handle("fixture:answer", (_event, requestId, answers) => {
    if (rejectAnswer) { rejectAnswer = false; return { ok: false, error: "That question is no longer waiting. Try again." }; }
    return coordinator.answer("chat", requestId, answers);
  });
  ipcMain.on("fixture:noop", () => {});
  const preload = join(home, "preload.cjs");
  writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
    contextBridge.exposeInMainWorld('pup',{
      os:process.platform,state:()=>ipcRenderer.invoke('fixture:state'),
      on:fn=>{const listener=(_event,payload)=>fn(payload);ipcRenderer.on('fixture:event',listener);return()=>ipcRenderer.removeListener('fixture:event',listener)},
      chat:text=>ipcRenderer.invoke('fixture:chat',text),stop:()=>ipcRenderer.invoke('fixture:stop'),
      resumeInput:()=>ipcRenderer.invoke('fixture:resume'),answerQuestion:(requestId,answers)=>ipcRenderer.invoke('fixture:answer',requestId,answers),
      specRead:()=>Promise.resolve({text:''}),termWrite:()=>{},termResize:()=>{},min:()=>{},quit:()=>{},pin:()=>Promise.resolve(true)
    });`);
  win = new BrowserWindow({ width: 680, height: 820, show: true, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (_event, details) => { if (details.level === "error") errors.push(details.message); });
  await win.loadFile(join(root, "src/renderer/index.html"));
  const js = (source) => win.webContents.executeJavaScript(source);
  await until(() => js('document.getElementById("chat").textContent.includes("Here.")'));
  const submit = async (text) => {
    await js(`document.getElementById('input').value=${JSON.stringify(text)};document.getElementById('send').click()`);
  };
  await submit("Lead task");
  await until(() => calls.length === 1);
  assert.equal(await js('document.getElementById("stop").hidden'), false);
  assert.equal(await js('document.getElementById("send").disabled'), false);
  assert.equal(await js('document.getElementById("send").classList.contains("stop")'), false);
  send({ type: "delta", text: "Stale draft" });
  await submit("First guidance");
  await submit("Second guidance");
  await until(() => calls.length === 3);
  assert.deepEqual(calls, ["Lead task", "First guidance", "Second guidance"]);
  await until(() => js('document.getElementById("pending-input").textContent.includes("2 messages")'));
  assert.deepEqual(await js('Array.from(document.querySelectorAll("#chat .msg.user"),el=>el.textContent)'), calls);
  assert.equal(await js('document.getElementById("chat").textContent.includes("Stale draft")'), false);
  await js('document.getElementById("stop").click()');
  await until(() => js('!document.getElementById("resume-input").hidden'));
  await delay(150);
  assert.equal(calls.length, 3, "Stop must never flush saved input into a new turn");
  assert.equal(resumeCount, 0);
  assert.equal(stopCount, 1);
  assert.equal(await js('document.getElementById("stop").hidden'), true);
  assert.ok(coordinator.pending("chat").every((message) => message.state === "paused"));
  await js('document.getElementById("resume-input").click()');
  await until(() => resumeCount === 1);
  assert.equal(coordinator.pending("chat").length, 0);

  await js('document.getElementById("input").value="My unsent chat draft"');
  const question = coordinator.ask(run, { questions: [
    { id: "choice", question: "Which approach should Nova use?", options: ["Inspect the saved evidence", "Run a fresh check"] },
    { id: "detail", question: "What detail matters most?" },
  ] }).then((result) => {
    answered.push(result);
    send({ type: "user_input", id: result.requestId, text: result.answers.map((answer) => answer.answer).join("\n\n") });
    return result;
  });
  await until(() => js('document.getElementById("question-dialog").open'));
  assert.equal(await js('document.querySelectorAll("#question-fields textarea").length'), 2);
  assert.equal(await js('document.querySelectorAll(".question-options [aria-pressed=true]").length'), 0);
  assert.equal(await js('document.getElementById("question-submit").disabled'), true);
  await js('document.querySelector(".question-options button").click()');
  assert.equal(answered.length, 0, "choosing a suggestion is not submitting an answer");
  await js('const field=document.getElementById("question-answer-1");field.value="Preserve the unfinished work";field.dispatchEvent(new Event("input",{bubbles:true}))');
  await js('document.getElementById("question-minimize").click()');
  assert.equal(await js('document.getElementById("question-dialog").open'), false);
  assert.equal(await js('document.getElementById("input").value'), "My unsent chat draft");
  await js('document.getElementById("question-open").click()');
  assert.equal(await js('document.getElementById("question-answer-1").value'), "Preserve the unfinished work");
  assert.equal(await js('document.querySelectorAll(".question-options [aria-pressed=true]").length'), 1);
  rejectAnswer = true;
  await js('document.getElementById("question-submit").click()');
  await until(() => js('document.getElementById("question-error").textContent.includes("no longer waiting")'));
  assert.equal(await js('document.getElementById("question-answer-1").value'), "Preserve the unfinished work");
  if (process.env.NOVA_CONVERSATION_SCREENSHOT) {
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await delay(250); // Let the real compositor paint the current modal before capturing it.
    writeFileSync(process.env.NOVA_CONVERSATION_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  await js('document.getElementById("question-submit").click()');
  assert.deepEqual((await question).answers, [{ id: "choice", answer: "Inspect the saved evidence" }, { id: "detail", answer: "Preserve the unfinished work" }]);
  await until(() => js('!document.getElementById("question-dialog").open'));
  assert.equal(await js('document.getElementById("input").value'), "My unsent chat draft");

  const pending = coordinator.ask(run, { questions: [{ id: "last", question: "Continue this check?" }] });
  const cancelled = assert.rejects(pending, { name: "AbortError" });
  await until(() => js('document.getElementById("question-dialog").open'));
  await js('document.getElementById("question-stop").click()');
  await cancelled;
  await until(() => js('!document.getElementById("question-dialog").open'));
  assert.equal(stopCount, 2);
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log("PASS: real Electron renderer, ordered busy sends, separate Stop, retained paused input, explicit Continue, unselected suggestions, free text, minimize/reopen drafts, stale-submit error, question Stop; deterministic lead fixture, no model-quality claim.");
  clearTimeout(deadline);
  win.destroy();
  rmSync(home, { recursive: true, force: true });
  app.exit(0);
} catch (error) {
  console.error(error); clearTimeout(deadline); app.exit(1);
}
}
void testConversationApp();
