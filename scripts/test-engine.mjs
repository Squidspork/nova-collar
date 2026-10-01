import { applyToolDelta, finishToolCalls, mergeName, splitToolName, knownToolNames } from "../src/main/tool-calls.js";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teammatePrompt } from "../src/main/agent.js";
import { applyScore, heuristicReview, isHot, formatIntuition, scoreTurn } from "../src/main/intuition.js";
import { admitMaster } from "../src/main/notebook.js";
import {
  censorPass,
  codeAsk,
  coverAsk,
  createHarness,
  inventedPrint,
  proofAsks,
  wrongWriteBlame,
  expectFromAsk,
  extractAsks,
  isTestPath,
  isVerifierPath,
  namedCode,
  patchVerdict,
  probePath,
  readJobSpec,
  runCommand,
  shellTargets,
  verifyCommand,
  verifyPath,
} from "../src/main/harness.js";
import { admitsUnknown, claimTokens, createGround, FACT_LAW, factAsk, folderAsk, missingClaims } from "../src/main/ground.js";
import { realToolName, toolDefs } from "../src/main/tools.js";
import { stackStep } from "../src/main/stack.js";
import { createTimeline, mergeAssistants } from "../src/main/timeline.js";
import { inferPack } from "../src/main/packs.js";

function assert(ok, label) {
  if (!ok) throw new Error(label);
  console.log(`ok  ${label}`);
}

assert(mergeName("host_file_read", "host_file_read") === "host_file_read", "repeat name is not appended");
assert(mergeName("host_fi", "host_file_read") === "host_file_read", "growing name replaces");
assert(mergeName("host_file_read", "host_fi") === "host_file_read", "shorter echo keeps long name");
assert(splitToolName("host_file_readhost_file_readbash").join(",") === "host_file_read,host_file_read,bash", "split mashed names");
assert(splitToolName("host_runmac_windows").join(",") === "host_run,mac_windows", "split host_run + mac_windows");
assert(splitToolName("not_a_tool").length === 0, "unknown mash stays empty split");
assert(knownToolNames().has("host_run") && knownToolNames().has("bash"), "known tools loaded");
assert(toolDefs().every((row) => row.function.name !== "bash" && row.function.name !== "write_file"), "aliases stay off the public tool list");
assert(!toolDefs().some((row) => ["web_search", "extract", "scrape", "docs_search"].includes(row.function.name)), "public list has no hosted search");
assert(toolDefs({ search: true }).some((row) => row.function.name === "web_search"), "search tools exist when enabled");
assert(realToolName("bash") === "host_run" && realToolName("write_file") === "host_file_write", "aliases map to host_*");
const aliasCall = new Map();
applyToolDelta(aliasCall, { index: 0, function: { name: "bash", arguments: "{\"command\":\"ps\"}" } });
assert(finishToolCalls(aliasCall)[0].function.name === "host_run", "finish rewrites bash to host_run");

const calls = new Map();
applyToolDelta(calls, { index: 0, id: "a", function: { name: "host_file_read", arguments: "" } });
applyToolDelta(calls, { index: 0, id: "a", function: { name: "host_file_read", arguments: "{\"path\"" } });
applyToolDelta(calls, { index: 0, id: "a", function: { name: "host_file_read", arguments: "{\"path\":\"x\"}" } });
const once = finishToolCalls(calls, { max: 3 });
assert(once.length === 1 && once[0].function.name === "host_file_read", "streamed repeat name is one call");
assert(once[0].function.arguments === "{\"path\":\"x\"}", "args grow instead of stacking");

const mash = new Map();
applyToolDelta(mash, { index: 0, function: { name: "host_runmac_windows", arguments: "{\"command\":\"ps\"}" } });
const split = finishToolCalls(mash, { max: 3 });
assert(split[0].function.name === "host_run" && split[0].function.arguments.includes("ps"), "first mashed tool keeps args");
assert(split[1].function.name === "mac_windows", "second mashed tool is split off");

