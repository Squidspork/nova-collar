import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createConversationCoordinator, validateQuestions } from "../src/main/conversation.js";

function memory() {
  let saved = { version: 1, sessions: {} }, count = 0, fail = false;
  const options = { id: () => `id-${++count}`, now: () => 123,
    storage: { read: () => structuredClone(saved), write: (value) => {
      if (fail) throw new Error("disk full");
      saved = structuredClone(value);
    } } };
  return { create: () => createConversationCoordinator(options), fail: (value) => { fail = value; } };
}

test("one lead owns ordered input; acknowledgements exclude concurrent sends", () => {
  const store = memory(), c = store.create(), run = c.start("chat");
  assert.throws(() => c.start("other"), /already working/);
  const first = c.enqueue("chat", "first"), second = c.enqueue("chat", "second");
  const batch = c.peek(run);
  assert.deepEqual(batch.messages.map((message) => message.id), [first.id, second.id]);
  c.enqueue("chat", "third");
  assert.deepEqual(c.peek(run), batch);
  assert.throws(() => c.ack(run, "old receipt"), /Stale/);
  c.ack(run, batch.receipt);
  assert.deepEqual(c.pending("chat").map((message) => message.content), ["third"]);
  assert.equal(c.peek(run).messages[0].content, "third");
});

test("stop pauses unconsumed work without releasing an active lead prematurely", () => {
  const c = memory().create(), run = c.start("chat");
  c.enqueue("chat", "keep this");
  const batch = c.peek(run);
  c.pause(run);
  assert.equal(c.peek(run), null);
  assert.throws(() => c.ack(run, batch.receipt), /cancelled/);
  assert.throws(() => c.start("chat", { resume: true }), /already working/);
  c.enqueue("chat", "sent after stop");
  c.finish(run, { reason: "stopped" });
  assert.ok(c.pending("chat").every((message) => message.state === "paused"));
  assert.throws(() => c.start("chat"), /Resume it explicitly/);
  const resumed = c.start("chat", { resume: true });
  assert.deepEqual(c.peek(resumed).messages.map((message) => message.content), ["keep this", "sent after stop"]);
  assert.throws(() => c.peek(run), /no longer active/);
});

test("restart pauses queues; persisted message ids reconcile the persist/ack crash window", () => {
  const store = memory(), before = store.create(), run = before.start("chat");
  const first = before.enqueue("chat", "already persisted"), second = before.enqueue("chat", "still pending");
  before.peek(run);
  const after = store.create();
  assert.ok(after.pending("chat").every((message) => message.state === "paused"));
  after.reconcile("chat", [first.id]);
  assert.deepEqual(after.pending("chat").map((message) => message.id), [second.id]);
});

test("a failed durable write loses no input and does not acknowledge it", () => {
  const store = memory(), c = store.create(), run = c.start("chat");
  c.enqueue("chat", "saved");
  const batch = c.peek(run);
  store.fail(true);
  assert.throws(() => c.enqueue("chat", "unsaved"), /disk full/);
  assert.throws(() => c.ack(run, batch.receipt), /disk full/);
  assert.deepEqual(c.pending("chat").map((message) => message.content), ["saved"]);
  store.fail(false);
  c.ack(run, batch.receipt);
  assert.equal(c.pending("chat").length, 0);
});

test("question suggestions are unselected; only explicit submitted words become answers", async () => {
  const c = memory().create(), run = c.start("chat");
  const promise = c.ask(run, { questions: [{ id: "choice", question: "May I delete it?", options: ["Yes", "No"] },
    { id: "detail", question: "Which directory?" }] });
  const question = c.snapshot("chat").question;
  assert.equal(Object.hasOwn(question.questions[0], "selected"), false);
  assert.throws(() => c.answer("chat", question.id, []), /each/);
  assert.throws(() => c.answer("chat", question.id, [{ id: "choice", answer: "No" }, { id: "choice", answer: "No" }]), /repeated/);
  assert.throws(() => c.answer("chat", "stale", [{ id: "choice", answer: "No" }, { id: "detail", answer: "work" }]), /no longer waiting/);
  c.answer("chat", question.id, [{ id: "detail", answer: "  work  " }, { id: "choice", answer: "Something else" }]);
  assert.deepEqual((await promise).answers, [{ id: "choice", answer: "Something else" }, { id: "detail", answer: "work" }]);
  assert.equal(c.pending("chat").length, 0, "caller persists actual user words separately; question wording never authorizes work");
  assert.equal(c.snapshot("chat").question, null);
  assert.equal(c.snapshot("chat").answeredQuestion.answers[0].answer, "Something else");
  assert.throws(() => c.answer("chat", question.id, []), /no longer waiting/);
});

