import { createHash } from "node:crypto";

/** Stop a tool call that is the same work again.

Laya judges the second try, once the checkpoint was trained on the loop
question. A third try stops even if Laya says to continue. Until that
training is in the checkpoint, a repeat stops when nothing else has run
since the last identical call.
*/

function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canon(value[key])]));
  }
  return value;
}

export function briefArgs(args) {
  const raw = String(args || "").trim();
  if (!raw) return "{}";
  try {
    return JSON.stringify(canon(JSON.parse(raw))).slice(0, 180);
  } catch {
    return raw.replace(/\s+/g, " ").slice(0, 180);
  }
}

export function toolSig(name, args) {
  let full;
  try { full = JSON.stringify(canon(typeof args === "object" ? args : JSON.parse(String(args || "{}")))); }
  catch { full = String(args || "{}").trim(); }
  return `${name}:${full.length <= 180 ? full : createHash("sha256").update(full).digest("hex")}`;
}

export function loopTrace({ ask, trail, next } = {}) {
  const asked = String(ask || "").replace(/\s+/g, " ").trim().slice(0, 400);
  const lines = (trail || []).slice(-8).map((row, i) => {
    const flag = row.ok === false ? "fail" : "ok";
    return `${i + 1}. ${row.name} ${row.args || "{}"} -> ${flag}`;
  });
  const again = `${next?.name || ""} ${next?.args || "{}"}`.trim();
  return `User asked: ${asked}\n\nTools already run this turn:\n${lines.join("\n") || "(none)"}\n\nAbout to run again: ${again}`;
}

export function changedSince(trail, sig) {
  let last = -1;
  for (let i = 0; i < (trail || []).length; i += 1) {
    if (trail[i].sig === sig) last = i;
  }
  if (last < 0) return false;
  return trail.slice(last + 1).some((row) => row.sig !== sig);
}

export function loopFromLaya(read) {
  if (!read || (read.choice !== "stop" && read.choice !== "go")) return null;
  const confidence = Number(read.confidence) || 0;
  if (confidence < 0.6) return null;
  const detail = `${read.choice} ${Math.round(confidence * 100)}%`;
  return { action: read.choice, blurb: read.choice === "stop" ? "loop" : "go", detail };
}

export const LOOP_CONTINUES = 3;

/** What to do when the model says it stopped. A later success clears the repeat failure. */
export function afterStop({ progressed = false, tries = 0, nudged = false, max = LOOP_CONTINUES } = {}) {
  if (progressed) return nudged ? "done" : "clear";
  if (tries < max) return "again";
  return "done";
}

export function gaveUpEarly(text) {
  const line = String(text || "");
  return /\bstopped\b/i.test(line) && /different step|same (call|result|command)/i.test(line);
}

export function loopContinueNote(n, max = LOOP_CONTINUES) {
  return `That call already ran. Do not run it again. Take a different step. Continue ${n} of ${max}.`;
}

export function shouldStopLoop({ count = 0, failedBefore = false, verdict = null, changed = false, trustLaya = false } = {}) {
  if (count >= 3) return "same call 3 times";
  if (count >= 2 && trustLaya && verdict?.action === "stop") return verdict.detail || "loop";
  if (count >= 2 && trustLaya && verdict?.action === "go") return "";
  if (count >= 2 && failedBefore && !changed) return "same call already failed";
  if (count >= 2 && !changed) return "same call already ran";
  return "";
}