const flood = new Map();
for (let i = 0; i < 8; i += 1) applyToolDelta(flood, { index: i, function: { name: "host_run", arguments: "{}" } });
assert(finishToolCalls(flood, { max: 3 }).length === 3, "caps parallel tools");

const sense = heuristicReview([
  { role: "user", content: "yea do not use the GO files, use the python instead" },
  { role: "assistant", content: "I was looping tools. Stopped and waiting." },
  { role: "user", content: "You stopped inferencing, are you done?" },
  { role: "step", name: "host_run", ok: true, blurb: "sed" },
  { role: "step", name: "host_run", ok: true, blurb: "sed" },
  { role: "step", name: "host_run", ok: true, blurb: "sed" },
  { role: "step", name: "host_run", ok: true, blurb: "sed" },
  { role: "step", name: "host_run", ok: true, blurb: "sed" },
  { role: "step", name: "host_run", ok: true, blurb: "sed" },
  { role: "step", name: "host_run", ok: true, blurb: "sed" },
  { role: "step", name: "host_run", ok: true, blurb: "sed" },
]);
assert(isHot([{ role: "user", content: "are you done?" }]), "hot on are-you-done");
assert(sense.friction.some((row) => /done/i.test(row)), "friction: had to ask if done");
assert(sense.next.some((row) => /status first|checkpoint/i.test(row)), "next: stop grinding");
assert(formatIntuition({ intent: "Finish fileo", next: [{ text: "Answer first", wins: 2, losses: 0, seen: 2 }], friction: [{ text: "Loop", wins: 0, losses: 0, seen: 1 }] }).includes("Intent:"), "sense formats");
assert(formatIntuition({
  intent: "Finish",
  next: [{ text: "Answer first", wins: 1, losses: 0, seen: 1 }],
  friction: [{ text: "Loop", wins: 0, losses: 0, seen: 1 }],
  misses: [{ text: "asks open: python not go", rung: "exec", flag: "ask-miss", n: 1 }],
}).includes("Last miss: exec:"), "sense carries the last verified miss");

const openMiss = scoreTurn([
  { role: "user", content: "use python not go" },
  { role: "step", name: "host_file_write", ok: true, blurb: "Wrote app.go" },
  { role: "step", name: "harness", ok: false, blurb: "asks open: python not go" },
  { role: "assistant", content: "PASS" },
]);
assert(openMiss.misses.some((row) => row.rung === "exec" && /python not go/.test(row.text)), "notebook keeps the open checklist");

const cleared = scoreTurn([
  { role: "step", name: "harness", ok: false, blurb: "compile failed" },
  { role: "step", name: "harness", ok: true, blurb: "compile ok" },
  { role: "assistant", content: "PASS py_compile" },
]);
assert(cleared.misses.length === 0, "a later harness pass clears the miss");

const lookedUp = scoreTurn([
  { role: "user", content: "Who founded Hungry Nova?" },
  { role: "step", name: "ground", ok: false, blurb: "no source this turn" },
  { role: "step", name: "web_search", ok: true, blurb: "hungry nova" },
  { role: "assistant", content: "From the page I read." },
]);
assert(!lookedUp.flags.includes("no-source"), "a later lookup clears a no-source miss");

const stuckFact = scoreTurn([
  { role: "user", content: "Who founded Hungry Nova?" },
  { role: "step", name: "ground", ok: false, blurb: "not in source: Ada Lovelace" },
  { role: "assistant", content: "Ada Lovelace founded it." },
]);
assert(stuckFact.flags.includes("ungrounded") && stuckFact.misses[0]?.rung === "evidence", "a shipped claim stays an evidence miss");

