/** Four voices from a free-form wish. The chosen one is this window's personality. */

import { complete } from "./agent.js";
import { loadConfig } from "./config.js";
import { watchJailbreak } from "./laya-steer.js";

const VOICE_SYSTEM = "Two or three sentences. First person. Start with I am. Stay inside the voice the user described. No title. No tools.";

const LEANS = [
  "Sound like a fox who has read a lot.",
  "Sound like someone who leaves a path the moment it fails.",
  "Sound clever and a little wild.",
  "Sound like a librarian with teeth.",
  "Sound quick, then precise.",
  "Sound like you change course when the first way fails.",
  "Sound feral and educated.",
  "Sound like you trust a new idea over an old belief.",
];

const HOUSE = /I do the work\.\s*I do not dump a plan|One step, then the result|^FAIL\b|\bStopped\b/i;

/** A plain first-person reply, with the stock harness line left out. */
export function voiceFromProse(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (line.length < 24 || HOUSE.test(line) || !/^I am\b/i.test(line)) return null;
  const title = line.replace(/^I am\s+/i, "").replace(/^(?:a|an|the)\s+/i, "").split(/[.!?]/)[0].replace(/,/g, "").trim();
  const words = title.split(/\s+/).filter(Boolean).slice(0, 3);
  while (words.length > 1 && /^(a|an|the)$/i.test(words.at(-1) || "")) words.pop();
  const name = words.join(" ").slice(0, 28);
  return { name: name || "voice", text: line.slice(0, 500) };
}

export function parseVoices(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw) return [];
  let chunks = raw.split(/\n---\n/).map((part) => part.trim()).filter(Boolean);
  if (chunks.length < 2) {
    chunks = raw.split(/\n(?=\d+[\).\]]\s)/).map((part) => part.trim()).filter(Boolean);
  }
  const voices = [];
  for (const chunk of chunks) {
    const named = chunk.match(/^name:\s*(.+)\n+text:\s*([\s\S]+)/i);
    let name = "";
    let body = "";
    if (named) {
      name = named[1];
      body = named[2];
    } else {
      const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
      name = (lines[0] || "").replace(/^\d+[\).\]]\s*/, "").replace(/^name:\s*/i, "");
      body = lines.slice(1).join(" ").replace(/^text:\s*/i, "");
    }
    name = name.replace(/\s+/g, " ").trim().slice(0, 32);
    body = body.replace(/\s+/g, " ").trim().slice(0, 500);
    if (name.length >= 2 && body.length >= 24) voices.push({ name, text: body });
  }
  const seen = new Set();
  return voices.filter((row) => {
    const key = row.text.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

export async function draftVoices(wish) {
  const ask = String(wish || "").replace(/\s+/g, " ").trim().slice(0, 800);
  if (ask.length < 8) throw new Error("Say a little more about the voice.");
  if (watchJailbreak(ask)) throw new Error("I won't make that.");
  const cfg = loadConfig();
  const voices = [];
  const seen = new Set();
  for (let i = 0; i < LEANS.length && voices.length < 4; i += 4) {
    const made = await Promise.all(LEANS.slice(i, i + 4).map((lean) => complete([
      { role: "system", content: VOICE_SYSTEM },
      { role: "user", content: `${lean}\n${ask}` },
    ], cfg, null, null, { toolChoice: "none", tools: [] })));
    for (const last of made) {
      const row = voiceFromProse(last.content) || voiceFromProse(parseVoices(last.content)[0]?.text);
      if (!row || seen.has(row.text)) continue;
      seen.add(row.text);
      voices.push(row.name ? row : { ...row, name: "voice" });
      if (voices.length === 4) break;
    }
  }
  if (voices.length < 4) throw new Error("I couldn’t shape four voices. Try the description again.");
  return voices.slice(0, 4);
}
