/** Turn a Nova Collar Laya label into a gate. Pack locks from the window win over the model. */

const PACKS = new Set(["host", "term", "net", "docker", "desk", "computer"]);
const RULE_BREAK = /\b(ignore|disregard|forget|bypass|override)\b.{0,48}\b(rules?|instructions?|policy|safety|previous)\b/i;
const UNLOCK = /\b(jailbreak|dan mode|unrestricted)\b/i;
const HIDDEN_PROMPT = /\b(?:hidden|system)\s+prompt\b/i;
const TAKE_SECRET = /\b(print|paste|reveal|show|dump|quote|cat|exfiltrate|output)\b.{0,60}\b(system prompt|hidden prompt|credentials|secrets?|api keys?|passwords?|tokens?|password file|secrets file|gateway env)\b/i;

/** Structural gate. A Laya "keep" or "answer" does not outrank this. */
export function watchJailbreak(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  return RULE_BREAK.test(s) || UNLOCK.test(s) || HIDDEN_PROMPT.test(s) || TAKE_SECRET.test(s);
}

/** A prose rewrite ("rewrite this shorter") is an answer. A rewrite of a bridge, module, or file is a code job. */
function codeEditAsk(text) {
  const s = String(text || "");
  return /\b(fix|patch|bug|rewrite|refactor)\b/i.test(s)
    && /\b(bridge|module|function|handler|\.[a-z0-9]{1,4}\b|src\/)/i.test(s);
}

export function steerFromLaya(read, { locked = false, text = "" } = {}) {
  if (watchJailbreak(text)) return { action: "refuse", blurb: "refused", detail: "watchdog" };
  if (!read || typeof read.choice !== "string") return null;
  const choice = read.choice;
  const confidence = Number(read.confidence) || 0;
  const detail = `${choice} ${Math.round(confidence * 100)}%`;
  if (choice === "refuse" && confidence >= 0.6) {
    return { action: "refuse", blurb: "refused", detail };
  }
  if (confidence < 0.45 || locked) return null;
  if (choice === "answer" && codeEditAsk(text)) {
    return { action: "code", code: true, blurb: "code", detail: `${detail} (code edit)` };
  }
  if (choice === "answer") {
    return { action: "answer", toolChoice: "none", tools: [], blurb: "answer, no tools", detail };
  }
  if (choice === "lookup") {
    return { action: "lookup", pack: "hnl", fact: true, blurb: "look it up", detail };
  }
  if (choice === "code") {
    return { action: "code", code: true, blurb: "code", detail };
  }
  if (PACKS.has(choice)) {
    return { action: "pack", pack: choice, blurb: choice, detail };
  }
  return null;
}
