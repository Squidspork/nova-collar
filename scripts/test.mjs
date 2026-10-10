import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const common = ["models", "model-history", "terminal", "approvals", "split", "goal", "laya-steer", "install", "board", "crew", "materials", "serve", "voice", "console", "windows"];
const suites = process.platform === "win32" ? common : [...common, "engine"];
for (const suite of suites) {
  const home = mkdtempSync(join(tmpdir(), "nova-test-"));
  console.log(`\n=== ${suite} ===`);
  try {
    const result = spawnSync(process.execPath, [`scripts/test-${suite}.mjs`], {
      stdio: "inherit", env: { ...process.env, NOVAPUP_HOME: home }, timeout: 120_000,
    });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exitCode = 1;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
