/** Work the pack is asked to do. A task has one member, one goal, and one Pack chat. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME, ensureHome } from "./config.js";
import { listBots, readBot, saveBot } from "./bots.js";
import { watchJailbreak } from "./laya-steer.js";
import { cleanText, isBotId, isTaskId, newTaskId, redactSecrets, safeJoin } from "./safe.js";
import { fileChat } from "./sessions.js";

const DIR = () => join(APP_HOME, "tasks");

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function taskFile(id) {
  return safeJoin(DIR(), id);
}

function cleanEvery(value) {
  const n = Number(value);
  return n === 1 || n === 3 ? n : 0;
}

function cleanStatus(value) {
  return value === "doing" || value === "done" || value === "hold" ? value : "open";
}

function cleanBy(value) {
  return value === "novapup" || value === "user" ? value : "";
}

function cleanTask(raw) {
  if (!isTaskId(raw?.id)) return null;
  const title = cleanText(raw.title, 240, { singleLine: true });
  if (!title || redactSecrets(title) !== title) return null;
  return {
    id: raw.id,
    title,
    detail: cleanText(raw.detail, 800, { singleLine: true }),
    goal: cleanText(raw.goal, 240, { singleLine: true }),
    status: cleanStatus(raw.status),
    every: cleanEvery(raw.every),
    botId: isBotId(raw.botId) ? raw.botId : "",
    chatId: cleanText(raw.chatId, 40, { singleLine: true }),
    note: cleanText(raw.note, 180, { singleLine: true }),
    result: cleanText(raw.result, 180, { singleLine: true }),
    ranAt: Number(raw.ranAt) || 0,
    by: cleanBy(raw.by),
    allow: Boolean(raw.allow),
    created: Number(raw.created) || Date.now(),
    updated: Number(raw.updated) || Date.now(),
  };
}

function freshTaskId() {
  let id = newTaskId();
  for (let i = 0; i < 4 && existsSync(taskFile(id) || ""); i += 1) id = newTaskId();
  return id;
}

export function listTasks() {
  ensureHome();
  if (!existsSync(DIR())) return [];
  return readdirSync(DIR())
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .filter((id) => isTaskId(id) && taskFile(id))
    .map((id) => cleanTask(readJson(taskFile(id), null)))
    .filter(Boolean)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export function readTask(id) {
  const file = taskFile(id);
  if (!file || !existsSync(file)) return null;
  return cleanTask(readJson(file, null));
}

export function saveTask(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  ensureHome();
  mkdirSync(DIR(), { recursive: true });
  const prior = isTaskId(input.id) ? readTask(input.id) : null;
  const task = cleanTask({
    id: prior?.id || freshTaskId(),
    title: input.title !== undefined ? input.title : prior?.title,
    detail: input.detail !== undefined ? input.detail : prior?.detail,
    goal: input.goal !== undefined ? input.goal : prior?.goal,
    status: input.status !== undefined ? input.status : prior?.status,
    every: input.every !== undefined ? input.every : prior?.every,
    botId: input.botId !== undefined ? input.botId : prior?.botId,
    chatId: input.chatId !== undefined ? input.chatId : prior?.chatId,
    note: input.note !== undefined ? input.note : prior?.note,
    result: input.result !== undefined ? input.result : prior?.result,
    ranAt: input.ranAt !== undefined ? input.ranAt : prior?.ranAt,
    by: input.by !== undefined ? input.by : prior?.by,
    allow: input.allow !== undefined ? input.allow : prior?.allow,
    created: prior?.created || Date.now(),
    updated: Date.now(),
  });
  if (!task) return null;
  if (task.every && input.ranAt === undefined && task.every !== (prior?.every || 0)) task.ranAt = Date.now();
  const file = taskFile(task.id);
  if (!file) return null;
  writeJson(file, task);
  return task;
}

function memberFor(input) {
  if (isBotId(input.botId)) {
    const found = readBot(input.botId);
    if (found) return found;
  }
  const named = cleanText(input.bot, 32, { singleLine: true }).toLowerCase();
  if (named) {
    const found = listBots().find((row) => row.id === input.bot || row.name.toLowerCase() === named);
    if (found) return readBot(found.id);
  }
  const member = input.member && typeof input.member === "object" ? input.member : null;
  if (member?.name || member?.role) return saveBot(member);
  if (!input.make) return null;
  const title = cleanText(input.title, 240, { singleLine: true });
  return saveBot({
    name: cleanText(title.split(/\s+/).slice(0, 2).join(" "), 32, { singleLine: true }) || "Pack",
    title: "pack",
    role: cleanText(input.detail || title, 400, { singleLine: true }),
    voice: "First line is the result.",
    pack: input.pack || "host",
  });
}

export function assignTask(input = {}) {
  const title = cleanText(input.title, 240, { singleLine: true });
  if (!title || redactSecrets(title) !== title) return null;
  if (watchJailbreak(title) || watchJailbreak(input.goal) || watchJailbreak(input.detail)) return null;
  const bot = memberFor(input);
  if (!bot?.id) return null;
  const goal = cleanText(input.goal, 240, { singleLine: true }) || title;
  const task = saveTask({
    title,
    detail: input.detail || "",
    goal,
    every: input.every,
    botId: bot.id,
    status: "open",
    by: input.by === "novapup" ? "novapup" : "user",
  });
  if (!task) return null;
  const chat = fileChat({
    title: `Pack · ${task.title}`,
    messages: [
      { role: "user", content: task.detail ? `${task.title}\n${task.detail}` : task.title },
      { role: "assistant", content: `${bot.name} has this. Goal: ${goal}` },
    ],
  });
  const saved = saveTask({ id: task.id, chatId: chat.id });
  return { task: saved, bot, chat };
}

export function releaseHeld(text, chatId) {
  if (!/^(yes|do it|go ahead)\b/i.test(String(text || "").trim())) return null;
  const task = listTasks().find((row) => row.chatId === chatId && row.status === "hold");
  if (!task) return null;
  const every = Number(task.every) || 0;
  const ranAt = every ? Date.now() - every * 60_000 - 1 : 0;
  return saveTask({ id: task.id, status: "open", allow: true, ranAt });
}

export function publicTasks() {
  return listTasks().map((task) => ({ ...task, bot: readBot(task.botId)?.name || "" }));
}

export function packBrief() {
  return listTasks()
    .filter((task) => task.status === "done" && task.result)
    .slice(0, 3)
    .map((task) => `${task.title}: ${task.result}`)
    .join("\n");
}
