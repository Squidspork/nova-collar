import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { APP_HOME } from "./config.js";
import { redactSecrets } from "./safe.js";
import { expandPath, getWorkdir } from "./workdir.js";

let notify = null;
const pending = new Map();
export function setApprovalNotifier(fn) { notify = fn; }
export function pendingApprovals() { return [...pending.values()].map((item) => item.request); }
export function resolveApproval(id, allowed) {
  const item = pending.get(String(id));
  if (!item) return false;
  item.finish(allowed === true);
  return true;
}
export function cancelApprovals() { for (const item of [...pending.values()]) item.finish(false); }

function ask(request, signal) {
  if (!notify || signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const id = randomUUID();
    let timer;
    const abort = () => finish(false);
    const finish = (allowed) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      notify?.({ type: "approval-closed", id });
      resolve(allowed);
    };
    const pub = { ...request, id };
    pending.set(id, { request: pub, finish });
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => finish(false), 10 * 60_000);
    notify({ type: "approval", request: pub });
  });
}

function canonical(path) {
  let parent = resolve(path);
  const parts = [];
  while (!existsSync(parent) && dirname(parent) !== parent) { parts.unshift(parent.slice(dirname(parent).length + 1)); parent = dirname(parent); }
  try { return join(realpathSync(parent), ...parts); } catch { return resolve(path); }
}
function outside(path, root) {
  const rel = relative(canonical(root), canonical(path));
  return rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel);
}
function hash(text) { return createHash("sha256").update(text).digest("hex"); }

export function commandNeedsApproval(command) {
  const text = String(command || "").trim();
  // Shell syntax, expansion, redirection and interpreters are not proven read-only.
  if (!text || /[\r\n;&|><`$(){}]/.test(text)) return true;
  if (/^(?:pwd|Get-Location|hostname|whoami)(?:\s|$)/i.test(text)) return false;
  if (/^git\s+(?:status|diff|log|show|ls-files)(?:\s|$)/i.test(text) && !/(?:--output|--ext-diff|--textconv|--exec|\s-o\b)/i.test(text)) return false;
  if (/^node\s+--check\s+(?:'[^']+'|"[^"]+"|[^\s'"-][^\s'"]*)$/i.test(text)) return false;
  if (/^(?:Get-Content|Get-ChildItem|Get-Item|Get-Process|Get-Service|Get-CimInstance)\b/i.test(text) && !/-ComputerName|-CimSession/i.test(text)) return false;
  if (/^(?:ls|cat|head|tail|wc|stat)\b/.test(text)) return false;
  return true;
}

export function assessAction(name, args = {}, ctx = {}) {
  const command = name === "term_send" ? args.text : args.command;
  if (["host_run", "bash", "term_send", "computer_exec", "docker_exec"].includes(name) || (name === "computer" && args.action === "exec")) {
    if (name === "term_send" || name === "docker_exec" || commandNeedsApproval(command)) return {
      title: name === "term_send" ? "Let the agent type into the terminal?" : "Allow this command?",
      reason: "This command can change files or system state. Approval applies to this exact action once.",
      detail: redactSecrets(`${name === "computer_exec" || name === "computer" ? "Remote workspace" : args.cwd || getWorkdir()}\n\n${String(command || "")}`),
      fingerprint: hash(JSON.stringify([name, args, getWorkdir()])),
    };
  }
  if (["host_file_write", "write_file", "computer_write", "set_rules", "set_personality"].includes(name)) {
    const remote = name === "computer_write";
    const path = name === "set_rules" || name === "set_personality"
      ? join(APP_HOME, name === "set_rules" ? "rules.md" : "personality.md") : expandPath(String(args.path || ""));
    const content = String(args.content ?? "");
    let old = "";
    let exists = false;
    try { exists = !remote && statSync(path).isFile(); if (exists) old = readFileSync(path, "utf8"); } catch {}
    const before = old.split("\n");
    const after = content.split("\n");
    const counts = new Map();
    for (const line of after) counts.set(line, (counts.get(line) || 0) + 1);
    let removed = 0;
    for (const line of before) { const left = counts.get(line) || 0; if (left) counts.set(line, left - 1); else removed++; }
    const added = [...counts.values()].reduce((a, b) => a + b, 0);
    const broad = exists && old !== content && (removed >= 10 && removed / before.length >= .25 || content.length > old.length * 2.2 && content.length - old.length > 1200 || removed + added >= 100 || !content.trim() || old.includes("\0") || content.length > 64_000 || removed === 0 && added === 0 && before.length >= 20);
    const reasons = [remote && "Write on the remote computer", name.startsWith("set_") && "Change the agent's standing instructions", !remote && outside(path, getWorkdir()) && "Write outside the current working folder", broad && "Large replacement or removal of existing content", content.length > 64_000 && "Write more than 64 KB", ctx.tasker === "user" && "Background task wants to write a file", ctx.tasker === "novapup" && exists && "Background task wants to overwrite a file"].filter(Boolean);
    if (reasons.length) return {
      title: exists ? "Allow this file replacement?" : "Allow this file write?",
      reason: reasons.join(". ") + ".",
      detail: redactSecrets(`${path}\n${Buffer.byteLength(old)} → ${Buffer.byteLength(content)} bytes; ${removed} lines removed, ${added} added.\n\nProposed content:\n${content.slice(0, 12_000)}${content.length > 12_000 ? "\n[Preview truncated]" : ""}`),
      fingerprint: hash(JSON.stringify([name, path, canonical(path), exists, old, content, getWorkdir()])),
    };
  }
  if (name === "docker_restart" || (["computer", "desk"].includes(name) && ["write", "pi", "type", "key", "click", "double_click", "drag", "open"].includes(args.action)) || /^(?:computer|mac|desk)_(?:write|pi|type|key|click|double_click|right_click|drag|open)$/.test(name)) return {
    title: "Allow this system action?", reason: "This can change a running application, container, or remote system.", detail: redactSecrets(JSON.stringify({ name, ...args }, null, 2)), fingerprint: hash(JSON.stringify([name, args])),
  };
  if (name === "set_workdir" && outside(expandPath(args.path || ""), getWorkdir())) return {
    title: "Change the working folder?", reason: "The agent wants to work outside the current folder.", detail: expandPath(args.path || ""), fingerprint: hash(JSON.stringify([args, getWorkdir()])),
  };
  return null;
}

export async function authorizeAction(name, args, ctx = {}) {
  const review = assessAction(name, args, ctx);
  if (!review) return { ok: true, approved: false };
  const { fingerprint, ...pub } = review;
  const allowed = await ask({ ...pub, tool: name, source: ctx.bot?.name || (ctx.taskId ? "Background task" : "Current chat") }, ctx.signal);
  if (!allowed) return { ok: false, held: true, error: "Not approved. Nothing was changed by this action. Ask the user before proposing it again." };
  if (ctx.signal?.aborted) return { ok: false, held: true, error: "Stopped before the approved action ran." };
  if (assessAction(name, args, ctx)?.fingerprint !== fingerprint) return { ok: false, held: true, error: "The file or working folder changed while waiting. Read it again before requesting approval." };
  return { ok: true, approved: true };
}
