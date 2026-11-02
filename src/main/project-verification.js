/** Bounded project observations and declared checks; never a drive-wide crawler. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SKIP = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "target", "dist", "build", ".next", ".cache", ".DS_Store", ".pytest_cache", ".swiftpm", ".build", "DerivedData"]);
const CHECK_PROFILES = [".nova/checks.json", ".novatag/checks.json"];
const MARKERS = [...CHECK_PROFILES, "harness.json", "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "Package.swift", "Makefile", ".git"];
const hash = (data) => createHash("sha256").update(data).digest("hex");
const canon = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

export function projectRoot(path, { directory = false } = {}) {
  let dir = directory ? resolve(path) : dirname(resolve(path));
  for (let depth = 0; depth < 8; depth++) {
    if (MARKERS.some((name) => existsSync(join(dir, name)))) return canon(dir);
    const parent = dirname(dir); if (parent === dir) break; dir = parent;
  }
  return null;
}

export function projectSnapshot(root) {
  root = canon(root);
  const files = new Map(), coverage = [];
  let head = "", count = 0, bytes = 0;
  const fingerprint = (file) => {
    if (++count > 5000) throw new Error("Project observation exceeded 5000 entries.");
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) { coverage.push(`Symlink not followed: ${file}`); return "symlink"; }
      if (!stat.isFile()) return "other";
      bytes += stat.size;
      if (stat.size > 10 * 1024 * 1024 || bytes > 30 * 1024 * 1024) throw new Error("Project observation exceeded its 10 MiB file / 30 MiB total limit.");
      return hash(readFileSync(file));
    } catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
  };
  const git = (args) => execFileSync("git", ["-C", root, "-c", "core.fsmonitor=false", ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  let gitFiles = null;
  try {
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    try { head = git(["rev-parse", "HEAD"]).trim(); } catch { head = "unborn"; }
    gitFiles = { top, entries: git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]).split("\0") };
  } catch { /* A non-Git project uses the same bounded source observation. */ }
  try {
    if (gitFiles) {
      for (let i = 0; i < gitFiles.entries.length; i++) {
        const entry = gitFiles.entries[i]; if (!entry) continue;
        const name = entry.slice(3), status = entry.slice(0, 2), file = resolve(gitFiles.top, name);
        if (!CHECK_PROFILES.some((profile) => name.endsWith(profile)) && name.split(/[\\/]/).some((part) => SKIP.has(part))) continue;
        files.set(file, `${status}:${fingerprint(file)}`);
        if (/[RC]/.test(status)) { const old = gitFiles.entries[++i]; if (old) files.set(resolve(gitFiles.top, old), "renamed"); }
      }
    } else {
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (SKIP.has(entry.name)) continue;
          const file = join(dir, entry.name);
          if (entry.isDirectory()) { if (++count > 5000) throw new Error("Project observation exceeded 5000 entries."); walk(file); }
          else files.set(file, fingerprint(file));
        }
      };
      walk(root);
    }
    for (const profile of CHECK_PROFILES) {
      const checks = join(root, profile);
      if (existsSync(checks)) files.set(checks, fingerprint(checks));
    }
  } catch (error) { coverage.push(error.message); }
  return { root, files, head, git: !!gitFiles, coverage, revision: hash(JSON.stringify({ head, files: [...files].sort(([a], [b]) => a.localeCompare(b)) })) };
}

