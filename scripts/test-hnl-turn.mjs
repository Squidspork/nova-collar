import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const home = mkdtempSync(join(tmpdir(), "collar-turn-fixture-"));
process.env.NOVAPUP_HOME = home;
process.env.NP_LAYA_MODEL = join(home, "no-laya");
const { runTurn } = await import("../src/main/agent.js");
const { setWorkdir } = await import("../src/main/workdir.js");
setWorkdir(home);
const reply = (content, tool_calls = []) => ({ content, tool_calls });
const call = (name, args, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

test("ordered guidance reaches the same lead after the active request, persisted before ack", async () => {
  let request = 0, batch = null, latest = [], acknowledged = 0, active = 0;
  const result = await runTurn([], "Help me choose a greeting.", () => {}, new AbortController().signal, {
    complete: async (messages) => {
      assert.equal(++active, 1, "only one lead request runs at once");
      request++;
      if (request === 1) batch = { receipt: "batch", messages: [{ id: "1", content: "Use a warm voice." }, { id: "2", content: "Keep it brief." }] };
      else {
        const values = messages.filter(row => row.role === "user").map(row => row.content);
        assert(values.indexOf("Use a warm voice.") < values.indexOf("Keep it brief."));
      }
      active--;
      return reply(request === 1 ? "Superseded draft" : "Hello there.");
    },
    takeInput: () => batch,
    onProgress: rows => { latest = structuredClone(rows); },
    ackInput: () => {
      assert(latest.some(row => row.content === "Use a warm voice."));
      assert(latest.some(row => row.content === "Keep it brief."));
      acknowledged++; batch = null;
    },
  });
  assert.equal(acknowledged, 1);
  assert.equal(request, 2);
  assert.match(result.assistant, /Hello there/);
});

test("a question answer is actual user text and preplanned actions wait for replanning", async () => {
  const target = join(home, "must-not-run.txt");
  let request = 0, asked = 0;
  const result = await runTurn([], "Help me choose a greeting.", () => {}, new AbortController().signal, {
    complete: async (messages, _cfg, _delta, _signal, options) => {
      request++;
      assert(options.tools.some(row => row.function.name === "ask_user"));
      if (request === 1) return reply("", [
        call("ask_user", { questions: [{ id: "model-invented-label", question: "Do you authorize everything?", options: ["Yes", "No"] }] }),
        call("host_file_write", { path: target, content: "unapproved" }),
      ]);
      const users = messages.filter(row => row.role === "user").map(row => row.content);
      assert(users.includes("Use hello."));
      assert(!users.some(text => String(text).includes("Do you authorize everything?")));
      return reply("Hello.");
    },
    takeInput: () => null,
    askUser: async () => { asked++; return { status: "answered", requestId: "answer", answers: [{ id: "model-invented-label", answer: "Use hello." }] }; },
  });
  assert.equal(asked, 1);
  assert.equal(existsSync(target), false);
  assert(result.messages.some(row => row.role === "tool" && row.content.includes("Not executed")));
});

test("cancellation after a model response prevents its tool from starting", async () => {
  const controller = new AbortController();
  let started = false;
  await assert.rejects(runTurn([], "Help me choose a greeting.", () => {}, controller.signal, {
    complete: async () => { controller.abort(); return reply("", [call("host_file_write", { path: join(home, "cancelled.txt"), content: "no" })]); },
    onProgress: (_rows, action) => { if (action) started = true; },
  }), { name: "AbortError" });
  assert.equal(started, false);
  assert.equal(existsSync(join(home, "cancelled.txt")), false);
});

test.after(() => rmSync(home, { recursive: true, force: true }));