const senseDoc = {
  intent: "Finish",
  source: "seed",
  next: [{ text: "Wait for harness compile and run before claiming done.", wins: 0, losses: 0, seen: 1 }],
  friction: [{ text: "Loop", wins: 0, losses: 0, seen: 1 }],
  misses: [],
  pain: 0,
  lastPain: 0,
  streak: 0,
  turns: 0,
};
const quietSense = applyScore(senseDoc, { pain: 5, flags: ["loop"], proved: false, misses: [] });
assert(quietSense.next[0].wins === 0 && quietSense.next[0].seen === 1, "intrinsic pain does not confirm rules");
const provedSense = applyScore(senseDoc, { pain: 0, flags: [], proved: true, misses: [] });
assert(provedSense.next[0].wins === 1, "harness pass credits the proof rule");
const stringSense = applyScore({ ...senseDoc, friction: "Claimed a fix that was not on disk." }, { pain: 0, flags: [], proved: false, misses: [] });
assert(stringSense.friction.length === 1 && stringSense.friction[0].text.startsWith("Claimed"), "a friction string stays one rule");
const letterSense = applyScore({ ...senseDoc, friction: ["e", "t", "I"].map((text) => ({ text })) }, { pain: 0, flags: [], proved: false, misses: [] });
assert(letterSense.friction.length > 0 && letterSense.friction.every((row) => row.text.length >= 8), "single-letter rules from a split string are dropped");
assert(letterSense.friction.some((row) => /asked if the work was done/.test(row.text)), "an all-garbage friction list falls back to the seed rules");
assert(admitMaster(["be more creative about the goal"], ["loop"]).length === 0, "a judge cannot write law from intrinsic pain");
assert(admitMaster(["Wait for the harness compile"], ["compile-fail"]).length === 1, "a judge line has to cite the verifier");

const pain = scoreTurn([
  { role: "user", content: "fix the tui" },
  { role: "step", name: "host_file_write", ok: true, blurb: "Wrote fileo" },
  { role: "assistant", content: "Fixed." },
]);
assert(pain.flags.includes("no-proof") && pain.pain >= 3, "unverified write is pain");

const proved = scoreTurn([
  { role: "user", content: "fix the tui" },
  { role: "step", name: "host_file_write", ok: true, blurb: "Wrote fileo" },
  { role: "step", name: "harness", ok: true, blurb: "compile ok" },
  { role: "assistant", content: "PASS py_compile fileo" },
]);
assert(!proved.flags.includes("no-proof"), "harness clears no-proof");

const dir = mkdtempSync(join(tmpdir(), "np-harness-"));
writeFileSync(join(dir, "ok.py"), "x = 1\n");
writeFileSync(join(dir, "bad.py"), "def broken(\n");
const good = await verifyPath(join(dir, "ok.py"));
const bad = await verifyPath(join(dir, "bad.py"));
assert(good?.ok === true, "py_compile passes a clean file");
assert(bad?.ok === false, "py_compile catches a broken file");

assert(extractAsks("yea do not use the GO files, use the python instead").includes("python not go"), "ask: python not go");
assert(extractAsks("- pretty\n- no scroll").includes("no scroll"), "ask: no scroll");
const polite = extractAsks("Write add.py that prints 4. Use python not go. Do not use the HNL computer. Do not start a UI.");
assert(polite.includes("python not go"), "polite prompt still extracts python not go");
assert(!polite.some((row) => /do not use|do not start/i.test(row)), "do-not phrases are not fake asks");
assert(coverAsk("python not go", { paths: ["app.py"] }) === true, "python write covers stack ask");
assert(coverAsk("python not go", { paths: ["app.go"] }) === false, "go write misses python ask");
assert(isVerifierPath("/Users/me/novapup/src/main/harness.js") === true, "harness.js is a verifier");
const oldLines = Array.from({ length: 24 }, (_, i) => `keep me line ${i} extra text`).join("\n");
const newLines = Array.from({ length: 40 }, (_, i) => `brand new line ${i} extra text`).join("\n");
assert(patchVerdict(oldLines, newLines).ok === false, "rewrite is blocked");
const shortLines = Array.from({ length: 8 }, (_, i) => `totally new line ${i} extra`).join("\n");
assert(patchVerdict(oldLines, shortLines).ok === false, "short replacement of a long file is blocked");
assert(patchVerdict(oldLines, `${oldLines}\nprint('still here')\n`).ok === true, "keeping the original lines is a patch");
assert(patchVerdict("x = 1\n", "x = 2\n").ok === true, "tiny edit is a patch");

