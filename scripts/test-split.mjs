import assert from "node:assert/strict";
import { HASH_ROUNDS, lanesFrom, pathBetween, PLAN_ROUNDS, planDone, shortModel, splitLabel } from "../src/main/split.js";

const chat = {
  url: "https://ai.hungrynova.com/v1",
  model: "HNL27b",
  key: "chat-key",
  local: false,
};
const cfg = {
  fastUrl: "http://127.0.0.1:8134/v1",
  fastModel: "/Users/example-user/Models/nova-pup-4b-collar",
  thinkUrl: "",
  thinkModel: "",
  chatKey: "chat-key",
  toolsKey: "",
};

const lanes = lanesFrom(cfg, chat);
assert.equal(lanes.on, true);
assert.equal(lanes.fast.local, true);
assert.equal(lanes.fast.model, cfg.fastModel);
assert.equal(lanes.think.model, "HNL27b");
assert.equal(lanes.think.local, false);
assert.deepEqual(splitLabel(lanes), {
  on: true,
  fast: "nova-pup-4b-collar",
  think: "HNL27b",
});
assert.equal(shortModel("HNL27b"), "HNL27b");

const off = lanesFrom({ ...cfg, fastUrl: "", fastModel: "" }, chat);
assert.equal(off.on, false);

const same = lanesFrom({
  ...cfg,
  fastUrl: "https://ai.hungrynova.com/v1",
  fastModel: "HNL27b",
}, chat);
assert.equal(same.on, false);

assert.equal(pathBetween({}), "fast");
assert.equal(pathBetween({ stuck: true }), "hash");
assert.equal(pathBetween({ stuck: true, hashes: 1 }), "hash");
assert.equal(pathBetween({ stuck: true, hashes: HASH_ROUNDS }), "fast");
assert.equal(pathBetween({ passed: true }), "hash");
assert.equal(pathBetween({ passed: true, hashes: HASH_ROUNDS }), "fast");

assert.equal(pathBetween({ deep: true }), "plan");
assert.equal(pathBetween({ deep: true, planned: true }), "fast");
assert.equal(pathBetween({ deep: true, planned: true, stuck: true }), "hash");

assert.equal(pathBetween({ answer: true }), "answer");
assert.equal(pathBetween({ answer: true, deep: true }), "answer");

assert.equal(planDone(["host_file_read"], 1), false);
assert.equal(planDone(["host_file_read"], PLAN_ROUNDS), true);
assert.equal(planDone(["host_file_read", "host_file_write"], 1), true);
assert.equal(planDone([], 1), true);

console.log("split ok");
