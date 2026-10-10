# Changelog

## 0.2.7 — Omarchy terminal output

- Preserve command output between shell control sequences on Omarchy and other terminals that use ST-terminated OSC records. The model's terminal reader now strips control codes without discarding the command's result.
- Cover BEL and ST terminators, terminal colors, and split PTY chunks. Use a cross-platform tool fixture in the engine tests.
- Add Linux regression and Electron smoke checks alongside Mac and Windows CI.

Validation: 16 automated suites and the Electron window, model picker, native terminal, approvals, and layout smoke test passed on Omarchy.

This is a source release.

## 0.2.6 — Model discovery and conversation reliability

- Preserve reasoning, tool-call IDs, arguments, and results across tool steps, later turns, and saved sessions. Keep complete tool/result groups when trimming history and retain image/audio attachments.
- Preserve reasoning during repair and verification steps. Give MiMo a concise function-tool contract while retaining authored personality and rules.
- Recognize verified document edits from matching write/read evidence, avoiding unnecessary retry loops while keeping checks for failed, stale, or unrelated reads.
- Include automatic provider model discovery, account-scoped catalog caching, advertised output limits, and chat-only model support introduced during 0.2.3 development.
- Replace personal identifiers in examples and remove personal profile links from release documentation.

Validation: 15 automated suites and Electron window checks cover model selection, tool history, saved sessions, terminal behavior, approvals, and document verification. Live MiMo tests exercised file creation, read-back, and a follow-up edit. These application fixes do not replace model-server configuration fixes; old conversations cannot recover reasoning that was never saved.

This is a source release. Existing platform installers remain available from earlier releases.

## 0.2.3 — Automatic model discovery

- Discover hosted models on launch, provider connection, and opening the picker. Keep the last successful catalog across restarts and show refresh errors without losing saved model selections.
- Scope catalogs to provider and account, display model descriptions, and accept newly published model IDs without an app update.
- Respect advertised output limits and omit tool parameters for chat-only models. Selecting one model clears older fast/thinking routing.
- Added streaming, file-read, catalog/routing regression coverage, and Electron picker checks. Short model probes do not establish sustained agent reliability.

## 0.2.2 — Windows support and shared reliability fixes

### Windows

- Add an x64 installer and zip, a native PowerShell terminal, and Windows implementations of host, network, and Docker commands.
- Use node-pty Node-API prebuilds so Windows packaging does not require Visual Studio.
- Quote paths containing spaces, apostrophes, and dollar signs correctly. Stop the full command process tree on timeout.
- Isolate command temporary files so cleanup cannot remove another program’s installer files. Avoid probing mapped network drives for local disk reports.
- Correct the optional Laya virtual-environment Python path on Windows.
- Hide Mac-only screen controls and report unsupported tools clearly.

### Model connections

- Select any installed Ollama or LM Studio model by its exact tag, including custom/red-team models.
- Selecting a local model clears prior fast/thinking roles while retaining hosted credentials for an explicit switch. No automatic cloud fallback from local mode.
- Refresh hosted model lists and show the actual model, endpoint, computer, and active roles. Remove stale hosted model suggestions.
- Offer the Hungry Nova 4B tool-worker + 27B planner/checker pairing. Bound smaller-model output and tool calls, and use the fast role for sub-agent tool work.

### Runtime

- Update Electron from 36.9.5 to the supported 43.7.7 series and refresh its cache dependency to resolve the dependency audit findings.

### Approval and verification on Mac and Windows

- Ask for one-time approval before risky commands, broad overwrites, emptying files, writes outside the working folder, and system-changing actions. Show the proposed action and file content before execution.
- Apply approval checks to chat tools, sub-agents, background tasks, and harness execution. Denial, cancellation, expiration, or a missing handler leaves the action unexecuted.
- Reject stale file approvals if the file changed while awaiting permission.
- Accept intentionally empty file content instead of treating it as a missing argument. Require matching write/read evidence for claims that a file was emptied.
- Hash complete tool arguments for repeat detection, repair incomplete arguments, and avoid premature success text before a tool runs.
- Fix streaming text replay, search-result evidence and error display, contradictory PASS labels, and harness backup/restore handling.

### Validation and scope

Windows 11 x64: installed and exercised with local Ollama, normal Qwen 27B and custom red-team tags, and the hosted 4B/27B option. Tested PowerShell, host facts, disk/ports/logs, quoted paths, errors/timeouts, temporary-file isolation, and allow/deny file-replacement dialogs. Docker CLI invocation was checked; container execution still requires a running engine and was not validated with the engine stopped.

Apple Silicon Mac: the same model, approval, streaming, and evidence changes are included. Native Mac screen control remains Mac-only. Windows 10 and Intel Mac builds are not part of the tested release matrix.

The next priorities are clear model identity, bounded small-model tool work, deterministic verification, and repeatable checks on both platforms before expanding autonomy.