writeFileSync(join(dir, "run.py"), "print('ok-run')\n");
writeFileSync(join(dir, "crash.py"), "raise ValueError('boom')\n");
writeFileSync(join(dir, "tui.py"), "import curses\n");
const ran = await probePath(join(dir, "run.py"), "print('ok-run')\n");
const crash = await probePath(join(dir, "crash.py"), "raise ValueError('boom')\n");
const tui = await probePath(join(dir, "tui.py"), "import curses\n");
assert(ran?.ok === true, "run probe passes a clean script");
assert(crash?.ok === false, "run probe catches a traceback");
assert(tui == null, "curses files skip the run probe");
writeFileSync(join(dir, "note.js"), "console.log('electron')\n");
const mentioned = await probePath(join(dir, "note.js"), "console.log('electron')\n");
assert(mentioned?.ok === true, "the word electron still runs");
writeFileSync(join(dir, "play.js"), "const { BrowserWindow } = require('electron');\n");
const windowRun = await probePath(join(dir, "play.js"), "const { BrowserWindow } = require('electron');\n");
assert(windowRun?.ok === false && /electron|module/i.test(windowRun.error || ""), "a window file is executed, not skipped");
assert(inventedPrint("It printed FAIL: no collision.", "TypeError: Matter.Body.get is not a function") === true, "invented printout is rejected");
assert(inventedPrint("It printed PHYSICS_OK.", "PHYSICS_OK") === false, "a real printout is kept");

const stackGate = createHarness({ ask: "use python not go" });
const stackPass = await stackGate.after(
  "write_file",
  JSON.stringify({ path: join(dir, "run.py"), content: "print('ok-run')\n" }),
  { ok: true, path: join(dir, "run.py") },
);
assert(stackPass?.ok === true, "checklist passes when python is written");
assert(stackGate.debt().length === 0, "no harness debt after python write");

assert(proofAsks("Make count.py print the numbers 1 to 3").length === 0, "print the numbers is not a printed token");
assert(proofAsks("hello.py prints hello and nothing else").join() === "hello.py prints hello", "a real printed token stays");
assert(proofAsks("create hello.py that prints exactly nova-ok-42").join() === "hello.py prints nova-ok-42", "an emphasis adverb is skipped and the hyphenated literal is kept");
assert(proofAsks("count.py prints exactly 3 lines").length === 0, "an emphasis adverb before a filler stays empty");
assert(namedCode("Write add.py that prints 4. See hungrynova.com").join() === "add.py", "a write ask names its code file");
assert(namedCode("What does add.py do?").length === 0, "a question about a file owes no write");
assert(namedCode("fix harness.js").length === 0, "verifier files are not owed");
assert(codeAsk("Write hello.py that prints hello and nothing else."), "a write ask that names a code file is a code job");
assert(!codeAsk("How full is the disk on this computer?"), "a host question is not a code job");
const namedGate = createHarness({ ask: "Write add.py that prints 4 and nothing else." });
assert(namedGate.debt().includes("write and run add.py"), "a named file is owed before any write");
await namedGate.after(
  "host_file_write",
  JSON.stringify({ path: join(dir, "thinking_model_path"), content: "thinking_model_path" }),
  { ok: true, path: join(dir, "thinking_model_path") },
);
assert(namedGate.debt().includes("write and run add.py"), "a stray write does not pay the named file");
writeFileSync(join(dir, "add.py"), "print(4)\n");
const namedPass = await namedGate.after(
  "host_file_write",
  JSON.stringify({ path: join(dir, "add.py"), content: "print(4)\n" }),
  { ok: true, path: join(dir, "add.py") },
);
assert(namedPass?.ok === true && namedGate.debt().length === 0, "the named file passing clears the debt");

