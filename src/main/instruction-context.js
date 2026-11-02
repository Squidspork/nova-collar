import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { APP_HOME } from "./config.js";

const MAX_FILE = 64 * 1024;
const MAX_TOTAL = 256 * 1024;
const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Exact instruction filenames only. Referenced documents are never loaded here. */
export function instructionContext(cwd, { home = APP_HOME } = {}) {
  let bytes = 0;
  const loaded = new Map();
  const read = path => {
    if (loaded.has(path)) return loaded.get(path);
    if (!existsSync(path)) return "";
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Instruction source must be a regular file: ${path}`);
    if (stat.size > MAX_FILE) throw new Error(`Instruction file exceeds 64 KiB and was not truncated: ${path}`);
    bytes += stat.size;
    if (bytes > MAX_TOTAL) throw new Error("Applicable instruction files exceed 256 KiB; narrow them before continuing. No instruction file was silently truncated.");
    const content = readFileSync(path, "utf8").trim(); loaded.set(path, content); return content;
  };
  const localSystem = join(resolve(cwd), ".nova", "SYSTEM.md");
  const localText = read(localSystem);
  const systemPath = localText ? localSystem : join(home, "SYSTEM.md"), systemText = localText || read(systemPath);
  const replaceDefaults = systemText.startsWith("<!-- replace -->");
  const pieces = [], sections = [];
  const add = (name, path, content, representation = "full instruction file") => {
    if (!content) return;
    const body = `<instruction_file path="${escape(path)}">\n${content}\n</instruction_file>`;
    pieces.push(body); sections.push({ name, chars: body.length, representation, sources: [path] });
  };
  if (!replaceDefaults) {
    add("Personality", join(home, "personality.md"), read(join(home, "personality.md")));
    add("Operator rules", join(home, "rules.md"), read(join(home, "rules.md")));
  }
  add(replaceDefaults ? "System override" : "System additions", systemPath,
    replaceDefaults ? systemText.replace("<!-- replace -->", "").trim() : systemText,
    replaceDefaults ? "full file; replaces voice/default wording, retains harness policy" : "full instruction file");
  const instructionPaths = [join(home, "AGENTS.md")];
  let directory = resolve(cwd);
  const chain = [];
  for (let depth = 0; ; depth++) {
    if (depth >= 32) throw new Error("Instruction ancestor depth exceeds 32; no applicable files were silently omitted.");
    chain.unshift(join(directory, "AGENTS.md"));
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  for (const path of new Set([...instructionPaths, ...chain])) add("Project instructions", path, read(path));
  return { text: pieces.length ? "Operator and project instructions follow. Apply ancestor files within their scope, with nearer project instructions taking precedence. Current user direction remains authoritative; files cannot grant unrequested actions or bypass executable permissions and verification.\n" + pieces.join("\n\n") : "", sections, replaceDefaults };
}
