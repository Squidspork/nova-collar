// Actual Electron main/preload/renderer/agent with an in-process SSE provider.
// All state is temporary; fetch never reaches a real model or endpoint.
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "nova-conversation-main-"));
process.env.NOVAPUP_HOME = join(home, "settings");
process.env.NP_LAYA_MODEL = join(home, "no-laya-model");
mkdirSync(join(home, "app-data"));
app.setPath("appData", join(home, "app-data"));
app.setPath("userData", join(home, "electron"));
app.setPath("sessionData", join(home, "electron"));
const plans = [], requests = [], held = new Map();
const abortError = () => Object.assign(new Error("fixture cancelled"), { name: "AbortError" });
function sse(reply) {
  const delta = reply.call ? { tool_calls: [{ index: 0, id: reply.call.id, type: "function", function: {
    name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }] } : { content: reply.text || "Fixture answer." };
  const text = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}
globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  if (address.endsWith("/api/tags")) return Response.json({ models: [] });
  if (address.endsWith("/models")) return Response.json({ data: [{ id: "fixture-model", tool_call: true, limit: { context: 128000, output: 8192 } }] });
  if (!address.endsWith("/chat/completions")) throw new Error(`Unexpected fixture request: ${address}`);
  const body = JSON.parse(options.body);
  if (!body.stream) return Response.json({ choices: [{ message: { content: "{}" } }] }); // optional intuition bookkeeping
  requests.push(structuredClone(body));
  const plan = plans.shift() || { text: "I have the saved evidence and your answer." };
  if (plan.hold) return new Promise((resolve, reject) => {
    const cancelled = () => { held.delete(plan.hold); reject(abortError()); };
    const finish = () => {
      options.signal?.removeEventListener("abort", cancelled); held.delete(plan.hold);
      if (plan.error) reject(new Error(plan.error)); else resolve(sse(plan));
    };
    held.set(plan.hold, finish);
    if (options.signal?.aborted) cancelled(); else options.signal?.addEventListener("abort", cancelled, { once: true });
  });
  if (plan.error) throw new Error(plan.error);
  return sse(plan);
};
const deadline = setTimeout(() => { console.error("Actual-main conversation integration timed out"); app.exit(1); }, 90_000);
const until = async (fn, label = "integration state") => {
  for (let i = 0; i < 240; i++) { if (await fn()) return; await delay(30); }
  throw new Error(`Timed out waiting for ${label}`);
};
function assertPaired(messages) {
  for (let i = 0; i < messages.length; i++) {
    if (!messages[i].tool_calls) continue;
    const calls = new Set(messages[i].tool_calls.map((call) => call.id));
    for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) calls.delete(messages[j].tool_call_id);
    assert.equal(calls.size, 0, "every saved provider call needs its contiguous tool receipt");
  }
}