const missGate = createHarness({ ask: "use python not go" });
writeFileSync(join(dir, "miss.js"), "console.log(1)\n");
const stackMiss = await missGate.after(
  "write_file",
  JSON.stringify({ path: join(dir, "miss.js"), content: "console.log(1)\n" }),
  { ok: true, path: join(dir, "miss.js") },
);
assert(stackMiss?.ok === false && /asks open/i.test(stackMiss.blurb), "checklist stays open on the wrong stack");

writeFileSync(join(dir, "soft.js"), "console.log(1)\n");
const softGate = createHarness({ ask: "- ship thrust and rotation" });
const softMiss = await softGate.after(
  "write_file",
  JSON.stringify({ path: join(dir, "soft.js"), content: "console.log(1)\n" }),
  { ok: true, path: join(dir, "soft.js") },
);
assert(softMiss?.ok === false && /asks open/i.test(softMiss.blurb), "soft checklist blocks a pass");
assert(softGate.debt().some((item) => /thrust|soft\.js/.test(item)), "open soft ask stays in debt");

const pageAsk = "- A toolbar 48px tall sits on the top edge\ncheck.js prints MIX_OK after the colors mix";
assert(proofAsks(pageAsk).includes("check.js prints MIX_OK"), "a print line stays in the checklist");
writeFileSync(join(dir, "colors.js"), "export const n = 1\n");
const pageGate = createHarness({ ask: pageAsk });
const layoutMiss = await pageGate.after(
  "write_file",
  JSON.stringify({ path: join(dir, "colors.js"), content: "export const n = 1\n" }),
  { ok: true, path: join(dir, "colors.js") },
);
assert(layoutMiss?.ok === false && /asks open/i.test(layoutMiss.blurb), "the window ask stays open after the script");
assert(!pageGate.debt().some((item) => item.includes("colors.js")), "a clean script is not called a failed write");
const pageHtml = "<html><body><div class=\"toolbar\" style=\"height:48px\">48px tall sits on the top edge</div></body></html>\n";
writeFileSync(join(dir, "index.html"), pageHtml);
const page = await pageGate.after(
  "write_file",
  JSON.stringify({ path: join(dir, "index.html"), content: pageHtml }),
  { ok: true, path: join(dir, "index.html") },
);
assert(page?.ok === false && /MIX_OK|check\.js/i.test(page.detail), "the page counts and the print proof stays open");
writeFileSync(join(dir, "check.js"), "console.log('MIX_OK')\n");
const printed = await pageGate.after(
  "write_file",
  JSON.stringify({ path: join(dir, "check.js"), content: "console.log('MIX_OK')\n" }),
  { ok: true, path: join(dir, "check.js") },
);
assert(printed?.ok === true, "the page and the printed check can pass together");
assert(pageGate.debt().length === 0, "covered page leaves no harness debt");
assert(wrongWriteBlame("host file write failed.", [{ name: "host_file_write", ok: true }]) === true, "a succeeded write is not a failure");
assert(wrongWriteBlame("host file write failed.", [{ name: "host_file_write", ok: false }]) === false, "a real write failure stays a failure");

const old = Array.from({ length: 24 }, (_, i) => `alpha line ${i} extra text`).join("\n");
const rewriteGate = createHarness();
rewriteGate.note("read_file", { path: join(dir, "run.py") }, { ok: true, path: join(dir, "run.py"), text: old });
const blocked = await rewriteGate.after(
  "write_file",
  JSON.stringify({ path: join(dir, "run.py"), content: Array.from({ length: 40 }, (_, i) => `beta line ${i} extra text`).join("\n") }),
  { ok: true, path: join(dir, "run.py") },
);
assert(blocked?.ok === false && /rewrite/i.test(blocked.detail), "harness blocks a full rewrite");

const self = await createHarness().after(
  "write_file",
  JSON.stringify({ path: join(dir, "harness.js"), content: "export const x = 1\n" }),
  { ok: true, path: join(dir, "harness.js") },
);
assert(self?.ok === false && /verifier/i.test(self.blurb), "harness cannot PASS its own rewrite");

