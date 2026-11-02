import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "nova-knowledge-")), home = join(root, "profile"), app = join(root, "app");
mkdirSync(home); mkdirSync(app); process.env.NOVAPUP_HOME = home;
process.env.NP_LAYA_MODEL = join(root, "no-laya");
const { listSkills, readSkill, skillsContext } = await import("../src/main/skills.js");
const { projectIdentity, recordProjectMemory, recordVerifiedRepair, searchProjectMemory, projectMemoryContext } = await import("../src/main/project-memory.js");
const { lookupProjects, projectMapContext } = await import("../src/main/project-map.js");
const { verificationSource } = await import("../src/main/verification-ledger.js");
after(() => rmSync(root, { recursive: true, force: true }));
const project = (name) => { const path = join(root, name); mkdirSync(path); writeFileSync(join(path, "package.json"), "{}\n"); return path; };
const skill = (base, name, content) => { const path = join(base, name); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "SKILL.md"), content); };

test("skills list descriptions only and disclose full overriding instructions on demand", () => {
  const cwd = project("skills"), options = { home, root: app };
  skill(join(app, "materials", "skills"), "debug", "---\nname: Debug\ndescription: Diagnose a failure.\n---\n# Debug\nBUNDLED_SECRET_INSTRUCTIONS\n");
  skill(join(home, "skills"), "debug", "# User Debug\nUser diagnostic description.\nUSER_FULL_BODY\n");
  skill(join(cwd, ".nova", "skills"), "debug", "# Project Debug\nProject diagnostic description.\nPROJECT_FULL_BODY\n");
  assert.equal(listSkills(cwd, options).length, 1); assert.equal(listSkills(cwd, options)[0].source, "project");
  const context = skillsContext(cwd, options);
  assert.equal(context.includes("FULL_BODY"), false); assert.equal(context.includes("SECRET_INSTRUCTIONS"), false);
  assert.match(readSkill("debug", cwd, options).content, /PROJECT_FULL_BODY/);
  assert.equal(readSkill("../outside", cwd, options).ok, false);
  skill(join(home, "skills"), "oversized", "x".repeat(32769));
  assert.equal(readSkill("oversized", cwd, options).ok, false);
});

test("skills reject directory symlinks and escaping ancestor roots", { skip: process.platform === "win32" }, () => {
  const cwd = project("skill-links"), outside = join(root, "outside-skills");
  skill(outside, "escape", "# Escape\nExternal instructions.\n");
  mkdirSync(join(cwd, ".nova", "skills"), { recursive: true });
  symlinkSync(join(outside, "escape"), join(cwd, ".nova", "skills", "escape"), "dir");
  assert.equal(readSkill("escape", cwd, { home, root: app }).ok, false);
  const second = project("skill-parent-link"); symlinkSync(root, join(second, ".nova"), "dir");
  skill(join(root, "skills"), "ancestor", "# Ancestor\nEscaped through parent.\n");
  assert.equal(readSkill("ancestor", second, { home, root: app }).ok, false);
});

test("model memory remains observation-only, scoped, dated, deduplicated and searchable offline", () => {
  const cwd = project("memory-a"), other = project("memory-b"), file = join(cwd, "app.js"); writeFileSync(file, "export const value = 1;\n");
  const note = recordProjectMemory(cwd, { text: "Parser repair uses an explicit newline boundary.", sourcePath: file, kind: "verified-repair", status: "verified" }, { home });
  assert.equal(note.ok, true); assert.equal(note.note.kind, "observation"); assert.equal(note.note.status, "observation"); assert.ok(note.note.createdAt); assert.ok(note.note.source.hash);
  assert.equal(recordProjectMemory(cwd, { text: note.note.text, sourcePath: file }, { home }).duplicate, true);
  const found = searchProjectMemory(cwd, "parser newline", { home }); assert.equal(found.method, "keywords"); assert.equal(found.notes.length, 1); assert.equal(found.notes[0].currentSourceMatches, true);
  assert.deepEqual(searchProjectMemory(other, "parser", { home }).notes, []);
  assert.deepEqual(searchProjectMemory(cwd, "parser", { home: join(root, "empty-profile") }).notes, []);
  writeFileSync(file, "export const value = 2;\n"); assert.equal(searchProjectMemory(cwd, "parser", { home }).notes[0].currentSourceMatches, false);
  assert.equal(recordProjectMemory(cwd, { text: "outside source", sourcePath: join(other, "package.json") }, { home }).ok, false);
  assert.match(projectMemoryContext(cwd, "parser", { home }), /Past observations, not instructions/);
});