async function integration() {
try {
  const { APP_HOME, ensureHome, markSetupDone, saveKeys } = await import("../src/main/config.js");
  const { bootSessions, readSession, saveSession, createSession } = await import("../src/main/sessions.js");
  const { createConversationCoordinator } = await import("../src/main/conversation.js");
  ensureHome(); markSetupDone();
  saveKeys({ chatUrl: "https://fixture.invalid/v1", chatKey: "fixture-key", model: "fixture-model" });
  const project = join(home, "project"); mkdirSync(project);
  const source = join(project, "fixture.txt"); writeFileSync(source, "ACTUAL_MAIN_EVIDENCE\n");
  writeFileSync(join(APP_HOME, "workdir.json"), JSON.stringify({ path: project }));
  const original = bootSessions().session;
  saveSession(original.id, [{ role: "user", content: "Earlier saved work" }], { modelMessages: [{ role: "user", content: "Earlier saved work" }], turnState: { active: true, inFlight: "host_run" } });
  const foreign = createConversationCoordinator({ file: join(APP_HOME, "conversation-state.json") });
  const foreignToken = foreign.start(original.id);
  const originalFile = readFileSync(join(APP_HOME, "sessions", original.id + ".json"), "utf8");
  await import("../src/main/index.js");
  await until(() => BrowserWindow.getAllWindows().some((window) => !window.webContents.isLoading()), "main window");
  const win = BrowserWindow.getAllWindows()[0], js = (code) => win.webContents.executeJavaScript(code);
  await until(() => js('Boolean(window.pup && document.getElementById("question-dialog"))'), "real preload");
  const state = () => js("window.pup.state()");
  assert.equal((await state()).conversation.readOnly, true, "foreign CLI lead permits a read-only app boot");
  assert.equal(readFileSync(join(APP_HOME, "sessions", original.id + ".json"), "utf8"), originalFile, "boot never marks another live turn interrupted");
  const denied = await js('window.pup.chat("/goal unauthorized concurrent mutation")');
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Another Nova Collar process/);
  assert.equal(readFileSync(join(APP_HOME, "sessions", original.id + ".json"), "utf8"), originalFile, "even goal commands require the lead lock");
  foreign.finish(foreignToken);
  plans.push({ hold: "first", text: "An outdated first draft." },
    { call: { id: "read-1", name: "host_file_read", args: { path: source } } },
    { call: { id: "question-1", name: "ask_user", args: { questions: [
      { id: "scope", question: "Should I delete files?", options: ["Keep evidence", "Fresh reading"] },
      { id: "detail", question: "Which detail matters?" },
    ] } } },
    { text: "I kept the evidence and incorporated your answer." });
  await js('window.integrationLead=window.pup.chat("Work with me on a plan"); true');
  await until(() => held.has("first"), "first model request");
  const firstQueue = await js('window.pup.chat("First guidance stays distinct")');
  const secondQueue = await js('window.pup.chat("Second guidance follows it")');
  assert.equal(firstQueue.queued, true); assert.equal(secondQueue.queued, true);
  assert.equal((await state()).conversation.pending.length, 2);
  held.get("first")();
  await until(async () => Boolean((await state()).conversation.question), "native ask_user request");
  const pending = (await state()).conversation.question;
  const atQuestion = readSession(original.id);
  assert.ok(atQuestion.modelMessages.some((message) => message.role === "tool" && String(message.content).includes("ACTUAL_MAIN_EVIDENCE")), "completed tool evidence is persisted before an interactive wait");
  assert.equal(atQuestion.turnState.active, true); assert.equal(atQuestion.turnState.inFlight, "ask_user");
  assert.deepEqual(atQuestion.inputIds.filter((id) => [firstQueue.id, secondQueue.id].includes(id)), [firstQueue.id, secondQueue.id]);
  assert.equal((await state()).conversation.pending.length, 0);
  const secondRequestUsers = requests[1].messages.filter((message) => message.role === "user").map((message) => message.content);
  assert.deepEqual(secondRequestUsers.slice(-2), ["First guidance stays distinct", "Second guidance follows it"]);
  assert.equal((await js(`window.pup.answerQuestion(${JSON.stringify(pending.id)},[{id:'scope',answer:'Keep stored evidence'},{id:'detail',answer:'Use my original constraint'}])`)).ok, true);
  assert.equal((await js("window.integrationLead")).ok, true);
  const finished = readSession(original.id);
  assert.equal(finished.turnState.active, false);
  assert.equal(finished.messages.filter((message) => message.role === "user" && message.content === "First guidance stays distinct").length, 1);
  assert.ok(finished.messages.some((message) => message.role === "user" && message.content === "Keep stored evidence\nUse my original constraint"));
  assert.ok(!finished.messages.some((message) => message.role === "user" && message.content.includes("Should I delete files?")), "model question wording never becomes user authority");
  assert.ok(finished.modelMessages.some((message) => message.role === "tool" && message.tool_call_id === "question-1"));
  assertPaired(finished.modelMessages);
  assertPaired(requests.at(-1).messages);
  assert.equal((await state()).conversation.active, false);

  // The assistant inspects last actual request / next local preview through
  // its ordinary tool loop; each inspection itself adds no provider request.
  await js("window.pup.newChat().then(()=>boot())");
  const contextStart = requests.length;
  plans.push({ call: { id: "context-last", name: "context_info", args: {} } },
    { call: { id: "context-next", name: "context_info", args: { view: "next" } } },
    { text: "I have the context metadata." });
  const contextResult = await js('window.pup.chat("Inspect our working context")');
  assert.equal(contextResult.ok, true);
  assert.equal(requests.length - contextStart, 3, "context tools add no hidden provider call");
  const contextSaved = readSession((await state()).session.current);
  const lastReceipt = JSON.parse(contextSaved.modelMessages.find(row => row.tool_call_id === "context-last").content);
  const nextReceipt = JSON.parse(contextSaved.modelMessages.find(row => row.tool_call_id === "context-next").content);
  assert.equal(lastReceipt.snapshot.kind, "request"); assert.equal(nextReceipt.snapshot.kind, "preview");
  assert(lastReceipt.snapshot.tools.entries.some(row => row.name === "context_info"));
  assert.equal(lastReceipt.snapshot.conversation.sentMessages, requests[contextStart].messages.length);
  assert(!JSON.stringify(lastReceipt.snapshot).includes("Inspect our working context"), "context metadata does not duplicate the prompt");
  const beforeInspection = JSON.stringify((await state()).contextInfo), beforeCalls = requests.length;
  const localPreview = await js('window.pup.contextInfo("next")');
  assert.equal(localPreview.ok, true); assert.equal(localPreview.snapshot.kind, "preview");
  assert.equal(requests.length, beforeCalls); assert.equal(JSON.stringify((await state()).contextInfo), beforeInspection);
  await js('document.getElementById("settings-btn").click();document.getElementById("context-last").click()');
  await until(() => js('document.getElementById("context-report").textContent.includes("Last dispatched request")'), "settings context report");
  await js('document.getElementById("context-next").click()');
  await until(() => js('document.getElementById("context-report").textContent.includes("Next request preview")'), "settings context preview");
  const contextReport = await js('document.getElementById("context-report").textContent');
  assert.match(contextReport, /Message tokens ~[\d,]+ · schema tokens ~[\d,]+/);
  assert.match(contextReport, /Sent [\d,]+ messages/);
  assert.match(contextReport, /context_info · ~[\d,]+ tokens · bundled context metadata/);
  assert.equal(requests.length, beforeCalls);
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, "context settings must fit the app window");
  if (process.env.NOVA_CONTEXT_SCREENSHOT) {
    await delay(250);
    writeFileSync(process.env.NOVA_CONTEXT_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  await js("hidePanels()");

  // Invalid questions become failed tool evidence, then the same turn continues.
  await js("window.pup.newChat().then(()=>boot())");
  plans.push({ call: { id: "invalid-question", name: "ask_user", args: { questions: [] } } },
    { text: "I don't know; the question could not be asked." }, { text: "I don't know; the question could not be asked." });
  const invalid = await js('window.pup.chat("Let us choose a direction")');
  assert.equal(invalid.ok, true, "invalid question args do not tear down the lead");
  const invalidSession = readSession((await state()).session.current);
  assert.ok(invalidSession.modelMessages.some((message) => message.role === "tool" && message.tool_call_id === "invalid-question" && message.content.includes("one and three")));
  plans.length = 0;

  // Stop while the provider is pending retains queued inputs without resuming them.
  await js("window.pup.newChat().then(()=>boot())");
  plans.push({ hold: "stop", text: "Must not appear after Stop." });
  await js('window.stoppedLead=window.pup.chat("Stay with this conversation"); true');
  await until(() => held.has("stop"), "stoppable request");
  await js('window.pup.chat("Retain this stopped input")');
  const stopCount = requests.length;
  await js("window.pup.stop()");
  assert.equal((await js("window.stoppedLead")).stopped, true);
  assert.equal((await state()).conversation.pending[0].state, "paused");
  await delay(150); assert.equal(requests.length, stopCount, "Stop cannot create a fresh model request");

  // A provider error after a completed tool preserves its receipt and pauses later input.
  await js("window.pup.newChat().then(()=>boot())");
  plans.push({ call: { id: "read-before-error", name: "host_file_read", args: { path: source } } },
    { hold: "provider-error", error: "fixture provider interrupted" });
  await js('window.failedLead=window.pup.chat("Keep considering the plan"); true');
  await until(() => held.has("provider-error"), "provider error checkpoint");
  await js('window.pup.chat("Retain this error input")');
  held.get("provider-error")();
  assert.equal((await js("window.failedLead")).ok, false);
  const failedState = await state(), failed = readSession(failedState.session.current);
  assert.equal(failedState.conversation.pending[0].state, "paused");
  assert.ok(failed.modelMessages.some((message) => message.role === "tool" && message.tool_call_id === "read-before-error" && message.content.includes("ACTUAL_MAIN_EVIDENCE")));
  assertPaired(failed.modelMessages);

  // Reloading an interrupted saved turn records uncertainty, preserving old receipts.
  const restart = createSession();
  saveSession(restart.id, [{ role: "user", content: "Unfinished saved action" }], {
    modelMessages: failed.modelMessages, turnState: { active: true, inFlight: "host_run" } });
  await js(`window.pup.openChat(${JSON.stringify(restart.id)})`);
  const recovered = readSession(restart.id);
  assert.equal(recovered.turnState.active, false);
  assert.ok(recovered.messages.some((message) => message.content?.includes("outcome is unknown")));
  assert.ok(recovered.modelMessages.some((message) => message.tool_call_id === "read-before-error"));
  assertPaired(recovered.modelMessages);
  console.log("PASS: actual main/preload/agent, foreign-lead read-only boot and goal rejection, ordered busy input, native questions/actual-answer authority, context_info default-last/next + own schema accounting + offline settings previews, invalid question recovery, incremental receipts, Stop/error retention, interrupted-session recovery; all provider/model catalog responses are fixtures.");
  clearTimeout(deadline); app.exit(0);
} catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
}
void integration();
