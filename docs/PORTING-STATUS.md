# Nova Collar methodology port

Reviewed November 2, 2026. Public source baseline: `b28af65`, Nova Collar 0.4.0.
Nova Tag's latest local working source includes changes beyond its committed
baseline. Nova Pocket evidence includes 2.4.0 build 31 and the newer November 2
2.4.1 build 32 context release;
an older checkout or a current model alias does not substitute for that evidence.

The [methodology](HNL-METHODOLOGY.md) is the shared direction. This table limits
claims to the mechanisms actually present in Collar.

| Lesson | Collar implementation | Evidence and practical limit |
| --- | --- | --- |
| Verification must survive conversation truncation and restart | `verification-ledger.js`, integrated through `harness.js` with a stable session ID | Profile-private atomic ledger; canonical project/path, current file hash, check strength and diagnostic, plus observed project revision. Tests cover restart, unrelated project pass, changed source, malformed state and isolated profiles. |
| A weaker pass cannot erase a stronger failure | Syntax, runtime, test and project phases in the ledger | Existing compiler/probe/job checks record their strength. A syntax-only pass retains a prior runtime/test/project obligation. An explicit retry uses the same existing checks; resume alone executes nothing. |
| Checked evidence must refer to the source that was checked | Hash before and after checks; stale passes invalidated when inspecting debt | A concurrent file change produces unverified status. Remote evidence is stored separately from local file identity; it does not establish the current remote filesystem after later external changes. |
| Project changes require project checks | `project-verification.js`, enabled for lead sessions | Observe current and explicitly declared roots using Git HEAD/dirty state or bounded source hashes. Detect configuration changes and newly created nested projects. Missing profiles, partial coverage, concurrent changes and active writers remain unverified. Tests include read-only work, YAML edits, profile changes, package managers and clean Git HEAD changes. |
| Preserve reversible file changes | `checkpoints.js`, the harness journal, and CLI checkpoint commands | Before/after content-addressed versions for file-tool writes and shell `paths` declared before execution. Undo preflights all files and rejects later edits or changed ancestor symlinks. Limits are 500 files, 10 MiB per file and 50 MiB per turn; uncovered paths are reported. |
| Learn repairs from matching evidence | `pack.js`, structured harness receipts and scoped notebook resolution | Automatic lessons require a failed harness check followed by a same-path/project, changed-hash, equal-or-stronger pass. Unrelated success cannot teach a fallback rule or clear another miss. Explicit user corrections remain teachable. This is retrieval data, not model weight training. |
| Helpers must report incomplete work honestly | `subagent.js` and `test-subagent.mjs` | Any failed, unavailable, malformed or disallowed tool keeps the helper result failed. Empty/truncated summaries and call/round limits are incomplete. Cancellation and held actions stop later actions. Every requested call receives a paired result. |
| Helpers cannot broaden parent authority | Role restriction and parent tool-catalog intersection | No recursion, interactive question tool or pack assignment in helper tools. Phone helpers cannot access local desktop packs. Existing action approval remains authoritative; the lead supplies its permitted catalog. |
| Ordered input and deliberate questions | Lead conversation integration in `agent.js`, `index.js` and the renderer | Verify the dedicated queue/question tests and the release's UI checks. The sibling evidence alone does not establish Collar UI parity. |
| Public and owner development builds need separate state | Public/development channel configuration and packaging | Build identity, profile location and launchers must be verified together. Renaming a window alone does not isolate user data. |
| Progressive instructions reduce context cost | `skills.js` and lead skill tools | List names/descriptions from bundled `materials/skills`, profile `skills`, and project `.nova/skills`. Read full instructions on demand. Limits are 64 entries per root and 32 KiB per file; symlink escapes are rejected. Parent tool/phone/helper restrictions are retained. |
| Local project memory needs source provenance | `project-memory.js` and lead memory tools | Profile-private atomic observations and matching verified repairs, with dates, source paths/hashes and command/session evidence. Offline keyword retrieval calls no model or embedding service. Git worktrees share project identity while nested packages remain distinct. Model notes cannot choose verified status. |
| Locate relevant sibling work and history explicitly | `project-map.js` and `project_lookup` | Optional profile `project-map.json` locates registered paths, aliases, relationships and dated records. Metadata reads explicit manifests only; no commands, drive crawl or remote connection. No owner registry is bundled. |
| Bounded helper provenance | `helper-context.js` and saved selection metadata | Select the marked original request, latest incorporated input and recent messages in order. Name source IDs/roles/timestamps and omitted message/character counts. Exclude pending input. Text remains below 12,000 characters; images have a separate bound and name their real source. Read-only helper history search stays inside incorporated conversation. |
| Inspect the actual context package | Context budgeting, context snapshots and `context_info` | Budget complete message/tool groups and reserve output before dispatch. Last-request metadata and next local preview have different meanings. Metadata names representations/source paths and omission estimates, without copying full prompts. Estimates are not provider billing or a guarantee of summary completeness. |
| Report dependencies and evaluation scope honestly | `dependencies.js` and `scripts/evaluate-harness.mjs` | Dated local version observations and isolated deterministic suite reports with source identity. No installation, backend inference, live model-quality score or operating system sandbox claim. |

## Existing behavior retained

Collar already reads files, preserves three older copies before a file-tool
replacement, checks supported source files, probes supported programs and can
run a nearby `harness.json` job check. Its established approval policy still
applies to tool execution. The methodology port does not silently install
dependencies, run every package script or bypass approvals.

