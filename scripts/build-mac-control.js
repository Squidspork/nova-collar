import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

if (process.platform !== "darwin") process.exit(0);

const root = join(import.meta.dirname, "..");
const outDir = join(root, "bin");
mkdirSync(outDir, { recursive: true });
const result = spawnSync(
  "swiftc",
  ["-O", "-o", join(outDir, "mac-control"), join(root, "src/native/mac-control.swift")],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
