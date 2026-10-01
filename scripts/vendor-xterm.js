import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dest = join(root, "src/renderer/vendor");
mkdirSync(dest, { recursive: true });
const files = [
  ["node_modules/@xterm/xterm/css/xterm.css", "xterm.css"],
  ["node_modules/@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["node_modules/@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
];
for (const [from, name] of files) {
  copyFileSync(join(root, from), join(dest, name));
}
