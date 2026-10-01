/** Pull the checkout (when it is one), then download a named material and set it up. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.js";
import { ensureLayaVenv } from "./laya.js";
import { fetchPiece, readCatalog } from "./materials.js";

export function runUpdate(argv = []) {
  const names = argv.filter((arg) => arg && !String(arg).startsWith("-"));
  // A packaged copy is not a git checkout; skip the pull and still allow downloads.
  if (existsSync(join(ROOT, ".git"))) {
    const pull = spawnSync("git", ["-C", ROOT, "pull", "--ff-only"], { stdio: "inherit" });
    if (pull.status !== 0) return pull.status || 1;
  }
  const catalog = readCatalog();
  process.stdout.write(`${catalog.chat}\n`);
  if (!names.length) {
    const optional = (catalog.pieces || []).map((row) => row.id).join(", ");
    process.stdout.write(`Program is current.${optional ? ` Optional: nova-collar update ${optional}` : ""}\n`);
    return 0;
  }
  let failed = 0;
  for (const id of names) {
    const result = fetchPiece(id, { catalog });
    if (!result.ok) {
      process.stderr.write(`${result.error}\n`);
      failed = 1;
      continue;
    }
    process.stdout.write(result.skipped ? `${id} is already here.\n` : `${id} is in ${result.path}\n`);
    if (id === "laya") {
      const venv = ensureLayaVenv({ log: (line) => process.stdout.write(`${line}\n`) });
      if (!venv.ok) {
        process.stderr.write(`${venv.error}\n`);
        failed = 1;
      } else {
        process.stdout.write(venv.skipped ? "Laya's Python environment is ready.\n" : "Laya's Python environment is set up.\n");
      }
    }
  }
  return failed;
}