export function projectChecks(root) {
  const config = CHECK_PROFILES.map((profile) => join(root, profile)).find((file) => existsSync(file)) || join(root, CHECK_PROFILES[0]);
  let commands = [], timeoutMs = 90000, expect = "";
  try {
    if (existsSync(config)) {
      const value = JSON.parse(readFileSync(config, "utf8")); commands = value.commands;
      timeoutMs = Math.min(90000, Math.max(1000, Number(value.timeoutMs) || timeoutMs));
      if (!Array.isArray(commands) || !commands.length || commands.length > 8 || commands.some((command) => typeof command !== "string" || !command.trim() || command.length > 4000)) throw new Error("checks.json needs 1–8 nonempty executable command strings.");
    } else if (existsSync(join(root, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")), scripts = pkg.scripts || {};
      const requested = String(pkg.packageManager || "").split("@")[0];
      const manager = ["npm", "pnpm", "yarn", "bun"].includes(requested) ? requested : existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")) ? "bun" : "npm";
      commands = ["typecheck", "build", "test"].filter((name) => scripts[name]).map((name) => `${manager} run ${name}`);
    } else if (existsSync(join(root, "Cargo.toml"))) commands = ["cargo check", "cargo test"];
    else if (existsSync(join(root, "go.mod"))) commands = ["go test ./..."];
    else if (existsSync(join(root, "Package.swift"))) commands = ["swift test"];
    else if (existsSync(join(root, "harness.json"))) {
      const spec = JSON.parse(readFileSync(join(root, "harness.json"), "utf8"));
      const command = String(spec.check || spec.command || "").trim(); if (command) commands = [command];
      expect = String(spec.expect || "").trim();
    }
    return { commands, timeoutMs, expect, source: existsSync(config) ? config : "project manifests" };
  } catch (error) { return { commands: [], timeoutMs, source: config, error: error.message }; }
}

export class ProjectObserver {
  constructor(cwd, ledger) {
    this.cwd = cwd; this.ledger = ledger; this.roots = new Map(); this.candidates = new Set(); this.attempts = new Map();
    const current = projectRoot(cwd, { directory: true }); if (current) this.watch(current);
    for (const entry of ledger?.entries.values() || []) if (entry.kind === "project") {
      const snapshot = this.watch(entry.path);
      if (snapshot.revision !== entry.hash || snapshot.coverage.length) ledger.projectChanged(entry.path, snapshot.revision, snapshot.coverage);
    }
  }
  watch(root) {
    const path = canon(root);
    if (!this.roots.has(path)) this.roots.set(path, projectSnapshot(path));
    return this.roots.get(path);
  }
  prepare(name, args) {
    if (name === "computer_write" || name.startsWith("computer_")) return;
    const base = args.cwd ? resolve(this.cwd, args.cwd) : this.cwd;
    const current = projectRoot(base, { directory: true }); if (current) this.watch(current);
    for (const path of [args.path, ...(Array.isArray(args.paths) ? args.paths : [])].filter((path) => typeof path === "string" && path)) {
      const full = resolve(base, path);
      if (MARKERS.includes(basename(full))) this.candidates.add(dirname(full));
      let directory = false; try { directory = lstatSync(full).isDirectory(); } catch {}
      const root = projectRoot(full, { directory });
      if (root) this.watch(root);
      else if (directory) this.watch(full);
    }
  }
  observe() {
    for (const candidate of this.candidates) if (!this.roots.has(canon(candidate)) && projectRoot(candidate, { directory: true }) === canon(candidate)) {
      const snapshot = this.watch(candidate); this.ledger.projectChanged(candidate, snapshot.revision, snapshot.coverage);
    }
    for (const [root, before] of [...this.roots]) {
      const after = projectSnapshot(root);
      if (before.revision !== after.revision || JSON.stringify(before.coverage) !== JSON.stringify(after.coverage)) {
        this.ledger.projectChanged(root, after.revision, after.coverage);
        for (const file of after.files.keys()) if (["package.json", "Cargo.toml", "go.mod", "Package.swift", "pyproject.toml"].includes(basename(file))) {
          const nested = projectRoot(file);
          if (nested && nested !== root && !this.roots.has(nested)) {
            const snapshot = this.watch(nested); this.ledger.projectChanged(nested, snapshot.revision, snapshot.coverage);
          }
        }
      }
      this.roots.set(root, after);
    }
  }
  async check(exec, { activeWriter = () => false } = {}) {
    this.observe(); const results = [];
    for (const row of this.ledger.unresolved().filter((entry) => entry.kind === "project")) {
      const before = projectSnapshot(row.path), profile = projectChecks(row.path);
      const writer = activeWriter(row.path);
      const attempt = `${before.revision}:${JSON.stringify(before.coverage)}`;
      if (writer) this.attempts.delete(row.path);
      else if (this.attempts.get(row.path) === attempt) continue;
      // Only a relevant source/profile revision or a new user turn authorizes
      // another automatic attempt. Writer skips remain retryable when it stops.
      if (!writer) this.attempts.set(row.path, attempt);
      let result = { ok: true, command: profile.commands.join(" && "), output: "" };
      if (profile.error || !profile.commands.length || !exec || writer) result = { ok: false, skipped: true, command: result.command, output: profile.error || (writer ? "A file-changing job is still active." : "No executable project check profile is available.") };
      else for (const command of profile.commands) {
        const checked = await exec(command, { cwd: row.path, timeoutMs: profile.timeoutMs });
        result.output += `${command}\n${checked?.stdout || checked?.output || checked?.stderr || checked?.error || ""}\n`;
        if (checked?.ok !== true) { result.ok = false; result.held = checked?.held; break; }
      }
      if (result.ok && profile.expect && !result.output.includes(profile.expect)) { result.ok = false; result.output += `Expected output missing: ${profile.expect}`; }
      const after = projectSnapshot(row.path), coverage = [...new Set([...before.coverage, ...after.coverage])];
      if (before.revision !== after.revision) coverage.push("Source changed during project verification; run checks again.");
      const verification = this.ledger.projectChecked(row.path, result, after.revision, coverage);
      this.roots.set(row.path, after);
      results.push({ name: "harness", pack: "host", path: row.path, ok: verification.status === "passed", held: result.held, blurb: `${verification.status} project ${row.path}`, detail: verification.diagnostic || "Declared project checks passed.", verification: { ...verification } });
      if (result.held) break;
    }
    return results;
  }
}
