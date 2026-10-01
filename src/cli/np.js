#!/usr/bin/env node
/** NP console. Same chats as the window. Duty officer, not the window voice. */

import { runTurn } from "../main/agent.js";
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
let archive = [];
let chatId = "";
let goal = "";
let busy = false;
let abort = null;
let leave = null;
let diskTimer = null;

function refreshBar() {
  screen.setMeta({ model: loadConfig().model, goal });
}

function sampleDisk() {
  watchDisk((pct) => screen.setMeta({ disk: pct }));
}

function remember(userText, rows) {
  messages.push({ role: "user", content: userText });
  for (const row of rows) {
    if (row?.role === "assistant" && String(row.content || "").trim()) messages.push(row);
    if (row?.role === "step" && row.name) messages.push(row);
  }
  if (chatId) saveSession(chatId, messages);
}

function use(session) {
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
  screen.setBusy(true);
  screen.setStatus(`${name} …`);
  abort = new AbortController();
  beginTurn({ signal: abort.signal, workdir: getWorkdir() });
  try {
    const result = await runPack(name, args);
    const ok = result?.ok !== false;
    screen.setStatus(`${name} ${ok ? "ok" : "fail"}`);
    screen.say(packText(result) || (ok ? "ok" : "failed"));
  } finally {
    endTurn();
    abort = null;
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
  busy = true;
  abort = new AbortController();
  screen.setBusy(true);
  screen.setStatus("thinking");
  beginTurn({ signal: abort.signal, workdir: getWorkdir() });
  const tape = createTimeline();
  let draft = "";
  try {
    const result = await runTurn(mergeAssistants(messages), text, (event) => {
      if (event.type === "retract") {
        tape.retract();
        draft = "";
        screen.setDraft("");
      }
      if (event.type === "delta" && event.text) {
        tape.delta(event.text);
        draft += event.text;
        screen.setDraft(draft);
      }
      if (event.type === "tool") screen.setStatus(event.name);
      if (event.type === "tool_result") {
        tape.step(event);
        screen.setStatus(`${event.name} ${event.ok === false ? "fail" : "ok"}  ${event.blurb || ""}`.trim());
      }
    }, abort.signal, { role: "term", goal });
    for (const entry of result.archive || []) {
      if (chatId) archive = pushArchive(chatId, entry);
    }
    if (result.goalStatus === "done" && goal && chatId) {
      goal = writeGoal(chatId, "");
      screen.say("Goal met. Cleared.");
      refreshBar();
    }
    const answer = redactSecrets(String(result.assistant || "").trim() || "No reply.");
    screen.clearDraft();
    screen.say(`collar  ${answer}`);
    remember(text, tape.finish(answer));
  } catch (error) {
    screen.clearDraft();
    const stopped = error?.name === "AbortError" || /stopped/i.test(error?.message || "");
    const reply = stopped ? "Stopped." : redactSecrets(error?.message || "That failed.");
    screen.say(reply);
    if (!stopped) remember(text, [{ role: "assistant", content: reply }]);
  } finally {
    endTurn();
    busy = false;
    abort = null;
    screen.setBusy(false);
  }
}

async function handle(line) {
  const cmd = parseConsole(line);
  if (cmd.type === "empty") return;
  if (cmd.type === "quit") return leave?.();
  if (cmd.type === "help" || cmd.type === "unknown") {
    if (cmd.type === "unknown") screen.say(`No command ${cmd.text}`);
    screen.say(HELP);
    return;
  }
  if (cmd.type === "new") return use(createSession());
  if (cmd.type === "chats") return showChats();
  if (cmd.type === "open") return openBy(cmd.query);
  if (cmd.type === "cd") {
    const next = setWorkdir(cmd.path, { create: false });
    screen.say(next.ok ? `dir  ${next.path}` : (next.error || "not a directory"));
    return;
  }
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
    saveKeys({ model: cmd.name });
    screen.say(`model  ${loadConfig().model}`);
    refreshBar();
    return;
  }
  if (cmd.type === "goal") {
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
    return chat(parsed.runText);
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
    abortTurn: () => abort?.abort(),
  });
}

if (process.argv.includes("--help")) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

leave = () => {
  if (diskTimer) clearInterval(diskTimer);
  screen.stop();
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  process.exit(0);
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
  boot({ quiet: first.type === "pack" || first.type === "help" || first.type === "unknown" });
  handle(asked || "/help").then(() => leave()).catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
} else {
  screen.start();
  sampleDisk();
  diskTimer = setInterval(sampleDisk, 8000);
  boot();
  listen();
}
