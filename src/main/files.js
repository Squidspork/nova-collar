import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { APP_HOME } from "./config.js";
import { checkWrite, runWatched } from "./guard.js";
import { denySecretPath, redactSecrets } from "./safe.js";
import { holdMessage, keepSpares, mutationHold } from "./spare.js";
import { expandPath, getWorkdir } from "./workdir.js";

function expand(path) {
  return expandPath(path, getWorkdir());
}

function gated(path) {
  const full = expand(path);
  const blocked = denySecretPath(full);
  if (blocked) return { ok: false, error: blocked, path: full };
  return { ok: true, path: full };
}

export async function runBash(command, cwd, opts) {
  return runWatched(command, expand(cwd || getWorkdir()), opts);
}

export function readUserFile(path) {
  const gate = gated(path);
  if (!gate.ok) return gate;
  try {
    const stat = statSync(gate.path);
    if (stat.isDirectory()) {
      return { ok: true, path: gate.path, directory: true, entries: readdirSync(gate.path).slice(0, 200) };
    }
    const text = redactSecrets(readFileSync(gate.path, "utf8").slice(0, 80_000));
    return { ok: true, path: gate.path, bytes: stat.size, text };
  } catch (error) {
    return { ok: false, error: error.message || "read failed", path: gate.path };
  }
}

export function writeUserFile(path, content, gateOpts = {}) {
  const size = checkWrite(content);
  if (!size.ok) return size;
  const gate = gated(path);
  if (!gate.ok) return gate;
  let exists = false;
  try {
    exists = existsSync(gate.path) && statSync(gate.path).isFile();
  } catch {
    exists = false;
  }
  const held = mutationHold({
    tasker: gateOpts.tasker || "",
    allow: Boolean(gateOpts.allow),
    exists,
    write: true,
  });
  if (held) return { ok: false, held: true, error: holdMessage(held, gate.path), path: gate.path };
  try {
    const spares = exists ? keepSpares(gate.path) : [];
    mkdirSync(dirname(gate.path), { recursive: true });
    writeFileSync(gate.path, content ?? "");
    return { ok: true, path: gate.path, bytes: size.bytes, spares };
  } catch (error) {
    return { ok: false, error: error.message || "write failed", path: gate.path };
  }
}

export function listDir(path) {
  const gate = gated(path || getWorkdir());
  if (!gate.ok) return gate;
  try {
    return {
      ok: true,
      path: gate.path,
      entries: readdirSync(gate.path, { withFileTypes: true }).slice(0, 300).map((entry) => ({
        name: entry.name,
        dir: entry.isDirectory(),
      })),
    };
  } catch (error) {
    return { ok: false, error: error.message || "list failed", path: gate.path };
  }
}

export function writeMemory(name, content) {
  const file = name === "personality" ? "personality.md" : "rules.md";
  return writeUserFile(`${APP_HOME}/${file}`, content);
}
