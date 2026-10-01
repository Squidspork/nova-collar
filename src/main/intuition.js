import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME, ensureHome, loadConfig } from "./config.js";
import { admitMaster, externalFlags, latestExternal, mergeMisses, missesFrom, scoreRule } from "./notebook.js";
import { cleanText, redactSecrets } from "./safe.js";

const FILE = () => join(APP_HOME, "intuition.json");
const MASTER = "nova-master:next";
const WINDOW = 16;

const SEED_NEXT = [
  "Answer with status first, then tools.",
  "One read, then act. Do not page a file with sed.",
  "Smallest edit. Wait for harness compile and run before claiming done.",
  "First line is PASS or FAIL and what was checked.",
  "Do not expand the harness or other verifiers.",
  "If you did not read it this turn, say you don't know. Do not invent.",
  "After a correction, restate the goal in one line and follow it.",
];
const SEED_FRICTION = [
  "Died mid-job with a loop or Stopped line instead of a result.",
  "Claimed a fix that was not on disk or did not compile.",
  "Had to be asked if the work was done.",
];

let timer = null;
let busy = false;
let turns = 0;

function asRule(row) {
  const text = cleanText(typeof row === "string" ? row : row?.text, 140, { singleLine: true });
  if (text.length < 8) return null;
  const raw = typeof row === "object" && row ? row : {};
  return {
    text,
    wins: Math.max(0, Number(raw.wins) || 0),
    losses: Math.max(0, Number(raw.losses) || 0),
    seen: Math.max(1, Number(raw.seen) || 1),
  };
}

function mergeRules(lists, max = 8) {
  const map = new Map();
  for (const list of lists) {
    // A rule list saved as one string must stay one rule, not one rule per letter.
    for (const row of typeof list === "string" ? [list] : list || []) {
      const rule = asRule(row);
      if (!rule) continue;
      const key = rule.text.toLowerCase();
      const have = map.get(key);
      map.set(key, have
        ? { ...have, wins: have.wins + rule.wins, losses: have.losses + rule.losses, seen: have.seen + 1 }
        : rule);
    }
  }
  return [...map.values()]
    .filter((row) => !(row.seen >= 3 && row.losses >= row.wins + 2))
    .sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses) || b.seen - a.seen)
    .slice(0, max);
}

function texts(rows, max, floor = -1) {
  return (rows || []).filter((row) => row.wins - row.losses >= floor).slice(0, max).map((row) => row.text);
}

function empty() {
  return {
    updated: 0,
    source: "seed",
    turns: 0,
    intent: "Finish the job in this window. Fast HNL tool. Compile and run before claiming done.",
    friction: SEED_FRICTION.map((text) => asRule(text)),
    next: SEED_NEXT.map((text) => asRule(text)),
    pain: 0,
    lastPain: 0,
    streak: 0,
    misses: [],
  };
}

function cleanDoc(raw) {
  const base = empty();
  if (!raw || typeof raw !== "object") return base;
  const friction = mergeRules([raw.friction], 6);
  const next = mergeRules([raw.next], 8);
  return {
    updated: Number(raw.updated) || Date.now(),
    source: /^(master|local|seed|mix)$/.test(raw.source) ? raw.source : base.source,
    turns: Number(raw.turns) || 0,
    intent: cleanText(raw.intent || base.intent, 200, { singleLine: true }) || base.intent,
    friction: friction.length ? friction : base.friction,
    next: next.length ? next : base.next,
    pain: Number(raw.pain) || 0,
    lastPain: Number(raw.lastPain) || 0,
    streak: Number(raw.streak) || 0,
    misses: mergeMisses(raw.misses, [], 6),
  };
}

