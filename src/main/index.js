import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTurn } from "./agent.js";
import { APP_HOME, BIN, ensureHome, isLocalModel, loadConfig, markSetupDone, publicState, readMemory, saveKeys, saveLane, saveLocalModel } from "./config.js";
import { isBotId, isChatId, redactSecrets, safePack } from "./safe.js";
import { setDeskGuard } from "./mac.js";
import { packPublic } from "./packs.js";
import { listBots, openBot, publicBot, readBot, removeBot, saveBot } from "./bots.js";
import { playbookPublic } from "./playbooks.js";
import { noteTurn, publicIntuition, reviewNow } from "./intuition.js";
import { allPackLessons, teachPack } from "./pack.js";
import { startBoard, stopBoard } from "./schedule.js";
import { bootSessions, createSession, fileChat, listSessions, openSession, persistSession, pushArchive, readSession, saveSession, writeGoal } from "./sessions.js";
import { assignTask, publicTasks, releaseHeld } from "./tasks.js";
import { applyGoalCommand, spokenGoal } from "./goal.js";
import { draftVoices } from "./voice.js";
import { writeMemory } from "./files.js";
import { watchJailbreak } from "./laya-steer.js";
import { createTimeline, mergeAssistants } from "./timeline.js";
import { appendTerm, bindPty, sendTerminal } from "./term-bridge.js";
import { beginTurn, endTurn } from "./guard.js";
import { bindTermPid, getWorkdir, loadWorkdir, noteTermActivity, onWorkdir, setWorkdir, watchShellCwd } from "./workdir.js";
import { startLaya, stopLaya } from "./laya.js";
import { ensureOllama, scanLocalModels } from "./setup.js";
import { completeSpec, readSpec, writeSpec } from "./spec.js";

const pty = createRequire(import.meta.url)("node-pty");

const here = dirname(fileURLToPath(import.meta.url));
let win;
let term;
let currentId = null;
let currentGoal = "";
let currentArchive = [];
let currentBot = null;
let turnAbort = null;
const history = [];

function send(payload) {
  win?.webContents.send("pup", payload);
}

function fromWindow(event) {
  return Boolean(win && !win.isDestroyed() && event?.sender === win.webContents);
}

function boundsPath() {
  return join(APP_HOME, "window.json");
}

function savedBounds() {
  try {
    const raw = JSON.parse(readFileSync(boundsPath(), "utf8"));
    if (raw?.width >= 280 && raw?.height >= 320) {
      return {
        x: Number.isFinite(raw.x) ? raw.x : undefined,
        y: Number.isFinite(raw.y) ? raw.y : undefined,
        width: raw.width,
        height: raw.height,
      };
    }
  } catch {
    /* first run */
  }
  return { width: 420, height: 580 };
}

let boundsTimer = null;
function persistBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    writeFileSync(boundsPath(), JSON.stringify(win.getBounds()));
  }, 400);
}

function createWindow() {
  const bounds = savedBounds();
  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 280,
    minHeight: 320,
    show: false,
    frame: false,
    transparent: false,
    backgroundColor: "#0b100d",
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    title: "Nova Collar",
    trafficLightPosition: { x: -100, y: -100 },
    webPreferences: {
      preload: join(here, "../preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.error("[renderer]", message);
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error("failed to load", code, desc);
  });
  win.on("moved", persistBounds);
  win.on("resized", persistBounds);
  win.once("ready-to-show", () => {
    const cur = win.getBounds();
    if (cur.width < 300 || cur.height < 360) win.setSize(bounds.width, bounds.height);
    win.show();
  });
  win.loadFile(join(here, "../renderer/index.html"));
}

