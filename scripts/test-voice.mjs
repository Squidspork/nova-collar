import assert from "node:assert/strict";
import { parseVoices, voiceFromProse } from "../src/main/voice.js";

const shaped = parseVoices(`name: night watch
text: I keep the watch short. I say what is wrong, then what I did.

---
name: warm den
text: I talk like a friend who still does the work. Soft, then precise.

---
name: ledger
text: I speak in counts and names. No flourish. The number comes first.

---
name: flare
text: I am brief and hot. The fault, the fix, then I stop.`);

assert.equal(shaped.length, 4);
assert.equal(shaped[0].name, "night watch");
assert.match(shaped[2].text, /counts and names/);

const numbered = parseVoices(`1. night watch
I keep the watch short and I name the fault first thing.

2. warm den
I talk like a friend who still finishes the job in front of me.

3. ledger
I speak in counts. The number comes before the story.

4. flare
I am brief and hot. Fault, fix, then silence.`);
assert.equal(numbered.length, 4);
assert.equal(numbered[3].name, "flare");
assert.equal(voiceFromProse("I do the work. I do not dump a plan. One step, then the result."), null);
assert.equal(voiceFromProse("I am a fox with a plan. If the first step does not work, I will try a different one.").name, "fox with");
assert.match(voiceFromProse("I am a librarian with teeth. I check it.").text, /librarian/);
assert.equal(voiceFromProse("I am quick, then precise. I change the step.").name, "quick then precise");

console.log("voice ok");
