/** Fast model and thinking model, with Laya's job label as the path between them. */

import { allowServiceUrl } from "./safe.js";

function endpoint(rawUrl, model, cfg, laneKey) {
  const url = allowServiceUrl(rawUrl, "local") || allowServiceUrl(rawUrl, "chat");
  const name = String(model || "").trim();
  if (!url || !name) return null;
  const local = url.startsWith("http://");
  return {
    url,
    model: name,
    key: local ? "ollama" : (String(laneKey || "").trim() || cfg.chatKey || cfg.toolsKey || ""),
    local,
  };
}

export function shortModel(id) {
  const parts = String(id || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

/**
 * The fast model works the harness on this computer.
 * The thinking model is the chat model already configured, unless HNL_THINK_* names another.
 * The split stays off until a fast model is set and it is not the same model as the thinker.
 */
export function lanesFrom(cfg, chat) {
  const fast = endpoint(cfg.fastUrl, cfg.fastModel, cfg, cfg.fastKey);
  let think = endpoint(cfg.thinkUrl, cfg.thinkModel, cfg, cfg.thinkKey);
  if (!think && fast && chat?.url && chat?.model && chat.model !== fast.model) {
    think = {
      url: chat.url,
      model: chat.model,
      key: chat.key || "",
      local: Boolean(chat.local),
    };
  }
  if (fast) fast.role = "fast";
  if (think) think.role = "think";
  const on = Boolean(fast && think && fast.model !== think.model);
  return { on, fast: on ? fast : null, think: on ? think : null };
}

export function splitLabel(lanes) {
  if (!lanes?.on) return { on: false, fast: "", think: "" };
  return {
    on: true,
    fast: shortModel(lanes.fast.model),
    think: shortModel(lanes.think.model),
  };
}

/**
 * Laya already scored the job. This picks the model for the next round.
 * answer: the thinking model writes the reply. The fast model is trained to act, not to talk.
 * plan: the thinking model takes the first step of a code, lookup, or goal job.
 * hash: the last step failed, looped, left the harness open, or passed it clean.
 *   The thinking model reads what was seen and writes the result or takes the next step.
 * fast: the fast model works the harness on this computer.
 */
export const HASH_ROUNDS = 2;
export const PLAN_ROUNDS = 2;

export function pathBetween({ answer = false, deep = false, planned = false, stuck = false, passed = false, hashes = 0 } = {}) {
  if (answer) return "answer";
  if (deep && !planned) return "plan";
  if ((stuck || passed) && hashes < HASH_ROUNDS) return "hash";
  return "fast";
}

const READS = new Set(["host_file_read", "read_file", "computer_read"]);

/** A plan round that only read files keeps planning, so the thinking model acts on what it read. */
export function planDone(names, rounds) {
  if (rounds >= PLAN_ROUNDS || !names?.length) return true;
  return names.some((name) => !READS.has(name));
}
