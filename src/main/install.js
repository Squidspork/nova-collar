/** Install choices. Nothing is downloaded until a step is asked for. */

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { ROOT, saveKeys, saveLocalModel, markSetupDone } from "./config.js";
import { allowServiceUrl } from "./safe.js";
import { ensureOllama, memoryPlan, scanLocalModels } from "./setup.js";

export function layaDir() {
  return process.env.NP_LAYA_MODEL || join(ROOT, "models", "laya-np");
}

export function layaReady() {
  return existsSync(join(layaDir(), "model.safetensors"));
}

export async function inspectInstall() {
  const scanned = await scanLocalModels();
  const memory = scanned.memory || memoryPlan();
  return {
    memory,
    found: scanned.found || [],
    laya: { ready: layaReady(), path: layaDir(), diskGb: memory.layaDiskGb, ramGb: memory.layaRamGb },
    localFit: memory.model,
  };
}

export function choiceList(info) {
  const lines = [
    "1. Bring your own model. One already running here, or an address you paste.",
  ];
  if (platform() === "win32") {
    lines.push("2. A local download is for macOS and Linux. On Windows, use a model you already have.");
  } else if (info.localFit) {
    lines.push(`2. Download ${info.localFit.name} onto this computer. About ${info.localFit.diskGb} GB on disk and ${info.localFit.runGb} GB while answering.`);
  } else {
    lines.push("2. A downloaded local model will not fit. This computer has under 8 GB of memory.");
  }
  return lines;
}

export function parseChoice(text, info) {
  const raw = String(text || "").trim().toLowerCase();
  const picked = raw || "1";
  if (picked === "1" || picked === "byo" || picked === "own") {
    if (info.found?.length) return { source: "found" };
    return { source: "endpoint" };
  }
  if (picked === "2" || picked === "download" || picked === "pull") {
    if (platform() === "win32") return { error: "A local download is for macOS and Linux." };
    if (!info.localFit) return { error: "This computer does not have enough memory for a local model." };
    return { source: "pull", model: info.localFit.name };
  }
  return { error: "Choose 1 or 2." };
}

export function applyEndpoint({ url, model, chatKey } = {}) {
  const chatUrl = String(url || "").trim().replace(/\/$/, "");
  const id = String(model || "").trim();
  if (!chatUrl || !id) return { ok: false, error: "Need an address and a model name." };
  let host = "";
  try {
    host = new URL(chatUrl).hostname;
  } catch {
    return { ok: false, error: "That address is not a URL." };
  }
  if (host === "127.0.0.1" || host === "localhost") {
    const cfg = saveLocalModel({ url: chatUrl, model: id });
    markSetupDone();
    return { ok: true, model: cfg.localModel, localModel: cfg.localModel, url: cfg.localUrl };
  }
  const allowed = allowServiceUrl(chatUrl, "chat");
  if (!allowed) {
    return { ok: false, error: "That address has to be https, and not a private network. A model on this computer uses http://127.0.0.1." };
  }
  const patch = { model: id, chatUrl: allowed };
  if (chatKey) patch.chatKey = String(chatKey).trim();
  const cfg = saveKeys(patch);
  markSetupDone();
  return { ok: true, model: cfg.model, chatUrl: cfg.chatUrl, keySaved: Boolean(cfg.chatKey) };
}

export function applyFound(hit, modelName) {
  const model = String(modelName || hit?.models?.[0] || "").trim();
  if (!hit || !model) return { ok: false, error: "Pick a model from the list." };
  if (allowServiceUrl(hit.url, "local")) {
    const cfg = saveLocalModel({ url: hit.url, model });
    markSetupDone();
    return { ok: true, model: cfg.model, localModel: cfg.localModel, url: cfg.localUrl };
  }
  const cfg = saveKeys({ model, chatUrl: hit.url });
  markSetupDone();
  return { ok: true, model: cfg.model, chatUrl: cfg.chatUrl, keySaved: Boolean(cfg.chatKey) };
}

export async function applyPull(onLine) {
  const pulled = await ensureOllama(onLine || (() => {}));
  if (!pulled.ok) return pulled;
  const cfg = saveLocalModel({ url: pulled.url, model: pulled.model });
  markSetupDone();
  return { ok: true, model: cfg.model, localModel: cfg.localModel, url: cfg.localUrl };
}

function linkOne(destDir, name, target) {
  const dest = join(destDir, name);
  if (existsSync(dest)) {
    const current = lstatSync(dest);
    if (!current.isSymbolicLink()) return { ok: true, path: dest, linked: false };
    if (readlinkSync(dest) === target) return { ok: true, path: dest, linked: true };
    return { ok: true, path: dest, linked: false };
  }
  symlinkSync(target, dest);
  return { ok: true, path: dest, linked: true };
}

export function linkNp() {
  const target = join(ROOT, "src", "cli", "np.js");
  const destDir = join(homedir(), ".local", "bin");
  mkdirSync(destDir, { recursive: true });
  const pub = linkOne(destDir, "nova-collar", target);
  linkOne(destDir, "np", target);
  return { ok: true, path: pub.path, linked: pub.linked, note: pub.linked ? "" : "nova-collar is already on your PATH. Left it in place." };
}
