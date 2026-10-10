import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "collar-history-"));
process.env.NOVAPUP_HOME = home;
const { saveKeys } = await import("../src/main/config.js");
const { runTurn } = await import("../src/main/agent.js");
const { toolDefs } = await import("../src/main/tools.js");
const { cleanModelHistory } = await import("../src/main/model-history.js");
const { bootSessions, readSession, saveSession } = await import("../src/main/sessions.js");
const originalFetch = globalThis.fetch;
const source = join(home, "fixture.txt");
writeFileSync(source, "COLLAR_HISTORY_742");
const sse = (deltas) => new Response(deltas.map(delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("") + "data: [DONE]\n\n");
try {
  saveKeys({ chatUrl: "https://models.example/v1", chatKey: "test-key", model: "MiMo-V2.6-Flash-RL-MLX-4bit-MTP" });
  let rounds = 0;
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith("/chat/completions")) throw new Error("No network in this test");
    const body = JSON.parse(init.body);
    rounds += 1;
    if (rounds === 1) return sse([
      { reasoning_content: "Read the file first. " },
      { reasoning_content: "Then report the exact marker." },
      { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "host_file_read", arguments: JSON.stringify({ path: source }) } }] },
    ]);
    assert.equal(rounds, 2, "no unexpected repair loop");
    const assistant = body.messages.find(row => row.tool_calls?.length);
    assert.equal(assistant.reasoning_content, "Read the file first. Then report the exact marker.");
    assert.equal(body.messages.at(-1).tool_call_id, "call_read");
    assert.match(body.messages.at(-1).content, /COLLAR_HISTORY_742/);
    return sse([{ reasoning_content: "The marker was read successfully." }, { content: "COLLAR_HISTORY_742" }]);
  };
  const result = await runTurn([], `Read ${source} and tell me its exact contents.`, () => {}, AbortSignal.timeout(15000), {
    pack: "host", tools: toolDefs().filter(tool => tool.function.name === "host_file_read"),
  });
  assert.equal(rounds, 2);
  assert.equal(result.assistant, "COLLAR_HISTORY_742");
  assert.equal(result.messages.at(-1).reasoning_content, "The marker was read successfully.");
  const { session } = bootSessions();
  saveSession(session.id, [{ role: "user", content: "Read fixture" }, { role: "assistant", content: result.assistant }], { modelMessages: result.messages });
  const reopened = readSession(session.id);
  assert.deepEqual(reopened.modelMessages, cleanModelHistory(result.messages), "wire transcript survives a chat reload");
  assert.ok(reopened.modelMessages.some(row => row.role === "tool" && row.tool_call_id === "call_read"));
  assert.ok(!("reasoning_content" in reopened.messages.at(-1)), "visible timeline remains separate");
  const clipped = cleanModelHistory([...result.messages, { role: "user", content: "Continue" }, { role: "assistant", content: "Done" }], { maxTurns: 1 });
  assert.deepEqual(clipped.map(row => row.role), ["user", "assistant"], "trimming removes a whole old tool chain");
  assert.ok(!cleanModelHistory([{ role: "user", content: "Read" }, result.messages.find(row => row.tool_calls?.length) ]).at(-1).tool_calls, "interrupted calls are not replayed without results");
  const media = [{ role: "user", content: [{ type: "text", text: "Read this screenshot" }, { type: "image_url", image_url: { url: "data:image/png;base64,TEST", detail: "high" } }] }];
  assert.deepEqual(cleanModelHistory(media), media, "screenshot history remains multimodal");
  const multi = cleanModelHistory([{ role: "user", content: "Inspect both" }, { role: "assistant", content: "", tool_calls: ["one", "two"].map(id => ({ id, type: "function", function: { name: "screen", arguments: "{}" } })) }, { role: "tool", tool_call_id: "one", content: "first" }, ...media, { role: "tool", tool_call_id: "two", content: "second" }]);
  assert.deepEqual(multi.map(row => row.role), ["user", "assistant", "tool", "tool", "user"], "screenshots follow the complete tool-result group");
  assert.equal(multi[1].tool_calls.length, 2);
  assert.equal(readFileSync(source, "utf8"), "COLLAR_HISTORY_742");
  // A recoverable tool error can produce a no-tool answer before the harness
  // asks for a retry. Its reasoning must survive that path as well.
  let repairRounds = 0;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    repairRounds += 1;
    if (repairRounds === 1) return sse([{ reasoning_content: "Try the requested file." }, { tool_calls: [{ index: 0, id: "missing", type: "function", function: { name: "host_file_read", arguments: JSON.stringify({ path: source + ".missing" }) } }] }]);
    if (repairRounds === 2) return sse([{ reasoning_content: "The path failed; correct it before retrying." }, { content: "The file could not be read." }]);
    if (repairRounds === 3) {
      assert.ok(body.messages.some(row => row.role === "assistant" && row.reasoning_content === "The path failed; correct it before retrying."), "repair nudge retains the prior reasoning");
      return sse([{ reasoning_content: "Read the correct path now." }, { tool_calls: [{ index: 0, id: "fixed", type: "function", function: { name: "host_file_read", arguments: JSON.stringify({ path: source }) } }] }]);
    }
    assert.equal(repairRounds, 4);
    return sse([{ content: "COLLAR_HISTORY_742" }]);
  };
  const repaired = await runTurn([], `Read ${source} and tell me its exact contents.`, () => {}, AbortSignal.timeout(15000), { pack: "host", tools: toolDefs().filter(tool => tool.function.name === "host_file_read") });
  assert.equal(repaired.assistant, "COLLAR_HISTORY_742");
  assert.equal(repairRounds, 4);
  console.log("PASS model history: reasoning across tool steps, final reasoning, persistence, complete-chain trimming");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(home, { recursive: true, force: true });
}
