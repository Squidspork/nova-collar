import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_HOME, LAYA_DATA, LAYA_SCRIPT, MODEL_HOME } from "./config.js";

const script = LAYA_SCRIPT;
const model = process.env.NP_LAYA_MODEL || join(MODEL_HOME, "models", "laya-np");
const venvDir = join(APP_HOME, "laya", ".venv");

let child = null;
let buffer = "";
let waiters = [];
let chain = Promise.resolve();
let warm = false;

function pythonBin() {
  const candidates = [
    process.env.NP_LAYA_PYTHON,
    layaVenvPython(),
    join(homedir(), "Projects/laya-demo/.venv/bin/python"),
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (found) return found;
  // No pinned venv: try a python3 on PATH. If it lacks torch or the laya package,
  // the reader exits on import and the window falls back to the heuristic decider.
  return process.platform === "win32" ? "python" : "python3";
}

export function layaReady() {
  return Boolean(pythonBin() && existsSync(script) && existsSync(join(model, "model.safetensors")));
}

// --- one-time optional setup: a private Python venv Laya can run from ---
// laya is public and Apache-2.0 (convaiinnovations/laya); it pulls torch,
// transformers, safetensors, huggingface_hub, and numpy. Nothing private installs.
const LAYA_PIP = process.env.NP_LAYA_PIP || "laya==0.3.20";

export function layaVenvPython() {
  return process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}

function basePython() {
  const names = [process.env.NP_LAYA_BASE_PYTHON, "python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"];
  for (const name of names) {
    if (!name) continue;
    const probe = spawnSync(name, ["-c", "import sys;print(sys.version_info[0],sys.version_info[1])"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (probe.status !== 0) continue;
    const [major, minor] = String(probe.stdout).trim().split(/\s+/).map(Number);
    if (major === 3 && minor >= 10) return name;
  }
  return "";
}

export function ensureLayaVenv({ force = false, log = () => {} } = {}) {
  const python = layaVenvPython();
  if (!force && existsSync(python)) return { ok: true, python, skipped: true };
  const base = basePython();
  if (!base) {
    return { ok: false, error: "Need Python 3.10 or newer on this computer first. Install it, then run nova-collar update laya again." };
  }
  log("Setting up a small Python environment for Laya…");
  const made = spawnSync(base, ["-m", "venv", venvDir], { encoding: "utf8" });
  if (made.status !== 0 || !existsSync(python)) {
    return { ok: false, error: "Could not create the Python environment for Laya." };
  }
  spawnSync(python, ["-m", "pip", "install", "--upgrade", "pip", "wheel"], { stdio: "inherit" });
  log("Installing Laya and PyTorch (a few hundred MB; this can take a few minutes)…");
  const got = spawnSync(python, ["-m", "pip", "install", LAYA_PIP], { stdio: "inherit" });
  if (got.status !== 0) {
    return { ok: false, error: "pip could not install Laya. Check the internet connection, then run nova-collar update laya again." };
  }
  return { ok: true, python, skipped: false };
}

function failAll(error) {
  const pending = waiters;
  waiters = [];
  for (const waiter of pending) waiter({ ok: false, error });
}

export function stopLaya() {
  const proc = child;
  child = null;
  warm = false;
  buffer = "";
  if (proc && !proc.killed) proc.kill();
  failAll("stopped");
}

function onData(chunk) {
  buffer += chunk.toString();
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\n");
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.ready) {
      warm = true;
      continue;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
  }
}

export function startLaya() {
  if (child || !layaReady()) return false;
  child = spawn(pythonBin(), [script], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, USE_TF: "0", PYTHONUNBUFFERED: "1", NP_LAYA_MODEL: model, NP_LAYA_DATA: LAYA_DATA },
  });
  child.stdout.on("data", onData);
  child.on("exit", () => {
    child = null;
    warm = false;
    failAll("laya stopped");
  });
  return true;
}

let asksCache;

function trainedAsks() {
  if (asksCache) return asksCache;
  try {
    const cfg = JSON.parse(readFileSync(join(model, "rl_agent_config.json"), "utf8"));
    asksCache = new Set(Array.isArray(cfg.asks) ? cfg.asks : []);
  } catch {
    asksCache = new Set();
  }
  return asksCache;
}

export function layaLoopTrained() {
  return trainedAsks().has("loop");
}

export function layaGoalTrained() {
  return trainedAsks().has("goal");
}

export function layaAuditTrained() {
  return trainedAsks().has("audit");
}

function ask(text, which) {
  if (!child) startLaya();
  if (!child) return Promise.resolve(null);
  const limit = warm ? 8000 : 90000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
      stopLaya();
    }, limit);
    waiters.push((msg) => {
      clearTimeout(timer);
      resolve(msg?.ok ? msg : null);
    });
    child.stdin.write(`${JSON.stringify({ text: String(text).slice(0, 4000), ask: which || "job" })}\n`);
  });
}

export function readLaya(text, which = "job") {
  if (!layaReady()) return Promise.resolve(null);
  const run = chain.then(() => ask(text, which));
  chain = run.then(() => {}, () => {});
  return run;
}
