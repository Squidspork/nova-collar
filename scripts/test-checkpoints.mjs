import assert from "node:assert/strict";
import { after, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "nova-checkpoints-"));
process.env.NOVAPUP_HOME = join(root, "profile"); mkdirSync(process.env.NOVAPUP_HOME);
const { Checkpoint, listCheckpoints, undoCheckpoint } = await import("../src/main/checkpoints.js");
const { createHarness } = await import("../src/main/harness.js");
const { setWorkdir } = await import("../src/main/workdir.js");
after(() => rmSync(root, { recursive: true, force: true }));

test("checkpoints preserve changed/new/deleted files and undo is itself reversible", () => {
  const path = join(root, "changes"); mkdirSync(path);
  const changed = join(path, "changed.txt"), deleted = join(path, "deleted.txt"), added = join(path, "added.txt");
  writeFileSync(changed, "before"); writeFileSync(deleted, "deleted before");
  const journal = new Checkpoint("changes-chat", path); journal.track([path]);
  writeFileSync(changed, "after"); rmSync(deleted); writeFileSync(added, "new");
  const saved = journal.finish("cancelled");
  assert.equal(saved.changes.length, 3); assert.equal(saved.reason, "cancelled");
  const restored = undoCheckpoint("changes-chat", saved.id);
  assert.equal(readFileSync(changed, "utf8"), "before"); assert.equal(readFileSync(deleted, "utf8"), "deleted before"); assert.equal(existsSync(added), false);
  undoCheckpoint("changes-chat", restored.checkpoint.id);
  assert.equal(readFileSync(changed, "utf8"), "after"); assert.equal(existsSync(deleted), false); assert.equal(readFileSync(added, "utf8"), "new");
});

test("undo preflights every conflict before writing any file", () => {
  const a = join(root, "conflict-a"), b = join(root, "conflict-b"); writeFileSync(a, "before a"); writeFileSync(b, "before b");
  const journal = new Checkpoint("conflict-chat", root); journal.track([a, b]); writeFileSync(a, "after a"); writeFileSync(b, "after b");
  const saved = journal.finish("finished"); writeFileSync(b, "later user edit");
  assert.throws(() => undoCheckpoint("conflict-chat", saved.id), /Changed since checkpoint/);
  assert.equal(readFileSync(a, "utf8"), "after a"); assert.equal(readFileSync(b, "utf8"), "later user edit");
});

test("undo refuses a swapped ancestor symlink even if file contents match", { skip: process.platform === "win32" }, () => {
  const path = join(root, "ancestor"), moved = join(root, "ancestor-moved"), victim = join(root, "victim"); mkdirSync(path); mkdirSync(victim);
  const file = join(path, "app.txt"); writeFileSync(file, "before");
  const journal = new Checkpoint("ancestor-chat", path); journal.track([file]); writeFileSync(file, "after");
  const saved = journal.finish("finished"); renameSync(path, moved); writeFileSync(join(victim, "app.txt"), "after"); symlinkSync(victim, path, "dir");
  assert.throws(() => undoCheckpoint("ancestor-chat", saved.id), /Changed path since checkpoint/);
  assert.equal(readFileSync(join(victim, "app.txt"), "utf8"), "after");
});

test("unchanged turns save nothing and size limits are explicitly uncovered", () => {
  const file = join(root, "limits"); writeFileSync(file, "large content");
  const empty = new Checkpoint("unchanged-chat", root); empty.track([file]); assert.equal(empty.finish("finished"), null); assert.deepEqual(listCheckpoints("unchanged-chat"), []);
  const limited = new Checkpoint("limits-chat", root, { maxFileBytes: 2 }); limited.track([file]);
  const saved = limited.finish("finished"); assert.equal(saved.changes.length, 0); assert.match(saved.skipped[0], /size limit/);
});

test("harness captures declared shell paths before execution and preserves one turn baseline", async () => {
  const path = join(root, "harness"); mkdirSync(path); setWorkdir(path);
  const file = join(path, "data.txt"); writeFileSync(file, "original");
  const events = [], gate = createHarness({ sessionId: "shell-backup", onCheckpoint: (event) => events.push(event) });
  gate.before("host_run", { command: "approved mutation", paths: [path] }); writeFileSync(file, "first");
  await gate.after("host_run", { command: "approved mutation" }, { ok: true });
  gate.before("host_run", { command: "second mutation", paths: [path] }); writeFileSync(file, "second");
  await gate.after("host_run", { command: "second mutation" }, { ok: false });
  const saved = gate.finish("cancelled"); assert.equal(saved.changes.length, 1); assert.equal(events.length, 1); assert.equal(gate.finish(), null);
  undoCheckpoint("shell-backup", saved.id); assert.equal(readFileSync(file, "utf8"), "original");
});
