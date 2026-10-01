import assert from "node:assert/strict";
import { pieceById, pieceUrl, readCatalog } from "../src/main/materials.js";

const catalog = readCatalog();
const laya = pieceById(catalog, "laya");
assert.equal(laya.file, "laya-np.tar.gz");
assert.equal(pieceUrl(catalog, laya), "https://github.com/Squidspork/nova-collar/releases/download/materials-1/laya-np.tar.gz");
assert.match(catalog.chat, /Bring your own/);
assert.equal(pieceById(catalog, "hnl27b"), null);
process.stdout.write("materials ok\n");