function startPty() {
  const shellPath = process.env.SHELL || "/bin/zsh";
  const startDir = loadWorkdir();
  // Make the CLI reachable in the window's terminal: ~/.local/bin is where the
  // installer links `np` / `nova-collar`, but it is not on a GUI app's PATH.
  const localBin = join(homedir(), ".local", "bin");
  const basePath = process.env.PATH || "";
  const withLocal = basePath.split(":").includes(localBin) ? basePath : `${localBin}:${basePath}`;
  term = pty.spawn(shellPath, ["-l"], {
    name: "xterm-256color",
    cols: 80,
    rows: 18,
    cwd: startDir || homedir(),
    env: { ...process.env, PATH: withLocal },
  });
  bindPty(term);
  bindTermPid(term.pid);
  let termBuf = "";
  let termFlush = null;
  term.onData((data) => {
    appendTerm(data);
    noteTermActivity();
    termBuf += data;
    if (termFlush) return;
    termFlush = setTimeout(() => {
      send({ type: "term", data: termBuf });
      termBuf = "";
      termFlush = null;
    }, 32);
  });
  watchShellCwd();
}

function visibleMessages() {
  return history.filter((row) => {
    if (row.role === "step") return Boolean(row.name);
    return (row.role === "user" || row.role === "assistant") && String(row.content || "").trim();
  });
}

function modelHistory() {
  return mergeAssistants(history);
}

function snapshot() {
  const cfg = loadConfig();
  return {
    ...publicState(),
    npReady: existsSync(join(homedir(), ".local", "bin", "np")),
    packs: [
      ...packPublic(),
      ...(cfg.hnlSearch ? [{ id: "hnl", title: "hnl", blurb: "Search, pages, memory" }] : []),
      { id: "computer", title: "computer", blurb: "A different machine, if you connected one" },
      ...(platform() === "darwin" ? [{ id: "desk", title: "desk", blurb: "This Mac's screen" }] : []),
    ],
    session: listSessions(),
    bots: listBots(),
    bot: currentBot ? publicBot(currentBot) : null,
    goal: currentGoal,
    archive: currentArchive.slice(-6),
    playbooks: playbookPublic().filter((row) => (cfg.hnlSearch || row.id !== "lookout") && (platform() === "darwin" || row.id !== "desk")),
    messages: visibleMessages(),
    workdir: getWorkdir(),
    intuition: publicIntuition(),
    packTeach: allPackLessons(),
    tasks: publicTasks(),
  };
}

let boardBusy = false;

async function runScheduled(job) {
  const task = job?.task;
  const bot = job?.bot;
  if (turnAbort || boardBusy || !task?.title || !bot?.id) return { skip: true };
  boardBusy = true;
  send({ type: "board", tasks: publicTasks() });
  const session = readSession(bot.id);
  const prior = session?.messages || [];
  const signal = new AbortController();
  const text = [
    task.title,
    task.detail || "",
    task.goal ? `Follow this goal until it is true: ${task.goal}` : "Write one line starting with Goal: naming the outcome, then do the task.",
    "If you need a sharper goal, write one line starting with Goal:.",
    "If the goal is true, the first line is Goal met.",
    job.note ? `Another goal you can help: ${job.note}` : "",
  ].filter(Boolean).join("\n");
  try {
    const result = await runTurn(prior, text, () => {}, signal.signal, {
      bot: readBot(bot.id) || bot,
      pack: bot.pack,
      goal: task.goal,
      note: job.note || "",
      tasker: task.by || "",
      allow: Boolean(task.allow),
      taskId: task.id,
    });
    const assistant = result?.assistant || "";
    let chatId = task.chatId || "";
    if (assistant) {
      persistSession(bot.id, [...prior, { role: "user", content: text }, { role: "assistant", content: assistant }], { title: bot.name });
      const chat = fileChat({
        id: chatId,
        title: `Pack · ${task.title}`,
        messages: [
          { role: "user", content: task.title },
          { role: "assistant", content: assistant },
        ],
      });
      if (chat?.id) chatId = chat.id;
    }
    return { assistant, chatId };
  } catch (error) {
    return { assistant: "", error: redactSecrets(error.message || "Run failed.") };
  } finally {
    boardBusy = false;
  }
}

