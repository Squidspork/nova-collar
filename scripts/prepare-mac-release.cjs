// Remove native debug paths before electron-builder signs the app.
const { readdirSync, openSync, readSync, closeSync, readFileSync } = require("node:fs");
const { join, relative } = require("node:path");
const { homedir } = require("node:os");
const { execFileSync } = require("node:child_process");

function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  });
}

exports.default = async context => {
  if (context.electronPlatformName !== "darwin") return;
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  const magic = new Set(["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);
  let stripped = 0;
  for (const file of filesUnder(resources)) {
    const fd = openSync(file, "r");
    const header = Buffer.alloc(4);
    try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
    if (!magic.has(header.toString("hex"))) continue;
    // Java class files share a magic number with universal Mach-O binaries.
    if (!execFileSync("file", ["-b", file], { encoding: "utf8" }).includes("Mach-O")) continue;
    execFileSync("xcrun", ["strip", "-S", file], { stdio: "pipe" });
    if (readFileSync(file).includes(Buffer.from(homedir() + "/"))) {
      throw new Error(`Native build contains a developer home path: ${relative(resources, file)}`);
    }
    stripped++;
  }
  console.log(`release privacy: stripped debug metadata from ${stripped} native files before signing.`);
};
