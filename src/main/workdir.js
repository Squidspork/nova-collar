import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { APP_HOME } from "./config.js";

const execFileAsync = promisify(execFile);
const FILE = () => join(APP_HOME, "workdir.json");

let cwd = homedir();
let termPid = null;
let timer = null;
let listeners = [];

function persist() {
  writeFileSync(FILE(), JSON.stringify({ path: cwd }));
}

function emit() {
  for (const fn of listeners) fn(cwd);
}

export function onWorkdir(fn) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((row) => row !== fn);
  };
}

export function getWorkdir() {
  return cwd;
}

export function expandPath(path, base = cwd) {
  if (!path) return base;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (path.startsWith("/")) return resolve(path);
  return resolve(base, path);
}

export function loadWorkdir() {
  try {
    const raw = JSON.parse(readFileSync(FILE(), "utf8"));
    const next = expandPath(raw?.path, homedir());
    if (existsSync(next) && statSync(next).isDirectory()) cwd = next;
  } catch {
    /* first run */
  }
  return cwd;
}

export function setWorkdir(path, { create = false } = {}) {
  const next = expandPath(path, cwd);
  if (create) mkdirSync(next, { recursive: true });
  if (!existsSync(next) || !statSync(next).isDirectory()) {
    return { ok: false, error: "not a directory", path: next };
  }
  if (next !== cwd) {
    cwd = next;
    persist();
    emit();
  }
  return { ok: true, path: cwd };
}

export function bindTermPid(pid) {
  termPid = pid || null;
}

export async function peekShellCwd() {
  if (!termPid) return null;
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(termPid), "-d", "cwd", "-Fn"], {
      timeout: 1500,
    });
    const line = String(stdout || "")
      .split("\n")
      .find((row) => row.startsWith("n/"));
    if (!line) return null;
    const path = line.slice(1);
    if (existsSync(path) && statSync(path).isDirectory()) return path;
  } catch {
    /* lsof missing or process gone */
  }
  return null;
}

export async function followShellCwd() {
  const next = await peekShellCwd();
  if (next) setWorkdir(next);
  return cwd;
}

export function noteTermActivity() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    followShellCwd().catch(() => {});
  }, 280);
}

export function watchShellCwd() {
  followShellCwd().catch(() => {});
}