function teachAfter(ask) {
  if (!currentBot?.pack) return;
  const start = history.map((row) => row.role).lastIndexOf("user");
  const trail = history.slice(start + 1).filter((row) => row.role === "step");
  teachPack({
    pack: currentBot.pack,
    from: currentBot.id,
    fromName: currentBot.name,
    ask,
    trail,
  })
    .then((taught) => {
      if (!taught?.ok) return;
      send({ type: "pack", lessons: allPackLessons(), text: taught.text });
    })
    .catch(() => {});
}

function senseAfter(messages) {
  noteTurn(messages)
    .then((doc) => {
      if (doc) send({ type: "intuition", intuition: doc });
    })
    .catch(() => {});
}

function applyWorkdir(path, opts = {}) {
  const next = setWorkdir(path, opts);
  if (next.ok) sendTerminal(`cd ${JSON.stringify(next.path)}`);
  return next;
}

function useSession(session) {
  currentId = session.id;
  currentGoal = String(session.goal || "");
  currentArchive = Array.isArray(session.archive) ? session.archive : [];
  history.length = 0;
  history.push(...session.messages);
  send({ type: "goal", text: currentGoal, archive: currentArchive.slice(-6) });
}

function persistTurn(userText, rows = []) {
  history.push({ role: "user", content: userText });
  for (const row of rows) {
    if (row?.role === "step" && row.name) {
      history.push({
        role: "step",
        name: row.name,
        pack: row.pack || "",
        ok: row.ok !== false,
        blurb: row.blurb || "",
        detail: row.detail || "",
      });
    }
    if (row?.role === "assistant" && String(row.content || "").trim()) {
      history.push({ role: "assistant", content: row.content });
    }
  }
  if (!currentId) return;
  if (currentBot) persistSession(currentId, history, { title: currentBot.name });
  else saveSession(currentId, history);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

setDeskGuard(async (fn) => {
  if (!win) return fn();
  const wasVisible = win.isVisible();
  const wasPinned = win.isAlwaysOnTop();
  if (wasPinned) win.setAlwaysOnTop(false);
  win.hide();
  await sleep(120);
  try {
    return await fn();
  } finally {
    if (wasVisible) {
      win.show();
      if (wasPinned) win.setAlwaysOnTop(true, "floating");
    }
  }
});

app.setName("Nova Collar");
// Window storage (tips, theme, pack) stays in the package-named folder, not the display name's.
app.setPath("userData", join(app.getPath("appData"), "novapup"));
app.commandLine.appendSwitch("touch-events", "enabled");

function startAutoUpdate() {
  // Packaged builds look at the configured GitHub releases for a newer version,
  // download it, and notify; electron-updater installs it on the next quit.
  // No-op in dev, and any failure (offline, private repo) is swallowed.
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = createRequire(import.meta.url)("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.on("error", () => {});
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch {}
}

app.whenReady().then(() => {
  ensureHome();
  loadWorkdir();
  const { session } = bootSessions();
  useSession(session);
  onWorkdir((path) => send({ type: "cwd", path }));
  createWindow();
  startPty();
  startLaya();
  startAutoUpdate();
  startBoard((job) => runScheduled(job), (rows) => {
    send({ type: "board", tasks: publicTasks() });
    for (const row of rows || []) {
      if (row.status !== "done" && row.status !== "hold") continue;
      send({
        type: "notice",
        title: row.title,
        text: row.status === "hold"
          ? "Waiting. Say yes in the Pack chat to allow one overwrite or delete. Older copies are kept."
          : (String(row.assistant || "").split("\n").map((line) => line.trim()).find(Boolean) || "Done."),
        chatId: row.chatId || "",
      });
    }
  });
});

app.on("before-quit", () => {
  stopBoard();
  stopLaya();
});
app.on("window-all-closed", () => app.quit());

ipcMain.handle("state", (event) => (fromWindow(event) ? snapshot() : {}));

ipcMain.handle("setup:scan", async (event) => (fromWindow(event) ? scanLocalModels() : { found: [] }));

ipcMain.handle("setup:install", async (event) => {
  if (!fromWindow(event)) return { ok: false };
  const result = await ensureOllama((line) => send({ type: "setup-log", line }));
  if (!result.ok) return result;
  saveLocalModel({ url: result.url, model: result.model });
  markSetupDone();
  return { ...result, state: snapshot() };
});

ipcMain.handle("setup:use", (event, pick) => {
  if (!fromWindow(event)) return { ok: false };
  const url = String(pick?.url || "");
  const model = String(pick?.model || "");
  if (!url.startsWith("http://127.0.0.1:") && !url.startsWith("http://localhost:")) {
    return { ok: false, error: "Only a server on this system can be saved." };
  }
  saveLocalModel({ url, model });
  markSetupDone();
  return { ok: true, state: snapshot() };
});

ipcMain.handle("setup:skip", (event) => {
  if (!fromWindow(event)) return { ok: false };
  markSetupDone();
  return { ok: true, state: snapshot() };
});

ipcMain.handle("keys", (event, keys) => {
  if (!fromWindow(event)) return {};
  const result = saveKeys(keys && typeof keys === "object" ? keys : {});
  const state = snapshot();
  return result && result.urlRejected ? { ...state, urlRejected: result.urlRejected } : state;
});

ipcMain.handle("model", (event, id) => {
  if (!fromWindow(event)) return {};
  saveKeys({ model: String(id || "") });
  return snapshot();
});

ipcMain.handle("model:lane", (event, body) => {
  if (!fromWindow(event)) return {};
  saveLane({ lane: String(body?.lane || ""), model: String(body?.model || "") });
  return snapshot();
});

ipcMain.handle("sessions:list", (event) => (fromWindow(event) ? listSessions() : { current: null, chats: [] }));

function parkCurrent() {
  if (!currentId) return;
  if (currentBot) persistSession(currentId, history, { title: currentBot.name });
  else saveSession(currentId, history);
}

ipcMain.handle("sessions:new", (event) => {
  if (!fromWindow(event)) return {};
  parkCurrent();
  currentBot = null;
  useSession(createSession());
  return snapshot();
});

ipcMain.handle("workdir:set", (event, path) => {
  if (!fromWindow(event)) return { ok: false };
  return applyWorkdir(String(path || ""), { create: true });
});

ipcMain.handle("workdir:pick", async (event) => {
  if (!fromWindow(event)) return { ok: false };
  const picked = await dialog.showOpenDialog(win, {
    title: "Working directory",
    defaultPath: getWorkdir(),
    properties: ["openDirectory", "createDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true, path: getWorkdir() };
  return applyWorkdir(picked.filePaths[0]);
});

ipcMain.handle("sessions:open", (event, id) => {
  if (!fromWindow(event)) return {};
  if (!isChatId(id) || id === currentId) return snapshot();
  parkCurrent();
  currentBot = null;
  const session = openSession(id);
  if (session) useSession(session);
  return snapshot();
});

ipcMain.handle("voice:read", (event) => (fromWindow(event) ? { text: readMemory().personality || "" } : { text: "" }));

let specAbort = null;

ipcMain.handle("spec:read", (event) => (fromWindow(event) ? { text: readSpec() } : { text: "" }));

ipcMain.handle("spec:write", (event, text) => (fromWindow(event) ? writeSpec(text) : { ok: false }));

ipcMain.handle("spec:complete", async (event, body) => {
  if (!fromWindow(event)) return { ok: false, error: "denied" };
  specAbort?.abort();
  specAbort = new AbortController();
  try {
    return await completeSpec(body || {}, specAbort.signal);
  } catch (error) {
    if (specAbort.signal.aborted) return { ok: false, error: "stopped" };
    return { ok: false, error: redactSecrets(error.message || "That failed.").slice(0, 200) };
  }
});

ipcMain.handle("clipboard:write", (event, text) => {
  if (!fromWindow(event)) return { ok: false };
  clipboard.writeText(String(text || "").slice(0, 100000));
  return { ok: true };
});

ipcMain.handle("voice:make", async (event, wish) => {
  if (!fromWindow(event)) return { ok: false, error: "no" };
  try {
    return { ok: true, voices: await draftVoices(wish) };
  } catch (error) {
    return { ok: false, error: redactSecrets(error.message || "That failed.").slice(0, 200) };
  }
});

ipcMain.handle("voice:set", (event, text) => {
  if (!fromWindow(event)) return { ok: false };
  const body = String(text || "").trim().slice(0, 500);
  if (body.length < 24) return { ok: false, error: "That voice is too short." };
  if (watchJailbreak(body)) return { ok: false, error: "I won't take that voice." };
  const wrote = writeMemory("personality", body);
  return wrote.ok ? { ok: true, text: body } : { ok: false, error: wrote.error || "Couldn’t keep that." };
});

ipcMain.handle("intuition:review", async (event) => {
  if (!fromWindow(event)) return {};
  await reviewNow(history);
  return snapshot();
});

ipcMain.handle("bots:list", (event) => (fromWindow(event) ? snapshot() : {}));

ipcMain.handle("bots:save", (event, input) => {
  if (!fromWindow(event)) return {};
  const bot = saveBot(input && typeof input === "object" && !Array.isArray(input) ? input : {});
  if (bot && currentBot?.id === bot.id) currentBot = readBot(bot.id);
  return snapshot();
});

ipcMain.handle("tasks:save", (event, input) => {
  if (!fromWindow(event)) return {};
  assignTask(input && typeof input === "object" && !Array.isArray(input) ? input : {});
  return snapshot();
});

ipcMain.handle("bots:open", (event, id) => {
  if (!fromWindow(event)) return {};
  if (!isBotId(id)) return snapshot();
  if (currentBot?.id === id && currentId === id) return snapshot();
  parkCurrent();
  const next = openBot(id);
  if (!next?.bot || !next.session) return snapshot();
  currentBot = next.bot;
  useSession(next.session);
  return snapshot();
});

ipcMain.handle("bots:remove", (event, id) => {
  if (!fromWindow(event)) return {};
  if (!isBotId(id)) return snapshot();
  const was = currentBot?.id === id;
  removeBot(id);
  if (was) {
    currentBot = null;
    const list = listSessions();
    const session = (list.current && openSession(list.current)) || createSession();
    useSession(session);
  }
  return snapshot();
});

ipcMain.handle("pin", (event, on) => {
  if (!fromWindow(event)) return false;
  win?.setAlwaysOnTop(Boolean(on), "floating");
  return Boolean(on);
});

ipcMain.handle("open-settings", (event) => {
  if (!fromWindow(event)) return false;
  return shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
});

ipcMain.on("term-write", (event, data) => {
  if (!fromWindow(event)) return;
  term?.write(String(data || "").slice(0, 16_384));
});
ipcMain.on("term-resize", (event, size) => {
  if (!fromWindow(event)) return;
  const cols = Number(size?.cols);
  const rows = Number(size?.rows);
  if (term && cols > 0 && rows > 0 && cols < 400 && rows < 200) term.resize(cols, rows);
});
ipcMain.on("window-min", (event) => {
  if (fromWindow(event)) win?.minimize();
});
ipcMain.on("window-close", (event) => {
  if (fromWindow(event)) win?.close();
});
ipcMain.handle("window-grow", (event, size = {}) => {
  if (!fromWindow(event) || !win) return;
  const width = Number(size.width);
  const height = Number(size.height);
  const bounds = win.getBounds();
  win.setSize(Math.max(bounds.width, width > 0 ? width : 860), Math.max(bounds.height, height > 0 ? height : bounds.height));
  persistBounds();
});

function reportWatchdog(killed) {
  for (const row of killed || []) {
    const payload = {
      type: "tool_result",
      name: "watchdog",
      ok: false,
      blurb: "Caught a runaway",
      detail: row.why || "Stopped a leftover process.",
    };
    send(payload);
  }
  return killed?.length ? killed : [];
}

ipcMain.handle("stop", (event) => {
  if (!fromWindow(event)) return { ok: false };
  turnAbort?.abort();
  return { ok: true };
});

ipcMain.handle("chat", async (event, payload) => {
  if (!fromWindow(event)) return { ok: false, error: "denied" };
  const text = (typeof payload === "string" ? payload : String(payload?.text || "")).slice(0, 24_000);
  const pack = safePack(typeof payload === "object" && payload ? payload.pack : "");
  const cfg = loadConfig();
  if (!existsSync(BIN)) {
    send({ type: "error", text: "mac-control is missing. Run npm run build:mac" });
  }
  const goalCmd = applyGoalCommand(text, currentGoal);
  if (goalCmd.changed && currentId) currentGoal = writeGoal(currentId, goalCmd.goal);
  else if (goalCmd.changed) currentGoal = goalCmd.goal;
  const heard = spokenGoal(text);
  if (heard) currentGoal = currentId ? writeGoal(currentId, heard) : heard;
  if (goalCmd.changed || heard) send({ type: "goal", text: currentGoal });
  if (goalCmd.handled) {
    const last = currentArchive.at(-1);
    const reply = goalCmd.goal && last
      ? `${goalCmd.reply}\nLast check: ${last.verdict}. ${last.opposite || last.detail || ""}`.trim()
      : goalCmd.reply;
    persistTurn(text, [{ role: "assistant", content: reply }]);
    send({ type: "done", text: reply });
    send({ type: "mood", mood: "idle", text: "here" });
    return { ok: true, goal: currentGoal };
  }
  const released = releaseHeld(text, currentId);
  if (released) {
    send({ type: "board", tasks: publicTasks() });
    send({ type: "done", text: "Yes. One overwrite or delete can proceed. Older copies are kept." });
    send({ type: "mood", mood: "idle", text: "here" });
    return { ok: true };
  }
  if (!isLocalModel(cfg.model) && !cfg.chatKey && !cfg.toolsKey) {
    return { ok: false, error: "need-keys" };
  }
  const runText = goalCmd.runText || text;
  turnAbort = new AbortController();
  beginTurn({ termPid: term?.pid, signal: turnAbort.signal, workdir: getWorkdir() });
  try {
    const tape = createTimeline();
    const result = await runTurn(modelHistory(), runText, (payload) => {
      if (payload?.type === "retract") tape.retract();
      if (payload?.type === "delta") tape.delta(payload.text);
      if (payload?.type === "tool_result") tape.step(payload);
      send(payload);
    }, turnAbort.signal, { pack: pack || currentBot?.pack || "", bot: currentBot, goal: currentGoal });
    const leftovers = reportWatchdog(endTurn());
    if (leftovers.length) {
      tape.step({
        name: "watchdog",
        ok: false,
        blurb: "Caught a runaway",
        detail: leftovers.map((row) => row.why).join("\n"),
      });
    }
    for (const entry of result.archive || []) {
      if (currentId) currentArchive = pushArchive(currentId, entry);
      else currentArchive = [...currentArchive, entry].slice(-24);
    }
    if (result.goalStatus === "done" && currentGoal && currentId) {
      currentGoal = writeGoal(currentId, "");
      send({ type: "goal", text: "", archive: currentArchive.slice(-6) });
    }
    persistTurn(text, tape.finish(result.assistant));
    send({ type: "done", text: result.assistant });
    teachAfter(runText);
    senseAfter(history);
    return { ok: true };
  } catch (error) {
    const leftovers = reportWatchdog(endTurn());
    const timedOut = error.name === "TimeoutError" || /timeout/i.test(error.message || "");
    const stopped = !timedOut && (error.name === "AbortError" || /stopped/i.test(error.message || ""));
    const reply = timedOut
      ? "That turn timed out. Say go and I’ll pick up from the last tool."
      : stopped
        ? "Stopped."
        : redactSecrets(error.message || "That failed.");
    persistTurn(text, [
      ...leftovers.length ? [{ role: "step", name: "watchdog", ok: false, blurb: "Caught a runaway", detail: leftovers.map((row) => row.why).join("\n") }] : [],
      { role: "assistant", content: reply },
    ]);
    send({ type: stopped ? "done" : "error", text: reply });
    senseAfter(history);
    send({ type: "mood", mood: "idle", text: "here" });
    return { ok: !stopped, error: stopped ? undefined : error.message, stopped };
  } finally {
    turnAbort = null;
  }
});
