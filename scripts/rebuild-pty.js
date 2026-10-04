import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
if (process.platform === "win32" && existsSync(join(root, "node_modules/node-pty/prebuilds", `win32-${process.arch}`, "conpty.node"))) {
  console.log("Using node-pty Windows Node-API prebuilds.");
  process.exit(0);
}
const cli = join(root, "node_modules/@electron/rebuild/lib/cli.js");
const result = spawnSync(process.execPath, [cli, "-f", "-w", "node-pty"], {
  stdio: "inherit",
  cwd: root,
});
process.exit(result.status ?? 1);
