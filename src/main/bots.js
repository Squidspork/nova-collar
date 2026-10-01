import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME, ensureHome } from "./config.js";
import { playbookFields, safePlaybook } from "./playbooks.js";
import { cleanText, isBotId, newBotId, safeJoin, safePack } from "./safe.js";
import { persistSession, readSession, removeSession } from "./sessions.js";

const DIR = () => join(APP_HOME, "bots");

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

function botFile(id) {
  return safeJoin(DIR(), id);
}

function cleanStarts(raw) {
  return String(raw || "")
    .split(/\n/)
    .map((line) => cleanText(line, 80, { singleLine: true }))
    .filter(Boolean)
    .slice(0, 3)
    .join("\n");
}

function cleanBot(raw) {
  if (!isBotId(raw?.id)) return null;
  const name = cleanText(raw.name || "Teammate", 32, { singleLine: true }) || "Teammate";
  return {
    id: raw.id,
    name,
    title: cleanText(raw.title, 80, { singleLine: true }),
    role: cleanText(raw.role, 4000),
    voice: cleanText(raw.voice, 240, { singleLine: true }),
    pack: safePack(raw.pack),
    ask: cleanText(raw.ask, 400, { singleLine: true }),
    starts: cleanStarts(raw.starts),
    playbook: safePlaybook(raw.playbook),
    every: cleanEvery(raw.every),
    task: cleanText(raw.task, 240, { singleLine: true }),
    goal: cleanText(raw.goal, 240, { singleLine: true }),
    status: cleanStatus(raw.status),
    ranAt: Number(raw.ranAt) || 0,
    note: cleanText(raw.note, 180, { singleLine: true }),
    sessionId: raw.id,
    created: Number(raw.created) || Date.now(),
    updated: Number(raw.updated) || Date.now(),
  };
}

function cleanEvery(value) {
  const n = Number(value);
  return n === 1 || n === 3 ? n : 0;
}

function cleanStatus(value) {
  return value === "doing" || value === "done" ? value : "open";
}

export function publicBot(bot) {
  if (!bot) return null;
  const session = readSession(bot.sessionId);
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    role: bot.role,
    voice: bot.voice,
    pack: bot.pack,
    ask: bot.ask,
    starts: bot.starts,
    playbook: bot.playbook,
    every: bot.every || 0,
    task: bot.task || "",
    goal: bot.goal || "",
    status: bot.status || "open",
    ranAt: bot.ranAt || 0,
    note: bot.note || "",
    sessionId: bot.sessionId,
    created: bot.created,
    updated: session?.updated || bot.updated,
    count: session?.messages?.length || 0,
  };
}

export function listBots() {
  ensureHome();
  mkdirSync(DIR(), { recursive: true });
  return readdirSync(DIR())
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5))
    .filter((id) => isBotId(id) && botFile(id))
    .map((id) => cleanBot(readJson(botFile(id), null)))
    .filter(Boolean)
    .map(publicBot)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export function readBot(id) {
  const file = botFile(id);
  if (!file || !existsSync(file)) return null;
  return cleanBot(readJson(file, null));
}

function freshBotId() {
  let id = newBotId();
  for (let i = 0; i < 4 && existsSync(botFile(id) || ""); i += 1) id = newBotId();
  return id;
}

export function saveBot(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  ensureHome();
  mkdirSync(DIR(), { recursive: true });
  const prior = isBotId(input.id) ? readBot(input.id) : null;
  const hired = !prior ? playbookFields(input.playbook) : null;
  const bot = cleanBot({
    id: prior?.id || freshBotId(),
    name: input.name || hired?.name || prior?.name,
    title: input.title || hired?.title || prior?.title,
    role: input.role || hired?.role || prior?.role,
    voice: input.voice || hired?.voice || prior?.voice,
    pack: input.pack || hired?.pack || prior?.pack,
    ask: input.ask || hired?.ask || prior?.ask,
    starts: input.starts || hired?.starts || prior?.starts,
    playbook: input.playbook || hired?.playbook || prior?.playbook,
    every: input.every !== undefined ? input.every : prior?.every,
    task: input.task !== undefined ? input.task : prior?.task,
    goal: input.goal !== undefined ? input.goal : prior?.goal,
    status: input.status !== undefined ? input.status : prior?.status,
    ranAt: input.ranAt !== undefined ? input.ranAt : prior?.ranAt,
    note: input.note !== undefined ? input.note : prior?.note,
    created: prior?.created || Date.now(),
    updated: Date.now(),
  });
  if (!bot) return null;
  if (bot.every && input.ranAt === undefined && bot.every !== (prior?.every || 0)) bot.ranAt = Date.now();
  if (prior && input.status === undefined && (bot.goal !== (prior.goal || "") || bot.task !== (prior.task || ""))) bot.status = "open";
  const file = botFile(bot.id);
  if (!file) return null;
  if (!readSession(bot.sessionId)) persistSession(bot.sessionId, [], { title: bot.name });
  writeJson(file, bot);
  return publicBot(bot);
}

export function openBot(id) {
  const bot = readBot(id);
  if (!bot) return null;
  if (!readSession(bot.sessionId)) persistSession(bot.sessionId, [], { title: bot.name });
  return { bot: publicBot(bot), session: readSession(bot.sessionId) };
}

export function removeBot(id) {
  const bot = readBot(id);
  if (!bot) return { ok: false };
  const file = botFile(bot.id);
  if (file) {
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
  removeSession(bot.sessionId);
  return { ok: true, id: bot.id };
}
