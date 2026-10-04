# Nova Collar

Nova Collar is the desktop agent harness from Hungry Nova Labs. One Electron window holds the conversation, a live terminal, and the tools that do the work. You bring the model. Nothing in this download locks you to one.

We use this harness at Hungry Nova Labs. I am building it into a tool we depend on, and I put it on GitHub to hear what you find.

## Install

**The Mac app.** Signed, notarized builds go to [Releases](https://github.com/Squidspork/nova-collar/releases) as they are cut. Download the `.dmg`, drag Nova Collar to `/Applications`, and open it. For Apple Silicon Macs running macOS 12 or newer. Windows x64 builds are also available; see below.

To build it yourself from the checkout:

```bash
npm install
npm run pack
```

The app lands at `dist/mac-arm64/Nova Collar.app`. Drag it to `/Applications` and open it.

**From source, with the CLI.** macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Squidspork/nova-collar/main/scripts/get-collar.sh | sh
```

Clone it and run `scripts/get-collar.sh` from the checkout, or run the one line above. Either way it lands in `~/NovaCollar`, installs the dependencies, and puts `nova-collar` and `np` on your PATH. It does not pick a model for you.

**Windows x64.** Download `Nova-Collar-0.2.2-x64.exe` from [Releases](https://github.com/Squidspork/nova-collar/releases/latest), run the installer, and open Nova Collar from the Start menu. Tested on Windows 11. Electron requires Windows 10 1809 or newer; Windows 10 has not been tested in this release.

To build the Windows installer from source, use Node.js 22.12 or newer:

```powershell
npm ci
npm run release:win
```

Run `dist/Nova-Collar-0.2.2-x64.exe`. The installer adds Nova Collar to the Start menu and desktop. The window terminal and host commands use Windows PowerShell. The Windows build uses node-pty’s bundled Node-API binaries, so Visual Studio is not required for the x64 package.

For local inference, install and start [Ollama for Windows](https://ollama.com/download/windows), then choose **On this computer (Ollama / LM Studio)**, scan, and select an installed model. Selecting a local model clears any previously configured fast/thinking roles so the whole turn stays local. The Hungry Nova endpoint and key remain saved for explicit model switching; there is no automatic cloud fallback. Local setup uses `http://127.0.0.1:11434/v1`. The model picker lists the models found on local servers at startup; use the local setup scan to refresh it. For example, select the exact installed tag `qwen3.8:27b` to use the normal local 27B model. Model names are discovered, not downloaded automatically. This includes custom models such as `rafw007/qwen3.8-27b-redteam:latest`.

```bash
nova-collar install     # show this computer's memory, ask where answers come from
nova-collar update      # pull the program
nova-collar update laya # fetch the optional decider and set up its Python
```

`install` shows the memory on this computer and asks where answers should come from: a model you already have, an address you paste, or a smaller local model when the memory fits. The same questions are MCP tools, `install_scan` and `install_apply`, from `node scripts/install-mcp.mjs`.

## Pick a model

Nova Collar is model-agnostic, and the window makes the connection the first thing you do. Choose a provider, paste your key, and connect:

- **Hungry Nova Labs** — paste the key we gave you and connect. One key fills both the fast and thinking roles. Use `nova-pup:4b` for tool work and `nova-pup:27b` for planning and checking. The **4B + 27B** option configures both roles. Refresh the provider model list for the models available to your account.
- **OpenAI, OpenRouter, Groq** — your own key; the address is already filled in, and common model names are offered.
- **Custom (OpenAI-compatible)** — any https endpoint you paste, with your own key and model.
- **On this computer** — scan for a local server you already run (Ollama or LM Studio). No key needed.

That is the whole connection. If I set up Nova Collar on another computer and hand someone a key, the window connects and starts working — no files to edit, nothing else to wire.

**By hand, if you prefer.** The window writes your choice to `~/.novapup/env` (macOS and Linux) or `.novapup\env` in your user profile (Windows). You can edit it directly:

- `HNL_FAST_MODEL` / `HNL_FAST_URL` — the fast model works the harness on this computer.
- `HNL_THINK_MODEL` / `HNL_THINK_URL` — the thinking model forms the plan and checks what the work turned up.
- Leave both lanes blank and the one chat model does the whole turn. Give it two different models or endpoints and the split turns on.
- A lane can carry its own key with `HNL_FAST_KEY` / `HNL_THINK_KEY`. Leave those blank and the lane borrows the chat key, so a single key can drive both lanes.

Search is bring-your-own; Nova Collar does not ship web search, page extract, or docs search. On a Mac, to let the window see and drive the screen, grant it Accessibility and Screen Recording when macOS asks. Windows and Linux do not have that screen control.

## Approval before risky actions

Nova Collar asks before broad file replacements, emptying an existing file, writes outside the working folder, changes to standing instructions, shell commands that are not recognized as read-only, agent typing in the terminal, and actions that change remote applications or containers. The dialog shows the action, path or command, reason, and a content preview for file writes. Choose **Allow once** or **Deny**. Approval covers that one action; if the file changes while the dialog is open, the agent must read it again.

These checks also cover sub-agents, background work, and automatic harness execution. A denied request stops the current task. Requests expire after ten minutes, and contexts without an approval handler deny them. These are application-level checks, not an operating-system sandbox; approving a shell command authorizes the effects of that command. Small edits inside the working folder can proceed without a dialog.

## Release findings and development

[0.2.2 release notes](CHANGELOG.md) record the Windows findings and fixes shared with Mac. Local and hosted connections stay explicit, the smaller model gets a bounded tool loop, and success claims must follow tool evidence. Windows has PowerShell, file, host, network, and Docker tools; native screen control remains Mac-only. Docker requires a running Docker engine.

For a source checkout, use Node.js 22.12 or newer, `npm ci`, then `npm test`. Tests isolate app settings in temporary folders and do not require a model server or GPU. CI runs the common suites on Mac and Windows, with Windows host-command checks and additional Mac harness checks. Mac release builds need Xcode command-line tools, a Developer ID certificate, and Apple notarization credentials; see [release instructions](docs/releasing.md).

## How a turn works

A turn can start with a small decision model called Laya. Laya does not write the reply. It scores one short choice about what the request needs: answer in words, look something up, work with files, use the terminal, check the network, use Docker, drive the Mac screen, work on code, or refuse.

Laya is optional. With it, the choice is sharper. Without it, the window still runs: an always-on structural check still refuses what should be refused, and a set of heuristics still routes the work. Installing Laya never becomes a thing the window depends on to answer.

From there the fast model works the harness and the thinking model plans and checks the result. Laya stands between them and picks the path. Plain answers come from the thinking model, and if either model stops answering, the other takes the turn. With one model configured, that model fills both roles.

The chat model then works a tool pack — a group of tools for one kind of work: the terminal, this system, the network, Docker, an incident, the Mac screen, or a remote computer. A locked pack takes priority over Laya's normal selection, but refusal takes priority over both. Requests to bypass the safety rules or dump real secrets are routed to refusal. A sub-agent handles a short tool loop inside a single pack.

### Laya, the decider

Laya is a task-routing classifier. It reads a request and picks the lane; it carries no private data of ours or yours. It starts from [`convaiinnovations/laya`](https://huggingface.co/convaiinnovations/laya) (Apache-2.0), which builds on Answer.AI's ModernBERT-large, and our checkpoint is trained only on Nova Collar's own job, loop, goal, and audit questions. That makes it safe to pass along with the app.

To add it:

```bash
nova-collar update laya
```

That downloads the checkpoint (about 1 GB) into a writable spot the app can reach, and sets up a small Python environment for it — PyTorch and a few companions from PyPI, a few hundred MB more on first run. After that the window finds the model on its own; point `NP_LAYA_MODEL` at a checkpoint if you keep one elsewhere. Nothing about Laya reaches out to the network.

### The terminal is a two-way door

The window has a live terminal. The agent can type into it and read it, so it can run a command where you can watch, and the chat shows what it typed. You can also talk back to the agent from that same terminal: `np "what you want"` runs a turn on the same chats as the window. When the agent changes its working directory, the terminal follows. It is meant for frictionless system work — you and the agent at one prompt.

### The pack

The bots are the pack. Each has a standing role, a voice, and one steer pack. Members on the same pack teach each other: a correction, or a failed step followed by a different step that worked, is kept for the others. Laya drops a lesson that does not belong to that pack, or that was already taught.

The Pack is also where longer work goes, so the conversation keeps moving. You open the Pack and write a task — what needs doing, what done looks like, and who holds it — or you tell Nova Collar in the chat to take care of it. A task runs once, every minute, or every three minutes, until the goal is met. The board shows what is open, worked, and finished. Before a file is replaced, three older copies are kept. If you assigned the task, the Pack waits for you before it writes; if Nova Collar assigned it, the Pack keeps going until an overwrite or a delete, then waits. When the goal is met, the writeup lands in a chat named for that task.

It is good for work you can look at: a repeated check, a small patch, a reachability watch. I would not hand it a long coding job and walk away.

### Doing the work means checking the work

The difference I care about is between saying something worked and having a reason to say it worked.

- **Code.** The harness requires compilation, execution, and a checklist against what was asked before the agent may call the job passed.
- **Facts.** A claim has to come from something the agent actually read this turn. Otherwise it says it does not know.
- **Repeats.** On the second identical tool call, Laya judges whether to continue or stop. A third identical call is stopped. A terminal that is still moving is not the same as progress.

For longer work in the conversation, `/goal` followed by an outcome sets a standing goal; `/goal` shows it and `/goal clear` removes it. While a goal is open, a repeated tool call is skipped so the turn takes a different step instead of ending in "Stopped." Before Nova Collar brings an answer back, it writes down the claim it wants to make, asks the opposite, and tries to disprove the opposite with a tool result. If it cannot, it drops that path and tries another, or says the claim is not proven.

## License and thanks

Nova Collar is Apache-2.0, Copyright 2026 Hungry Nova Labs. The full terms are in [`LICENSE`](LICENSE), the attribution is in [`NOTICE`](NOTICE), and the same thanks — in plainer words — open from the name in the window's corner.

The window stands on other people's work, and the duty their licenses ask is small: keep their notices with any real copy.

- **MIT.** Electron, xterm.js and its fit addon, node-pty, and qrcode make up the window and its terminal; electron-builder and @electron/rebuild package it. Thank you to the Electron contributors and GitHub, the xterm.js authors (SourceLair and Christopher Jeffrey), Christopher Jeffrey again for node-pty, and Ryan Day for qrcode.
- **BSD, inside Electron.** Electron ships Chromium; Chromium's notices travel with the Electron distribution.
- **Apache-2.0.** Laya starts from `convaiinnovations/laya`, which builds on Answer.AI's ModernBERT-large. Thank you to Convai Innovations and to Answer.AI. Our checkpoint is a modified copy; their license, a note that the weights changed, and their attribution travel with it.
- **Optional, from PyPI.** If you add Laya, its Python environment pulls PyTorch, transformers, safetensors, huggingface_hub, and numpy under their own licenses. None of these ship inside the window.
- **Ollama (MIT).** If setup installs it for a local model. Nova Collar does not ship Ollama inside the window.

## About Hungry Nova Labs

Hungry Nova Labs is a veteran-owned technology company in Augusta, Georgia. We work with private AI, Linux systems, hosting, and infrastructure. The reason behind that work is straightforward: build things that help people do something useful while keeping control over their data and the systems they depend on.

Being able to talk to a computer naturally is a big step forward. Turning that conversation into working code, a solved problem, or something that makes someone's day easier is where the progress becomes meaningful. That is what I am building Hungry Nova Labs around — the infrastructure underneath a service and the tools people use to reach it, because a good interface needs a dependable system behind it, and a powerful system should be something people can actually use.

The public face of that work is [hungrynovalabs.com](https://hungrynovalabs.com). If you want me, not the company, my credentials are at [msalinas.us](https://msalinas.us). Nova Access is one login for the private apps, portals, and AI you want kept out of a shared public cloud. We design it and we run it, and you can take it with you. You hold the keys. We don't keep a spare.

Nova Collar is one part of that: a conversation brought closer to an outcome someone can inspect, understand, and use.

**Own Your Data. Own Your Future.**
