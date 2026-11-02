#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { dependencyReport } from "../main/dependencies.js";
import { listCheckpoints, undoCheckpoint } from "../main/checkpoints.js";
import { createConversationCoordinator } from "../main/conversation.js";
import { cleanModelHistory } from "../main/model-history.js";
/** NP console. Same chats as the window. Duty officer, not the window voice. */

import { analysisManager } from "../main/analysis-runtime.js";
import { previewContextInfo, runTurn } from "../main/agent.js";
import { describeContext, lastContextSnapshot } from "../main/context.js";
import { loadConfig, saveKeys } from "../main/config.js";
import { applyGoalCommand } from "../main/goal.js";
import { beginTurn, endTurn } from "../main/guard.js";
import { runPack } from "../main/packs.js";
import { redactSecrets } from "../main/safe.js";
import {
  bootSessions,
  createSession,
  listSessions,
  openSession,
  pushArchive,
  readSession,
  saveSession,
  writeGoal,
} from "../main/sessions.js";
import { createTimeline, mergeAssistants } from "../main/timeline.js";
import { getWorkdir, loadWorkdir, setWorkdir } from "../main/workdir.js";
import { HELP, parseConsole } from "./commands.js";
import { bindConsole } from "./input.js";
import { createScreen, watchDisk } from "./screen.js";
import { THEME_IDS } from "./themes.js";

const asked = process.argv.slice(2).filter((arg) => arg !== "--").join(" ").trim();
const plain = Boolean(asked) || !process.stdout.isTTY;
const screen = createScreen({ plain });
let messages = [];
let wireMessages = [];
let inputIds = [];
let token = null;
const conversations = createConversationCoordinator();
let archive = [];
let chatId = "";
let goal = "";
let busy = false;
let abort = null;
let leave = null;
let diskTimer = null;
let commandLease = null;

async function withCommandLease(action) {
  if (commandLease) return action();
  commandLease = conversations.start(chatId, { resume: true });
  try { return await action(); }
  finally { conversations.finish(commandLease, { reason: "command-finished" }); commandLease = null; }
}

function refreshBar() {
  screen.setMeta({ model: loadConfig().model, goal });
}

function sampleDisk() {
  watchDisk((pct) => screen.setMeta({ disk: pct }));
}

function remember(userText, rows) {
  wireMessages = cleanModelHistory([...wireMessages, { role: "user", content: userText }, ...rows.filter(row => row.role === "assistant")]);
  messages.push({ role: "user", content: userText });
  for (const row of rows) {
    if (row?.role === "assistant" && String(row.content || "").trim()) messages.push(row);
    if (row?.role === "step" && row.name) messages.push(row);
  }
  if (chatId) saveSession(chatId, messages, { modelMessages: wireMessages, inputIds });
}

function use(session) {
  inputIds = session.inputIds || [];
  try { if (!commandLease) conversations.reconcile(session.id, inputIds); }
  catch (error) { if (error.code !== "LEAD_BUSY") throw error; }
  wireMessages = session.modelMessages?.length ? session.modelMessages : mergeAssistants(session.messages || []);
  chatId = session.id;
  goal = String(session.goal || "");
  archive = Array.isArray(session.archive) ? session.archive : [];
  messages = Array.isArray(session.messages) ? session.messages : [];
  screen.say(`chat  ${session.title || "New chat"}`);
  const recent = messages.filter((row) => row.role === "user" || row.role === "assistant").slice(-6);
  for (const row of recent) {
    const who = row.role === "user" ? "you" : "collar";
    screen.say(`${who}  ${String(row.content || "").replace(/\s+/g, " ").slice(0, 220)}`);
  }
  refreshBar();
}

function packText(result) {
  const raw = result?.stdout || result?.error || result?.note || "";
  const text = redactSecrets(String(raw || "")).trim();
  return text.split("\n").slice(0, 18).join("\n");
}

async function runPackLine(name, args) {
  if (!commandLease) return withCommandLease(() => runPackLine(name, args));
  busy = true;
  screen.setBusy(true);
  screen.setStatus(`${name} …`);
  abort = new AbortController();
  beginTurn({ signal: abort.signal, workdir: getWorkdir() });
  try {
    const result = await runPack(name, args, { signal: abort.signal });
    const ok = result?.ok !== false;
    screen.setStatus(`${name} ${ok ? "ok" : "fail"}`);
    screen.say(packText(result) || (ok ? "ok" : "failed"));
  } finally {
    endTurn();
    abort = null;
    busy = false;
    screen.setBusy(false);
  }
}

