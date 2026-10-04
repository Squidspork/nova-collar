import { execFileSync, spawn } from "node:child_process";
import { scrubEnv } from "./safe.js";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isWindows, shellLaunch } from "./platform.js";

const TMPS = [...new Set([tmpdir(), "/tmp", "/private/tmp"].map((dir) => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}))];
const MAX_GROWTH = 32 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_WRITE = 8 * 1024 * 1024;
const HOT = /(?:\byes\b\s*[>|])|(?:while\s*(?:true|:|1))|(?:(?::|\btrue\b)\s*;?\s*do\b)|(?:nohup\b)|(?:&\s*$)/i;

let turn = null;

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function dirShot(dir) {
  const map = {};
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      map[name] = fileSize(join(dir, name));
    }
  } catch {
    /* dir unreadable */
  }
  return map;
}

function tmpShot() {
  const map = {};
  for (const dir of TMPS) Object.assign(map, dirShot(dir));
  return map;
}

function growthSince(before, dir = TMP) {
  const now = dirShot(dir);
  let grew = 0;
  const fat = [];
  for (const [name, size] of Object.entries(now)) {
    const delta = size - (before[name] || 0);
    if (delta > 0) grew += delta;
    if (delta > 0 && size >= MAX_FILE) fat.push({ path: join(dir, name), size });
  }
  return { grew, fat };
}

function removeFat(files) {
  for (const file of files || []) {
    try {
      unlinkSync(file.path);
    } catch {
      /* still open or already gone */
    }
  }
}

function killGroup(pid) {
  if (!pid) return;
  if (isWindows) {
    try { execFileSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 3000 }); } catch {}
    return;
  }
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  }
}

function descendants(pid) {
  if (isWindows) return [];
  const found = new Set();
  const walk = (parent) => {
    let text = "";
    try {
      text = execFileSync("pgrep", ["-P", String(parent)], { encoding: "utf8", timeout: 800 });
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      const child = Number(line.trim());
      if (!child || found.has(child)) continue;
      found.add(child);
      walk(child);
    }
  };
  walk(pid);
  return [...found];
}

function writesFat(pid) {
  try {
    const text = execFileSync("lsof", ["-a", "-p", String(pid), "-Fn"], { encoding: "utf8", timeout: 1200 });
    for (const line of text.split("\n")) {
      if (!line.startsWith("n/")) continue;
      const path = line.slice(1);
      if (fileSize(path) >= MAX_FILE) return path;
    }
  } catch {
    /* lsof miss */
  }
  return "";
}

function cpuHot(pid) {
  try {
    const text = execFileSync("ps", ["-o", "pcpu=", "-p", String(pid)], { encoding: "utf8", timeout: 800 });
    return Number(text.trim()) >= 70;
  } catch {
    return false;
  }
}

function stopPid(pid, why) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
  const event = { pid, why };
  if (turn) turn.killed.push(event);
  return event;
}

export function beginTurn({ termPid, signal, workdir } = {}) {
  turn = {
    termPid: termPid || null,
    signal: signal || null,
    workdir: workdir || homedir(),
    beforeKids: termPid ? descendants(termPid) : [],
    groups: [],
    killed: [],
    tmp: tmpShot(),
    work: dirShot(workdir || homedir()),
  };
}

export function endTurn() {
  if (!turn) return [];
  for (const pid of turn.groups) killGroup(pid);
  const extra = [];
  if (turn.termPid) {
    for (const pid of descendants(turn.termPid)) {
      if (turn.beforeKids.includes(pid)) continue;
      const fat = writesFat(pid);
      if (fat) extra.push(stopPid(pid, `was filling ${fat}`));
      else if (cpuHot(pid)) extra.push(stopPid(pid, "stuck at high CPU after the turn"));
    }
  }
  const killed = [...turn.killed, ...extra];
  turn = null;
  return killed;
}

export function checkWrite(content) {
  const bytes = Buffer.byteLength(String(content ?? ""), "utf8");
  if (bytes > MAX_WRITE) {
    return {
      ok: false,
      error: `Write blocked at ${(bytes / 1024 / 1024).toFixed(1)} MB. Cap is 8 MB so a runaway file cannot fill the disk.`,
    };
  }
  return { ok: true, bytes };
}

export function runWatched(command, cwd, { signal, timeoutMs } = {}) {
  signal = signal || turn?.signal;
  const risky = HOT.test(String(command || ""));
  const budget = Math.min(timeoutMs || (risky ? 12_000 : 90_000), risky ? 12_000 : 90_000);
  // Shared temp directories contain other apps' downloads and installers. Watch
  // only the private temp directory assigned to this command, never delete theirs.
  const commandTmp = mkdtempSync(join(tmpdir(), "nova-command-"));
  const beforeTmp = dirShot(commandTmp);
  const beforeWork = dirShot(cwd || turn?.workdir || homedir());
  return new Promise((resolve) => {
    const shell = shellLaunch(command);
    const child = spawn(shell.file, shell.args, {
      cwd,
      env: { ...scrubEnv(), TMP: commandTmp, TEMP: commandTmp, TMPDIR: commandTmp },
      detached: !isWindows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (turn && child.pid) turn.groups.push(child.pid);

    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(tick);
      signal?.removeEventListener?.("abort", onAbort);
      if (!result.ok) killGroup(child.pid);
      try { rmSync(commandTmp, { recursive: true, force: true }); } catch {}
      resolve({
        ...result,
        cwd,
        stdout: stdout.slice(0, 40_000),
        stderr: stderr.slice(0, 8_000),
      });
    };

    const onAbort = () => {
      killGroup(child.pid);
      finish({ ok: false, killed: "stop", error: "Stopped." });
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 400_000) stderr = stderr.slice(-400_000);
    });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => {
      const tmp = [growthSince(beforeTmp, commandTmp)];
      const work = growthSince(beforeWork, cwd || turn?.workdir || homedir());
      const disk = [...tmp.flatMap((row) => row.fat), ...work.fat];
      const limited = /file size limit/i.test(stderr);
      if (disk.length || limited) {
        removeFat(tmp.flatMap((row) => row.fat));
        finish({
          ok: false,
          killed: "disk",
          error: `Stopped a runaway write at ${disk[0]?.path || "a file"}.`,
        });
        return;
      }
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: stderr.trim() || `exit ${code}` });
    });

    const timer = setTimeout(() => {
      killGroup(child.pid);
      finish({
        ok: false,
        killed: "timeout",
        error: `Stopped after ${Math.round(budget / 1000)}s so it could not run forever.`,
      });
    }, budget);

    const tick = setInterval(() => {
      const tmp = [growthSince(beforeTmp, commandTmp)];
      const work = growthSince(beforeWork, cwd || turn?.workdir || homedir());
      const grew = tmp.reduce((sum, row) => sum + row.grew, 0) + work.grew;
      const disk = [...tmp.flatMap((row) => row.fat), ...work.fat];
      if (grew >= MAX_GROWTH || disk.length) {
        killGroup(child.pid);
        removeFat(tmp.flatMap((row) => row.fat));
        const where = disk[0]?.path || `/tmp grew ${(grew / 1024 / 1024).toFixed(0)} MB`;
        finish({ ok: false, killed: "disk", error: `Stopped a runaway write at ${where}.` });
      }
      if (signal?.aborted) onAbort();
    }, 160);

    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
