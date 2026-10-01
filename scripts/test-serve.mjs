import assert from "node:assert/strict";
import { onlineAsk, pinPublicHost, plainTurn, servesAsk, toolsForAsk, skipNote, tunnelTurn } from "../src/main/serve.js";

const tools = [
  "host_listen_ports",
  "host_disk",
  "host_facts",
  "host_processes",
  "host_service_status",
  "mac_screenshot",
  "term_send",
  "host_tunnels",
  "net_report",
  "host_run",
  "say_plain",
].map((name) => ({ function: { name } }));

const ports = toolsForAsk(tools, "what ports are open?");
assert.deepEqual(ports.map((row) => row.function.name), ["host_listen_ports"]);
assert.equal(servesAsk("what ports are open?", "host_disk"), false);
assert.equal(servesAsk("what ports are open?", "host_facts"), false);
assert.equal(servesAsk("what ports are open?", "host_processes"), false);

const disk = toolsForAsk(tools, "how full is the disk?");
assert.deepEqual(disk.map((row) => row.function.name), ["host_disk"]);

const report = toolsForAsk(tools, "status report for this computer");
const names = report.map((row) => row.function.name);
assert.ok(names.includes("host_disk"));
assert.ok(names.includes("host_listen_ports"));
assert.equal(names.includes("host_service_status"), false);
assert.equal(names.includes("mac_screenshot"), false);
assert.equal(names.includes("term_send"), false);

assert.equal(servesAsk("is nginx running?", "host_service_status"), true);
assert.equal(servesAsk("is nginx running?", "host_disk"), false);
assert.equal(servesAsk("try again", "mac_screenshot"), true);
assert.equal(servesAsk("take a screenshot", "host_disk"), false);
assert.match(skipNote("host_disk", "what ports are open?"), /host disk does not answer/);
assert.match(skipNote("host_disk", "what ports are open?"), /host_listen_ports/);

const tunnels = toolsForAsk(tools, "how many ssh tunnels do I have and where do they go?");
assert.deepEqual(tunnels.map((row) => row.function.name), ["host_tunnels"]);
assert.equal(servesAsk("how many ssh tunnels do I have and where do they go?", "net_report"), false);
assert.equal(servesAsk("how many ssh tunnels do I have and where do they go?", "host_run"), false);
assert.match(skipNote("net_report", "ssh tunnels on this computer"), /host_tunnels/);
const follow = "sorry, tell me in human mode, not this crazy text";
const prior = [
  { role: "user", content: "can you send a ping to check if my ssh tunnels are active?" },
  { role: "assistant", content: "4 SSH tunnels are active. Through studio, local port 9123 goes to port 1234 there." },
];
assert.equal(tunnelTurn(follow), false);
assert.equal(plainTurn(follow, prior), true);
assert.equal(servesAsk(follow, "net_report", prior), false);
assert.equal(servesAsk(follow, "host_tunnels", prior), false);
assert.equal(servesAsk(follow, "say_plain", prior), true);
assert.deepEqual(toolsForAsk(tools, follow, prior).map((row) => row.function.name), ["say_plain"]);

const docker = toolsForAsk([...tools, { function: { name: "docker_ps" } }], "Is Docker running on this computer?");
assert.deepEqual(docker.map((row) => row.function.name), ["docker_ps"]);
assert.equal(servesAsk("Is Docker running on this computer?", "host_run"), false);
const online = toolsForAsk(tools, "Is this computer connected to the internet?");
assert.deepEqual(online.map((row) => row.function.name), ["net_report"]);
assert.equal(servesAsk("Is this computer connected to the internet?", "host_run"), false);
assert.equal(onlineAsk("Is this computer connected to the internet?"), true);
assert.equal(onlineAsk("is example.com online?"), false);
assert.match(pinPublicHost('{"host":"studio"}'), /hungrynovalabs\.com/);

const folderTools = ["web_search", "extract", "host_file_read", "host_file_write", "host_run"].map((name) => ({ function: { name } }));
const folder = toolsForAsk(folderTools, "Who founded the company that built this folder?");
assert.deepEqual(folder.map((row) => row.function.name), ["host_file_read"]);
assert.equal(servesAsk("Who founded the company that built this folder?", "web_search"), false);
assert.equal(servesAsk("Build a drawing program in this folder.", "host_file_write"), true);

const locked = toolsForAsk(tools, "is the studio machine awake?", [], new Set(["host_disk", "host_listen_ports", "host_run"]));
assert.deepEqual(locked.map((row) => row.function.name).sort(), ["host_disk", "host_listen_ports"]);

console.log("serve ok");
