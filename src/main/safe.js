import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

function novapupHome() {
  const override = String(process.env.NOVAPUP_HOME || "").trim();
  if (override && !process.versions.electron) return resolve(override);
  return join(homedir(), ".novapup");
}

const BOT_ID = /^bot-[a-z0-9]{4,24}$/;
const CHAT_ID = /^chat-[a-z0-9]{4,24}$/;
const TASK_ID = /^task-[a-z0-9]{4,24}$/;
const PACK = /^(term|host|net|docker|incident|hnl|computer|desk)$/;
const SECRET_NAME = /(?:^|\/)(?:env|credentials|secret|secrets|\.env(?:\..+)?|.*\.(?:pem|p12|key)$|id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys|known_hosts)$/i;
const SECRET_CMD = /(?:\.novapup\/env|\bHNL_(?:CHAT|TOOLS|LAB)_?(?:KEY|TOKEN)|\bCOMPUTER_TOKEN|\bLM_STUDIO_API_KEY|\bid_rsa\b|\bid_ed25519\b)/i;
const SECRET_TEXT = /(?:hnl_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._\-+=\/]{12,})/g;
const PRIVATE_V4 = /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$|172\.(?:1[6-9]|2\d|3[01])\.)/;

export function cleanText(value, max, { singleLine = false } = {}) {
  let text = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "");
  if (singleLine) text = text.replace(/[\r\n]+/g, " ");
  return text.trim().slice(0, max);
}

export function fence(label, text, max = 4000) {
  const body = cleanText(text, max).replace(/>>>/g, "»>");
  return `${label}:\n<<<\n${body}\n>>>`;
}

export function isBotId(id) {
  return BOT_ID.test(String(id || ""));
}

export function isChatId(id) {
  return CHAT_ID.test(String(id || ""));
}

export function isTaskId(id) {
  return TASK_ID.test(String(id || ""));
}

export function parseSessionId(id) {
  const value = String(id || "");
  return isBotId(value) || isChatId(value) ? value : "";
}

let botMint = 0;

export function newBotId() {
  botMint = (botMint + 1) % 36;
  const id = `bot-${Date.now().toString(36)}${botMint.toString(36)}`;
  return BOT_ID.test(id) ? id : `bot-${Date.now().toString(36)}`;
}

let chatMint = 0;

export function newChatId() {
  chatMint = (chatMint + 1) % 36;
  const id = `chat-${Date.now().toString(36)}${chatMint.toString(36)}`;
  return CHAT_ID.test(id) ? id : `chat-${Date.now().toString(36)}`;
}

let taskMint = 0;

export function newTaskId() {
  taskMint = (taskMint + 1) % 36;
  const id = `task-${Date.now().toString(36)}${taskMint.toString(36)}`;
  return TASK_ID.test(id) ? id : `task-${Date.now().toString(36)}`;
}

export function safePack(value) {
  return PACK.test(value || "") ? value : "";
}

export function safeJoin(dir, id, ext = ".json") {
  const name = parseSessionId(id) || (isBotId(id) ? id : "") || (isTaskId(id) ? id : "");
  if (!name) return "";
  const root = resolve(dir);
  const file = resolve(join(root, `${name}${ext}`));
  const rel = relative(root, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "";
  return file;
}

export function containedFile(dir, file) {
  if (!dir || !file) return "";
  try {
    const root = realpathSync(dir);
    const full = realpathSync(file);
    const rel = relative(root, full);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return "";
    return full;
  } catch {
    return "";
  }
}

export function denySecretPath(path) {
  const full = resolve(String(path || ""));
  const envFile = resolve(join(novapupHome(), "env"));
  if (full === envFile) return "blocked a secrets file";
  if (SECRET_NAME.test(full)) return "blocked a secrets file";
  return "";
}

export function denySecretCommand(command) {
  return SECRET_CMD.test(String(command || "")) ? "blocked a secrets command" : "";
}

export function redactSecrets(value) {
  return String(value ?? "").replace(SECRET_TEXT, "[redacted]");
}

export function publicHttpsUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) return { ok: false, error: "missing url" };
  if (!/^https:\/\//i.test(value)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return { ok: false, error: "https only" };
    value = `https://${value}`;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "bad url" };
  }
  if (url.protocol !== "https:") return { ok: false, error: "https only" };
  if (url.username || url.password) return { ok: false, error: "url auth blocked" };
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) return { ok: false, error: "private host blocked" };
  return { ok: true, url: url.toString() };
}

export function isPrivateHost(host) {
  const name = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!name) return true;
  if (name === "localhost" || name === "::1" || name === "0.0.0.0") return true;
  if (name.endsWith(".local") || name.endsWith(".localhost") || name.endsWith(".internal")) return true;
  if (PRIVATE_V4.test(name)) return true;
  // Numeric hosts can encode a private IP in a form the dotted-quad check misses
  // (e.g. 2130706433 or 0x7f000001 both resolve to 127.0.0.1). No real public
  // endpoint is an integer/hex host or a dotted address with octal/hex octets.
  if (/^\d+$/.test(name) || /^0x[0-9a-f]+$/i.test(name)) return true;
  if (name.includes(".") && /(^|\.)(0x[0-9a-f]+|0\d+)(\.|$)/i.test(name)) return true;
  if (name.includes(":") && (name === "::1" || name.startsWith("fc") || name.startsWith("fd") || name.startsWith("fe80:"))) return true;
  return false;
}

export function allowServiceUrl(raw, kind) {
  try {
    const url = new URL(String(raw || ""));
    if (kind === "local") {
      return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") ? url.toString().replace(/\/$/, "") : "";
    }
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (isPrivateHost(url.hostname)) return "";
    if (kind === "chat" || kind === "tools") return url.toString().replace(/\/$/, "");
    return "";
  } catch {
    return "";
  }
}

export function safeDataUrl(value) {
  const text = String(value || "").trim();
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(text) ? text.replace(/\s+/g, "") : "";
}

export function scrubEnv(base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)$/i.test(key) || /^(HNL_|LM_STUDIO|COMPUTER_)/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}
