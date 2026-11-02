import { spawnSync } from "node:child_process";
import { analysisBundle } from "./analysis-runtime.js";
import { layaReady } from "./install.js";

/** Dated local observations; never installs software or infers a model backend. */
export function dependencyReport({ run = spawnSync } = {}) {
  const tools = [
    ["git", ["--version"], "project history"],
    ["python3", ["--version"], "Python file checks and optional Laya"],
    ["tshark", ["--version"], "optional network capture"],
    ["nmap", ["--version"], "optional device discovery"],
    ["docker", ["--version"], "optional Docker tools"],
  ].map(([name, args, purpose]) => {
    const result = run(name, args, { encoding: "utf8", timeout: 2000, maxBuffer: 16000, windowsHide: true });
    return { name, purpose, available: result.status === 0,
      ...(result.status === 0 ? { version: String(result.stdout || result.stderr || "").split("\n")[0].slice(0, 200) } : { reason: result.error?.code || "not available" }) };
  });
  const analysis = analysisBundle();
  return { observedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    node: process.version, electron: process.versions.electron || null,
    analysis: { ready: analysis.ok, reason: analysis.ok ? "verified local bundle present" : analysis.error || "bundle unavailable" },
    laya: { ready: layaReady(), optional: true }, tools,
    modelRouting: "Not probed. Configured names and aliases do not establish a live backend or historical deployment.",
    network: "No captures, discoveries, remote model requests or installation were started." };
}