const keepPath = join(dir, "keep.py");
const keepOld = Array.from({ length: 24 }, (_, i) => `keep me line ${i} extra text`).join("\n");
writeFileSync(keepPath, keepOld);
const pre = createHarness();
pre.note("read_file", { path: keepPath }, { ok: true, path: keepPath, text: keepOld });
const preRewrite = pre.before(
  "write_file",
  JSON.stringify({ path: keepPath, content: Array.from({ length: 40 }, (_, i) => `new line ${i} extra text`).join("\n") }),
);
assert(preRewrite?.ok === false && /rewrite/i.test(preRewrite.detail), "before() blocks a rewrite");
const preSelf = createHarness().before(
  "write_file",
  JSON.stringify({ path: join(dir, "harness.js"), content: "export const x = 1\n" }),
);
assert(preSelf?.ok === false && /verifier/i.test(preSelf.blurb), "before() blocks verifier writes");

writeFileSync(keepPath, Array.from({ length: 40 }, (_, i) => `new line ${i} extra text`).join("\n"));
const viaShell = await pre.after("bash", JSON.stringify({ command: "true" }), { ok: true });
assert(viaShell?.ok === false && /shell write reverted/i.test(viaShell.detail), "shell rewrite is reverted");
assert(readFileSync(keepPath, "utf8") === keepOld, "shell rewrite restores the original file");

const scored = scoreTurn([
  { role: "user", content: "use python not go" },
  { role: "step", name: "host_file_write", ok: true, blurb: "Wrote app.go" },
  { role: "step", name: "harness", ok: false, blurb: "asks open: python not go" },
  { role: "assistant", content: "PASS" },
]);
assert(scored.flags.includes("ask-miss"), "open checklist is pain");

assert(factAsk("Who founded Hungry Nova and in what year?") === true, "fact ask: who/when");
assert(factAsk("Write add.py that prints 4. Use python not go.") === false, "code job is not a fact ask");
assert(admitsUnknown("I don't know. I will not invent.") === true, "admits unknown");
assert(admitsUnknown("I can't and won't surface a person's employee ID.") === true, "refusal counts as not inventing");
assert(FACT_LAW.includes("do not state it"), "house fact law is shared");
assert(teammatePrompt({ name: "Scout" }).includes(FACT_LAW), "teammates get the same fact law");
assert(inferPack("Who founded Hungry Nova?") === "hnl", "fact ask steers hnl pack");
const eyes = createGround();
assert(eyes.seen() === false, "ground starts unseen");
eyes.note("host_run");
assert(eyes.seen() === false, "shell is not a lookup");
eyes.note("web_search");
assert(eyes.seen() === true, "web_search counts as lookup");
assert(claimTokens("Hungry Nova launched in 2019 for $20.").includes("Hungry Nova"), "claim: proper name");
assert(claimTokens("Hungry Nova launched in 2019 for $20.").includes("2019"), "claim: year");
assert(missingClaims("Hungry Nova launched in 1999", "Hungry Nova started in 2019").includes("1999"), "year must be in the source");
assert(missingClaims("Hungry Nova launched in 2019", "Hungry Nova started in 2019").length === 0, "supported claim is clean");
const sourced = createGround();
sourced.note("web_search", { content: "Hungry Nova started in 2019" });
assert(sourced.unsupported("Hungry Nova launched in 1999").includes("1999"), "invented year is unsupported");
assert(sourced.unsupported("Hungry Nova launched in 2019").length === 0, "quoted year is supported");
assert(folderAsk("Who founded the company that built this folder?") === true, "folder fact is about this folder");
const webOnly = createGround();
webOnly.note("web_search", { content: "Ed Logg designed Asteroids" });
assert(webOnly.unsupported("Ed Logg founded it.", "Who founded the company that built this folder?").length > 0, "the web is not a source for this folder");
const readFolder = createGround();
readFolder.note("host_file_read", { content: "The studio bell was $18.40 in 2019." });
assert(readFolder.unsupported("The studio bell was $18.40 in 2019.", "What did this folder say about the bell?").length === 0, "a file in this folder can support the fact");