function showChats() {
  const list = listSessions();
  if (!list.chats.length) {
    screen.say("No chats yet.");
    return;
  }
  list.chats.slice(0, 12).forEach((row, index) => {
    const mark = row.id === chatId ? "*" : " ";
    screen.say(`${mark}${index + 1}  ${row.title || "New chat"}`);
  });
}

function openBy(query) {
  const list = listSessions();
  const number = Number(query);
  const row = Number.isInteger(number) && number > 0
    ? list.chats[number - 1]
    : list.chats.find((item) => item.id === query || String(item.title || "").toLowerCase().includes(query.toLowerCase()));
  if (!row) {
    screen.say("No chat by that number or name.");
    return;
  }
  const session = openSession(row.id);
  if (!session) {
    screen.say("That chat is gone.");
    return;
  }
  use(session);
}

async function chat(text) {
  const cfg = loadConfig();
  if (!cfg.chatKey && !cfg.toolsKey && cfg.model !== "local-3.8") {
    screen.say("No chat key yet. Save one in the window, then come back.");
    return;
  }
  try { token = conversations.start(chatId, { resume: true }); }
  catch (error) { screen.say(error.message); return; }
  // The window may have completed a turn while this CLI was idle. Refresh only
  // after acquiring ownership, before replacing any saved conversation state.
  const latest = readSession(chatId);
  if (latest) {
    messages = latest.messages || []; inputIds = latest.inputIds || [];
    wireMessages = latest.modelMessages?.length ? latest.modelMessages : mergeAssistants(messages);
    goal = String(latest.goal || ""); archive = latest.archive || [];
  }
  const submitted = conversations.snapshot(chatId).answeredQuestion;
  if (submitted && !inputIds.includes(submitted.id)) {
    const words = submitted.answers.map(row => redactSecrets(row.answer)).join("\n");
    messages.push({ role: "user", content: words, id: submitted.id, createdAt: new Date(submitted.answered).toISOString() });
    wireMessages.push({ role: "user", content: words }); inputIds.push(submitted.id);
  }
  busy = true;
  abort = new AbortController();
  screen.setBusy(true); screen.setStatus("thinking");
  beginTurn({ signal: abort.signal, workdir: getWorkdir() });
  const base = messages.slice();
  const users = [{ role: "user", content: redactSecrets(text), id: randomUUID(), createdAt: new Date().toISOString() }], steps = [];
  let savedWire = [...wireMessages, { role: "user", content: redactSecrets(text) }];
  let final = "", reason = "unfinished";
  const checkpoint = (rows = savedWire, inFlight = null) => {
    savedWire = [...rows];
    if (inFlight) savedWire.push({ role: "tool", tool_call_id: inFlight.id,
      content: `Interrupted ${inFlight.name}: outcome unknown. Inspect before retrying; do not replay automatically.` });
    if (final && (savedWire.at(-1)?.role !== "assistant" || savedWire.at(-1)?.content !== final)) savedWire.push({ role: "assistant", content: final });
    wireMessages = cleanModelHistory(savedWire);
    messages = [...base, ...users, ...steps, ...(final ? [{ role: "assistant", content: final }] : [])];
    saveSession(chatId, messages, { modelMessages: wireMessages, inputIds, turnState: { active: !final, inFlight: inFlight?.name || "" } });
  };
  try {
    checkpoint();
    const result = await runTurn(wireMessages.slice(0, -1), text, event => {
      if (event.type === "retract") screen.clearDraft();
      if (event.type === "delta") screen.setDraft(event.text);
      if (event.type === "tool") screen.setStatus(event.name);
      if (event.type === "tool_result") {
        steps.push({ role: "step", ...event });
        screen.setStatus(`${event.name} ${event.ok === false ? "fail" : "ok"}  ${event.blurb || ""}`.trim());
      }
    }, abort.signal, {
      role: "term", goal, sessionId: chatId, onProgress: checkpoint,
      sourceMessages: () => messages, originalRequestId: users[0].id,
      takeInput: () => {
        const batch = conversations.peek(token);
        if (!batch) return null;
        const pending = batch.messages.filter(row => !inputIds.includes(row.id));
        for (const row of pending) {
          users.push({ role: "user", content: row.content, id: row.id, createdAt: new Date(row.created).toISOString() }); inputIds.push(row.id);
        }
        if (!pending.length) { conversations.ack(token, batch.receipt); return null; }
        return { ...batch, messages: pending };
      },
      ackInput: batch => conversations.ack(token, batch.receipt),
      ...(!plain ? { askUser: async args => {
        args.questions.forEach((question, index) => {
          screen.say(`${index + 1}. ${question.question}`);
          if (question.options?.length) screen.say(`Suggestions: ${question.options.join(" | ")}`);
        });
        screen.say('Answer explicitly with /answer ["your answer", "next answer"] (one string per question). Ctrl-C stops.');
        const answer = await conversations.ask(token, args, { signal: abort.signal });
        const words = answer.answers.map(row => redactSecrets(row.answer)).join("\n");
        users.push({ role: "user", content: words, id: answer.requestId, createdAt: new Date().toISOString() }); inputIds.push(answer.requestId);
        checkpoint([...savedWire, { role: "user", content: words }]);
        return answer;
      } } : {}),
    });
    for (const entry of result.archive || []) if (chatId) archive = pushArchive(chatId, entry);
    if (result.goalStatus === "done" && goal && chatId) { goal = writeGoal(chatId, ""); refreshBar(); }
    final = redactSecrets(result.assistant || "No reply."); reason = result.held ? "held" : "finished";
    checkpoint(result.messages || savedWire);
    screen.clearDraft(); screen.say(`collar  ${final}`);
  } catch (error) {
    const stopped = abort.signal.aborted || error?.name === "AbortError";
    reason = stopped ? "stopped" : "error";
    final = stopped ? "Stopped. Pending input is saved. /continue resumes it deliberately." : redactSecrets(error?.message || "That failed.");
    checkpoint([...savedWire, { role: "assistant", content: final }]);
    screen.clearDraft(); screen.say(final);
  } finally {
    endTurn(); conversations.finish(token, { reason }); token = null;
    busy = false; abort = null; screen.setBusy(false);
  }
}

