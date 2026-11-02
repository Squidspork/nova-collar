import assert from "node:assert/strict";
import { test } from "node:test";
import { applyToolDelta, finishToolCalls } from "../src/main/tool-calls.js";

test("argument deltas preserve repeated digits, whitespace, braces and exact file contents", () => {
  for (const [parts, expected] of [
    [['{"n":1', '0', '0}'], { n: 100 }],
    [['{"content":"', 'ha', 'ha', ' ', ' ', '"}'], { content: "haha  " }],
    [['{"object":{"nested":{', '}', '}', '}'], { object: { nested: {} } }],
  ]) {
    const calls = new Map();
    parts.forEach((arguments_, i) => applyToolDelta(calls, { index: 0, ...(i === 0 ? { id: "call" } : {}), function: { ...(i === 0 ? { name: "host_file_write" } : {}), arguments: arguments_ } }));
    assert.deepEqual(JSON.parse(finishToolCalls(calls)[0].function.arguments), expected);
  }
});

test("interleaved calls retain independent delta streams", () => {
  const calls = new Map();
  for (const [index, name, args] of [[0, "host_file_read", '{"path":"a'], [1, "host_file_read", '{"path":"b'], [0, "", 'a"}'], [1, "", 'b"}']]) {
    applyToolDelta(calls, { index, id: `c${index}`, function: { name, arguments: args } });
  }
  assert.deepEqual(finishToolCalls(calls).map(row => JSON.parse(row.function.arguments).path), ["aa", "bb"]);
});
