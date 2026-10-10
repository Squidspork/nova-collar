import { stripVTControlCharacters } from "node:util";

let pty = null;
let raw = "";

function stripAnsi(text) {
  // OSC records can end with BEL or ST. Matching only BEL can swallow real
  // command output between Omarchy's ST-terminated records and the next title.
  return stripVTControlCharacters(String(text)).replace(/\r/g, "");
}

export function bindPty(session) {
  pty = session;
}

export function appendTerm(data) {
  raw = (raw + data).slice(-48_000);
}

export function readTerminal(limit = 12_000) {
  return stripAnsi(raw).slice(-Math.max(200, Number(limit) || 12_000));
}

export function sendTerminal(text, enter = true) {
  if (!pty) return { ok: false, error: "terminal is not up" };
  const newline = process.platform === "win32" ? "\r" : "\n";
  const payload = enter ? `${String(text).replace(/[\r\n]+$/, "")}${newline}` : String(text);
  pty.write(payload);
  return { ok: true, sent: payload };
}