async function handle(line) {
  const text = String(line || "").trim();
  if (/^\/context(?:\s+next)?$/i.test(text)) {
    try { screen.say(describeContext(/\s+next$/i.test(text) ? previewContextInfo(wireMessages, { sessionId: chatId, role: "term" }) : lastContextSnapshot(chatId))); }
    catch (error) { screen.say(error.message); }
    return;
  }
  if (busy) {
    if (/^\/answer\s+/i.test(text)) {
      const question = conversations.snapshot(chatId).question;
      if (!question) return screen.say("No question is waiting.");
      try {
        const values = JSON.parse(text.replace(/^\/answer\s+/i, ""));
        if (!Array.isArray(values) || values.length !== question.questions.length) throw new Error("Provide one answer string per question.");
        conversations.answer(chatId, question.id, question.questions.map((row, i) => ({ id: row.id, answer: values[i] })));
      } catch (error) { screen.say(error.message); }
      return;
    }
    if (text.startsWith("/")) return screen.say("Ctrl-C stops this turn. Other commands wait until it ends; /answer submits a waiting question.");
    conversations.enqueue(chatId, redactSecrets(text));
    screen.say("Guidance saved for the next model/tool boundary."); return;
  }
  if (text === "/dependencies") { screen.say(JSON.stringify(dependencyReport(), null, 2)); return; }
  if (text === "/checkpoints") {
    for (const row of listCheckpoints(chatId).slice(0, 12)) screen.say(`${row.id} · ${row.changes.length} file changes · ${row.skipped.length} uncovered paths · ${row.reason}`);
    return;
  }
  if (/^\/undo(?:\s|$)/.test(text)) {
    let own;
    try { own = conversations.start(chatId, { resume: true }); const result = undoCheckpoint(chatId, text.replace(/^\/undo\s*/, "")); screen.say(`Restored ${result.restored} files. External actions were not undone.`); }
    catch (error) { screen.say(error.message); }
    finally { if (own) conversations.finish(own, { reason: "manual-undo" }); }
    return;
  }
  if (text === "/continue") return chat("Continue saved work using the recorded evidence. Inspect unknown outcomes before retrying actions.");
  const cmd = parseConsole(line);
  if (cmd.type === "empty") return;
  if (cmd.type === "quit") return leave?.();
  if (cmd.type === "help" || cmd.type === "unknown") {
    if (cmd.type === "unknown") screen.say(`No command ${cmd.text}`);
    screen.say(HELP);
    return;
  }
  if (cmd.type === "new") return withCommandLease(() => use(createSession()));
  if (cmd.type === "chats") return showChats();
  if (cmd.type === "open") return withCommandLease(() => openBy(cmd.query));
  if (cmd.type === "cd") return withCommandLease(() => {
    const next = setWorkdir(cmd.path, { create: false });
    screen.say(next.ok ? `dir  ${next.path}` : (next.error || "not a directory"));
    return;
  });
  if (cmd.type === "theme") {
    if (!cmd.name) {
      screen.say(THEME_IDS.join("  "));
      return;
    }
    const name = screen.applyTheme(cmd.name);
    screen.say(name ? `theme  ${name}` : `No coat ${cmd.name}. ${THEME_IDS.join(" ")}`);
    return;
  }
  if (cmd.type === "model") {
    if (!cmd.name) {
      screen.say(`model  ${loadConfig().model}`);
      return;
    }
    return withCommandLease(() => {
      saveKeys({ model: cmd.name });
      screen.say(`model  ${loadConfig().model}`);
      refreshBar();
    });
  }
  if (cmd.type === "goal") {
    let nextTask = null;
    await withCommandLease(() => {
    const latest = readSession(chatId);
    if (latest) { messages = latest.messages || []; wireMessages = latest.modelMessages || mergeAssistants(messages); inputIds = latest.inputIds || []; goal = latest.goal || ""; }
    const parsed = applyGoalCommand(cmd.text, goal);
    if (parsed.changed && chatId) goal = writeGoal(chatId, parsed.goal);
    else if (parsed.changed) goal = parsed.goal;
    refreshBar();
    if (parsed.handled) {
      const last = archive.at(-1);
      const reply = parsed.goal && last
        ? `${parsed.reply}\nLast check: ${last.verdict}. ${last.opposite || last.detail || ""}`.trim()
        : (parsed.reply || "Goal set.");
      screen.say(reply);
      remember(cmd.text, [{ role: "assistant", content: reply }]);
      return;
    }
    screen.say(`Goal: ${parsed.goal}`);
    nextTask = parsed.runText;
    });
    if (nextTask) return chat(nextTask);
    return;
  }
  if (cmd.type === "pack") return runPackLine(cmd.name, cmd.args);
  return chat(cmd.text);
}

