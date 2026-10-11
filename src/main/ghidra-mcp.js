import { collectFunctionReview, REVIEW_DESCRIPTION, REVIEW_PROPERTIES } from './ghidra-review.mjs';
/** Ghidra desktop-project integration; normal analysis uses the headless pack. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME, ROOT } from "./config.js";

const ORIGIN = "http://127.0.0.1:8089";
const CLOSED = "Ghidra is not listening on 127.0.0.1:8089. Open it with ghidraRun and leave the project window open.";

export function ghidraSkillDir(home = APP_HOME) {
  return join(home, "skills", "ghidra");
}

export function ghidraReady(home = APP_HOME) {
  return existsSync(join(ghidraSkillDir(home), "installed")) || (home === APP_HOME && existsSync(join(ROOT, "materials/skills/ghidra/SKILL.md")));
}

export function ghidraAsk(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  const artifact = /\b(function|address|0x[0-9a-f]+|binary|firmware|executable|dll|dylib)\b/i.test(s);
  if (/^(what|who|explain|define)\b/i.test(s) && !artifact) return false;
  if (/\b(ghidra|decompil\w*|disassembl\w*|xref|cross[- ]?references?|firmware|reverse[- ]engineer)\b/i.test(s)) return true;
  return /\b(binary|executable|dll|dylib|firmware)\b/i.test(s)
    && /\b(function|decompil\w*|disassembl\w*|xref|calls?)\b/i.test(s);
}

/** Installed skill wins over a generic code/host lane. A locked pack and a refusal stay. */
export function steerGhidra(text, steer, { installed = false, locked = false } = {}) {
  if (!installed || locked) return steer;
  if (steer?.action === "refuse") return steer;
  if (!ghidraAsk(text)) return steer;
  return { action: "pack", pack: "ghidra", blurb: "ghidra", detail: "compiled program" };
}

export function ghidraDoctrine(home = APP_HOME) {
  const installed = join(ghidraSkillDir(home), "SKILL.md");
  const file = existsSync(installed) || home !== APP_HOME ? installed : join(ROOT, "materials/skills/ghidra/SKILL.md");
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").replace(/^# .+\n+/, "").trim().slice(0, 1400);
}

export function ghidraPack() {
  return {
    id: "ghidra",
    title: "Ghidra projects",
    blurb: "Work with an existing project open in the Ghidra desktop window",
    tools: [
      tool("ghidra_review_function", REVIEW_DESCRIPTION, REVIEW_PROPERTIES, ["program", "address"]),
      tool("ghidra_status", "See if Ghidra MCP is up, and whether a program is open."),
      tool("ghidra_programs", "List programs open in Ghidra."),
      tool("ghidra_functions", "Search function names in the open program.", {
        name_pattern: { type: "string" },
        program: { type: "string" },
        limit: { type: "integer" },
      }),
      tool("ghidra_decompile", "Decompile one function by name or address. Read-only.", {
        address: { type: "string" },
        program: { type: "string" },
      }, ["address"]),
      tool("ghidra_xrefs", "Cross-references to one function.", {
        name: { type: "string" },
        address: { type: "string" },
        program: { type: "string" },
      }),
      tool("ghidra_strings", "Defined strings in the open program.", {
        filter: { type: "string" },
        program: { type: "string" },
        limit: { type: "integer" },
      }),
    ],
  };
}

function tool(name, description, properties = {}, required = []) {
  return { name, description, properties, required };
}

export function installSkillPack(id, { root = ROOT, home = APP_HOME } = {}) {
  if (id !== "ghidra") return { ok: false, error: `No skill pack named ${id}.` };
  const src = join(root, "materials", "skills", "ghidra", "SKILL.md");
  if (!existsSync(src)) return { ok: false, error: "The Ghidra skill pack is not in this copy." };
  const dest = ghidraSkillDir(home);
  mkdirSync(dest, { recursive: true });
  const next = readFileSync(src, "utf8");
  const skillFile = join(dest, "SKILL.md");
  const marker = join(dest, "installed");
  const same = existsSync(skillFile) && existsSync(marker) && readFileSync(skillFile, "utf8") === next;
  writeFileSync(skillFile, next);
  if (!existsSync(marker)) writeFileSync(marker, new Date().toISOString());
  return { ok: true, path: dest, skipped: same };
}

async function ghidraGet(path, params = {}, timeoutMs = 20000) {
  const url = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { ok: false, error: CLOSED };
  }
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { text: raw.slice(0, 2000) };
  }
  if (!response.ok || body?.error) {
    return { ok: false, error: String(body?.error || `Ghidra returned ${response.status}`) };
  }
  return { ok: true, body };
}

function clip(text, max = 6000) {
  const value = String(text || "");
  return value.length <= max ? value : `${value.slice(0, max)}\n… truncated`;
}

export async function runGhidra(name, args = {}) {
  if (!ghidraReady()) {
    return { ok: false, error: "Ghidra skill pack is not installed. nova-collar update ghidra" };
  }
  if (name === "ghidra_review_function") {
    try {
      return { ok: true, ...await collectFunctionReview(async (path, params) => {
        const result = await ghidraGet(path, params, path === "/decompile_function" ? 45000 : 15000);
        if (!result.ok) throw new Error(result.error);
        return result.body;
      }, args) };
    } catch (error) { return { ok: false, error: String(error.message || error) }; }
  }
  const program = args.program || "";
  if (name === "ghidra_status") {
    const [health, version, programs] = await Promise.all([
      ghidraGet("/mcp/health"),
      ghidraGet("/get_version"),
      ghidraGet("/list_open_programs"),
    ]);
    if (!health.ok) return health;
    return {
      ok: true,
      version: version.body || {},
      programs: programs.body?.count ?? 0,
      current: programs.body?.current_program || "",
    };
  }
  if (name === "ghidra_programs") return shape(await ghidraGet("/list_open_programs"));
  if (name === "ghidra_functions") {
    return shape(await ghidraGet("/search_functions", {
      name_pattern: args.name_pattern || "",
      program,
      offset: 0,
      limit: clamp(args.limit, 30, 1, 50),
    }));
  }
  if (name === "ghidra_decompile") {
    const got = await ghidraGet("/decompile_function", {
      address: args.address || "",
      program,
      timeout: 30,
    }, 35000);
    if (!got.ok) return got;
    return {
      ok: true,
      name: got.body?.name || "",
      address: got.body?.address || "",
      decompiled: clip(got.body?.decompiled),
    };
  }
  if (name === "ghidra_xrefs") {
    if (!args.name && !args.address) return { ok: false, error: "Pass a function name or address." };
    return shape(await ghidraGet("/get_function_xrefs", {
      name: args.name || "",
      address: args.address || "",
      program,
      offset: 0,
      limit: 20,
    }));
  }
  if (name === "ghidra_strings") {
    return shape(await ghidraGet("/list_strings", {
      filter: args.filter || "",
      program,
      offset: 0,
      limit: clamp(args.limit, 30, 1, 50),
    }));
  }
  return null;
}

function clamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function shape(result) {
  if (!result.ok) return result;
  const text = JSON.stringify(result.body);
  return { ok: true, ...(text.length > 6000 ? { text: `${text.slice(0, 6000)}\n… truncated` } : result.body) };
}
