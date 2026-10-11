import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghidraAsk, ghidraDoctrine, ghidraReady, installSkillPack, steerGhidra } from "../src/main/ghidra-mcp.js";
import { inferPack } from "../src/main/packs.js";

assert.equal(ghidraAsk("What is Ghidra?"), false);
assert.equal(ghidraAsk("Decompile the function at 0x401000"), true);
assert.equal(ghidraAsk("What does this function in the binary do?"), true);
assert.equal(ghidraAsk("Is example.com up?"), false);

const host = steerGhidra("Decompile main in this binary", { action: "pack", pack: "host" }, { installed: true });
assert.equal(host.pack, "ghidra");
const locked = steerGhidra("Decompile main", { action: "pack", pack: "host" }, { installed: true, locked: true });
assert.equal(locked.pack, "host");
const refused = steerGhidra("Decompile main", { action: "refuse" }, { installed: true });
assert.equal(refused.action, "refuse");
const off = steerGhidra("Decompile main", { action: "pack", pack: "code" }, { installed: false });
assert.equal(off.pack, "code");

const home = mkdtempSync(join(tmpdir(), "ghidra-skill-"));
try {
  assert.equal(ghidraReady(home), false);
  const installed = installSkillPack("ghidra", { home });
  assert.equal(installed.ok, true);
  assert.equal(ghidraReady(home), true);
  assert.match(ghidraDoctrine(home), /ghidra_status/);
  assert.match(ghidraDoctrine(home), /Do not write an exploit/);
  const again = installSkillPack("ghidra", { home });
  assert.equal(again.skipped, true);
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (!ghidraReady()) {
  assert.equal(inferPack("Decompile the open binary"), "");
}

process.stdout.write("ghidra skill ok\n");
