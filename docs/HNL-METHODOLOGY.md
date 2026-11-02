# Hungry Nova Labs methodology

Nova Collar is Hungry Nova Labs' public desktop harness. Nova Tag is the small
terminal harness; Nova Pocket is the phone companion. They share operating
principles and lessons, while retaining separate interfaces, state, releases and
capability limits. A feature in a sibling product is evidence for a design, not
proof that Collar implements it.

This document describes the method. [Porting status](PORTING-STATUS.md) names the
implemented pieces and remaining work.

## Work from the user's actual request

Respect the requested stage. A question, review or comparison needs an answer;
an implementation request authorizes the necessary work within its stated scope.
Keep the original objective and constraints when more input arrives. Ask for a
material missing detail or preference; decide routine implementation details.

Keep one lead conversation. Deliver messages sent during work separately, in
order, at a safe model/tool boundary. New guidance does not rewrite output that
already streamed or undo an action that started. Stopping, errors and restarts
leave unconsumed input visible and paused until a deliberate continuation.

Structured questions require a deliberate answer. Suggestions start unselected;
custom text remains available. Preserve the chat draft separately from the
question draft. Only the user's submitted words carry user authority. Model
question wording, helper goals and tool output cannot manufacture permission.

## Let evidence determine completion

A tool result supports a statement about what happened. Generated prose does not
prove a file was written, a build passed, a deployment changed, or a screen
works. Distinguish syntax checks, execution, tests, project checks and visual
inspection. A skipped, unavailable or partial check leaves the relevant work
unverified.

Unfinished verification belongs to the harness, outside the model's summarized
conversation. Persist it by session, canonical project/path and source identity.
A pass on another file cannot erase a failure. A syntax pass cannot erase a
runtime or test failure. Changed source invalidates earlier passing evidence.
Cancellation and budget exhaustion preserve unfinished work.

Repair the observed cause in small steps: read the diagnostic and relevant
source, recall applicable prior evidence, change the cause, then recheck. Do not
weaken a test merely to get a pass. Keep retries and repair prompts bounded;
report unresolved work explicitly when those limits are reached. Model or Laya
advice can suggest the next step; it does not verify the result.

Use current results for current claims. A dated test receipt or recalled lesson
describes the check at that time. A configured endpoint, protocol name or model
alias does not establish the live backend, offline operation or model quality.
Retain historical deployment and performance records rather than inferring the
past from today's routing.

## Preserve work without exaggerating coverage

Read before overwriting substantial existing files. Preserve existing user
changes and keep review focused on the task. Backups must say which operations
and paths they cover, their size limits and what they omit. A few spare file
versions are useful, but do not constitute a complete project checkpoint or
undo system.

Declare shell mutation paths before execution. Undeclared shell writes,
external applications, remote actions and spawned processes need their own
coverage; do not imply that file-tool backups cover them. Do not automatically
replay interrupted or uncertain side effects. Restoring conversation history
does not reverse effects on disk or in another service.

## Keep the harness small and capabilities explicit

Offer the tools relevant to the task. List skill descriptions and read their
full instructions only when needed. Retrieve a bounded set of relevant memory
and source records; avoid drive-wide crawling or placing every tool manual in
every request.

When the permitted catalog would exceed 30% of the effective context window,
offer task-relevant schemas and `discover_tools`. Discovery searches bounded
metadata or selects up to six exact permitted names; full schemas then appear
on the next request. Discovery executes no operation. Hidden or out-of-catalog
calls cannot execute, and helpers inherit the separate permission catalog.
Local request metadata uses the same effective window sent as `num_ctx`.

Compaction should retain the user's goal, constraints, decisions, verified
progress, pending obligations and next action. Preserve complete tool call and
result pairs. Reserve the active model's output budget before its context fills.
Summaries compress evidence; they do not create successful checks.

Context inspection must remain useful when a request is too large. The next
preview reports retained messages, schema costs and negative headroom with an
explicit blocked-dispatch note. It neither sends the request nor replaces the
last dispatched snapshot; the actual dispatch still fails its budget check.

Project maps locate work and dated records. Their commands and relationships
have provenance and remain observations until verified. Memory should preserve
source, date, scope and verification evidence. Verified repair retrieval is not
model weight training; similarity scores are relevance signals, not correctness
probabilities.

## Delegate bounded work and keep authority with the lead

Helpers receive a limited goal and the parent's permitted tools and role. They
cannot recursively delegate, ask interactive questions, grant themselves
permission or broaden a phone role into local desktop access. Tool failures,
incomplete answers, cancellation and limits remain visible to the lead. A
confident helper summary cannot turn them into verified success.

Keep every requested tool call paired with a result, including a refusal or a
cancelled/skipped execution. Check cancellation before each action. Stop after
a held action instead of executing the rest of a batch. Keep reads, output,
rounds, processes and time bounded for the tools involved.

## Test behavior independently of model claims

Use deterministic integration tests to verify steering, questions, receipts,
permission boundaries, cancellation and persistence. State when a test uses a
fixture rather than a live model or service.

For coding evaluations, use disposable fixtures, a failing reproduction,
allowed edit scope and an independent grader. Isolate evaluation memory from
personal memory. Record source identity, settings, requested and reported model
identity, tool events, timing, failed checks and the final outcome. Protecting
fixture paths and graders does not provide an operating system sandbox.

Report the cases measured. A successful smoke test, accepted image request or
working transport does not prove general coding parity, accurate image
understanding or a complete product workflow. Verify the visible product flow
when its behavior or layout matters.

## Keep the public product separate from owner development

Public releases use the public Git source and a clean public profile. The
owner's development build keeps its own name, application identity and storage.
Do not package owner memory, SSH credentials, private project maps, connection
settings, endpoints, transcripts or investigation reports into a public build.
Keep services bring-your-own and report their configured dependencies honestly.

## Review sources

The November 2026 review compared Nova Collar's public baseline `b28af65` with
the newer Nova Tag working implementation and Nova Pocket release evidence:

- Nova Tag: `src/agent/{loop,prompt,compact,learning,changes}.js`,
  `src/session/{tasks,checkpoints,jobs,workspaces}.js`, project identity/memory,
  evaluation runner, and the associated reliability and coverage tests.
- Nova Pocket / Nova Tag: **Nova-Conversation-Update.txt** and
  **Nova-Conversation-Verification.json**, November 1, 2026. These record Pocket
  2.4.0 build 31 and the ordered input/question work, with fixture tests and
  separate installation/data-preservation evidence.
- Nova Pocket 2.4.1 build 32 / Nova Tag context update:
  **RepoPrompt-and-Nova-update.txt** and **Nova-Context-Verification.json**,
  November 2, 2026. Request metadata distinguishes the last dispatched request
  from a fresh local preview; bounded helper packets name original/latest user
  sources, omitted context and image provenance. Context metadata contains
  counts/paths instead of duplicating private prompts or file contents.
- Original Nova Tag design history, October 17–22, 2026: minimal modular tools,
  smart compaction, evidence-based completion, and explicit exclusion of owner
  private data from future public releases.

Those historical owner records were consulted during development. They are not
bundled runtime dependencies or public product data.
