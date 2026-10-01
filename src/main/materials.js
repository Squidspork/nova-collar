/** Optional downloads named in materials/catalog.json. Chat models stay bring-your-own. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT, MODEL_HOME } from "./config.js";

export function readCatalog(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "materials", "catalog.json"), "utf8"));
}

export function pieceById(catalog, id) {
  return (catalog?.pieces || []).find((row) => row.id === id) || null;
}

export function pieceUrl(catalog, piece) {
  const repo = String(catalog?.repo || "").replace(/\/$/, "");
  return `${repo}/releases/download/${piece.tag}/${piece.file}`;
}

export function fetchPiece(id, { root = ROOT, base = MODEL_HOME, catalog = null, force = false } = {}) {
  const book = catalog || readCatalog(root);
  const piece = pieceById(book, id);
  if (!piece?.file || !piece?.tag || !piece?.path) return { ok: false, error: `No material named ${id}.` };
  const dest = join(base, piece.path);
  const marker = piece.marker ? join(base, piece.marker) : "";
  if (!force && marker && existsSync(marker)) return { ok: true, path: dest, skipped: true };
  const part = join(base, "models", ".download");
  mkdirSync(part, { recursive: true });
  const archive = join(part, piece.file);
  const repo = String(book.repo || "").replace(/^https:\/\/github.com\//, "").replace(/\.git$/, "");
  const gh = spawnSync("gh", [
    "release", "download", piece.tag,
    "--repo", repo,
    "--pattern", piece.file,
    "--dir", part,
    "--clobber",
  ], { encoding: "utf8" });
  if (gh.status !== 0 || !existsSync(archive)) {
    const curl = spawnSync("curl", ["-fL", "--retry", "2", "-o", archive, pieceUrl(book, piece)], { encoding: "utf8" });
    if (curl.status !== 0 || !existsSync(archive)) {
      return { ok: false, error: "That file is not on the release yet, or this repo is still private. gh auth login, then nova-collar update laya." };
    }
  }
  mkdirSync(join(base, "models"), { recursive: true });
  const tar = spawnSync("tar", ["-xzf", archive, "-C", join(base, "models")], { encoding: "utf8" });
  rmSync(archive, { force: true });
  if (tar.status !== 0) return { ok: false, error: "The archive did not unpack." };
  if (marker && !existsSync(marker)) return { ok: false, error: "The archive unpacked, and the expected file was not in it." };
  return { ok: true, path: dest, skipped: false };
}
