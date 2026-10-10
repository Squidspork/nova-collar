import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_HOME, ensureHome } from "./config.js";
import { cleanText, isBotId, isChatId, newChatId, parseSessionId, safeJoin, safePack } from "./safe.js";
import { cleanModelHistory } from "./model-history.js";

const SESSIONS = () => join(APP_HOME, "sessions");
const INDEX = () => join(SESSIONS(), "index.json");
const LEGACY = () => join(APP_HOME, "history.json");

function titleFrom(messages) {
  const users = messages.filter((row) => row.role === "user" && String(row.content || "").trim());
  const pick =
    users.find((row) => String(row.content).replace(/\s+/g, " ").trim().length >= 24) || users[0];
  if (!pick) return "New chat";
  return String(pick.content).replace(/\s+/g, " ").trim().slice(0, 48);
}

function cleanRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(-80).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    if (row.role === "user" || row.role === "assistant") {
      return [{ role: row.role, content: String(row.content || "").slice(0, 24_000) }];
    }
    if (row.role === "step" && row.name) {
      return [{
        role: "step",
        name: cleanText(row.name, 64, { singleLine: true }),
        pack: safePack(row.pack),
        ok: row.ok !== false,
        blurb: cleanText(row.blurb, 240, { singleLine: true }),
        detail: String(row.detail || "").slice(0, 8000),
      }];
    }
    if (row.role === "shot" && /^shot-[a-z0-9]+-[a-z0-9]+$/i.test(row.shotId || "")) {
      return [{
        role: "shot",
        shotId: row.shotId,
        name: cleanText(row.name, 64, { singleLine: true }),
        blurb: cleanText(row.blurb || "image", 64, { singleLine: true }),
      }];
    }
    return [];
  });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

function sessionFile(id) {
  return safeJoin(SESSIONS(), id);
}

function metaOf(session) {
  return {
    id: session.id,
    title: session.title,
    created: session.created,
    updated: session.updated,
    count: session.messages.length,
  };
}

function readIndex() {
  const raw = readJson(INDEX(), { current: null, chats: [] });
  if (!raw || !Array.isArray(raw.chats)) return { current: null, chats: [] };
  return raw;
}

function writeIndex(index) {
  writeJson(INDEX(), index);
}

export function readSession(id) {
  const safe = parseSessionId(id);
  const file = sessionFile(safe);
  if (!safe || !file) return null;
  const raw = readJson(file, null);
  if (!raw) return null;
  return {
    id: safe,
    title: cleanText(raw.title || "New chat", 80, { singleLine: true }) || "New chat",
    created: Number(raw.created) || Date.now(),
    updated: Number(raw.updated) || Date.now(),
    messages: cleanRows(raw.messages),
    modelMessages: cleanModelHistory(raw.modelMessages),
    goal: cleanText(raw.goal, 400, { singleLine: true }),
    archive: cleanArchive(raw.archive),
  };
}

function cleanArchive(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-24).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const verdict = ["held", "retry", "unproven"].includes(row.verdict) ? row.verdict : "";
    const claim = cleanText(row.claim, 240, { singleLine: true });
    const internalGoal = cleanText(row.internalGoal, 320, { singleLine: true });
    if (!verdict || (!claim && !internalGoal)) return [];
    return [{
      at: Number(row.at) || Date.now(),
      userGoal: cleanText(row.userGoal, 400, { singleLine: true }),
      claim,
      opposite: cleanText(row.opposite, 280, { singleLine: true }),
      internalGoal,
      verdict,
      detail: cleanText(row.detail, 180, { singleLine: true }),
    }];
  });
}

function writeSession(session) {
  const file = sessionFile(session.id);
  if (!file) return;
  writeJson(file, session);
}

export function pushArchive(id, entry) {
  const safe = parseSessionId(id);
  const current = readSession(safe);
  if (!current || !entry) return [];
  current.archive = cleanArchive([...(current.archive || []), { ...entry, at: Date.now() }]);
  current.updated = Date.now();
  writeSession(current);
  return current.archive;
}

export function writeGoal(id, goal) {
  const safe = parseSessionId(id);
  const current = readSession(safe);
  if (!current) return "";
  current.goal = cleanText(goal, 400, { singleLine: true });
  current.updated = Date.now();
  writeSession(current);
  return current.goal;
}

