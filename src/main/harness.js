import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { readUserFile, writeUserFile } from "./files.js";
import {
  censorPass,
  expectFromAsk,
  isCodePath,
  isPagePath,
  isVerifierPath,
  probePath,
  readJobSpec,
  runJobSpec,
  shellTargets,
  snapshotIfExists,
  unreadExisting,
  verifyPath,
} from "./harness-check.js";
import { expandPath, getWorkdir } from "./workdir.js";

export {
  censorPass,
  CODE,
  expectFromAsk,
  inventedPrint,
  isCodePath,
  isPagePath,
  isTestPath,
  isTuiSource,
  isVerifierPath,
  isWindowSource,
  missExpect,
  probePath,
  readJobSpec,
  runCommand,
  runJobSpec,
  shellTargets,
  TUI,
  unreadExisting,
  verifyCommand,
  verifyPath,
} from "./harness-check.js";

const WRITE = new Set(["write_file", "host_file_write", "computer_write"]);
const READ = new Set(["read_file", "host_file_read", "computer_read"]);
const SHELL = new Set(["bash", "host_run"]);
const STACK = { python: "python", py: "python", javascript: "javascript", js: "javascript", node: "javascript", go: "go", golang: "go" };

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function stackOf(word) {
  return STACK[String(word || "").toLowerCase()] || "";
}

function proof(ok, path, blurb, detail) {
  return { name: "harness", pack: "host", ok, blurb, detail: detail || blurb, path };
}

