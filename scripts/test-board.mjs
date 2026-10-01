import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOVAPUP_HOME = mkdtempSync(join(tmpdir(), "novapup-board-"));

const { saveBot } = await import("../src/main/bots.js");
const { finishedGoal, shareContext, taskDue } = await import("../src/main/board.js");
const { tick, stopBoard } = await import("../src/main/schedule.js");
const { assignTask, listTasks, saveTask } = await import("../src/main/tasks.js");
const { createSession, listSessions } = await import("../src/main/sessions.js");
const { stopLaya } = await import("../src/main/laya.js");

const t0 = 1_700_000_000_000;

function job(name, every, title, extra = {}) {
  const bot = saveBot({ name, title: name, role: "Watch the task.", pack: "host" });
  const task = saveTask({
    title,
    goal: extra.goal || title,
    every,
    botId: bot.id,
    ranAt: extra.ranAt === undefined ? t0 : extra.ranAt,
    status: extra.status || "open",
  });
  return { bot, task };
}

const one = job("One", 1, "Reply with the single word PONG");
const three = job("Three", 3, "Reply with the single word PING");
assert.equal(taskDue(one.task, t0 + 59_000), false);
assert.equal(taskDue(one.task, t0 + 60_000), true);
assert.equal(taskDue(three.task, t0 + 120_000), false);
assert.equal(taskDue(three.task, t0 + 180_000), true);
assert.equal(taskDue({ ...one.task, title: "" }, t0 + 60_000), false);
assert.equal(taskDue({ ...one.task, status: "done" }, t0 + 60_000), false);

const runs = [];
const runner = async () => ({ assistant: "Still working." });
async function fire(at) {
  const rows = await tick(runner, at);
  for (const row of rows) runs.push({ id: row.id, at });
  return rows;
}

assert.equal((await fire(t0 + 59_000)).length, 0);
assert.equal((await fire(t0 + 60_000)).length, 1);
assert.equal((await fire(t0 + 120_000)).length, 1);
assert.equal((await fire(t0 + 180_000)).length, 2);
assert.deepEqual(runs.filter((row) => row.id === one.task.id).map((row) => row.at), [t0 + 60_000, t0 + 120_000, t0 + 180_000]);
assert.deepEqual(runs.filter((row) => row.id === three.task.id).map((row) => row.at), [t0 + 180_000]);
assert.equal(listTasks().find((row) => row.id === one.task.id).goal, "Reply with the single word PONG");
assert.equal(listTasks().find((row) => row.id === one.task.id).status, "open");

const ace = job("Ace", 0, "Say PONG", { goal: "Say PONG", ranAt: 0 });
const finished = await tick(async () => ({ assistant: "Goal met\nPONG" }), t0);
assert.equal(finished.find((row) => row.id === ace.task.id)?.status, "done");
assert.equal(listTasks().find((row) => row.id === ace.task.id).status, "done");
assert.equal((await tick(async () => ({ assistant: "again" }), t0 + 120_000)).some((row) => row.id === ace.task.id), false);
assert.equal(finishedGoal("Say PONG", "Goal met\nPONG"), true);
assert.equal(finishedGoal("Say PONG", "PONG"), false);

assert.equal(shareContext({
  task: "Write the disk report",
  self: { id: "a", pack: "host", goal: "Write the disk report" },
  other: { id: "b", pack: "host", goal: "Write the disk report for the host", status: "open" },
}), true);
assert.equal(shareContext({
  task: "Paint a picture of a harbor",
  self: { id: "a", pack: "host", goal: "Paint a picture of a harbor" },
  other: { id: "b", pack: "computer", goal: "Paint a picture of a harbor", status: "open" },
}), false);
assert.equal(shareContext({
  task: "Write the disk report",
  self: { id: "a", pack: "host", goal: "Write the disk report" },
  other: { id: "b", pack: "host", goal: "Write the disk report for the host", status: "open" },
  verdict: { action: "stuck" },
}), false);
assert.equal(shareContext({
  task: "Count the crates",
  self: { id: "a", pack: "host", goal: "Count the crates" },
  other: { id: "b", pack: "desk", goal: "Draft the harbor notes", status: "open" },
  verdict: { action: "keep" },
}), true);