test("cancellation and restart interrupt questions without re-asking or choosing", async () => {
  const store = memory(), c = store.create(), run = c.start("chat"), controller = new AbortController();
  const cancelled = c.ask(run, { questions: [{ id: "q", question: "Which one?" }] }, { signal: controller.signal });
  const rejection = assert.rejects(cancelled, { name: "AbortError" });
  controller.abort();
  await rejection;
  assert.equal(c.snapshot("chat").question, null);
  const unfinished = c.ask(run, { questions: [{ id: "next", question: "Try again?" }] });
  const after = store.create();
  assert.equal(after.snapshot("chat").question, null);
  assert.equal(after.snapshot("chat").interruptedQuestion.state, "interrupted");
  const stopped = assert.rejects(unfinished, { name: "AbortError" });
  c.finish(run);
  await stopped;
});

test("question validation is bounded, unique and independent from ordinary drafts", () => {
  assert.throws(() => validateQuestions({ questions: [] }), /one and three/);
  assert.throws(() => validateQuestions({ questions: [{ id: "a", question: "A?" }, { id: "a", question: "B?" }] }), /unique/);
  assert.throws(() => validateQuestions({ questions: [{ id: "a", question: "A?", options: ["yes", "yes"] }] }), /distinct/);
  assert.throws(() => validateQuestions({ questions: [{ id: "a", question: "A?", selected: 0 }] }), /fields/);
});

test("an aborted question settles even when storage fails; stopped input stays retained", async () => {
  const store = memory(), c = store.create(), run = c.start("chat"), controller = new AbortController();
  c.enqueue("chat", "retain this input");
  const question = c.ask(run, { questions: [{ id: "q", question: "Continue?" }] }, { signal: controller.signal });
  const rejection = assert.rejects(question, { name: "AbortError" });
  store.fail(true);
  controller.abort();
  await rejection;
  assert.equal(c.snapshot("chat").question, null);
  assert.throws(() => c.pause(run), /disk full/);
  assert.equal(c.peek(run), null, "storage failure cannot allow cancelled work to resume");
  assert.equal(c.pending("chat")[0].content, "retain this input");
  store.fail(false);
  c.finish(run);
  assert.equal(c.pending("chat")[0].state, "paused");
});

test("a later question rejects the old request id and a question with empty answers", async () => {
  const c = memory().create(), run = c.start("chat");
  const first = c.ask(run, { questions: [{ id: "q", question: "First?" }] });
  const firstId = c.snapshot("chat").question.id;
  const rejection = assert.rejects(first, { name: "AbortError" });
  c.cancelQuestion("chat", firstId);
  await rejection;
  const next = c.ask(run, { questions: [{ id: "q", question: "Second?" }] });
  const nextId = c.snapshot("chat").question.id;
  assert.notEqual(firstId, nextId);
  assert.throws(() => c.answer("chat", firstId, [{ id: "q", answer: "yes" }]), /no longer waiting/);
  assert.throws(() => c.answer("chat", nextId, [{ id: "q", answer: " " }]), /Invalid answer/);
  await assert.rejects(c.ask(run, { questions: [{ id: "other", question: "Third?" }] }), /waiting question/);
  c.answer("chat", nextId, [{ id: "q", answer: "my actual words" }]);
  assert.equal((await next).answers[0].answer, "my actual words");
});

test("full queues reject new messages without truncating already saved user input", () => {
  const c = memory().create();
  for (let i = 0; i < 100; i++) c.enqueue("chat", `message ${i}`);
  assert.throws(() => c.enqueue("chat", "one too many"), /100 pending/);
  assert.equal(c.pending("chat").length, 100);
  assert.equal(c.pending("chat")[0].content, "message 0");
  assert.throws(() => c.enqueue("other", "x".repeat(24_001)), /Invalid message/);
});