const tape = createTimeline();
tape.delta("Looking.\n");
tape.step({ name: "ping_check", ok: true, blurb: "203.0.113.10 → 56 bytes" });
tape.delta("4 hosts are up.");
const timed = tape.finish("4 hosts are up.");
assert(timed[0].role === "assistant" && timed[0].content === "Looking.", "timeline keeps text before tools");
assert(timed[1].role === "step" && timed[1].name === "ping_check", "timeline keeps the tool in the middle");
assert(timed[2].role === "assistant" && timed[2].content === "4 hosts are up.", "timeline keeps text after tools");
assert(mergeAssistants(timed).length === 1 && mergeAssistants(timed)[0].content.includes("Looking."), "model history joins assistant fragments");
const dropped = createTimeline();
dropped.delta("Stopped. Same call 3 times.");
dropped.retract();
dropped.step({ name: "laya", ok: true, blurb: "cleared" });
const kept = dropped.finish("From the tool results:\n70%");
assert(kept.every((row) => !/Stopped/.test(row.content || "")), "retract drops a stop sentence before the next step");
assert(kept.some((row) => row.role === "assistant" && row.content.includes("70%")), "finish keeps the result after a retract");

const stacked = stackStep(
  { name: "ping_check", ok: true, blurb: "203.0.113.10 → 56 bytes" },
  { name: "ping_check", ok: true, blurb: "203.0.113.11 → 56 bytes" },
);
assert(stacked?.hits === 2 && /· 2$/.test(stacked.blurb), "same tool folds into one line");
const mixed = stackStep(stacked, { name: "ping_check", ok: false, blurb: "Failed: exit 2" });
assert(mixed?.ok === false && /1 failed/.test(mixed.blurb), "folded line keeps fail counts");
assert(stackStep(stacked, { name: "host_run", ok: true, blurb: "ok" }) == null, "different tools do not fold");

assert(expectFromAsk("Write add.py that prints 4 and output 'hi'").join(",") === "4,hi", "expect tokens from the ask");
writeFileSync(join(dir, "four.py"), "print(2)\n");
const missedOut = await probePath(join(dir, "four.py"), "print(2)\n", { expect: ["4"] });
assert(missedOut?.ok === false && /missing output/i.test(missedOut.error), "run probe requires expected stdout");
writeFileSync(join(dir, "four.py"), "print(4)\n");
const hitOut = await probePath(join(dir, "four.py"), "print(4)\n", { expect: ["4"] });
assert(hitOut?.ok === true, "run probe passes when stdout matches");

writeFileSync(join(dir, "hang.py"), "import time\ntime.sleep(20)\n");
const hung = await probePath(join(dir, "hang.py"), "import time\ntime.sleep(20)\n");
assert(hung?.ok === false && /hung|timed out/i.test(`${hung.blurb} ${hung.error}`), "timeout is a FAIL");

assert(shellTargets(`cat > ${join(dir, "made.py")}`).includes(join(dir, "made.py")), "shell targets from redirect");
writeFileSync(join(dir, "made.py"), "print(4)\n");
const viaRedirect = await createHarness({ ask: "prints 4. use python not go" }).after(
  "bash",
  JSON.stringify({ command: `cat > ${join(dir, "made.py")}` }),
  { ok: true },
);
assert(viaRedirect?.ok === true, "bash-created code is compiled and run");

const fat = Array.from({ length: 10 }, (_, i) => `existing line ${i} extra`).join("\n");
const fatPath = join(dir, "fat.py");
writeFileSync(fatPath, fat);
const unread = createHarness().before("write_file", JSON.stringify({ path: fatPath, content: "print(1)\n" }));
assert(unread?.ok === false && /read first/i.test(unread.blurb), "overwrite of a substantial file requires a read");

