/** Three older copies of a file, kept before a replace. */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME, ensureHome } from "./config.js";

const KEEP = 3;

export function spareDir(path) {
  const id = createHash("sha256").update(String(path || "")).digest("hex").slice(0, 16);
  return join(APP_HOME, "spares", id);
}

export function keepSpares(path) {
  if (!path || !existsSync(path)) return [];
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  const dir = spareDir(path);
  ensureHome();
  mkdirSync(dir, { recursive: true });
  for (let slot = KEEP - 1; slot >= 1; slot -= 1) {
    const from = join(dir, String(slot - 1));
    if (existsSync(from)) copyFileSync(from, join(dir, String(slot)));
  }
  copyFileSync(path, join(dir, "0"));
  writeFileSync(join(dir, "path.txt"), `${path}\n`);
  return [0, 1, 2].map((slot) => join(dir, String(slot))).filter((file) => existsSync(file));
}

export function destructiveCommand(command) {
  const text = String(command || "");
  return /\b(rm|rmdir|unlink|shred)\b/.test(text)
    || /\bgit\s+clean\b/.test(text)
    || /\bgit\s+reset\b[\s\S]{0,40}--hard/.test(text);
}

/** User-assigned work waits before it changes a file. NP-assigned work waits at an overwrite or a delete. */
export function mutationHold({ tasker = "", allow = false, exists = false, command = "", write = false } = {}) {
  if (allow || (tasker !== "user" && tasker !== "novapup")) return "";
  if (destructiveCommand(command)) return "delete";
  if (write && tasker === "user") return "write";
  if (write && exists && tasker === "novapup") return "overwrite";
  return "";
}

export function holdMessage(kind, path) {
  const action = kind === "delete" ? "delete" : kind === "overwrite" ? "overwrite" : "write";
  const where = path ? ` ${path}` : "";
  return `Held. This would ${action}${where}. Three older copies are kept when a replace goes through. Say yes in this Pack chat to allow it once.`;
}