export function removeSession(id) {
  const safe = parseSessionId(id);
  const file = sessionFile(safe);
  if (!safe || !file || !isBotId(safe)) return { ok: false };
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
  return { ok: true };
}

export function bootSessions() {
  ensureHome();
  mkdirSync(SESSIONS(), { recursive: true });
  const index = readIndex();
  if (isChatId(index.current) && sessionFile(index.current) && existsSync(sessionFile(index.current))) {
    return { index, session: readSession(index.current) };
  }

  const messages = existsSync(LEGACY()) ? cleanRows(readJson(LEGACY(), [])) : [];
  const session = {
    id: newChatId(),
    title: messages.length ? "Current chat" : "New chat",
    created: Date.now(),
    updated: Date.now(),
    messages,
  };
  writeSession(session);
  const next = { current: session.id, chats: [metaOf(session)] };
  writeIndex(next);
  return { index: next, session };
}

export function listSessions() {
  const index = readIndex();
  const chats = index.chats
    .filter((row) => isChatId(row.id))
    .map((row) => {
      const file = sessionFile(row.id);
      const live = file && existsSync(file) ? readSession(row.id) : null;
      return live ? metaOf(live) : row;
    })
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return { current: isChatId(index.current) ? index.current : chats[0]?.id || null, chats };
}

export function persistSession(id, messages, extra = {}) {
  const safe = parseSessionId(id);
  if (!safe) return null;
  const current = readSession(safe) || {
    id: safe,
    title: extra.title || "New chat",
    created: Date.now(),
    updated: Date.now(),
    messages: [],
  };
  current.messages = cleanRows(messages);
  if (extra.modelMessages) current.modelMessages = cleanModelHistory(extra.modelMessages);
  current.updated = Date.now();
  if (extra.title) current.title = cleanText(extra.title, 80, { singleLine: true }) || current.title;
  writeSession(current);
  return current;
}

export function saveSession(id, messages, extra = {}) {
  const safe = parseSessionId(id);
  if (!safe || isBotId(safe)) return null;
  const current = readSession(safe) || {
    id: safe,
    title: "New chat",
    created: Date.now(),
    updated: Date.now(),
    messages: [],
  };
  current.messages = cleanRows(messages);
  if (extra.modelMessages) current.modelMessages = cleanModelHistory(extra.modelMessages);
  current.updated = Date.now();
  if (current.title === "New chat") {
    current.title = titleFrom(current.messages);
  }
  writeSession(current);
  const index = readIndex();
  const chats = index.chats.filter((row) => row.id !== safe);
  chats.unshift(metaOf(current));
  writeIndex({ current: safe, chats });
  return current;
}

export function fileChat({ id = "", title = "Pack", messages = [] } = {}) {
  const safe = isChatId(id) ? id : "";
  let session = safe ? readSession(safe) : null;
  if (!session) {
    session = {
      id: newChatId(),
      title: cleanText(title, 80, { singleLine: true }) || "Pack",
      created: Date.now(),
      updated: Date.now(),
      messages: [],
    };
  }
  if (title) session.title = cleanText(title, 80, { singleLine: true }) || session.title;
  if (messages.length) session.messages = cleanRows([...(session.messages || []), ...messages]);
  session.updated = Date.now();
  writeSession(session);
  const index = readIndex();
  const chats = index.chats.filter((row) => row.id !== session.id);
  chats.unshift(metaOf(session));
  writeIndex({ current: index.current, chats });
  return session;
}

export function createSession() {
  const session = {
    id: newChatId(),
    title: "New chat",
    created: Date.now(),
    updated: Date.now(),
    messages: [],
  };
  writeSession(session);
  const index = readIndex();
  writeIndex({
    current: session.id,
    chats: [metaOf(session), ...index.chats.filter((row) => row.id !== session.id)],
  });
  return session;
}

export function openSession(id) {
  if (!isChatId(id)) return null;
  const session = readSession(id);
  if (!session) return null;
  const index = readIndex();
  writeIndex({
    current: id,
    chats: index.chats.some((row) => row.id === id) ? index.chats : [metaOf(session), ...index.chats],
  });
  return session;
}
