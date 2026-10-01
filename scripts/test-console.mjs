import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConsole } from "../src/cli/commands.js";
import { availableFromVmStat, loadReadout } from "../src/cli/meters.js";
import { completeInput, themePartial } from "../src/cli/complete.js";
import { pickTheme } from "../src/cli/themes.js";

assert.equal(parseConsole("/goal").type, "goal");
assert.equal(parseConsole("/goal clear").text, "/goal clear");
assert.equal(parseConsole("/new").type, "new");
assert.equal(parseConsole("/disk").name, "host_disk");
assert.equal(parseConsole("/theme").type, "theme");
assert.equal(parseConsole("/theme radar").name, "radar");
assert.equal(parseConsole("/tcp 127.0.0.1 1").args.port, 1);
assert.equal(parseConsole("/logs /var/log/syslog").name, "host_tail_log");
assert.equal(parseConsole("how full is the disk").type, "chat");
assert.equal(parseConsole("/nope").type, "unknown");
assert.equal(pickTheme("amber", ""), "amber");
assert.equal(pickTheme("amber", "radar"), "radar");
assert.equal(pickTheme("amber", "nope"), "");
assert.equal(themePartial("/theme"), "");
assert.equal(themePartial("/theme ra"), "ra");
assert.equal(themePartial("/th"), null);
assert.equal(completeInput("/di").options[0].fill, "/disk");
assert.deepEqual(completeInput("/d").options.map((row) => row.id), ["/disk", "/dns", "/docker"]);
assert.equal(completeInput("/theme a").kind, "theme");
assert.equal(completeInput("/theme a").options[0].id, "amber");
assert.equal(completeInput("/theme a").filled, "/theme amber");
assert.equal(loadReadout(0, 18), "0.00/18 [............]");
assert.equal(loadReadout(3, 18), "3.00/18 [##..........]");
assert.equal(loadReadout(18, 18), "18.00/18 [############]");
assert.equal(loadReadout(36, 18), "36.00/18 [############]");
const vm = [
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "Pages free:                                   442106.",
  "Pages inactive:                              1585035.",
  "Pages speculative:                             60668.",
].join("\n");
assert.equal(availableFromVmStat(vm), (442106 + 1585035 + 60668) * 16384);
assert.equal(Number.isNaN(availableFromVmStat("nope")), true);

const home = mkdtempSync(join(tmpdir(), "np-console-"));
const env = { ...process.env, NOVAPUP_HOME: home };
function run(args) {
  return spawnSync(process.execPath, ["src/cli/np.js", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    encoding: "utf8",
  });
}

try {
  const disk = run(["/disk"]);
  assert.equal(disk.status, 0, disk.stderr);
  assert.match(disk.stdout, /%|Filesystem|Avail/);

  const facts = run(["/facts"]);
  assert.equal(facts.status, 0, facts.stderr);
  assert.match(facts.stdout, /CPU|cpu|Mem|mem|Darwin|Linux/);

  const goal = run(["/goal"]);
  assert.match(goal.stdout, /No goal/);

  const planted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { bootSessions, writeGoal } from "./src/main/sessions.js";
    const started = bootSessions();
    writeGoal(started.session.id, "disk under 90");
  `], { cwd: fileURLToPath(new URL("..", import.meta.url)), env, encoding: "utf8" });
  assert.equal(planted.status, 0, planted.stderr);
  const shown = run(["/goal"]);
  assert.match(shown.stdout, /disk under 90/);

  const made = run(["/new"]);
  assert.match(made.stdout, /New chat/);

  const listed = run(["/chats"]);
  assert.match(listed.stdout, /1/);

  const ports = run(["/ports"]);
  assert.equal(ports.status, 0, ports.stderr);
  assert.match(ports.stdout, /LISTEN|State|no ss or lsof/i);
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log("console ok");
