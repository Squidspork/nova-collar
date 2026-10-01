let pty = null;
let raw = "";

function stripAnsi(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\r/g, "");
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
  const payload = enter && !String(text).endsWith("\n") ? `${text}\n` : String(text);
  pty.write(payload);
  return { ok: true, sent: payload };
}
