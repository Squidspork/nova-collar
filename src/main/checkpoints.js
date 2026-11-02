/** Per-turn file versions. Manifests reference shared content-addressed blobs. */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { APP_HOME } from "./config.js";

const ROOT = join(APP_HOME, "checkpoints");
const OBJECTS = join(ROOT, "objects");
const IGNORE = new Set([".git", ".novapup", ".nova-collar-public", "node_modules", "__pycache__", ".venv", "target", "dist", "build"]);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const manifestDir = (sessionId) => join(ROOT, hash(String(sessionId)).slice(0, 24));
function canonical(file) {
  try { return realpathSync(file); } catch {
    const parent = dirname(file); return parent === file ? file : join(canonical(parent), basename(file));
  }
}

function snapshot(file, maxBytes) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    if (stat.size > maxBytes) throw new Error("file exceeds checkpoint size limit");
    const data = readFileSync(file);
    return { hash: hash(data), mode: stat.mode & 0o777, data, realPath: canonical(file) };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function store(snapshot) {
  if (!snapshot) return null;
  mkdirSync(OBJECTS, { recursive: true, mode: 0o700 });
  const file = join(OBJECTS, snapshot.hash);
  try { writeFileSync(file, snapshot.data, { flag: "wx", mode: 0o600 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  return { hash: snapshot.hash, mode: snapshot.mode };
}

export class Checkpoint {
  constructor(sessionId, cwd, options = {}) {
    this.sessionId = sessionId; this.cwd = cwd; this.before = new Map(); this.directories = new Set(); this.skipped = [];
    this.maxBytes = options.maxFileBytes || 10 * 1024 * 1024;
    this.maxTotal = options.maxTotalBytes || 50 * 1024 * 1024;
    this.bytes = 0;
  }

  track(paths) {
    for (const given of paths) {
      const file = resolve(this.cwd, String(given));
      try {
        if (existsSync(file) && lstatSync(file).isDirectory()) {
          if (this.directories.has(file)) continue;
          this.walk(file, (entry) => this.capture(entry));
          this.directories.add(file);
        } else if (!existsSync(file) && String(given).endsWith("/")) {
          this.directories.add(file);
        } else this.capture(file);
      } catch (error) { this.skipped.push(`${file}: ${error.message}`); }
    }
  }

  walk(dir, visit) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORE.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) this.walk(file, visit);
      else if (entry.isFile()) visit(file);
      if (this.before.size >= 500) throw new Error("checkpoint file count limit reached");
    }
  }

  capture(file) {
    if (this.before.has(file)) return;
    if (this.before.size >= 500) throw new Error("checkpoint file count limit reached");
    // An unseen file under a directory already captured was created this turn.
    const added = [...this.directories].some((dir) => file.startsWith(dir + sep));
    const before = added ? null : snapshot(file, this.maxBytes);
    if (this.bytes + (before?.data.length || 0) > this.maxTotal) throw new Error("checkpoint memory limit reached");
    this.bytes += before?.data.length || 0;
    this.before.set(file, before);
  }

  finish(reason) {
    const changes = [];
    let afterBytes = 0;
    for (const dir of this.directories) {
      try { this.walk(dir, (file) => { if (!this.before.has(file)) this.before.set(file, null); }); } catch (error) { if (error.code !== "ENOENT") this.skipped.push(`${dir}: ${error.message}`); }
    }
    for (const [file, before] of this.before) {
      try {
        const after = snapshot(file, this.maxBytes);
        if (before && after && before.realPath !== after.realPath) throw new Error("source path changed through a symlink or moved ancestor");
        if (before?.hash === after?.hash && before?.mode === after?.mode) continue;
        afterBytes += after?.data.length || 0;
        if (afterBytes > this.maxTotal) throw new Error("checkpoint final size limit reached");
        changes.push({ path: file, realPath: before?.realPath || after?.realPath || canonical(file), kind: !before ? "added" : !after ? "deleted" : "edited", before: store(before), after: store(after) });
      } catch (error) { this.skipped.push(`${file}: ${error.message}`); }
    }
    if (!changes.length && !this.skipped.length) return null;
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
    const manifest = { version: 1, id, sessionId: this.sessionId, cwd: this.cwd, ts: new Date().toISOString(), reason, changes, skipped: this.skipped };
    const dir = manifestDir(this.sessionId); mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return manifest;
  }
}

export function listCheckpoints(sessionId) {
  const dir = manifestDir(sessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().reverse().flatMap((name) => {
    try { return [JSON.parse(readFileSync(join(dir, name), "utf8"))]; } catch { return []; }
  });
}

export function undoCheckpoint(sessionId, id) {
  const manifest = listCheckpoints(sessionId).find((c) => id ? c.id === id : c.changes.length > 0);
  if (!manifest) throw new Error("No matching checkpoint.");
  const restore = [];
  // Validate everything first: do not overwrite subsequent user edits or corrupt blobs.
  for (const change of manifest.changes) {
    if (change.realPath && canonical(change.path) !== change.realPath) throw new Error(`Changed path since checkpoint: ${change.path}. Restore stopped.`);
    const current = snapshot(change.path, 100 * 1024 * 1024);
    if (current?.hash !== change.after?.hash || current?.mode !== change.after?.mode) throw new Error(`Changed since checkpoint: ${change.path}. Restore stopped.`);
    let data = null;
    if (change.before) {
      data = readFileSync(join(OBJECTS, change.before.hash));
      if (hash(data) !== change.before.hash) throw new Error(`Damaged checkpoint for ${change.path}`);
    }
    restore.push({ ...change, data });
  }
  const undo = new Checkpoint(sessionId, manifest.cwd);
  undo.track(restore.map((r) => r.path));
  for (const change of restore) {
    if (!change.before) { rmSync(change.path); continue; }
    mkdirSync(dirname(change.path), { recursive: true });
    const tmp = `${change.path}.novapup-${randomUUID()}`;
    writeFileSync(tmp, change.data, { mode: change.before.mode });
    chmodSync(tmp, change.before.mode);
    renameSync(tmp, change.path);
  }
  return { restored: restore.length, checkpoint: undo.finish(`undo:${manifest.id}`) };
}