assert(verifyCommand(join(dir, "x.go")).command.includes("go build"), "go files use go build");
assert(verifyCommand(join(dir, "x.ts")).command.includes("tsc"), "ts files typecheck");
writeFileSync(join(dir, "ok.sh"), "echo hi\n");
assert(verifyCommand(join(dir, "ok.sh")).command.includes("bash -n"), "shell files are syntax-checked");
const shOk = await verifyPath(join(dir, "ok.sh"));
assert(shOk?.ok === true, "bash -n passes a clean script");

assert(isTestPath(join(dir, "test_add.py")) === true, "pytest-style name is a test");
assert(runCommand(join(dir, "test_add.py")).command.includes("pytest"), "test files run as tests");
writeFileSync(join(dir, "test_add.py"), "def test_ok():\n    assert True\n\nif __name__ == '__main__':\n    test_ok()\n    print('ok')\n");
const tested = await probePath(join(dir, "test_add.py"), "def test_ok():\n    assert True\n");
assert(tested?.ok === true, "test file probe passes");

assert(censorPass("PASS compile ok\nnext", ["ask:python"]) === "FAIL (harness still open)\nnext", "open debt censors PASS");
assert(censorPass("PASS compile ok", []) === "PASS compile ok", "clean debt keeps PASS");

const jobDir = join(dir, "jobbox");
mkdirSync(jobDir);
writeFileSync(join(jobDir, "job.py"), "print('job-ok')\n");
writeFileSync(join(jobDir, "harness.json"), JSON.stringify({ check: `python3 ${join(jobDir, "job.py")}`, expect: "job-ok" }));
assert(readJobSpec(jobDir)?.expect === "job-ok", "reads human harness.json");
assert(isVerifierPath(join(jobDir, "harness.json")) === true, "harness.json is a verifier");
const lockJob = createHarness().before("write_file", JSON.stringify({ path: join(jobDir, "harness.json"), content: "{}\n" }));
assert(lockJob?.ok === false && /verifier/i.test(lockJob.blurb), "before() blocks harness.json writes");
const jobGate = await createHarness({ ask: "use python not go" }).after(
  "write_file",
  JSON.stringify({ path: join(jobDir, "job.py"), content: "print('job-ok')\n" }),
  { ok: true, path: join(jobDir, "job.py") },
);
assert(jobGate?.ok === true, "human harness.json check runs after a write");
writeFileSync(join(jobDir, "job.py"), "print('wrong')\n");
const jobMiss = await createHarness({ ask: "use python not go" }).after(
  "write_file",
  JSON.stringify({ path: join(jobDir, "job.py"), content: "print('wrong')\n" }),
  { ok: true, path: join(jobDir, "job.py") },
);
assert(jobMiss?.ok === false && /job missed|harness.json/i.test(`${jobMiss.blurb} ${jobMiss.detail}`), "harness.json expect can fail the write");

const remoteCmds = [];
const remote = async (command) => {
  remoteCmds.push(command);
  return { ok: true, stdout: "4\n" };
};
const remoteOk = await createHarness({ ask: "prints 4", remoteExec: remote }).after(
  "computer_write",
  JSON.stringify({ path: "add.py", content: "print(4)\n" }),
  { ok: true, path: "add.py" },
);
assert(remoteOk?.ok === true, "computer_write compiles through remoteExec");
assert(remoteCmds.some((row) => row.includes("py_compile")), "remote compile uses py_compile");
const remoteNo = await createHarness({ ask: "prints 4" }).after(
  "computer_write",
  JSON.stringify({ path: "add.py", content: "print(4)\n" }),
  { ok: true, path: "add.py" },
);
assert(remoteNo?.ok === false && /unverified/i.test(remoteNo.blurb), "computer_write without tools key stays unverified");

const many = createHarness({ ask: "use python not go" });
for (let i = 0; i < 5; i += 1) {
  const file = join(dir, `many${i}.py`);
  writeFileSync(file, "print(1)\n");
  const row = await many.after("write_file", JSON.stringify({ path: file, content: "print(1)\n" }), { ok: true, path: file });
  assert(row != null, `fifth write still checked (${i})`);
}

console.log("engine tool-call fixes ok");
