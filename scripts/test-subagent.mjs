import assert from "node:assert/strict";
import { test } from "node:test";
import { runSubagent, toolsForPack } from "../src/main/subagent.js";

const cfg = { model: "local-3.8", hnlSearch: false };
const task = { pack: "host", task: "Inspect the host and report the result." };
const call = (name = "host_facts", id = "one", args = "{}") => ({ id, type: "function", function: { name, arguments: args } });

test("a completed helper needs successful tools and a completed factual summary", async () => {
  let rounds = 0;
  const result = await runSubagent(task, cfg, { complete: async () => ++rounds === 1 ? { content: "", tool_calls: [call()] } : { content: "Host inspected.", tool_calls: [] } }, { execute: async () => ({ ok: true, text: "system evidence" }) });
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.used, ["host_facts"]);
  for (const pack of ["host", "hnl", "computer", "analysis"]) assert.ok(toolsForPack(pack, cfg).every((row) => !["subagent", "ask_user", "pack_task"].includes(row.function.name)));
});

test("an earlier failed tool survives later successes and optimistic prose", async () => {
  let round = 0;
  const result = await runSubagent(task, cfg, { complete: async () => ++round === 1 ? { content: "", tool_calls: [call("host_facts", "a"), call("host_disk", "b")] } : { content: "Everything passed.", tool_calls: [] } }, { execute: async (name) => name === "host_facts" ? { ok: false, error: "inspection failed" } : { ok: true, text: "disk okay" } });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /inspection failed/);
});

test("disallowed and malformed calls get paired error receipts without gaining authority", async () => {
  let round = 0, executed = 0, transcript;
  const result = await runSubagent(task, cfg, {
    allowedTools: ["host_facts"],
    complete: async (messages, _cfg, _delta, _signal, extra) => {
      assert.deepEqual(extra.tools.map((row) => row.function.name), ["host_facts"]);
      if (++round === 1) return { content: "", tool_calls: [call("host_file_write", "denied"), call("subagent", "recursive"), call("host_facts", "invalid", "{")] };
      transcript = structuredClone(messages);
      return { content: "Done.", tool_calls: [] };
    },
  }, { execute: async () => { executed++; return { ok: true }; } });
  assert.equal(result.ok, false);
  assert.equal(executed, 0);
  const assistant = transcript.find((row) => row.role === "assistant");
  assert.deepEqual(transcript.filter((row) => row.role === "tool").map((row) => row.tool_call_id), assistant.tool_calls.map((row) => row.id));
  assert.equal(result.failures.length, 3);
});

test("cancellation between tools never executes the rest of a batch", async () => {
  const controller = new AbortController(), events = [], names = [];
  const result = await runSubagent(task, cfg, {
    signal: controller.signal, emit: (event) => events.push(event),
    complete: async () => ({ content: "", tool_calls: [call("host_facts", "a"), call("host_disk", "b")] }),
  }, { execute: async (name) => { names.push(name); controller.abort(); return { ok: true, text: "first receipt" }; } });
  assert.equal(result.ok, false);
  assert.equal(result.status, "cancelled");
  assert.deepEqual(names, ["host_facts"]);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 2);
  assert.match(result.notes[1], /not executed/);
});

test("cancellation during tool-start notification prevents that tool executing", async () => {
  const controller = new AbortController(); let executed = 0;
  const result = await runSubagent(task, cfg, {
    signal: controller.signal, emit: (event) => { if (event.type === "tool") controller.abort(); },
    complete: async () => ({ content: "", tool_calls: [call()] }),
  }, { execute: async () => { executed++; return { ok: true }; } });
  assert.equal(result.status, "cancelled");
  assert.equal(executed, 0);
});

test("held actions stop later tools and remain failures", async () => {
  let executed = 0;
  const result = await runSubagent(task, cfg, { complete: async () => ({ content: "", tool_calls: [call("host_facts", "a"), call("host_disk", "b")] }) }, { execute: async () => { executed++; return { ok: false, held: true, error: "Denied by user" }; } });
  assert.equal(result.ok, false);
  assert.equal(result.held, true);
  assert.equal(executed, 1);
  assert.match(result.notes[1], /not executed/);
});

test("round and per-batch caps report incomplete rather than successful work", async () => {
  let executed = 0;
  const capped = await runSubagent(task, cfg, { complete: async () => ({ content: "", tool_calls: [call()] }) }, { execute: async () => { executed++; return { ok: true }; } });
  assert.equal(capped.ok, false);
  assert.equal(capped.status, "incomplete");
  assert.equal(executed, 3);
  executed = 0;
  const wide = await runSubagent(task, cfg, { complete: async () => ({ content: "", tool_calls: Array.from({ length: 9 }, (_, i) => call("host_facts", `call-${i}`)) }) }, { execute: async () => { executed++; return { ok: true }; } });
  assert.equal(wide.ok, false);
  assert.equal(wide.status, "incomplete");
  assert.equal(executed, 0);
  assert.equal(wide.failures.length, 9);
});

test("empty or truncated summaries and model failures cannot pass", async () => {
  for (const final of [{ content: "", tool_calls: [] }, { content: "Partial", tool_calls: [], finish_reason: "length" }]) {
    let round = 0;
    const result = await runSubagent(task, cfg, { complete: async () => ++round === 1 ? { content: "", tool_calls: [call()] } : final }, { execute: async () => ({ ok: true }) });
    assert.equal(result.ok, false);
    assert.equal(result.status, "incomplete");
  }
  const failed = await runSubagent(task, cfg, { complete: async () => { throw new Error("model unavailable"); } });
  assert.equal(failed.status, "failed");
});

test("helpers preserve parent role, remote permission and recursion boundaries", async () => {
  let called = false;
  const complete = async () => { called = true; return { content: "", tool_calls: [] }; };
  assert.equal((await runSubagent(task, cfg, { role: "phone", complete })).ok, false);
  assert.equal((await runSubagent(task, cfg, { depth: 1, complete })).ok, false);
  assert.equal((await runSubagent({ ...task, pack: "computer" }, cfg, { complete })).ok, false);
  assert.equal(called, false);
  let round = 0;
  const result = await runSubagent({ ...task, pack: "computer" }, cfg, {
    role: "phone", remote: false, allowedTools: ["computer_exec"],
    complete: async () => ++round === 1 ? { content: "", tool_calls: [call("computer_exec")] } : { content: "Remote inspected.", tool_calls: [] },
  }, { execute: async (_name, _args, _cfg, ctx) => {
    assert.equal(ctx.role, "phone"); assert.equal(ctx.remote, false); assert.equal(ctx.depth, 1);
    assert.deepEqual(ctx.allowedTools, ["computer_exec"]);
    return { ok: true };
  } });
  assert.equal(result.ok, true);
});