export function scoreTurn(messages) {
  const users = (messages || []).filter((row) => row.role === "user");
  const asst = (messages || []).filter((row) => row.role === "assistant");
  const steps = (messages || []).filter((row) => row.role === "step");
  const userText = users.map((row) => String(row.content || "")).join("\n");
  const asstText = asst.map((row) => String(row.content || "")).join("\n");
  const flags = [];
  let pain = 0;
  if (/looping tools|tool cap|Stopped\.|timed out/i.test(asstText)) { pain += 3; flags.push("loop"); }
  if (/\b(did you|are you done|did you stop|you stopped)\b/i.test(userText)) { pain += 3; flags.push("ask-done"); }
  if (/\b(wtf|leak|creepy)\b/i.test(userText)) { pain += 2; flags.push("surprise"); }
  if (users.length >= 2 && cleanText(users.at(-1)?.content, 80) === cleanText(users.at(-2)?.content, 80)) { pain += 2; flags.push("repeat"); }
  const wrote = steps.filter((row) => /write/.test(row.name || ""));
  const proof = steps.some((row) => row.name === "harness" && row.ok);
  const proofFail = steps.some((row) => row.name === "harness" && row.ok === false);
  if (wrote.length && !proof) { pain += 3; flags.push("no-proof"); }
  if (proofFail) { pain += 2; flags.push("compile-fail"); }
  if (steps.some((row) => row.name === "harness" && /run failed/i.test(row.blurb || ""))) { pain += 2; flags.push("run-fail"); }
  if (steps.some((row) => row.name === "harness" && /asks open/i.test(row.blurb || ""))) { pain += 2; flags.push("ask-miss"); }
  if (steps.some((row) => row.name === "harness" && /rewrite blocked|verifier edit/i.test(row.blurb || ""))) { pain += 2; flags.push("rewrite"); }
  if (steps.filter((row) => row.ok === false).length) { pain += 1; flags.push("tool-fail"); }
  if (steps.slice(-12).length >= 8) { pain += 1; flags.push("hops"); }
  const misses = missesFrom(messages);
  if (misses.some((row) => row.flag === "no-source")) { pain += 2; flags.push("no-source"); }
  if (misses.some((row) => row.flag === "ungrounded")) { pain += 2; flags.push("ungrounded"); }
  if (/\bPASS\b/.test(asstText) && proof && pain >= 2) pain -= 2;
  return {
    pain: Math.max(0, Math.min(10, pain)),
    flags,
    proved: proof,
    misses,
  };
}

export function applyScore(doc, metrics) {
  const next = cleanDoc(doc);
  next.next = mergeRules([next.next.map((row) => scoreRule(row, metrics))], 8);
  next.misses = mergeMisses(next.misses, metrics.misses);
  next.lastPain = next.pain;
  next.pain = metrics.pain;
  next.streak = metrics.pain <= 2 ? next.streak + 1 : 0;
  next.turns += 1;
  next.updated = Date.now();
  return next;
}

export function readIntuition() {
  ensureHome();
  mkdirSync(APP_HOME, { recursive: true });
  if (!existsSync(FILE())) {
    const seed = { ...empty(), updated: Date.now(), source: "seed" };
    writeFileSync(FILE(), JSON.stringify(seed, null, 2));
    return seed;
  }
  try {
    return cleanDoc(JSON.parse(readFileSync(FILE(), "utf8")));
  } catch {
    return empty();
  }
}

function save(doc) {
  writeFileSync(FILE(), JSON.stringify(doc, null, 2));
  return publicIntuition();
}

export function publicIntuition() {
  const doc = readIntuition();
  return {
    intent: doc.intent,
    friction: texts(doc.friction, 6, -2),
    next: texts(doc.next, 5, -1),
    pain: doc.pain,
    streak: doc.streak,
    source: doc.source,
    updated: doc.updated,
    when: doc.updated,
    turns: doc.turns,
    misses: (doc.misses || [])
      .filter((row) => row.rung === "exec" || row.rung === "evidence")
      .slice(0, 4)
      .map((row) => `${row.rung}: ${row.text}`),
  };
}

export function formatIntuition(doc = readIntuition(), { local = false, short = false } = {}) {
  const live = doc.next ? doc : readIntuition();
  const doNow = texts(live.next, local ? 3 : 4, -1);
  const miss = latestExternal(live.misses);
  if (short) {
    return cleanText(`Sense: ${miss ? `Last miss: ${miss}. ` : ""}${doNow[0] || live.intent}`, 200, { singleLine: true });
  }
  const lines = [
    `Intent: ${live.intent}`,
    miss ? `Last miss: ${miss}` : "",
    `Do: ${doNow.join("; ")}`,
    `Don't: ${texts(live.friction, 3, -2).join("; ")}`,
    live.pain ? `Last pain ${live.pain}/10` : "",
  ].filter(Boolean);
  return local ? lines.join(" ").slice(0, 400) : lines.join("\n").slice(0, 800);
}

function clip(row) {
  if (row.role === "step") return `step ${row.ok === false ? "fail" : "ok"} ${row.name}: ${cleanText(row.blurb || "", 80, { singleLine: true })}`;
  return `${row.role} ${cleanText(row.content || "", 180, { singleLine: true })}`;
}

export function transcriptOf(messages, limit = WINDOW) {
  return (messages || []).filter((row) => row && (row.role === "user" || row.role === "assistant" || row.role === "step")).slice(-limit).map(clip);
}