const parked = createSession();
const assigned = assignTask({
  title: "Write the disk report",
  goal: "The disk report is written",
  make: true,
  pack: "host",
});
assert.ok(assigned?.task?.id && assigned.bot?.id && assigned.chat?.id);
assert.equal(listSessions().current, parked.id);
assert.ok(listSessions().chats.some((row) => row.id === assigned.chat.id && row.title.startsWith("Pack ·")));
assert.equal(assigned.task.by, "user");
saveTask({ id: assigned.task.id, status: "done" });

const { writeFileSync, readFileSync } = await import("node:fs");
const { keepSpares, mutationHold } = await import("../src/main/spare.js");
const { writeUserFile } = await import("../src/main/files.js");
const { releaseHeld } = await import("../src/main/tasks.js");
const spareFile = join(process.env.NOVAPUP_HOME, "note.txt");
writeFileSync(spareFile, "one\n");
writeUserFile(spareFile, "two\n");
writeUserFile(spareFile, "three\n");
writeUserFile(spareFile, "four\n");
const copies = keepSpares(spareFile);
assert.equal(copies.length, 3);
assert.equal(readFileSync(copies[0], "utf8"), "four\n");
assert.equal(mutationHold({ tasker: "user", write: true }), "write");
assert.equal(mutationHold({ tasker: "novapup", write: true, exists: false }), "");
assert.equal(mutationHold({ tasker: "novapup", write: true, exists: true }), "overwrite");
assert.equal(mutationHold({ tasker: "novapup", command: "rm keep.py" }), "delete");
assert.equal(mutationHold({ tasker: "novapup", command: "rm keep.py", allow: true }), "");
const held = assignTask({ title: "Patch the gate", goal: "The gate holds", make: true, by: "novapup" });
assert.equal(held.task.by, "novapup");
saveTask({ id: held.task.id, status: "hold" });
assert.equal(taskDue(listTasks().find((row) => row.id === held.task.id), Date.now()), false);
const yes = releaseHeld("yes", held.chat.id);
assert.equal(yes.allow, true);
assert.equal(yes.status, "open");

stopBoard();
stopLaya();

if (!process.argv.includes("--clock")) {
  console.log("board intervals ok");
  process.exit(0);
}

for (const task of listTasks()) saveTask({ id: task.id, status: "done" });
const start = Date.now();
const minuteBot = saveBot({ name: "Minute", title: "Minute", role: "Answer on time.", pack: "host" });
const slowBot = saveBot({ name: "Slow", title: "Slow", role: "Answer on time.", pack: "host" });
const minute = saveTask({
  title: "Reply with the single word PONG",
  goal: "Reply with the single word PONG",
  every: 1,
  botId: minuteBot.id,
  ranAt: start,
});
const slow = saveTask({
  title: "Reply with the single word PING",
  goal: "Reply with the single word PING",
  every: 3,
  botId: slowBot.id,
  ranAt: start,
});
const hits = [];
const clockRun = async (job) => {
  const word = job.task.id === minute.id ? "PONG" : "PING";
  hits.push({ id: job.task.id, at: Date.now() - start, word });
  return { assistant: `Still working.\n${word}` };
};

let pending = Promise.resolve();
const clock = setInterval(() => {
  pending = tick(clockRun).catch((error) => console.error(error));
}, 5_000);

await new Promise((resolve) => setTimeout(resolve, 190_000));
clearInterval(clock);
await pending;
stopBoard();
stopLaya();

const minuteHits = hits.filter((row) => row.id === minute.id);
const slowHits = hits.filter((row) => row.id === slow.id);
assert.ok(minuteHits.length >= 3, `1-minute task ran ${minuteHits.length} times`);
assert.equal(slowHits.length, 1, `3-minute task ran ${slowHits.length} times`);
assert.ok(minuteHits.every((row) => row.word === "PONG"));
assert.equal(slowHits[0].word, "PING");
assert.ok(minuteHits[0].at >= 55_000 && minuteHits[0].at <= 75_000);
assert.ok(slowHits[0].at >= 170_000 && slowHits[0].at <= 190_000);
for (let i = 1; i < minuteHits.length; i += 1) {
  const gap = minuteHits[i].at - minuteHits[i - 1].at;
  assert.ok(gap >= 50_000 && gap <= 75_000, `gap ${gap}`);
}
assert.equal(listTasks().find((row) => row.id === minute.id).goal, "Reply with the single word PONG");
console.log("board clock ok", { minute: minuteHits.map((row) => row.at), slow: slowHits.map((row) => row.at) });