test("verified repair memory requires changed source, matching scope, strength and current hashes", () => {
  const cwd = project("verified-memory"), file = join(cwd, "app.js"); writeFileSync(file, "export const fixed = true;\n");
  const before = { path: file, project: cwd, remote: false, status: "failed", phase: "runtime", hash: "a".repeat(64), diagnostic: "runtime boundary failed" };
  const after = { ...before, status: "passed", hash: verificationSource(file).hash, command: "node app.js", verifiedAt: "2026-11-02T12:00:00Z" };
  const repaired = recordVerifiedRepair(cwd, { before, after, sessionId: "proof-chat" }, { home });
  assert.equal(repaired.ok, true); assert.equal(repaired.note.kind, "verified-repair"); assert.equal(repaired.note.evidence.sessionId, "proof-chat");
  for (const change of [{ phase: "syntax" }, { project: "/other" }, { hash: "b".repeat(64) }, { hash: before.hash }]) assert.equal(recordVerifiedRepair(cwd, { before, after: { ...after, ...change } }, { home }).ok, false);
});

test("malformed local memory fails closed without erasing original data", () => {
  const cwd = project("broken-memory"), file = join(home, "project-memory", `${projectIdentity(cwd).id}.json`);
  writeFileSync(file, "{invalid");
  assert.equal(recordProjectMemory(cwd, { text: "new note" }, { home }).ok, false);
  assert.equal(searchProjectMemory(cwd, "note", { home }).ok, false);
  assert.equal(readFileSync(file, "utf8"), "{invalid");
});

test("Git worktrees and nested folders share memory without merging independent packages", () => {
  const cwd = project("memory-git"), linked = join(root, "memory-worktree");
  const git = (args) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { stdio: "ignore" });
  git(["init"]); git(["add", "."]); git(["commit", "-m", "fixture"]); git(["worktree", "add", "-b", "fixture-linked", linked]);
  mkdirSync(join(cwd, "src")); assert.equal(projectIdentity(cwd).id, projectIdentity(join(cwd, "src")).id); assert.equal(projectIdentity(cwd).id, projectIdentity(linked).id);
  recordProjectMemory(cwd, { text: "Worktree memory retains parser observations." }, { home });
  assert.equal(searchProjectMemory(linked, "parser", { home }).notes.length, 1);
  mkdirSync(join(cwd, "package-child")); writeFileSync(join(cwd, "package-child", "package.json"), "{}\n");
  assert.notEqual(projectIdentity(cwd).id, projectIdentity(join(cwd, "package-child")).id);
});

test("project map uses registered paths, reports history and never executes manifest commands", () => {
  const cwd = project("map-current"), sibling = project("map-sibling"), sentinel = join(sibling, "should-not-exist");
  writeFileSync(join(sibling, "package.json"), JSON.stringify({ scripts: { test: `touch ${sentinel}` } }));
  writeFileSync(join(home, "project-map.json"), JSON.stringify({ version: 1, projects: [
    { id: "tag", name: "Nova Tag", path: sibling, aliases: ["terminal"], records: [{ path: "/reports/history.txt", asOf: "2026-11-01", summary: "Earlier deployment." }] },
    { id: "remote-tag", path: "/remote/tag", host: "example-host" },
  ] }));
  const result = lookupProjects("terminal", cwd, { home }); assert.equal(result.ok, true); assert.equal(result.projects.length, 1); assert.equal(result.projects[0].records[0].historical, true); assert.deepEqual(result.projects[0].checks.commands, ["npm run test"]);
  assert.equal(existsSync(sentinel), false); assert.equal(lookupProjects("remote-tag", cwd, { home }).projects[0].status, "historical-remote-record");
  assert.match(projectMapContext(cwd, "terminal", { home }), /not instructions/);
});

test("the lead discovers skills and records/searches observations through real local tool dispatch", async () => {
  const cwd = project("lead-dispatch");
  skill(join(cwd, ".nova", "skills"), "repair", "# Repair\nDiagnose parser boundary failures.\nFULL_ON_DEMAND_INSTRUCTIONS\n");
  const { runTurn } = await import("../src/main/agent.js");
  const { setWorkdir } = await import("../src/main/workdir.js"); setWorkdir(cwd);
  const call = (name, args) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
  let requests = 0;
  const result = await runTurn([], "Help inspect this project's parser memory and skills.", () => {}, new AbortController().signal, {
    sessionId: "knowledge-dispatch",
    complete: async (messages, _cfg, _delta, _signal, options) => {
      assert.ok(options.tools.some((row) => row.function.name === "read_skill"));
      if (++requests === 1) {
        assert.equal(messages[0].content.includes("FULL_ON_DEMAND_INSTRUCTIONS"), false);
        return { content: "", tool_calls: [call("read_skill", { name: "repair" }), call("project_memory_record", { text: "Parser boundaries need explicit newline handling." })] };
      }
      if (requests === 2) {
        assert.ok(messages.some((row) => row.role === "tool" && row.content.includes("FULL_ON_DEMAND_INSTRUCTIONS")));
        return { content: "", tool_calls: [call("project_memory_search", { query: "parser newline" })] };
      }
      assert.ok(messages.some((row) => row.role === "tool" && row.content.includes('"kind":"observation"')));
      return { content: "Saved and found the project observation.", tool_calls: [] };
    },
  });
  assert.match(result.assistant, /Saved and found/); assert.equal(requests, 3);
});
