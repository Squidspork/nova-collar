import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { isWindows, quoteShell } from "./platform.js";
import { runBash } from "./files.js";
import { denySecretPath } from "./safe.js";
import { expandPath, getWorkdir } from "./workdir.js";

export const CODE = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".json", ".sh", ".bash"]);
export const PAGE = new Set([".html", ".htm", ".css"]);
export const TUI = /\b(curses|textual|blessed|prompt_toolkit|urwid|npyscreen)\b/i;
const CRASH = /\b(Traceback|SyntaxError|ReferenceError|TypeError|panic:|FATAL EXCEPTION|Exception:)\b/;
const VERIFIER = /(?:^|\/)(?:harness|intuition|safe)\.js$|(?:^|\/)harness\.json$/i;

export function isCodePath(path) {
  return CODE.has(extname(String(path || "")).toLowerCase());
}

export function isPagePath(path) {
  return PAGE.has(extname(String(path || "")).toLowerCase());
}

export function isVerifierPath(path) {
  return VERIFIER.test(String(path || "").replace(/\\/g, "/"));
}

export function isTestPath(path) {
  const base = basename(String(path || "")).toLowerCase();
  return /(?:^test_.*|_test)\.py$/.test(base) || /\.test\.(js|mjs|cjs|ts)$/.test(base) || /_test\.go$/.test(base);
}

export function isTuiSource(path, source = "") {
  return TUI.test(source) || TUI.test(basename(String(path || "")));
}