export function extractAsks(text) {
  const out = [];
  const add = (value) => {
    const item = String(value || "").replace(/\s+/g, " ").trim().replace(/[.;:]+$/, "");
    if (item.length < 3 || item.length > 72) return;
    if (!out.some((row) => row.toLowerCase() === item.toLowerCase())) out.push(item);
  };
  const raw = String(text || "");
  for (const line of raw.split("\n")) {
    const hit = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.{3,72})$/);
    if (hit) add(hit[1]);
  }
  for (const hit of raw.matchAll(/\b([a-z][a-z0-9.+#]{1,16})\s+not\s+([a-z][a-z0-9.+#]{1,16})\b/gi)) {
    const want = stackOf(hit[1]);
    const avoid = stackOf(hit[2]);
    if (want && avoid && want !== avoid) add(`${want} not ${avoid}`);
  }
  let prefer = "";
  for (const hit of raw.matchAll(/\b(?:use|prefer)\s+(?:the\s+)?(python|javascript|js|node|go|golang)\b/gi)) {
    const before = raw.slice(Math.max(0, hit.index - 16), hit.index).toLowerCase();
    if (/(?:do not|don't|not|no|never)\s+$/.test(before)) continue;
    prefer = stackOf(hit[1]);
    if (prefer) break;
  }
  const avoid = raw.match(/\b(?:do not|don't|not|instead of|no)\s+(?:use\s+)?(?:the\s+)?(go|golang|python|javascript|js)\b/i);
  const skip = stackOf(avoid?.[1]);
  if (prefer && skip && prefer !== skip) add(`${prefer} not ${skip}`);
  for (const hit of raw.matchAll(/\bno\s+(scroll|rewrite|tables?|bash)\b/gi)) add(`no ${hit[1].toLowerCase()}`);
  return out.slice(0, 6);
}

export function classifyAsk(ask) {
  const text = String(ask || "").toLowerCase();
  if (/\b(python|javascript|node|go|golang)\b/.test(text)) return "stack";
  if (/\b(compil|syntax|indent|parse)\b/.test(text)) return "compile";
  if (/\b(test|run|crash|traceback|execute|prints?)\b/.test(text)) return "run";
  return "soft";
}

const PRINT_FILLER = /^(the|all|out|each|every|some|any|its|them|this|that|these|those|numbers?|lines?|words?|text|something|nothing|one|two|three|and|with|from|what|whatever|only|exactly|literally|precisely|simply|just|always)$/i;

/** "check.js prints MIX_OK" stays required even when it sits past the short bullet list.
 *  "prints exactly nova-ok-42" skips the emphasis adverb and keeps the hyphenated literal. */
export function proofAsks(text) {
  const out = [];
  for (const hit of String(text || "").matchAll(/\b([\w.-]+\.(?:js|mjs|cjs|py|sh))\b[^\n]{0,100}?\bprints?\s+(?:(?:exactly|literally|precisely|simply|just|always)\s+)?([A-Za-z0-9][A-Za-z0-9_-]{2,40})\b/g)) {
    if (PRINT_FILLER.test(hit[2])) continue;
    const item = `${hit[1]} prints ${hit[2]}`;
    if (!out.includes(item)) out.push(item);
  }
  return out.slice(0, 3);
}

/** The reply says a write failed, and every write in the turn succeeded. */
export function wrongWriteBlame(answer, trail) {
  const said = String(answer || "");
  if (!/\b(write|wrote)\b/i.test(said) || !/\bfail/i.test(said)) return false;
  const writes = (trail || []).filter((row) => /file_write|write_file/.test(String(row.name || "")));
  return writes.length > 0 && writes.every((row) => row.ok !== false);
}

export function coverAsk(ask, { paths = [], texts = [], runOut = "" } = {}) {
  const text = String(ask || "").toLowerCase();
  const files = paths.map((path) => extname(path).toLowerCase());
  const blob = [...paths, ...texts, runOut].join("\n").toLowerCase();
  if (text === "python not go") return files.includes(".py") && !files.includes(".go");
  if (text === "javascript not go") return files.some((ext) => [".js", ".mjs", ".cjs"].includes(ext)) && !files.includes(".go");
  if (text === "javascript not python") return files.some((ext) => [".js", ".mjs", ".cjs"].includes(ext)) && !files.includes(".py");
  if (text === "go not python") return files.includes(".go") && !files.includes(".py");
  if (text.startsWith("no ")) return !blob.includes(text.slice(3));
  const printed = text.match(/^([\w.-]+) prints (\S+)$/);
  if (printed) {
    const file = printed[1].toLowerCase();
    const token = printed[2].toLowerCase();
    return paths.some((path) => String(path).toLowerCase().endsWith(file)) && blob.includes(token);
  }
  const words = text.split(/\W+/).filter((word) => word.length > 3);
  return Boolean(words.length) && words.every((word) => blob.includes(word));
}

export function patchVerdict(prior, next) {
  const oldText = String(prior || "");
  const newText = String(next || "");
  if (!oldText || oldText.length < 400) return { ok: true };
  if (newText.length > oldText.length * 2.2 && newText.length - oldText.length > 1200) {
    return { ok: false, error: "rewrite too large — patch the existing file" };
   }
  const oldLines = new Set(oldText.split("\n").map((line) => line.trim()).filter((line) => line.length > 8));
  const newLines = new Set(newText.split("\n").map((line) => line.trim()).filter((line) => line.length > 8));
  if (oldLines.size >= 20) {
    const kept = [...oldLines].filter((line) => newLines.has(line)).length;
    if (kept / oldLines.size < 0.25) return { ok: false, error: "rewrite too large — keep more of the original" };
   }
  return { ok: true };
}


/** Code files a write or fix ask names. A turn that never touched them cannot claim PASS. */
export function namedCode(text) {
  const raw = String(text || "");
  if (!/\b(write|create|make|build|fix|patch|edit|update|change|rewrite)\b/i.test(raw)) return [];
  const out = [];
  for (const hit of raw.matchAll(/\b[\w-][\w.-]*\.[a-z]{1,4}\b/gi)) {
    const name = hit[0];
    if (isCodePath(name) && !isVerifierPath(name) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, 4);
}

function specNear(path) {
  const full = expandPath(path, getWorkdir());
  return readJobSpec(dirname(full)) || readJobSpec(getWorkdir());
}

export function createHarness({ ask = "", remoteExec } = {}) {
  const wrote = new Set();
  const passed = new Set();
  const prior = new Map();
  const sources = new Map();
  const asks = [...extractAsks(ask)];
  for (const item of proofAsks(ask)) {
    if (!asks.some((row) => row.toLowerCase() === item.toLowerCase())) asks.push(item);
  }
  const named = namedCode(ask);
  const covered = new Set();
  const extraDebt = [];
  const expect = expectFromAsk(ask);
  const unchecked = new Set();
  const clean = new Set();
  const broken = new Set();

  function tokensFor(path) {
    const base = basename(String(path || "")).toLowerCase();
    const out = [];
    for (const item of asks) {
      const hit = String(item).match(/^([\w.-]+) prints (\S+)$/i);
      if (hit && base === hit[1].toLowerCase()) out.push(hit[2]);
    }
    return out;
  }

  function release() {
    for (const file of clean) passed.add(file);
    for (const file of wrote) {
      if (!broken.has(file) && !unchecked.has(file)) passed.add(file);
    }
  }

  function markAsks(extra = {}) {
    for (const item of asks) {
      if (coverAsk(item, { paths: [...wrote], texts: [...sources.values()], ...extra })) covered.add(item);
    }
  }

  function hardMiss() {
    return asks.filter((item) => classifyAsk(item) !== "soft" && !covered.has(item));
  }

  function openSoft() {
    return asks.filter((item) => classifyAsk(item) === "soft" && !covered.has(item));
  }

  function auditDisk() {
    const seen = new Set();
    for (const [path, old] of prior) {
      const full = expandPath(path, getWorkdir());
      if (seen.has(full) || !old || old.length < 400) continue;
      seen.add(full);
      const now = readUserFile(full);
      if (!now?.ok || now.directory) continue;
      const patch = patchVerdict(old, now.text);
      if (patch.ok) continue;
      writeUserFile(full, old);
      return proof(false, full, `rewrite blocked ${full}`, `${patch.error} (shell write reverted)`);
    }
    return null;
  }

  async function finishCheck(path, text, exec) {
    const opts = exec ? { expand: false, exec, expect } : { expect };
    const compile = await verifyPath(path, opts);
    if (!compile) {
      unchecked.add(path);
      extraDebt.push(`unverified ${path}`);
      return proof(false, path, `unverified ${path}`, "no compile command for this file");
    }
    unchecked.delete(path);
    if (!compile.ok) {
      broken.add(compile.path);
      clean.delete(compile.path);
      return proof(false, compile.path, compile.blurb, compile.error);
    }
    const run = await probePath(path, text, { ...opts, expect: [...expect, ...tokensFor(path)] });
    markAsks({ runOut: run?.stdout || run?.error || "" });
    if (run && !run.ok) {
      broken.add(run.path);
      clean.delete(run.path);
      return proof(false, run.path, run.blurb, run.error);
    }
    clean.add(compile.path);
    broken.delete(compile.path);
    let jobNote = "";
    if (!exec) {
      const spec = specNear(path);
      if (spec) {
        const job = await runJobSpec(spec);
        if (job && !job.ok) {
          broken.add(compile.path);
          clean.delete(compile.path);
          return proof(false, job.path, job.blurb, job.error);
        }
        jobNote = job?.blurb || "";
      }
    }
    const miss = hardMiss();
    const soft = openSoft();
    const open = [...miss, ...soft];
    const blurb = [
      compile.blurb,
      run?.blurb,
      jobNote,
      open.length ? `asks open: ${open.join("; ")}` : (asks.length ? "asks covered" : ""),
    ].filter(Boolean).join(" · ");
    if (open.length) return proof(false, compile.path, blurb, `Still open: ${open.join("; ")}`);
    release();
    return { ...proof(true, compile.path, blurb, blurb), stdout: String(run?.stdout || "").trim().slice(0, 300) };
  }

  function finishPage(path, text) {
    const body = String(text || "").trim();
    const ext = extname(path).toLowerCase();
    if (body.length < 20) {
      broken.add(path);
      return proof(false, path, "page empty", "The page is too small to be the window.");
    }
    if ((ext === ".html" || ext === ".htm") && !/<\w/.test(body)) {
      broken.add(path);
      return proof(false, path, "not a page", "This is not HTML.");
    }
    sources.set(path, body);
    wrote.add(path);
    broken.delete(path);
    markAsks();
    const open = [...hardMiss(), ...openSoft()];
    const blurb = open.length ? `asks open: ${open.join("; ")}` : "page ok · asks covered";
    if (open.length) return proof(false, path, blurb, `Still open: ${open.join("; ")}`);
    release();
    return proof(true, path, blurb, blurb);
  }

  return {
    asks,
    note(name, args, result) {
      const text = result?.text ?? result?.content;
      if (READ.has(name) && result?.ok && text != null) {
        if (result.path) prior.set(result.path, String(text));
        if (args?.path) prior.set(expandPath(args.path, getWorkdir()), String(text));
      }
      if (!WRITE.has(name) || !result?.ok || !result.path) return;
      if (isCodePath(result.path) || isPagePath(result.path)) wrote.add(result.path);
      if (typeof args?.content === "string") sources.set(result.path, args.content);
    },
    before(name, rawArgs) {
      const args = parseArgs(rawArgs);
      if (SHELL.has(name)) {
        for (const target of shellTargets(args.command)) snapshotIfExists(target, prior);
        return null;
      }
      if (!WRITE.has(name) || !args.path) return null;
      const full = expandPath(args.path, getWorkdir());
      if (isVerifierPath(full) || isVerifierPath(args.path)) {
        return proof(false, full, "verifier edit — human review", "Do not expand the harness from a job. A human reviews verifier changes.");
      }
      if (name !== "computer_write" && unreadExisting(args.path, prior)) {
        return proof(false, full, "read first", "read the existing file before overwriting it");
      }
      if (!isCodePath(full) && !isCodePath(args.path) && !isPagePath(full) && !isPagePath(args.path)) return null;
      const patch = patchVerdict(prior.get(full) || prior.get(args.path), String(args.content || ""));
      if (!patch.ok) return proof(false, full, `rewrite blocked ${full}`, patch.error);
      return null;
    },
    async after(name, rawArgs, result) {
      const args = parseArgs(rawArgs);
      this.note(name, args, result);
      if (SHELL.has(name)) {
        const smash = auditDisk();
        if (smash) return smash;
        const targets = shellTargets(args.command).filter((file) => isCodePath(file) && existsSync(file));
        if (!targets.length) return null;
        const file = targets[0];
        wrote.add(file);
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        return finishCheck(file, text);
      }
      const file = result?.path || args.path;
      if (!WRITE.has(name) || !result?.ok) return null;
      if (isPagePath(file)) return finishPage(file, String(args.content || sources.get(file) || ""));
      if (!isCodePath(file)) return null;
      if (isVerifierPath(file)) {
        return proof(false, file, "verifier edit — human review", "Do not expand the harness from a job. A human reviews verifier changes.");
      }
      if (name === "computer_write") {
        if (!remoteExec) {
          extraDebt.push("computer_write unverified");
          return proof(false, file, "remote write unverified", "No tools key to computer_exec a compile.");
        }
        return finishCheck(file, args.content || "", remoteExec);
      }
      const text = String(args.content || sources.get(file) || "");
      const patch = patchVerdict(prior.get(file), text);
      if (!patch.ok) {
        const old = prior.get(file);
        if (old != null) writeUserFile(file, old);
        return proof(false, file, `rewrite blocked ${file}`, patch.error);
      }
      if (text) prior.set(file, text);
      return finishCheck(file, text);
    },
    block(reason) {
      const text = String(reason || "harness blocked").slice(0, 160);
      if (text && !extraDebt.includes(text)) extraDebt.push(text);
    },
    debt() {
      const touched = [...clean, ...passed, ...broken, ...unchecked].map((path) => basename(path).toLowerCase());
      return [
        ...[...broken],
        ...[...unchecked],
        ...named.filter((name) => !touched.includes(name.toLowerCase())).map((name) => `write and run ${name}`),
        ...hardMiss().map((item) => `ask:${item}`),
        ...openSoft().map((item) => `ask:${item}`),
        ...extraDebt,
      ];
    },
  };
}

export function codeAsk(text) {
  return extractAsks(text).length > 0
    || expectFromAsk(text).length > 0
    || namedCode(text).length > 0
    || /\b(fix|bug|compile|indent|error|tui|python|script|function|rewrite|patch|code|program)\b/i.test(String(text || ""));
}
