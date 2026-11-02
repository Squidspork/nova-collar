import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_HOME } from "./config.js";

const MAX_MESSAGES = 100;
const MAX_TEXT = 24_000;
const MAX_BYTES = 8_000_000;
const copy = (value) => structuredClone(value);
const abortError = () => Object.assign(new Error("Question cancelled."), { name: "AbortError" });
const leadBusy = () => Object.assign(new Error("Another Nova Collar process owns the active lead for this profile. Use that window or wait until it finishes."), { code: "LEAD_BUSY" });

function readLock(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.token !== "string" || !value.token) throw new Error("Invalid lead lock.");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // A just-created lock may still be getting its first bytes. Never remove an
    // unknown owner's lock merely because its contents cannot yet be read.
    throw leadBusy();
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function createLock(path) {
  const lease = { pid: process.pid, token: randomUUID() };
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(lease)); fsyncSync(descriptor);
    return lease;
  } catch (error) {
    if (descriptor !== undefined) { try { unlinkSync(path); } catch { /* preserve original write error */ } }
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function releaseLock(path, lease) {
  if (!lease) return;
  const owner = readLock(path);
  if (owner?.pid === lease.pid && owner.token === lease.token) unlinkSync(path);
}

function takeLock(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const recovery = `${path}.recovery`;
  let gate;
  try {
    // A stale recovery gate is itself a pid/token lock and can be recovered
    // using the same protocol. A live gate always blocks competing starts.
    if (existsSync(recovery)) gate = takeLock(recovery);
    try { return createLock(path); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const previous = readLock(path);
    if (previous && alive(previous.pid)) throw leadBusy();
    // Serialize stale cleanup, then re-read: another cleaner cannot unlink a
    // newly acquired live lead lock using its earlier dead-pid observation.
    if (!gate) gate = takeLock(recovery);
    const current = readLock(path);
    if (current && alive(current.pid)) throw leadBusy();
    if (current) unlinkSync(path);
    try { return createLock(path); }
    catch (error) { if (error.code === "EEXIST") throw leadBusy(); throw error; }
  } finally { if (gate) releaseLock(recovery, gate); }
}

function atomicWrite(file, state) {
  const text = JSON.stringify(state, null, 2);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Saved conversation input is full. Resume or clear pending work first.");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function nonempty(value, limit, label) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`Invalid ${label}.`);
  return value.trim();
}

export function validateQuestions(args) {
  if (!args || Object.keys(args).some((key) => key !== "questions") || !Array.isArray(args.questions)
    || args.questions.length < 1 || args.questions.length > 3) throw new Error("Ask between one and three questions.");
  const ids = new Set();
  return args.questions.map((row) => {
    if (!row || Object.keys(row).some((key) => !["id", "question", "options"].includes(key))) throw new Error("Invalid question fields.");
    const id = nonempty(row.id, 64, "question id");
    const question = nonempty(row.question, 600, "question text");
    if (ids.has(id)) throw new Error("Question ids must be unique.");
    ids.add(id);
    let options = [];
    if (row.options !== undefined) {
      if (!Array.isArray(row.options) || row.options.length < 2 || row.options.length > 5) throw new Error("Provide two to five suggestions, or omit them.");
      options = row.options.map((value) => nonempty(value, 160, "suggestion"));
      if (new Set(options).size !== options.length) throw new Error("Suggestions must be distinct.");
    }
    return { id, question, options };
  });
}

function validateState(raw) {
  if (!raw || raw.version !== 1 || !raw.sessions || typeof raw.sessions !== "object" || Array.isArray(raw.sessions)) throw new Error("Saved conversation input is invalid; preserve it for recovery.");
  const ids = new Set();
  for (const [sessionId, session] of Object.entries(raw.sessions)) {
    nonempty(sessionId, 200, "session id");
    if (!session || !Array.isArray(session.messages) || session.messages.length > MAX_MESSAGES) throw new Error("Invalid saved input queue.");
    for (const message of session.messages) {
      nonempty(message.id, 200, "message id");
      nonempty(message.content, MAX_TEXT, "message");
      if (ids.has(message.id) || !["queued", "paused"].includes(message.state) || !Number.isFinite(message.created)) throw new Error("Invalid saved queue message.");
      ids.add(message.id);
    }
    if (session.question) {
      nonempty(session.question.id, 200, "question request id");
      if (!Array.isArray(session.question.questions)) throw new Error("Invalid saved questions.");
      validateQuestions({ questions: session.question.questions.map((question) => question?.options?.length === 0
        ? { ...question, options: undefined } : question) });
      if (!["waiting", "answered", "interrupted"].includes(session.question.state)) throw new Error("Invalid saved question status.");
    }
  }
  return raw;
}

/** One lead turn owns the coordinator. Pending input is separate from chat/model history.
 * peek() reserves a stable snapshot; persist its messages in BOTH histories before ack().
 * Include row ids in persisted history metadata and reconcile() them after a crash.
 * No queue acknowledgement, question answer, or restore ever reruns an action.
 */
export function createConversationCoordinator({ file = join(APP_HOME, "conversation-state.json"), now = Date.now,
  id = randomUUID, onChange = () => {}, storage, lock = !storage } = {}) {
  const read = storage?.read || (() => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, sessions: {} });
  const write = storage?.write || ((value) => atomicWrite(file, value));
  let state = validateState(copy(read()));
  let active = null;
  let waiter = null;
  const lockFile = `${file}.lock`;
  let lease = null;

  function refresh() { state = validateState(copy(read())); }
  function recover(next) {
    let changed = false;
    for (const saved of Object.values(next.sessions)) {
      for (const message of saved.messages) if (message.state === "queued") { message.state = "paused"; message.reason = "restarted"; changed = true; }
      if (saved.question?.state === "waiting") { saved.question.state = "interrupted"; changed = true; }
    }
    return changed;
  }

  function sessionKey(value) { return nonempty(value, 200, "session id"); }
  function row(next, sessionId) {
    // A null-prototype map and own-property checks keep user supplied ids inert.
    if (!Object.hasOwn(next.sessions, sessionId)) Object.defineProperty(next.sessions, sessionId, { value: { messages: [] }, enumerable: true, writable: true, configurable: true });
    return next.sessions[sessionId];
  }
  function current(token) {
    if (!active || token !== active.token) throw new Error("This lead turn is no longer active.");
    return active;
  }
  function snapshot(sessionId) {
    sessionId = sessionKey(sessionId);
    const saved = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : { messages: [] };
    return copy({ active: active?.sessionId === sessionId, paused: saved.messages.some((message) => message.state === "paused") || (active?.sessionId === sessionId && active.paused),
      pending: saved.messages, question: saved.question?.state === "waiting" && waiter?.requestId === saved.question.id ? saved.question : null,
      answeredQuestion: saved.question?.state === "answered" ? saved.question : null,
      interruptedQuestion: saved.question?.state === "interrupted" ? saved.question : null });
  }
  function announce(sessionId) { try { onChange(snapshot(sessionId), sessionId); } catch { /* storage is committed; a UI listener cannot roll it back */ } }
  function commit(change, sessionId) {
    const temporary = lock && !lease ? takeLock(lockFile) : null;
    try {
      if (temporary) refresh();
      const next = copy(state);
      const result = change(next);
      write(next); // Never expose a mutation the durable write did not accept.
      state = next;
      if (sessionId) announce(sessionId);
      return result;
    } finally { if (temporary) releaseLock(lockFile, temporary); }
  }
  function cancelWaiter(sessionId) {
    if (waiter?.sessionId !== sessionId) return;
    const waiting = waiter; waiter = null;
    waiting.cleanup(); waiting.reject(abortError());
  }

  // Launching the app is never permission to resume its previous work.
  let recoveryLease;
  try {
    if (lock) { recoveryLease = takeLock(lockFile); refresh(); }
    const next = copy(state);
    if (recover(next)) { write(next); state = next; }
  } catch (error) { if (error.code !== "LEAD_BUSY") throw error; }
  finally { if (recoveryLease) releaseLock(lockFile, recoveryLease); }

  return {
    snapshot,
    pending: (sessionId) => snapshot(sessionId).pending,
    start(sessionId, { resume = false } = {}) {
      sessionId = sessionKey(sessionId);
      if (active) throw new Error("A lead turn is already working. Send guidance to its queue or stop it first.");
      if (lock) lease = takeLock(lockFile);
      try {
        if (lock) {
          refresh();
          const next = copy(state);
          if (recover(next)) { write(next); state = next; }
        }
        if (!resume && snapshot(sessionId).paused) throw new Error("Pending input is paused. Resume it explicitly.");
        const token = id();
        if (resume) commit((next) => {
          for (const message of row(next, sessionId).messages) { message.state = "queued"; delete message.reason; }
        });
        active = { sessionId, token, batch: null, paused: false };
        announce(sessionId);
        return token;
      } catch (error) { if (lease) releaseLock(lockFile, lease); lease = null; throw error; }
    },
    enqueue(sessionId, content) {
      sessionId = sessionKey(sessionId);
      content = nonempty(content, MAX_TEXT, "message");
      const message = { id: id(), content, created: now(), state: active?.sessionId === sessionId && !active.paused ? "queued" : "paused" };
      if (message.state === "paused") message.reason = "awaiting-resume";
      commit((next) => {
        const saved = row(next, sessionId);
        if (saved.messages.length >= MAX_MESSAGES) throw new Error("This chat already has 100 pending messages. Resume or clear them first.");
        if (Object.values(next.sessions).some((session) => session.messages.some((entry) => entry.id === message.id))) throw new Error("Duplicate message id.");
        saved.messages.push(message);
      }, sessionId);
      return copy(message);
    },
    peek(token) {
      const run = current(token);
      if (run.paused) return null;
      if (run.batch) return copy(run.batch);
      const messages = snapshot(run.sessionId).pending.filter((message) => message.state === "queued");
      if (!messages.length) return null;
      run.batch = { receipt: id(), messages };
      return copy(run.batch);
    },
    ack(token, receipt) {
      const run = current(token);
      if (run.paused || !run.batch || run.batch.receipt !== receipt) throw new Error("Stale or cancelled input receipt.");
      const ids = new Set(run.batch.messages.map((message) => message.id));
      commit((next) => { row(next, run.sessionId).messages = row(next, run.sessionId).messages.filter((message) => !ids.has(message.id)); }, run.sessionId);
      run.batch = null;
    },
    reconcile(sessionId, incorporatedIds) {
      sessionId = sessionKey(sessionId);
      if (active?.sessionId === sessionId) throw new Error("Reconcile saved input before starting the lead.");
      if (!Array.isArray(incorporatedIds) || incorporatedIds.some((value) => typeof value !== "string")) throw new Error("Provide ids actually persisted with chat history.");
      const ids = new Set(incorporatedIds);
      commit((next) => { row(next, sessionId).messages = row(next, sessionId).messages.filter((message) => !ids.has(message.id)); }, sessionId);
    },
    pause(token, reason = "stopped") {
      const run = current(token);
      run.paused = true; run.batch = null;
      try {
        commit((next) => {
          const saved = row(next, run.sessionId);
          for (const message of saved.messages) { message.state = "paused"; message.reason = String(reason).slice(0, 80); }
          if (saved.question?.state === "waiting") saved.question.state = "interrupted";
        });
      } finally { cancelWaiter(run.sessionId); announce(run.sessionId); }
    },
    finish(token, { reason = "unfinished" } = {}) {
      const run = current(token);
      try { this.pause(token, reason); }
      finally {
        active = null;
        try { if (lease) releaseLock(lockFile, lease); }
        finally { lease = null; announce(run.sessionId); }
      }
    },
    ask(token, args, { signal } = {}) {
      const run = current(token);
      if (run.paused || signal?.aborted) return Promise.reject(abortError());
      if (waiter) return Promise.reject(new Error("Answer the waiting question first."));
      const questions = validateQuestions(args);
      const request = { id: id(), questions, created: now(), state: "waiting" };
      // Keep promise state ready before announcing the question to the UI.
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      // Cancellation must still settle the awaiter if persisting its interrupted
      // receipt fails. The untouched on-disk waiting receipt pauses on restart.
      const cancelled = () => { try { this.cancelQuestion(run.sessionId, request.id); } catch { /* no action may continue after abort */ } };
      waiter = { sessionId: run.sessionId, requestId: request.id, resolve, reject,
        cleanup: () => signal?.removeEventListener("abort", cancelled) };
      try {
        commit((next) => { row(next, run.sessionId).question = request; });
      } catch (error) { waiter = null; reject(error); return promise; }
      signal?.addEventListener("abort", cancelled, { once: true });
      if (signal?.aborted) cancelled();
      announce(run.sessionId);
      return promise;
    },
    answer(sessionId, requestId, answers) {
      sessionId = sessionKey(sessionId);
      const saved = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId] : null;
      const request = saved?.question;
      if (!waiter || waiter.sessionId !== sessionId || waiter.requestId !== requestId || request?.id !== requestId || request.state !== "waiting") throw new Error("That question is no longer waiting.");
      if (!Array.isArray(answers) || answers.length !== request.questions.length) throw new Error("Answer each waiting question explicitly.");
      const values = new Map();
      for (const answer of answers) {
        if (!answer || Object.keys(answer).some((key) => !["id", "answer"].includes(key)) || values.has(answer.id)) throw new Error("Invalid or repeated answer.");
        values.set(answer.id, nonempty(answer.answer, 4000, "answer"));
      }
      const submitted = request.questions.map((question) => {
        if (!values.has(question.id)) throw new Error("A waiting question has no answer.");
        return { id: question.id, answer: values.get(question.id) };
      });
      const waiting = waiter;
      commit((next) => { row(next, sessionId).question = { ...request, state: "answered", answered: now(), answers: submitted }; });
      waiter = null; waiting.cleanup();
      waiting.resolve({ status: "answered", requestId, answers: submitted });
      announce(sessionId);
      return { ok: true };
    },
    cancelQuestion(sessionId, requestId) {
      sessionId = sessionKey(sessionId);
      if (waiter?.sessionId !== sessionId || waiter.requestId !== requestId) return false;
      try { commit((next) => { row(next, sessionId).question.state = "interrupted"; }); }
      finally { cancelWaiter(sessionId); announce(sessionId); }
      return true;
    },
  };
}
