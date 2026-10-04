import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowServiceUrl, publicHttpsUrl } from "./safe.js";
import { lanesFrom, splitLabel } from "./split.js";

function electronApp() {
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) return null;
  try {
    return createRequire(import.meta.url)("electron").app;
  } catch {
    return null;
  }
}

const app = electronApp();
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const ROOT = app?.isPackaged ? app.getAppPath() : srcRoot;
export const APP_HOME = (() => {
  const override = String(process.env.NOVAPUP_HOME || "").trim();
  if (override && !app?.isPackaged) return resolve(override);
  return join(homedir(), ".novapup");
})();
export const BIN = app?.isPackaged
  ? join(process.resourcesPath, "mac-control")
  : join(srcRoot, "bin/mac-control");

// Laya's reader script and decision configs ship beside the app; the downloaded
// model lives in a writable place. In dev everything stays in the source tree.
export const LAYA_SCRIPT = app?.isPackaged
  ? join(process.resourcesPath, "laya_np.py")
  : join(srcRoot, "scripts", "laya_np.py");
export const LAYA_DATA = app?.isPackaged ? process.resourcesPath : join(srcRoot, "data");
export const MODEL_HOME = app?.isPackaged ? APP_HOME : srcRoot;

export const LOCAL_ID = "local-3.8";
export const LOCAL_OLLAMA_MODEL = "qwen3.8:27b-mlx";

export const MODELS = [
  { id: LOCAL_ID, label: "Local 3.8", hint: "this system" },
  { id: "nova-pup:3.8", label: "Nova 3.8", hint: "remote" },
  { id: "HNL27b", label: "HNL 27B", hint: "27B" },
  { id: "nova-pup", label: "Nova Pup", hint: "chat" },
  { id: "nova-pup:27b", label: "Pup 27B", hint: "27B" },
  { id: "nova-pup:4b", label: "Pup 4B", hint: "fast" },
  { id: "nova-master:next", label: "Master", hint: "coding" },
];

const MODEL_ALIASES = {
  "local 3.8": LOCAL_ID,
  "local3.8": LOCAL_ID,
  "local-3.8": LOCAL_ID,
  "nova3.8": "nova-pup:3.8",
  "nova-3.8": "nova-pup:3.8",
  "nova 3.8": "nova-pup:3.8",
  "nova-pup 3.8": "nova-pup:3.8",
  "grove:27b": "Grove:27b",
  "grove27b": "Grove:27b",
  "grove 27b": "Grove:27b",
  "hnl-grove-27b": "Grove:27b",
  "nova-pup:latest": "nova-pup",
  "hnl-nova-pup": "nova-pup",
  "hnl-nova-pup-27b": "nova-pup:27b",
  hnl27b: "HNL27b",
  "hnl-27b": "HNL27b",
  "hnl27b:latest": "HNL27b",
  "hnl-nova-pup-4b": "nova-pup:4b",
  "nova-master": "nova-master:next",
};

export function normalizeModel(id) {
  const raw = String(id || "").trim();
  if (!raw) return DEFAULTS.HNL_MODEL;
  return MODEL_ALIASES[raw.toLowerCase()] || raw;
}

export function isLocalModel(id) {
  return normalizeModel(id) === LOCAL_ID;
}

const DEFAULTS = {
  HNL_CHAT_URL: "",
  HNL_TOOLS_URL: "",
  HNL_MODEL: LOCAL_ID,
  OLLAMA_URL: "http://127.0.0.1:11434/v1",
  OLLAMA_MODEL: LOCAL_OLLAMA_MODEL,
  HNL_CHAT_KEY: "",
  HNL_TOOLS_KEY: "",
  HNL_COMFY_URL: "",
  HNL_COMFY_FALLBACK: "",
  HNL_COMFY_MODEL: "flux-2-klein-4b.safetensors",
  HNL_LAB_TOKEN: "",
};

export function ensureHome() {
  mkdirSync(join(APP_HOME, "shots"), { recursive: true });
  mkdirSync(join(APP_HOME, "sessions"), { recursive: true });
  const personality = join(APP_HOME, "personality.md");
  const rules = join(APP_HOME, "rules.md");
  if (!existsSync(personality)) {
    writeFileSync(personality, readFileSync(join(ROOT, "data/personality.md"), "utf8"));
  }
  if (!existsSync(rules)) {
    writeFileSync(rules, readFileSync(join(ROOT, "data/rules.md"), "utf8"));
  }
  return APP_HOME;
}

