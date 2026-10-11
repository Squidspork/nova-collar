// DMG stapling happens after electron-builder first computes update metadata.
// Rebuild the blockmaps and hashes from the final bytes, after the builder exits.
const { createReadStream } = require("node:fs");
const { readFile, writeFile, stat } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { join, basename, resolve } = require("node:path");
const yaml = require("js-yaml");
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap");

async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

async function finalizeMacRelease(outDir) {
  const manifestPath = join(outDir, "latest-mac.yml");
  const manifest = yaml.load(await readFile(manifestPath, "utf8"));
  if (!manifest.files?.length) throw new Error("Mac update manifest has no files.");
  const artifacts = [];
  for (const entry of manifest.files) {
    if (typeof entry.url !== "string" || basename(entry.url) !== entry.url || !/\.(zip|dmg)$/.test(entry.url)) {
      throw new Error("Mac update manifest must reference local ZIP or DMG filenames.");
    }
    const file = join(outDir, entry.url);
    const info = await buildBlockMap(file, "gzip", file + ".blockmap");
    entry.sha512 = info.sha512;
    entry.size = (await stat(file)).size;
    delete entry.blockMapSize;
    artifacts.push(file, file + ".blockmap");
  }
  const primary = manifest.files.find(entry => entry.url.endsWith(".zip"));
  if (!primary) throw new Error("Mac auto-update requires a ZIP.");
  manifest.path = primary.url;
  manifest.sha512 = primary.sha512;
  await writeFile(manifestPath, yaml.dump(manifest, { lineWidth: -1 }));
  artifacts.push(manifestPath);
  const sums = await Promise.all(artifacts.map(async file => `${await digest(file, "sha256", "hex")}  ${basename(file)}`));
  await writeFile(join(outDir, "SHA256SUMS.txt"), sums.join("\n") + "\n");
  console.log(`Final Mac update metadata verified for ${manifest.files.length} artifacts.`);
}

module.exports = { finalizeMacRelease, digest };
if (require.main === module) finalizeMacRelease(resolve(__dirname, "../dist")).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
