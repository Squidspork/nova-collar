import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { complete } from "./agent.js";
import { APP_HOME, ensureHome, isLocalModel, loadConfig } from "./config.js";

const MAX = 200_000;

function specPath() {
  return join(APP_HOME, "spec.md");
}

export function readSpec() {
  ensureHome();
  if (!existsSync(specPath())) return "";
  return readFileSync(specPath(), "utf8").slice(0, MAX);
}

export function writeSpec(text) {
  ensureHome();
  const body = String(text ?? "").slice(0, MAX);
  writeFileSync(specPath(), body);
  return { ok: true, bytes: Buffer.byteLength(body) };
}

function bare(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  return (fenced ? fenced[1] : raw).trim();
}

/** One insertion for the spec editor. No tools, no file writes. */
export async function completeSpec(body, signal) {
  const cfg = loadConfig();
  if (!isLocalModel(cfg.model) && !cfg.chatKey && !cfg.toolsKey) {
    return { ok: false, error: "need-keys" };
  }
  const mode = String(body?.mode || "write");
  const before = String(body?.before || "").slice(-4000);
  const after = String(body?.after || "").slice(0, 1500);
  const selection = String(body?.selection || "").slice(0, 4000);
  const instruction = String(body?.instruction || "").slice(0, 1000);
  const system = [
    "You are writing inside a product spec.",
    "Return only the text to insert. No preamble, no quotes around the whole answer.",
    "Keep the headings and voice already in the document.",
    "When the operator asks for layout, name the region, its size, and where it sits.",
  ].join(" ");
  let user = "";
  if (mode === "complete") {
    user = `Continue from the cursor. One short line, or one short paragraph. Do not rewrite the document.\n\n--- before the cursor ---\n${before}\n--- after the cursor ---\n${after}`;
  } else if (mode === "from") {
    user = `The selection is the instruction. Write the spec text that should replace it.\n\n${selection}\n\nDocument before the selection:\n${before}`;
  } else if (mode === "ref") {
    user = `The selection is reference only. Write the next section at the cursor. Do not repeat the selection.\n\nReference:\n${selection}\n\nBefore the cursor:\n${before}\n\nAfter the cursor:\n${after}\n\n${instruction}`.trim();
  } else {
    user = `Write this at the cursor:\n${instruction}\n\nBefore the cursor:\n${before}\n\nAfter the cursor:\n${after}`;
  }
  const reply = await complete(
    [{ role: "system", content: system }, { role: "user", content: user }],
    cfg,
    null,
    signal,
    { tools: [], toolChoice: "none", temperature: 0.3, predict: 500 },
  );
  const text = bare(reply?.content || "");
  if (!text) return { ok: false, error: "Nothing to add." };
  return { ok: true, text: text.slice(0, 8000) };
}