function parseEnv(text, into) {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    into[key] = value;
  }
}

export function loadConfig() {
  ensureHome();
  const cfg = { ...DEFAULTS, ...process.env };
  for (const file of [join(ROOT, ".env"), join(APP_HOME, "env")]) {
    if (existsSync(file)) parseEnv(readFileSync(file, "utf8"), cfg);
  }
  return {
    chatUrl: allowServiceUrl(cfg.HNL_CHAT_URL, "chat") || DEFAULTS.HNL_CHAT_URL,
    toolsUrl: allowServiceUrl(cfg.HNL_TOOLS_URL, "tools") || DEFAULTS.HNL_TOOLS_URL,
    chatKey: String(cfg.HNL_CHAT_KEY || "").trim(),
    toolsKey: String(cfg.HNL_TOOLS_KEY || "").trim(),
    model: normalizeModel(cfg.HNL_MODEL || DEFAULTS.HNL_MODEL),
    localUrl: allowServiceUrl(cfg.OLLAMA_URL, "local") || DEFAULTS.OLLAMA_URL,
    localModel: String(cfg.OLLAMA_MODEL || DEFAULTS.OLLAMA_MODEL).trim(),
    comfyUrl: String(cfg.HNL_COMFY_URL || DEFAULTS.HNL_COMFY_URL).replace(/\/$/, ""),
    comfyFallback: String(cfg.HNL_COMFY_FALLBACK || DEFAULTS.HNL_COMFY_FALLBACK).replace(/\/$/, ""),
    comfyModel: String(cfg.HNL_COMFY_MODEL || DEFAULTS.HNL_COMFY_MODEL).trim(),
    labToken: String(cfg.HNL_LAB_TOKEN || "").trim(),
    hnlSearch: String(cfg.HNL_SEARCH || "").trim() === "1",
    fastUrl: String(cfg.HNL_FAST_URL || "").trim(),
    fastModel: String(cfg.HNL_FAST_MODEL || "").trim(),
    thinkUrl: String(cfg.HNL_THINK_URL || "").trim(),
    thinkModel: String(cfg.HNL_THINK_MODEL || "").trim(),
    fastKey: String(cfg.HNL_FAST_KEY || "").trim(),
    thinkKey: String(cfg.HNL_THINK_KEY || "").trim(),
    home: APP_HOME,
    root: ROOT,
    bin: BIN,
  };
}

function writeEnv(current, patch = {}) {
  const next = {
    HNL_CHAT_URL: patch.chatUrl ?? current.chatUrl,
    HNL_TOOLS_URL: current.toolsUrl,
    HNL_CHAT_KEY: patch.chatKey ?? current.chatKey,
    HNL_TOOLS_KEY: patch.toolsKey ?? current.toolsKey,
    HNL_MODEL: normalizeModel(patch.model ?? current.model),
    OLLAMA_URL: patch.localUrl ?? current.localUrl,
    OLLAMA_MODEL: patch.localModel ?? current.localModel,
    HNL_COMFY_URL: current.comfyUrl,
    HNL_COMFY_FALLBACK: current.comfyFallback,
    HNL_COMFY_MODEL: current.comfyModel,
    HNL_LAB_TOKEN: current.labToken,
    HNL_FAST_URL: patch.fastUrl ?? current.fastUrl ?? "",
    HNL_FAST_MODEL: patch.fastModel ?? current.fastModel ?? "",
    HNL_THINK_URL: patch.thinkUrl ?? current.thinkUrl ?? "",
    HNL_THINK_MODEL: patch.thinkModel ?? current.thinkModel ?? "",
    HNL_FAST_KEY: patch.fastKey ?? current.fastKey ?? "",
    HNL_THINK_KEY: patch.thinkKey ?? current.thinkKey ?? "",
    ...(current.hnlSearch ? { HNL_SEARCH: "1" } : {}),
  };
  // Strip control characters so a pasted key or URL cannot inject extra env lines.
  const clean = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  writeFileSync(join(APP_HOME, "env"), Object.entries(next).map(([key, value]) => `${key}=${clean(value)}`).join("\n") + "\n");
  return loadConfig();
}