export function heuristicReview(messages) {
  const metrics = scoreTurn(messages);
  const users = (messages || []).filter((row) => row.role === "user");
  const last = [...users].reverse().find((row) => {
    const text = String(row.content || "").trim();
    return text.length > 12 && text.length < 220 && !/traceback|line \d+, in /i.test(text);
  });
  const next = [];
  if (metrics.flags.includes("loop") || metrics.flags.includes("hops")) next.push("Answer with status first, then tools.");
  if (metrics.flags.includes("no-proof") || metrics.flags.includes("compile-fail") || metrics.flags.includes("run-fail")) {
    next.push("Smallest edit. Wait for harness compile and run before claiming done.");
  }
  if (metrics.flags.includes("ask-miss")) next.push("Tick each ask. Do not PASS with open checklist items.");
  if (metrics.flags.includes("rewrite")) next.push("One read, then the smallest patch. Do not rewrite the harness.");
  if (metrics.flags.includes("ask-done") || metrics.flags.includes("repeat")) next.push("First line is PASS or FAIL and what was checked.");
  if (metrics.flags.includes("no-source") || metrics.flags.includes("ungrounded")) {
    next.push("If you did not read it this turn, say you don't know. Do not invent.");
  }
  if (!next.length) next.push("One read, then act. Do not page a file with sed.");
  const friction = [];
  if (metrics.flags.includes("loop")) friction.push("Died mid-job with a loop or Stopped line instead of a result.");
  if (metrics.flags.includes("no-proof")) friction.push("Claimed a fix that was not on disk or did not compile.");
  if (metrics.flags.includes("run-fail")) friction.push("Compile passed but the run probe crashed.");
  if (metrics.flags.includes("ask-miss")) friction.push("Claimed done with checklist items still open.");
  if (metrics.flags.includes("rewrite")) friction.push("Rewrote a file or the verifier instead of a small patch.");
  if (metrics.flags.includes("ask-done")) friction.push("Had to be asked if the work was done.");
  if (metrics.flags.includes("no-source")) friction.push("Answered a fact without looking it up this turn.");
  if (metrics.flags.includes("ungrounded")) friction.push("Stated a name, year, or price that was not in what was read.");
  return {
    intent: cleanText(last?.content || "", 200, { singleLine: true }) || readIntuition().intent,
    friction,
    next,
    metrics,
  };
}

export function isHot(messages) {
  return scoreTurn(messages).pain >= 4 || /\b(did you|are you done|stopped|looping|wtf|no actually)\b/i.test(transcriptOf(messages, 8).join("\n"));
}

function parseGuess(text) {
  const raw = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function askMaster(transcript, prior, metrics) {
  const cfg = loadConfig();
  if (!cfg.chatKey) return null;
  const winners = texts(prior.next, 4, 1);
  const response = await fetch(`${cfg.chatUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.chatKey}`,
      "content-type": "application/json",
      "user-agent": "NovaCollar/0.1",
    },
    body: JSON.stringify({
      model: MASTER,
      stream: false,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You gloss one Nova Collar turn. JSON only: {intent, friction: string[0-2], next: string[0-1]}. next is optional and may only restate the verifier that failed (harness, compile, checklist, or source). Do not set a new objective. No tools. No secrets.",
        },
        {
          role: "user",
          content: redactSecrets(`Winners: ${JSON.stringify(winners)}\nPain ${metrics.pain} flags ${metrics.flags.join(",")}\nIntent: ${prior.intent}\nTurns:\n${transcript.join("\n")}`),
        },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) return null;
  return parseGuess((await response.json())?.choices?.[0]?.message?.content);
}

export async function reviewIntuition(messages, { force = false } = {}) {
  const prior = applyScore(readIntuition(), scoreTurn(messages));
  const guess = heuristicReview(messages);
  let source = "local";
  let incoming = guess;
  const external = externalFlags(guess.metrics.flags);
  const wantMaster = force || (external.length > 0 && (guess.metrics.pain >= 4 || prior.streak === 0));
  if (wantMaster) {
    try {
      const master = await askMaster(transcriptOf(messages), prior, guess.metrics);
      if (master) {
        const admitted = admitMaster(master.next, guess.metrics.flags);
        incoming = {
          intent: force ? (master.intent || guess.intent) : guess.intent,
          friction: guess.friction,
          next: [...guess.next, ...admitted],
        };
        source = admitted.length ? "mix" : (force ? "master" : "local");
      }
    } catch {
      /* keep scored grind */
    }
  }
  const next = {
    ...prior,
    source,
    updated: Date.now(),
    intent: incoming.intent || prior.intent,
    friction: mergeRules([incoming.friction, prior.friction], 6),
    next: mergeRules([incoming.next, prior.next], 8),
  };
  return save(next);
}

export function noteTurn(messages) {
  turns += 1;
  const hot = isHot(messages);
  const quiet = !hot && scoreTurn(messages).pain <= 2 && turns % 6 !== 0 && turns !== 1;
  if (quiet) {
    save(applyScore(readIntuition(), scoreTurn(messages)));
    return Promise.resolve(publicIntuition());
  }
  return new Promise((resolve) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (busy) {
        resolve(null);
        return;
      }
      busy = true;
      reviewIntuition(messages)
        .then(resolve)
        .catch(() => resolve(null))
        .finally(() => { busy = false; });
    }, hot ? 800 : 4000);
  });
}

export async function reviewNow(messages) {
  if (busy) return publicIntuition();
  busy = true;
  try {
    return await reviewIntuition(messages, { force: true });
  } finally {
    busy = false;
  }
}
