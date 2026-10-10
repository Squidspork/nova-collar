import assert from "node:assert/strict";
import { appendTerm, readTerminal } from "../src/main/term-bridge.js";

appendTerm("\x1b]0;title\x07\x1b[32mready\x1b[0m\r\n");
assert.equal(readTerminal(), "ready\n", "strip color and BEL-terminated titles");

// Omarchy's shell integration ends OSC records with ST (ESC + backslash).
// A later BEL-terminated title must not consume the command output between them.
appendTerm(
  "\x1b]3008;type=command\x1b\\verified output\r\n"
  + "\x1b]3008;exit=success\x1b\\"
  + "\x1b]0;next title\x07prompt> ",
);
assert.equal(readTerminal(), "ready\nverified output\nprompt> ",
  "preserve output between ST-terminated shell records and the next title");

appendTerm("\x1b]3008;type=command\x1b");
appendTerm("\\second output\r\n\x1b]3008;exit=success\x1b\\");
assert.equal(readTerminal(), "ready\nverified output\nprompt> second output\n",
  "handle control sequences split across PTY chunks");

appendTerm("\x9d3008;type=command\x9cC1 output\r\n\x9d0;title\x07");
assert.equal(readTerminal(), "ready\nverified output\nprompt> second output\nC1 output\n",
  "handle single-character OSC and ST controls");

console.log("PASS terminal: colors, BEL/ST shell records, chunk boundaries, preserved command output");
