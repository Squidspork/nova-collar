import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const cli = join(root, "node_modules/@electron/rebuild/lib/cli.js");
const result = spawnSync(process.execPath, [cli, "-f", "-w", "node-pty"], {
  stdio: "inherit",
  cwd: root,
});
process.exit(result.status ?? 1);