export function saveKeys({ chatKey, toolsKey, model, chatUrl }) {
  ensureHome();
  // A caller-supplied chat endpoint must be a public https URL. Reject a blocked,
  // private, or malformed address instead of silently falling back to the default.
  let url = chatUrl;
  if (chatUrl !== undefined && String(chatUrl).trim()) {
    const checked = publicHttpsUrl(chatUrl);
    if (!checked.ok) return { ...publicState(), urlRejected: checked.error || "bad url" };
    url = checked.url;
  }
  const reset = model !== undefined || chatUrl !== undefined
    ? { fastUrl: "", fastModel: "", fastKey: "", thinkUrl: "", thinkModel: "", thinkKey: "" } : {};
  return writeEnv(loadConfig(), { ...reset, chatKey, toolsKey, model, chatUrl: url });
}

export function saveLocalModel({ url, model }) {
  ensureHome();
  return writeEnv(loadConfig(), {
    localUrl: String(url || "").replace(/\/$/, ""),
    localModel: String(model || "").trim(),
    model: LOCAL_ID,
    // Local selection owns the whole turn; old remote roles must not keep routing it.
    fastUrl: "", fastModel: "", fastKey: "",
    thinkUrl: "", thinkModel: "", thinkKey: "",
  });
}

/**
 * Point one lane (fast or think) at a model, or clear it.
 * Clearing the fast lane turns the split off, so the single chat model does the whole turn.
 * A local model uses the local server; anything else rides the chat endpoint.
 */
export function saveLane({ lane, model }) {
  ensureHome();
  const which = lane === "fast" ? "fast" : lane === "think" ? "think" : "";
  if (!which) return loadConfig();
  const cfg = loadConfig();
  const id = String(model || "").trim();
  if (!id) {
    return writeEnv(cfg, { [`${which}Model`]: "", [`${which}Url`]: "" });
  }
  const resolved = normalizeModel(id);
  const url = isLocalModel(resolved) ? cfg.localUrl : cfg.chatUrl;
  return writeEnv(cfg, { [`${which}Model`]: isLocalModel(resolved) ? cfg.localModel : resolved, [`${which}Url`]: url, [`${which}Key`]: "" });
}

export function isSetupDone() {
  return existsSync(join(APP_HOME, "setup.json"));
}

export function markSetupDone() {
  ensureHome();
  writeFileSync(join(APP_HOME, "setup.json"), "{\"done\":true}\n");
}

export function readMemory() {
  ensureHome();
  return {
    personality: readFileSync(join(APP_HOME, "personality.md"), "utf8"),
    rules: readFileSync(join(APP_HOME, "rules.md"), "utf8"),
  };
}

export function chatTarget(cfg = loadConfig()) {
  if (isLocalModel(cfg.model)) {
    return { url: cfg.localUrl, model: cfg.localModel, key: "ollama", local: true };
  }
  return { url: cfg.chatUrl, model: cfg.model, key: cfg.chatKey || cfg.toolsKey, local: false };
}

function modelChoices(model) {
  const id = normalizeModel(model);
  if (!id || MODELS.some((row) => row.id === id)) return MODELS;
  return [...MODELS, { id, label: id, hint: "saved" }];
}

export function publicState(cfg = loadConfig()) {
  return {
    ready: isLocalModel(cfg.model) || Boolean(cfg.chatKey || cfg.toolsKey),
    hasToolsKey: Boolean(cfg.toolsKey),
    hasComfy: Boolean(cfg.comfyUrl || cfg.comfyFallback),
    model: cfg.model,
    models: modelChoices(cfg.model).map((row) => row.id === LOCAL_ID ? { ...row, label: `Local: ${cfg.localModel}` } : row),
    chatUrl: isLocalModel(cfg.model) ? cfg.localUrl : cfg.chatUrl,
    toolsUrl: cfg.toolsUrl,
    local: isLocalModel(cfg.model),
    localModel: cfg.localModel,
    split: splitLabel(lanesFrom(cfg, chatTarget(cfg))),
    providerUrl: cfg.chatUrl,
    lanes: Object.fromEntries(["fast", "think"].map((lane) => [lane, cfg[`${lane}Url`] === cfg.localUrl && cfg[`${lane}Model`] === cfg.localModel ? LOCAL_ID : cfg[`${lane}Model`] || ""])),
    laneEndpoints: { fast: cfg.fastUrl, think: cfg.thinkUrl },
    setupDone: isSetupDone(),
    os: process.platform,
    host: hostname(),
  };
}