function boot({ quiet = false } = {}) {
  loadWorkdir();
  const started = bootSessions();
  const current = started.session || openSession(started.index.current) || createSession();
  if (quiet) {
    chatId = current.id;
    goal = String(current.goal || "");
    archive = Array.isArray(current.archive) ? current.archive : [];
    messages = Array.isArray(current.messages) ? current.messages : [];
    wireMessages = current.modelMessages?.length ? current.modelMessages : mergeAssistants(messages);
    inputIds = current.inputIds || [];
    try { conversations.reconcile(chatId, inputIds); }
    catch (error) { if (error.code !== "LEAD_BUSY") throw error; }
    refreshBar();
    return;
  }
  use(current);
  screen.say(`dir  ${getWorkdir()}`);
  screen.say("Shared with the window. /help for the desk.");
}

function listen() {
  bindConsole({
    screen,
    onLine: (line) => handle(line).catch((error) => screen.say(error.message || "failed")),
    onLeave: () => leave?.(),
    isBusy: () => busy,
    abortTurn: () => { if (token) conversations.pause(token, "stopped"); abort?.abort(); },
  });
}

if (process.argv.includes("--help")) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

leave = async (exitCode = 0) => {
  abort?.abort();
  await analysisManager.closeAll();
  if (diskTimer) clearInterval(diskTimer);
  screen.stop();
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  process.exit(typeof exitCode === 'number' ? exitCode : 0);
};
process.on("SIGTERM", leave);

if (process.argv[2] === "update") {
  import("../main/update.js").then(({ runUpdate }) => {
    process.exit(runUpdate(process.argv.slice(3)) || 0);
  }).catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
} else if (process.argv[2] === "install") {
  import("../main/install-cli.js").then(({ runInstaller }) => runInstaller(process.argv.slice(3))).then((code) => {
    process.exit(code || 0);
  }).catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
} else if (plain) {
  const first = parseConsole(asked || "/help");
  boot({ quiet: first.type === "pack" || first.type === "help" || first.type === "unknown" || first.type === "context" });
  handle(asked || "/help").then(() => leave()).catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    return leave(1);
  });
} else {
  screen.start();
  sampleDisk();
  diskTimer = setInterval(sampleDisk, 8000);
  boot();
  listen();
}
