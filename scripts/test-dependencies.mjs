import assert from "node:assert/strict";
import { test } from "node:test";
import { dependencyReport } from "../src/main/dependencies.js";
test("dependency audit is bounded, local, dated and honest about missing optional tools", () => {
  const seen = [];
  const report = dependencyReport({ run: (file, args, options) => {
    seen.push({ file, args, options });
    return file === "git" ? { status: 0, stdout: "git version fixture\n" } : { status: null, error: { code: "ENOENT" } };
  } });
  assert(report.observedAt);
  assert.equal(report.tools.find(row => row.name === "git").available, true);
  assert.equal(report.tools.find(row => row.name === "tshark").available, false);
  assert(seen.every(row => row.options.timeout === 2000 && row.args.join() === "--version"));
  assert.match(report.modelRouting, /Not probed/);
});