test("atomic file storage survives reopening and fails closed on corrupted data", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-conversation-")), file = join(home, "input.json");
  try {
    const c = createConversationCoordinator({ file }), run = c.start("chat");
    c.enqueue("chat", "durable");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
    const restored = createConversationCoordinator({ file });
    assert.equal(restored.pending("chat")[0].state, "queued", "a second instance must never pause a live owner's input");
    assert.throws(() => restored.start("chat", { resume: true }), { code: "LEAD_BUSY" });
    c.finish(run);
    assert.equal(createConversationCoordinator({ file }).pending("chat")[0].state, "paused");
    writeFileSync(file, "not JSON");
    assert.throws(() => createConversationCoordinator({ file }));
    assert.equal(readFileSync(file, "utf8"), "not JSON");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("session ids cannot reach an object prototype or another session queue", () => {
  const c = memory().create();
  c.enqueue("__proto__", "inert data");
  c.enqueue("constructor", "also inert");
  assert.equal(c.pending("__proto__")[0].content, "inert data");
  assert.equal(c.pending("constructor")[0].content, "also inert");
  assert.equal(c.pending("untouched").length, 0);
});

test("a separate process cannot acquire, enqueue, reconcile, or pause a live lead", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-lead-process-")), file = join(home, "input.json");
  try {
    const c = createConversationCoordinator({ file }), run = c.start("chat");
    c.enqueue("chat", "live pending input");
    const before = readFileSync(file, "utf8"), owner = readFileSync(`${file}.lock`, "utf8");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {createConversationCoordinator} from ${JSON.stringify(new URL("../src/main/conversation.js", import.meta.url).href)};
      const c=createConversationCoordinator({file:${JSON.stringify(file)}});
      assert.equal(c.pending('chat')[0].state,'queued');
      for(const action of [()=>c.start('other'),()=>c.enqueue('chat','foreign'),()=>c.reconcile('chat',[])])
        assert.throws(action,{code:'LEAD_BUSY'});
    `], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(readFileSync(`${file}.lock`, "utf8"), owner);
    c.pause(run);
    const second = createConversationCoordinator({ file });
    assert.throws(() => second.start("chat", { resume: true }), { code: "LEAD_BUSY" }, "paused work still owns the process lock");
    c.finish(run);
    const next = second.start("chat", { resume: true });
    assert.equal(second.pending("chat")[0].content, "live pending input", "new owner refreshes state under its lock");
    second.finish(next);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("dead pid locks and interrupted recovery gates recover; live and unknown locks stay intact", () => {
  const home = mkdtempSync(join(tmpdir(), "nova-lead-stale-")), file = join(home, "input.json");
  try {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    assert.equal(child.status, 0);
    const deadPid = Number(child.stdout);
    const old = { pid: deadPid, token: "previous-process" };
    writeFileSync(file, JSON.stringify({ version: 1, sessions: { chat: { messages: [{ id: "prior", content: "retained", created: 1, state: "queued" }] } } }));
    writeFileSync(`${file}.lock`, JSON.stringify(old));
    writeFileSync(`${file}.lock.recovery`, JSON.stringify({ pid: deadPid, token: "interrupted-cleaner" }));
    const c = createConversationCoordinator({ file });
    assert.equal(c.pending("chat")[0].state, "paused");
    const run = c.start("chat", { resume: true });
    const owner = JSON.parse(readFileSync(`${file}.lock`, "utf8"));
    assert.equal(owner.pid, process.pid);
    assert.notEqual(owner.token, old.token);
    c.finish(run);
    const foreign = JSON.stringify({ pid: process.pid, token: "other-live-coordinator" });
    writeFileSync(`${file}.lock`, foreign);
    assert.throws(() => createConversationCoordinator({ file }).start("chat", { resume: true }), { code: "LEAD_BUSY" });
    assert.equal(readFileSync(`${file}.lock`, "utf8"), foreign);
    writeFileSync(`${file}.lock`, "");
    assert.throws(() => createConversationCoordinator({ file }).start("chat", { resume: true }), { code: "LEAD_BUSY" });
    assert.equal(readFileSync(`${file}.lock`, "utf8"), "", "unknown lock ownership is never treated as dead");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
