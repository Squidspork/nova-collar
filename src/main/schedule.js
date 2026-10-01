/** Wake one pack task at a time. Once, every minute, or every three minutes. */

import { readBot } from "./bots.js";
import { finishedGoal, goalLine, helpNote, taskDue } from "./board.js";
import { listTasks, saveTask } from "./tasks.js";

let ticking = false;
let timer = null;

function othersFor(task, bot) {
  return listTasks()
    .filter((row) => row.id !== task.id && row.goal && row.status !== "done")
    .map((row) => {
      const mate = readBot(row.botId);
      return {
        id: row.id,
        name: mate?.name || "Pack",
        pack: mate?.pack || bot?.pack || "",
        goal: row.goal,
        status: row.status,
      };
    });
}

export async function tick(run, now = Date.now()) {
  if (ticking) return [];
  ticking = true;
  const done = [];
  try {
    const due = listTasks().filter((task) => taskDue(task, now));
    for (const task of due) {
      const bot = readBot(task.botId);
      const goal = task.goal || task.title;
      if (!bot) {
        saveTask({ id: task.id, status: "open", ranAt: now, note: "Pick a member." });
        continue;
      }
      saveTask({ id: task.id, status: "doing", goal, ranAt: now });
      let note = "";
      try {
        note = await helpNote({
          id: task.id,
          name: bot.name,
          pack: bot.pack,
          goal,
          task: task.title,
          status: "doing",
        }, othersFor(task, bot));
      } catch {
        note = "";
      }
      if (note) saveTask({ id: task.id, note });
      let result = { assistant: "" };
      try {
        result = (await run({ task: { ...task, goal, note }, bot, note, goal })) || result;
      } catch {
        saveTask({ id: task.id, status: "open", note: note || "Run failed." });
        continue;
      }
      if (result.skip) {
        saveTask({ id: task.id, status: "open", ranAt: task.ranAt, note: task.note || "" });
        continue;
      }
      if (result.held) {
        const line = String(result.assistant || "").split("\n").map((row) => row.trim()).find(Boolean) || "Waiting for yes.";
        saveTask({ id: task.id, status: "hold", ranAt: now, note: "Waiting for yes.", result: line.slice(0, 180) });
        done.push({ id: task.id, title: task.title, status: "hold", note, assistant: result.assistant || "", chatId: result.chatId || task.chatId || "" });
        continue;
      }
      const nextGoal = goalLine(result.assistant) || goal;
      const status = finishedGoal(nextGoal, result.assistant) ? "done" : "open";
      const line = String(result.assistant || "").split("\n").map((row) => row.trim()).find(Boolean) || "";
      saveTask({
        id: task.id,
        status,
        goal: nextGoal,
        ranAt: now,
        note: note || "",
        result: line.slice(0, 180),
        chatId: result.chatId || task.chatId || "",
      });
      done.push({ id: task.id, title: task.title, status, note, assistant: result.assistant || "", chatId: result.chatId || task.chatId || "" });
    }
  } finally {
    ticking = false;
  }
  return done;
}

export function startBoard(run, after) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    tick(run).then((rows) => after?.(rows)).catch(() => {});
  }, 15_000);
  return stopBoard;
}

export function stopBoard() {
  if (timer) clearInterval(timer);
  timer = null;
}
