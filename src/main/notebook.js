import { cleanText } from "./safe.js";

// Verification hierarchy from the RSI survey: a miss only sticks when an
// external signal caught it (harness or a source). Intrinsic pain — loops,
// "are you done" — is recorded as friction elsewhere and cannot write law.

const EXEC = new Set(["no-proof", "compile-fail", "run-fail", "ask-miss", "rewrite"]);
const EVIDENCE = new Set(["no-source", "ungrounded"]);
const CHECK = new Set(["tool-fail"]);
const LOOKUP = new Set([
  "web_search", "extract", "scrape", "docs_search", "memory_recall", "memory_search",
  "host_file_read", "read_file", "computer_read", "http_check", "net_report",
]);
const VERIFIER_WORD = /harness|compile|run|checklist|proof|source|read/i;
const RANK = { exec: 0, evidence: 1, check: 2, intrinsic: 3 };

export function rungOf(flag) {
  if (EXEC.has(flag)) return "exec";
  if (EVIDENCE.has(flag)) return "evidence";
  if (CHECK.has(flag)) return "check";
  return "intrinsic";
}

export function externalFlags(flags) {
  return (flags || []).filter((flag) => rungOf(flag) !== "intrinsic");
}

function asMiss(row) {
  if (!row || typeof row !== "object") return null;
  const text = cleanText(row.text, 140, { singleLine: true });
  if (!text) return null;
  const flag = String(row.flag || "");
  const rung = RANK[row.rung] != null ? row.rung : rungOf(flag);
  return {
    text,
    flag,
    rung,
    n: Math.max(1, Number(row.n) || 1),
    at: Number(row.at) || 0,
  };
}

export function mergeMisses(prior, incoming, max = 6) {
  const map = new Map();
  for (const row of [...(prior || []), ...(incoming || [])]) {
    const miss = asMiss(row);
    if (!miss) continue;
    const key = miss.text.toLowerCase();
    const have = map.get(key);
    if (!have) {
      map.set(key, miss);
      continue;
    }
    map.set(key, {
      ...have,
      n: have.n + miss.n,
      at: Math.max(have.at, miss.at),
      flag: miss.flag || have.flag,
      rung: RANK[miss.rung] < RANK[have.rung] ? miss.rung : have.rung,
    });
  }
  return [...map.values()]
    .sort((a, b) => RANK[a.rung] - RANK[b.rung] || b.at - a.at)
    .slice(0, max);
}

function harnessFlag(blurb) {
  if (/run failed/i.test(blurb)) return "run-fail";
  if (/asks open/i.test(blurb)) return "ask-miss";
  if (/rewrite|verifier/i.test(blurb)) return "rewrite";
  return "compile-fail";
}

export function missesFrom(messages) {
  const rows = messages || [];
  const steps = rows.filter((row) => row.role === "step");
  const out = [];
  const harnessPassed = steps.some((row) => row.name === "harness" && row.ok);
  if (!harnessPassed) {
    for (const step of steps) {
      if (step.name !== "harness" || step.ok !== false) continue;
      const blurb = String(step.blurb || step.detail || "harness failed");
      out.push({ text: blurb, flag: harnessFlag(blurb), rung: "exec", at: Date.now() });
    }
    const wrote = steps.some((row) => /write/.test(row.name || "") && row.ok !== false);
    if (wrote && !out.some((row) => row.rung === "exec")) {
      out.push({ text: "Wrote a file with no harness proof.", flag: "no-proof", rung: "exec", at: Date.now() });
    }
  }
  const answer = String([...rows].reverse().find((row) => row.role === "assistant")?.content || "");
  const admitted = /don't know|do not know|not sure|cannot verify|can't verify/i.test(answer);
  const looked = steps.some((row) => LOOKUP.has(row.name));
  for (const step of steps) {
    if (step.name !== "ground" || step.ok !== false || admitted) continue;
    const blurb = String(step.blurb || "fact not in source");
    if (/no source/i.test(blurb)) {
      if (!looked) out.push({ text: blurb, flag: "no-source", rung: "evidence", at: Date.now() });
      continue;
    }
    const tokens = blurb.replace(/^not in source:\s*/i, "").split(",").map((part) => part.trim()).filter(Boolean);
    if (tokens.some((token) => answer.toLowerCase().includes(token.toLowerCase()))) {
      out.push({ text: blurb, flag: "ungrounded", rung: "evidence", at: Date.now() });
    }
  }
  return mergeMisses([], out, 4);
}

export function latestExternal(misses) {
  const row = (misses || []).find((item) => item.rung === "exec" || item.rung === "evidence");
  return row ? `${row.rung}: ${row.text}` : "";
}

export function admitMaster(lines, flags) {
  if (!externalFlags(flags).length) return [];
  const kept = [];
  for (const row of lines || []) {
    const text = cleanText(typeof row === "string" ? row : row?.text, 140, { singleLine: true });
    if (!text || !VERIFIER_WORD.test(text)) continue;
    kept.push(text);
    if (kept.length >= 1) break;
  }
  return kept;
}

function proofRule(text) {
  return /compile|harness|proof|pass or fail/.test(String(text || "").toLowerCase());
}

export function scoreRule(rule, metrics) {
  const flags = metrics?.flags || [];
  const external = externalFlags(flags);
  const proved = Boolean(metrics?.proved);
  if (!external.length && !proved) return rule;
  if (proved && proofRule(rule.text) && !external.length) {
    return { ...rule, seen: rule.seen + 1, wins: rule.wins + 1 };
  }
  if (external.length && proofRule(rule.text)) {
    return { ...rule, seen: rule.seen + 1 };
  }
  return rule;
}
