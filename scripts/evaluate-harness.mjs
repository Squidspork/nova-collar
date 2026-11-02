// Reproducible harness evaluation, with an independent Node test runner.
// This deliberately makes no claim about a live model's coding quality.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const suites = ["conversation", "hnl-turn", "helper-context", "verification", "projects", "checkpoints", "subagent", "context", "context-info", "request-budget", "tool-catalog", "cli-control", "project-knowledge", "streaming", "processes"];
const home = mkdtempSync(join(tmpdir(), "collar-evaluation-"));
const git = args => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
};
const started = Date.now();
const cases = [];
try {
  for (const name of suites) {
    const file = `scripts/test-${name}.mjs`, time = Date.now();
    const run = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", env: { ...process.env, NOVAPUP_HOME: join(home, name), NP_LAYA_MODEL: join(home, "no-model") }, timeout: 120000, maxBuffer: 2000000 });
    cases.push({ name, passed: run.status === 0, exitCode: run.status, durationMs: Date.now() - time,
      graderSha256: createHash("sha256").update(readFileSync(file)).digest("hex"), diagnostics: (run.stdout || "") + (run.stderr || "") });
  }
  const sourceStatus = git(["status", "--porcelain"]);
  const result = { schemaVersion: 1, observedAt: new Date().toISOString(), sourceRevision: git(["rev-parse", "HEAD"]) || "unknown",
    sourceDirty: sourceStatus === null ? null : Boolean(sourceStatus), node: process.version, platform: process.platform,
    mode: "deterministic harness fixtures with real filesystem/compiler/process cases", requestedModel: null, reportedModel: null,
    liveModelQualityBenchmark: false, operatingSystemSandbox: false, isolatedProfile: true,
    passed: cases.every(row => row.passed), durationMs: Date.now() - started, cases };
  const target = process.argv[2];
  if (target) writeFileSync(target, JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.passed) process.exitCode = 1;
} finally { rmSync(home, { recursive: true, force: true }); }
