/** Shared goals for the pack. Laya decides whether one task should see another goal. */

import { goalFromLaya, goalTrace } from "./goal.js";
import { layaGoalTrained, layaReady, readLaya } from "./laya.js";

const STOP = new Set(["this", "that", "with", "from", "your", "have", "will", "they", "them", "pack", "goal", "task", "into", "then", "when", "what", "only"]);

function words(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3 && !STOP.has(word)),
  );
}

export function overlap(left, right) {
  const a = words(left);
  let n = 0;
  for (const word of words(right)) if (a.has(word)) n += 1;
  return n;
}

export function taskDue(task, now) {
  if (!task?.botId || !task.title) return false;
  if (task.status === "doing" || task.status === "done" || task.status === "hold") return false;
  const every = Number(task.every) || 0;
  const last = Number(task.ranAt) || 0;
  if (!every) return !last || now - last >= 60_000;
  if (!last) return false;
  return now - last >= every * 60_000;
}

export function isDue(bot, now) {
  if (!bot?.every || !bot.task) return false;
  if (bot.status === "doing" || bot.status === "done") return false;
  const last = Number(bot.ranAt) || 0;
  if (!last) return false;
  return now - last >= bot.every * 60_000;
}

export function cardOf(bot) {
  return {
    id: bot.id,
    name: bot.name,
    pack: bot.pack || "auto",
    goal: bot.goal || "",
    task: bot.task || "",
    every: bot.every || 0,
    status: bot.status || "open",
    note: bot.note || "",
  };
}

export function columns(cards) {
  const rows = cards || [];
  return {
    open: rows.filter((row) => row.goal && row.status !== "doing" && row.status !== "done"),
    doing: rows.filter((row) => row.status === "doing"),
    done: rows.filter((row) => row.status === "done"),
  };
}

export function shareContext({ task, self, other, verdict } = {}) {
  if (!other?.goal || !self || other.id === self.id || other.status === "done") return false;
  if (verdict?.action === "refuse" || verdict?.action === "stuck" || verdict?.action === "done") return false;
  if (verdict?.action === "keep") return true;
  const same = self.pack && self.pack === other.pack;
  return Boolean(same && overlap(`${task || ""} ${self.goal || ""}`, other.goal) >= 2);
}

export function bestOther(self, others) {
  const open = (others || []).filter((row) => row && row.id !== self?.id && row.goal && row.status !== "done");
  open.sort((a, b) => overlap(`${self?.task || ""} ${self?.goal || ""}`, b.goal) - overlap(`${self?.task || ""} ${self?.goal || ""}`, a.goal));
  return open[0] || null;
}

export function goalLine(text) {
  const match = String(text || "").match(/^goal:\s*(.+)$/im);
  if (!match) return "";
  return match[1].replace(/\s+/g, " ").trim().slice(0, 200);
}

export function finishedGoal(goal, assistant) {
  const body = String(assistant || "").trim();
  if (!body || !String(goal || "").trim()) return false;
  if (/^goal met\b/i.test(body)) return true;
  return false;
}

export async function helpNote(self, others) {
  const other = bestOther(self, others);
  if (!other) return "";
  let verdict = null;
  if (layaReady() && layaGoalTrained()) {
    try {
      const read = readLaya(goalTrace({
        goal: other.goal,
        ask: self.task || self.goal,
        trail: [],
        why: "deciding whether this task can help that goal",
      }), "goal");
      const timed = new Promise((resolve) => setTimeout(() => resolve(null), 2500));
      verdict = goalFromLaya(await Promise.race([read, timed]));
    } catch {
      verdict = null;
    }
  }
  if (!shareContext({ task: self.task, self, other, verdict })) return "";
  return `${other.name} is on: ${other.goal}`;
}