The public baseline's page check is structural. Nonempty HTML/CSS and textual
checklist matches do not prove correct browser behavior or visual layout.
Likewise, a syntax-only check remains syntax evidence. Observed project modules
are compiled and verified by the project's checks rather than launched as
standalone applications. Explicit file verification and work outside observed
projects retain the existing probe behavior; interactive programs and services
need representative explicit verification.

Shell mutation declarations use the `host_run.paths` array. Declarations are
captured before execution for the per-turn checkpoint; observed roots are
checked after tools even if a command fails after writing. The existing limited
output-path recognition also retains per-file obligations. Undeclared writes
outside observed roots and external applications remain outside this coverage.
There is no drive-wide audit or background daemon supervisor.

## Declared project checks

Add `.nova/checks.json` to a project when its manifests do not describe the
required verification:

```json
{"commands":["python3 -m py_compile app.py","python3 -m unittest discover -s tests"],"timeoutMs":90000}
```

This is trusted executable configuration, subject to the existing command
approval policy. It supports 1–8 command strings, each at most 4,000 characters,
and a timeout of up to 90 seconds per command. Dependencies are not installed
automatically. `.novatag/checks.json` is accepted for sibling compatibility;
`.nova/checks.json` takes precedence. Existing `harness.json` checks retain their
expected-output condition.

Without a custom profile, Collar selects declared `typecheck`, `build` and
`test` package scripts using npm/pnpm/yarn/bun, Cargo check/tests, Go tests or
Swift tests. It does not choose development servers or deployment scripts.
Observation is bounded to 5,000 entries, 10 MiB per file and 30 MiB of source
content per root. Partial observation remains unverified even if the commands
pass. Model-generated changes to verifier configuration require human review.

## Skills, project observations and history

The local lead has `list_skills`, `read_skill`, `project_memory_record`,
`project_memory_search` and `project_lookup`. Full skill instructions stay off
the initial prompt; use `read_skill` before applying one. Model-written notes
are observations. Only the harness's internal matching failure/repair hook can
record a verified repair, and it rechecks the current source hash. Recalled
material is historical evidence rather than standing instructions or a fresh
successful check.

The optional profile registry uses this shape:

```json
{"version":1,"projects":[{"id":"example","name":"Example app","path":"/absolute/path/to/app","host":"local","aliases":["example"],"records":[{"path":"/absolute/path/to/report.txt","asOf":"2026-11-02","summary":"Earlier investigation","historical":true}]}]}
```

Relationships may name another registered `projectId`, a `kind` and an evidence
path. Remote entries use an explicit `host`; their paths remain historical
records until checked separately. Registry reads are bounded to 100 projects,
512 KiB and 10 selected results. Local memory is bounded to 500 notes and 2 MiB
per project, with a default of five keyword matches per search. Data lives in
the selected application profile and is excluded from public source packages.

## Follow-up capabilities requiring separate implementation

These are reviewed Nova Tag/Pocket lessons, not completed Collar features:

- **Managed jobs.** Tag has inspectable jobs with bounded logs and persistent
  stale/unattached state. Collar's owned command runner and active-writer gate
  do not provide a persistent service supervisor or an equivalent jobs UI.
- **Optional semantic retrieval.** Tag adds configured embeddings to keyword
  search. Collar's project memory works offline and requires no hosted
  embedding service; an optional semantic adapter must preserve the same
  source/evidence and fallback boundaries.
- **Live coding evaluation cases.** Deterministic suites verify harness
  behavior independently of model prose. A live coding study still needs
  disposable fixtures, failing reproductions, protected graders, edit-scope
  checks and requested/reported model identities before comparative
  model-quality claims can be made.
- **Configured fallback policy.** Tag can hand off once under
  bounded failure conditions without losing checks or starting on cancellation.
  That policy and its dated route audit must be adapted to user-selected
  providers; owner model names/performance do not become public defaults.

## Validation scope

`test-verification.mjs` and `test-projects.mjs` use temporary source projects and their own
`NOVAPUP_HOME`. They check persisted obligations and file identity without live
model calls. `test-subagent.mjs` uses deterministic model/tool fixtures to test
failure reporting, protocol pairing, cancellation and permissions. The existing
engine suite checks compiler/probe behavior and legacy harness semantics.
`test-checkpoints.mjs` verifies before/after restoration, reversible undo,
conflict preflight, swapped ancestor symlinks, size coverage and declared shell
paths. Pack/crew tests reject unrelated, unchanged-source and weaker-check
learning.
`test-project-knowledge.mjs` covers progressive disclosure, symlink containment,
observation-only notes, repair evidence, stale hashes, isolated profiles,
Git/worktree identity and a real lead tool-dispatch round trip with deterministic
model responses.

Nova Pocket's November 1 report records 59 selected unit tests and two final
simulator UI tests for ordered input/questions, plus separate installation and
data-preservation checks. Nova Tag's report records 188 passing tests before
the final display refinement and 18 focused tests afterward. Those are dated
sibling results, not freshly run Collar checks or live model quality scores.
The newer November 2 context report records Tag's 195 passing serial tests and
Pocket 2.4.1 build 32's 56 selected simulator tests, including seven context
regressions. Its default concurrent Tag run had a background-job fixture timeout
while isolated job tests passed; that limitation remains part of the history.
Pocket's signed install and post-launch preservation were checked separately
from deterministic context behavior. Neither result is a live answer-quality
benchmark.

## Streaming protocol check

Tool argument fragments are appended as deltas. Equal adjacent fragments can
represent repeated digits, whitespace, braces or file content and are retained.
The implementation follows the [official function-calling streaming contract](https://developers.openai.com/api/docs/guides/function-calling). Dedicated tests cover repeated content and interleaved calls.
