/** Lessons shared by bots on the same steer pack. Hungry Nova calls those bots the pack. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME, ensureHome } from "./config.js";
import { auditFromLaya, auditTrace, planAudit } from "./goal.js";
import { layaAuditTrained, layaReady, readLaya } from "./laya.js";
import { steerFromLaya } from "./laya-steer.js";
import { cleanText, fence, redactSecrets, safePack } from "./safe.js";

const MAX = 6;
const CORRECTION = /^(?:no[,.\s]|wrong[,.\s]|instead[,.\s]|don'?t\b|do not\b|stop[,.\s]|actually[,.\s])/i;
const LEAD = /^(?:no[,.\s]+|wrong[,.\s]+|instead[,.\s]+|stop[,.\s]+|actually[,.\s]+)/i;

function dir() {
  return join(APP_HOME, "pack");
}

function fileFor(pack) {
  const id = safePack(pack);
  return id ? join(dir(), `${id}.json`) : "";
}

function cleanLesson(text) {
  const line = cleanText(text, 160, { singleLine: true });
  if (line.length < 8) return "";
  if (redactSecrets(line) !== line) return "";
  if (/novapup\/env|ignore previous|system prompt|\bapi key\b/i.test(line)) return "";
  return line;
}

export function readPackLessons(pack) {
  const file = fileFor(pack);
  if (!file || !existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const rows = Array.isArray(raw?.lessons) ? raw.lessons : [];
    return rows
      .map((row) => {
        const text = cleanLesson(row?.text);
        if (!text) return null;
        return {
          text,
          from: cleanText(row.from, 40, { singleLine: true }),
          fromName: cleanText(row.fromName, 32, { singleLine: true }) || "Pack",
          at: Number(row.at) || 0,
        };
      })
      .filter(Boolean)
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function lessonsFor(pack, exceptId = "") {
  const skip = String(exceptId || "");
  return readPackLessons(pack).filter((row) => row.from !== skip);
}

export function allPackLessons() {
  ensureHome();
  mkdirSync(dir(), { recursive: true });
  return ["term", "host", "net", "docker", "incident", "hnl", "computer", "desk"].flatMap((pack) =>
    readPackLessons(pack).map((row) => ({ ...row, pack })),
  );
}

function writeLessons(pack, lessons) {
  const file = fileFor(pack);
  if (!file) return [];
  ensureHome();
  mkdirSync(dir(), { recursive: true });
  const rows = lessons.slice(0, MAX);
  writeFileSync(file, JSON.stringify({ pack: safePack(pack), lessons: rows }, null, 2));
  return rows;
}

export function lessonFromTurn({ ask, trail } = {}) {
  const user = String(ask || "").replace(/\s+/g, " ").trim();
  if (CORRECTION.test(user)) {
    const text = cleanLesson(user.replace(LEAD, "").trim() || user);
    return text ? { kind: "teach", text } : null;
  }
  const steps = Array.isArray(trail) ? trail : [];
  const failAt = steps.findIndex((row) => row && row.ok === false && row.name);
  if (failAt < 0) return null;
  const fail = steps[failAt];
  const later = steps.slice(failAt + 1).find((row) => row && row.ok !== false && row.name && row.name !== fail.name);
  if (!later) return null;
  const text = cleanLesson(`If ${fail.name} fails, try ${later.name} instead of repeating it.`);
  return text ? { kind: "learn", text } : null;
}

export function lessonVerdict({ text, pack, existing = [], job = null, audit = null } = {}) {
  const line = cleanLesson(text);
  if (!line || !safePack(pack)) return { ok: false, why: "empty" };
  if (existing.some((row) => row.text.toLowerCase() === line.toLowerCase())) {
    return { ok: false, why: "already taught" };
  }
  if (job?.action === "refuse") return { ok: false, why: "laya refused" };
  if (audit?.action === "retry") return { ok: false, why: "unproven" };
  return { ok: true, text: line };
}

export function formatPackLessons(rows) {
  if (!rows?.length) return "";
  const body = rows.slice(0, MAX).map((row) => `${row.fromName}: ${row.text}`).join("\n");
  return [
    "From the pack: other members on this steer pack already learned the lines below. Follow them. Do not repeat a failed step they named.",
    fence("From the pack", body, 900),
  ].join("\n");
}

async function layaOnLesson(draft, { ask, trail }) {
  if (!layaReady()) return { job: null, audit: null };
  const job = steerFromLaya(await readLaya(draft.text, "job"), { text: draft.text });
  if (draft.kind !== "learn" || !layaAuditTrained()) return { job, audit: null };
  const plan = planAudit({ claim: draft.text, ask, trail });
  if (plan.action === "skip") return { job, audit: null };
  const audit = auditFromLaya(await readLaya(auditTrace({
    claim: draft.text,
    opposite: plan.opposite,
    internalGoal: plan.internalGoal,
    ask,
    trail,
  }), "audit"));
  if (audit?.action === "retry" || (!audit && plan.action === "retry")) {
    return { job, audit: { action: "retry" } };
  }
  return { job, audit };
}

export async function teachPack({ pack, from, fromName, ask, trail } = {}) {
  const id = safePack(pack);
  if (!id) return { ok: false, why: "empty" };
  const draft = lessonFromTurn({ ask, trail });
  if (!draft) return { ok: false, why: "nothing to teach" };
  const existing = readPackLessons(id);
  const gate = await layaOnLesson(draft, { ask, trail });
  const verdict = lessonVerdict({ text: draft.text, pack: id, existing, job: gate.job, audit: gate.audit });
  if (!verdict.ok) return verdict;
  const lessons = [
    {
      text: verdict.text,
      from: cleanText(from, 40, { singleLine: true }),
      fromName: cleanText(fromName, 32, { singleLine: true }) || "Pack",
      at: Date.now(),
    },
    ...existing,
  ];
  writeLessons(id, lessons);
  return { ok: true, text: verdict.text, pack: id };
}