/** A desktop window. Node still has to start it; a comment that says electron does not count. */
export function isWindowSource(path, source = "") {
  const text = String(source || "");
  return /\brequire\s*\(\s*['"]electron['"]\s*\)/.test(text)
    || /\bfrom\s+['"]electron['"]/.test(text)
    || /\bBrowserWindow\b/.test(text);
}

/** The reply describes a printout the last tool did not produce. */
export function inventedPrint(answer, detail) {
  const said = String(answer || "");
  const err = String(detail || "");
  const hit = said.match(/\bprinted\s+["']?([^"'\n]{3,80})/i);
  if (!hit) return false;
  const claim = hit[1].replace(/[.\s]+$/g, "").trim().toLowerCase();
  if (!claim) return false;
  return !err.toLowerCase().includes(claim.slice(0, 48));
}

export function expectFromAsk(text) {
  const out = [];
  const add = (value) => {
    const item = String(value || "").trim();
    if (item && !out.includes(item)) out.push(item);
  };
  const raw = String(text || "");
  for (const hit of raw.matchAll(/\bprints?\s+["']([^"']{1,40})["']/gi)) add(hit[1]);
  for (const hit of raw.matchAll(/\bprints?\s+(\d+)\b/gi)) add(hit[1]);
  for (const hit of raw.matchAll(/\boutput(?:s)?\s+["']([^"']{1,40})["']/gi)) add(hit[1]);
  return out.slice(0, 4);
}

export function missExpect(stdout, expects) {
  const blob = String(stdout || "");
  return (expects || []).filter((item) => !blob.includes(item));
}

export function verifyCommand(path, { expand = true } = {}) {
  const full = expand ? expandPath(path, getWorkdir()) : String(path || "");
  const ext = extname(full).toLowerCase();
  const windows = expand && isWindows;
  const q = quoteShell(full, windows);
  if (ext === ".py") return { full, command: `${windows ? "python" : "python3"} -m py_compile ${q}` };
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { full, command: `node --check ${q}` };
  if (ext === ".ts" || ext === ".tsx") {
    return { full, command: `npx --no-install tsc --pretty false --noEmit --skipLibCheck ${q}` };
  }
  if (ext === ".go") return { full, command: windows ? `gofmt -e ${q} | Out-Null; if ($LASTEXITCODE -eq 0) { go build -o NUL ${q} }` : `gofmt -e ${q} >/dev/null && go build -o /dev/null ${q}` };
  if (ext === ".json") return { full, command: `${windows ? "python" : "python3"} -c 'import json,sys; json.load(open(sys.argv[1]))' ${q}` };
  if (ext === ".sh" || ext === ".bash") return { full, command: `bash -n ${q}` };
  return null;
}

export function runCommand(path, source = "", { expand = true } = {}) {
  const full = expand ? expandPath(path, getWorkdir()) : String(path || "");
  if (isVerifierPath(full)) return null;
  const ext = extname(full).toLowerCase();
  const windows = expand && isWindows;
  const q = quoteShell(full, windows);
  if (isWindowSource(full, source) && (ext === ".js" || ext === ".mjs" || ext === ".cjs")) {
    return { full, command: `node ${q}`, window: true };
  }
  if (isTuiSource(full, source)) return null;
  if (isTestPath(full)) {
    if (ext === ".py") return { full, command: `${windows ? "python" : "python3"} -m pytest -q ${q}`, test: true };
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { full, command: `node --test ${q}`, test: true };
    if (ext === ".go") return { full, command: `go test ${q}`, test: true };
  }
  if (ext === ".py") return { full, command: `${windows ? "python" : "python3"} ${q}` };
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { full, command: `node ${q}` };
  if (ext === ".sh" || ext === ".bash") return { full, command: `bash ${q}` };
  return null;
}

function shaped(raw) {
  return {
    ok: Boolean(raw?.ok),
    stdout: String(raw?.stdout || raw?.output || raw?.text || ""),
    stderr: String(raw?.stderr || ""),
    error: String(raw?.error || ""),
    killed: raw?.killed,
    held: raw?.held,
  };
}

function judged(result, path, kind) {
  const err = String(result.stderr || result.error || result.stdout || "").trim();
  if (result.ok) return { ok: true, path, blurb: `${kind} ok ${path}`, stdout: result.stdout.slice(0, 400) };
  return { ok: false, held: result.held, path, error: err.slice(0, 800) || `${kind} failed`, blurb: `${kind} failed ${path}` };
}

export async function verifyPath(path, extra = {}) {
  const expand = extra.expand !== false;
  const plan = verifyCommand(path, { expand });
  if (!plan) return null;
  if (expand && denySecretPath(plan.full)) return { ok: false, path: plan.full, error: "blocked a secrets file" };
  const run = extra.exec || ((command) => runBash(command));
  return judged(shaped(await run(plan.command)), plan.full, "compile");
}

export async function probePath(path, source = "", extra = {}) {
  const expand = extra.expand !== false;
  const expect = extra.expect || [];
  const plan = runCommand(path, source, { expand });
  if (!plan) return null;
  if (expand && denySecretPath(plan.full)) {
    return { ok: false, path: plan.full, error: "blocked a secrets file", blurb: `run blocked ${plan.full}` };
  }
  const run = extra.exec || ((command) => runBash(command, undefined, { timeoutMs: 3500 }));
  let result = shaped(await run(plan.command));
  if (plan.test && /No module named pytest|pytest: command not found/i.test(`${result.stderr} ${result.error}`)) {
    result = shaped(await run(`${expand && isWindows ? "python" : "python3"} ${quoteShell(plan.full, expand && isWindows)}`));
  }
  const out = `${result.stdout}\n${result.stderr}\n${result.error}`;
  if (CRASH.test(out)) {
    return { ok: false, path: plan.full, error: out.trim().slice(0, 800), blurb: `run failed ${plan.full}` };
  }
  if (result.killed === "timeout") {
    if (plan.window && !CRASH.test(out)) {
      return { ok: true, path: plan.full, blurb: `window stayed open ${plan.full}`, stdout: result.stdout.slice(0, 400) };
    }
    return { ok: false, path: plan.full, error: "timed out", blurb: `run hung ${plan.full}` };
  }
  if (!(result.ok || /usage:|argparse|required arguments/i.test(out))) {
    return {
      ok: false,
      held: result.held,
      path: plan.full,
      error: String(result.stderr || result.error || "run failed").slice(0, 800),
      blurb: `run failed ${plan.full}`,
    };
  }
  const missing = missExpect(result.stdout, expect);
  if (missing.length) {
    return { ok: false, path: plan.full, error: `missing output: ${missing.join(", ")}`, blurb: `run missed ${missing.join(", ")}` };
  }
  return {
    ok: true,
    path: plan.full,
    blurb: plan.test ? `test ok ${plan.full}` : `run ok ${plan.full}`,
    stdout: result.stdout.slice(0, 400),
  };
}

export function readJobSpec(dir = getWorkdir()) {
  const file = join(dir, "harness.json");
  if (!existsSync(file) || denySecretPath(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const check = String(raw.check || raw.command || "").trim().slice(0, 240);
    const expect = String(raw.expect || "").trim().slice(0, 80);
    if (!check || /(?:\brm\b|\bcurl\b|\bwget\b|\byes\b|while\s)/i.test(check)) return null;
    return { check, expect };
  } catch {
    return null;
  }
}

export async function runJobSpec(spec, extra = {}) {
  if (!spec?.check) return null;
  const run = extra.exec || ((command) => runBash(command, undefined, { timeoutMs: 15_000 }));
  const result = shaped(await run(spec.check));
  const out = `${result.stdout}\n${result.stderr}`;
  if (!result.ok) {
    return { ok: false, held: result.held, path: "harness.json", blurb: "job check failed", error: String(result.stderr || result.error || "check failed").slice(0, 800) };
  }
  if (spec.expect && !out.includes(spec.expect)) {
    return { ok: false, path: "harness.json", blurb: `job missed ${spec.expect}`, error: `harness.json expect ${JSON.stringify(spec.expect)} not in output` };
  }
  return { ok: true, path: "harness.json", blurb: "job check ok", stdout: result.stdout.slice(0, 400) };
}

export function shellTargets(command, base = getWorkdir()) {
  const found = [];
  const cmd = String(command || "");
  for (const hit of cmd.matchAll(/(?:>>?|tee(?:\s+-a)?)\s*["']?([^\s"'|&;]+)/g)) {
    if (isCodePath(hit[1])) found.push(expandPath(hit[1], base));
  }
  for (const hit of cmd.matchAll(/open\(\s*['"]([^'"]+)['"]\s*,\s*['"]w/g)) {
    if (isCodePath(hit[1])) found.push(expandPath(hit[1], base));
  }
  return [...new Set(found)];
}

export function unreadExisting(path, prior) {
  const full = expandPath(path, getWorkdir());
  if (prior?.has(full) || prior?.has(path)) return false;
  if (isVerifierPath(full)) return false;
  try {
    if (!existsSync(full)) return false;
    const text = readFileSync(full, "utf8");
    return text.length >= 200 || text.split("\n").length >= 8;
  } catch {
    return false;
  }
}

export function snapshotIfExists(path, prior) {
  const full = expandPath(path, getWorkdir());
  if (prior.has(full) || !existsSync(full)) return;
  try {
    prior.set(full, readFileSync(full, "utf8"));
  } catch {
    /* unreadable */
  }
}

export function censorPass(text, debt) {
  if (!debt?.length) return String(text || "");
  return String(text || "").replace(/^\s*PASS\b.*$/gm, "FAIL (harness still open)");
}
