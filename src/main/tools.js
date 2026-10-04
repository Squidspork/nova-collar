import { authorizeAction } from "./approvals.js";
import { cdCommand } from "./platform.js";
import { readFileSync, existsSync } from "node:fs";
import { generateImage } from "./comfy.js";
import { isDeskTool, runDesk } from "./mac.js";
import { isHnlTool, runHnlTool } from "./hnl.js";
import { isPackTool, LOCAL_PACK_TOOLS, packToolDefs, runPack } from "./packs.js";
import { readTerminal, sendTerminal } from "./term-bridge.js";
import { listDir, readUserFile, runBash, writeMemory, writeUserFile } from "./files.js";
import { setWorkdir } from "./workdir.js";
import { denySecretCommand, publicHttpsUrl, redactSecrets } from "./safe.js";
import { watchJailbreak } from "./laya-steer.js";
import { holdMessage, mutationHold } from "./spare.js";
import { shellTargets } from "./harness-check.js";
import { saveTask } from "./tasks.js";

const xy = {
  x: { type: "integer", description: "Pixels from left of the last screenshot" },
  y: { type: "integer", description: "Pixels from top of the last screenshot" },
};

const HNL_SEARCH = new Set(["web_search", "extract", "scrape", "docs_search"]);

function fn(name, description, properties = {}, required = []) {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  };
}

export function toolDefs({ local = false, search = false } = {}) {
  const defs = [
    ...packToolDefs(fn, { lean: local }),
    fn("subagent", "Cursor-style specialist sub-agent. Multi-step pack work. pack: host, net, docker, incident, hnl, computer, desk, term.", { task: { type: "string" }, pack: { type: "string" } }, ["task", "pack"]),
    fn("pack_task", "Give the Pack a task so Nova Collar can keep working. title is the job. goal is what done looks like. bot is an existing member name, or omit it and a member is made. every is 0 (once), 1, or 3 minutes.", {
      title: { type: "string" },
      goal: { type: "string" },
      detail: { type: "string" },
      bot: { type: "string" },
      pack: { type: "string" },
      every: { type: "integer" },
    }, ["title"]),
    fn("list_dir", "List a local directory. Defaults to the window working directory.", { path: { type: "string" } }, []),
    fn("set_workdir", "Set the window working directory and cd the live terminal there. Use this before writing project files.", { path: { type: "string" }, create: { type: "boolean" } }, ["path"]),
    fn("set_rules", "Write your operating rules (guardrails). You live by this file.", { content: { type: "string" } }, ["content"]),
    fn("set_personality", "Rewrite your personality. This window is you.", { content: { type: "string" } }, ["content"]),
    fn("mac_info", "desk pack: This system screen size, pointer, front app, accessibility trust."),
    fn("mac_screenshot", "desk pack: Capture this system desktop. Click using these coordinates. Origin top-left."),
    fn("mac_click", "desk pack: Left-click this system at screenshot pixels.", xy, ["x", "y"]),
    fn("mac_double_click", "desk pack: Double-click this system.", xy, ["x", "y"]),
    fn("mac_right_click", "desk pack: Right-click this system.", xy, ["x", "y"]),
    fn("mac_move", "desk pack: Move the pointer on this system.", xy, ["x", "y"]),
    fn("mac_drag", "desk pack: Drag on this system.", { ...xy, x2: { type: "integer" }, y2: { type: "integer" } }, ["x", "y", "x2", "y2"]),
    fn("mac_scroll", "desk pack: Scroll this system.", { ...xy, direction: { type: "string" }, amount: { type: "integer" } }, ["direction"]),
    fn("mac_type", "desk pack: Type into the focused field on this system.", { text: { type: "string" } }, ["text"]),
    fn("mac_key", "desk pack: Press a key. macOS desktop control understands enter, tab, escape, cmd+c, cmd+v, cmd+space, cmd+tab.", { key: { type: "string" } }, ["key"]),
    fn("mac_open", "desk pack: Open a URL, path, or app on this system.", { target: { type: "string" } }, ["target"]),
    fn("mac_focus", "desk pack: Focus a running app on this system.", { app: { type: "string" } }, ["app"]),
    fn("mac_windows", "desk pack: List on-screen windows on this system."),
    fn("web_search", "hnl pack: SearxNG via Hungry Nova. Current public web facts.", { q: { type: "string" } }, ["q"]),
    fn("extract", "hnl pack: Clean text from a public page.", { url: { type: "string" } }, ["url"]),
    fn("scrape", "hnl pack: Firecrawl scrape of a public page.", { url: { type: "string" } }, ["url"]),
    fn("docs_search", "hnl pack: Search Hungry Nova product docs.", { q: { type: "string" } }, ["q"]),
    fn(
      "memory_remember",
      "hnl pack: Store a durable fact in Honcho memory for this tools key.",
      { text: { type: "string" } },
      ["text"],
    ),
    fn(
      "memory_recall",
      "hnl pack: Ask Honcho what it already knows about this user.",
      { q: { type: "string" } },
      ["q"],
    ),
    fn(
      "memory_search",
      "hnl pack: Search stored Honcho notes for this tools key.",
      { q: { type: "string" } },
      ["q"],
    ),
    fn(
      "generate_image",
      "Studio Flux.2 Klein. Full visual prompt.",
      { prompt: { type: "string" }, width: { type: "integer" }, height: { type: "integer" } },
      ["prompt"],
    ),
    fn(
      "computer",
      "HNL remote 1280x720 desktop. Prefer computer_* when possible.",
      {
        action: { type: "string" },
        x: { type: "integer" },
        y: { type: "integer" },
        x2: { type: "integer" },
        y2: { type: "integer" },
        text: { type: "string" },
        key: { type: "string" },
        url: { type: "string" },
        command: { type: "string" },
        path: { type: "string" },
        content: { type: "string" },
        prompt: { type: "string" },
        direction: { type: "string" },
        amount: { type: "integer" },
        ms: { type: "integer" },
      },
      ["action"],
    ),
    fn("computer_guide", "HNL computer playbook. Call first for the remote desktop."),
    fn("computer_screenshot", "See the HNL 1280x720 agent desktop."),
    fn("computer_open", "Open a public URL on the HNL computer.", { url: { type: "string" } }, ["url"]),
    fn("computer_click", "Click the HNL computer.", xy, ["x", "y"]),
    fn("computer_double_click", "Double-click the HNL computer.", xy, ["x", "y"]),
    fn("computer_right_click", "Right-click the HNL computer.", xy, ["x", "y"]),
    fn("computer_move", "Move pointer on the HNL computer.", xy, ["x", "y"]),
    fn("computer_drag", "Drag on the HNL computer.", { ...xy, x2: { type: "integer" }, y2: { type: "integer" } }, ["x", "y", "x2", "y2"]),
    fn("computer_scroll", "Scroll the HNL computer.", { ...xy, direction: { type: "string" }, amount: { type: "integer" } }, ["direction"]),
    fn("computer_type", "Type on the HNL computer.", { text: { type: "string" } }, ["text"]),
    fn("computer_key", "Key on the HNL computer.", { key: { type: "string" } }, ["key"]),
    fn("computer_wait", "Wait on the HNL computer, then screenshot.", { ms: { type: "integer" } }),
    fn("computer_exec", "Shell on the HNL computer workspace.", { command: { type: "string" } }, ["command"]),
    fn("computer_read", "Read a file on the HNL computer workspace.", { path: { type: "string" } }, ["path"]),
    fn("computer_write", "Write a file on the HNL computer workspace.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    fn("computer_pi", "Run Pi on the HNL computer for a coding task.", { prompt: { type: "string" }, model: { type: "string" } }, ["prompt"]),
  ];
  const supported = defs.filter((row) => process.platform === "darwin" || !row.function.name.startsWith("mac_"));
  if (local) {
    const keep = new Set([
      ...LOCAL_PACK_TOOLS,
      "subagent",
      "pack_task",
      "list_dir",
      "set_workdir",
      "web_search",
      "extract",
      "memory_remember",
      "memory_search",
      "computer_exec",
      "computer_read",
      "computer_write",
      "computer_screenshot",
      "generate_image",
      "mac_screenshot",
      "mac_info",
      "mac_windows",
    ]);
    return supported.filter((row) => keep.has(row.function?.name || "") && (search || !HNL_SEARCH.has(row.function?.name || "")));
  }
  if (search) return supported;
  return supported.filter((row) => !HNL_SEARCH.has(row.function?.name || ""));
}

export function wantsRemoteComputer(text) {
  return /\b(hnl computer|remote (desktop|workspace|computer)|on the remote|that other machine)\b/i.test(String(text || ""));
}

export function plainToolDef() {
  return fn(
    "say_plain",
    "Plain-language outlet. words is what was said. info is raw data. Returns one human sentence and does not check the computer again.",
    { words: { type: "string" }, info: { type: "string" }, text: { type: "string" } },
  );
}

export function windowToolDefs({ local = false, search = false, remote = false } = {}) {
  const defs = toolDefs({ local, search });
  if (remote) return defs;
  return defs.filter((row) => {
    const name = row.function?.name || "";
    return name !== "computer" && !name.startsWith("computer_");
  });
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function executeTool(name, rawArgs, cfg, ctx = {}) {
  try {
    const execution = { ...ctx };
    const args = structuredClone(parseArgs(rawArgs));
    const result = await runTool(name, args, cfg, execution);
    return { ...result, approved: execution.actionApproved === true };
  } catch (error) {
    return { ok: false, error: redactSecrets(error.message || "tool failed") };
  }
}

export const TOOL_ALIAS = {
  bash: "host_run",
  read_file: "host_file_read",
  write_file: "host_file_write",
};

export function realToolName(name) {
  return TOOL_ALIAS[name] || name;
}

function shellToolName(text) {
  const word = String(text || "").trim().split(/\s+/)[0] || "";
  if (!LOCAL_PACK_TOOLS.has(word)) return "";
  if (word === "term_send" || word === "term_read" || word === "host_run") return "";
  return word;
}

async function runTool(name, rawArgs, cfg, ctx = {}) {
  name = realToolName(name);
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(String(name || ""))) {
    return { ok: false, error: "unknown tool" };
  }
  if ((name === "computer" || name.startsWith("computer_")) && ctx.role !== "phone" && !ctx.remote) {
    return { ok: false, error: "That is the remote computer. On this computer use host_file_write, host_file_read, or host_run." };
  }
  const args = parseArgs(rawArgs);
  if (ctx.bot && (name === "set_rules" || name === "set_personality" || name === "pack_task")) {
    return { ok: false, error: "teammates cannot rewrite Nova Collar or assign the pack" };
  }
  if ((name === "host_run" || name === "term_send") && denySecretCommand(args.command || args.text)) return { ok: false, error: "blocked a secrets command" };
  const approval = await authorizeAction(name, args, ctx);
  if (!approval.ok) return approval;
  ctx.actionApproved = approval.approved;
  if (approval.approved) ctx.allow = true;
  if (name === "pack_task") {
    const { assignTask } = await import("./tasks.js");
    const assigned = assignTask({
      title: args.title,
      goal: args.goal,
      detail: args.detail,
      bot: args.bot,
      pack: args.pack,
      every: args.every,
      make: !args.bot,
      by: "novapup",
    });
    if (!assigned && (watchJailbreak(args.title) || watchJailbreak(args.goal) || watchJailbreak(args.detail))) {
      return { ok: false, error: "I won't do that." };
    }
    if (!assigned) return { ok: false, error: args.bot ? "No pack member by that name." : "Need a task title." };
    return {
      ok: true,
      id: assigned.task.id,
      title: assigned.task.title,
      bot: assigned.bot.name,
      chat: assigned.chat.title,
      every: assigned.task.every,
    };
  }
  if (name === "extract" || name === "scrape" || name === "computer_open" || (name === "computer" && args.action === "open")) {
    const allowed = publicHttpsUrl(args.url);
    if (!allowed.ok) return allowed;
    args.url = allowed.url;
  }
  if ((name === "bash" || name === "host_run") && denySecretCommand(args.command)) {
    return { ok: false, error: denySecretCommand(args.command) };
  }
  if (name === "bash" || name === "host_run") {
    const typed = shellToolName(args.command);
    if (typed) return { ok: false, error: `${typed} is a tool. Call ${typed}. Do not type it into the shell.` };
    const kind = mutationHold({ tasker: ctx.tasker, allow: ctx.allow, command: args.command });
    const writes = shellTargets(args.command).some((file) => existsSync(file))
      || /writeFileSync|createWriteStream|\.writeFile\(/.test(String(args.command || ""));
    if (kind) return { ok: false, held: true, error: holdMessage(kind) };
    if (writes && !ctx.allow && (ctx.tasker === "user" || ctx.tasker === "novapup")) {
      return { ok: false, held: true, error: holdMessage("overwrite") };
    }
    if (ctx.allow && ctx.taskId && (kind || writes)) saveTask({ id: ctx.taskId, allow: false });
    return runBash(args.command, args.cwd);
  }
  if (name === "read_file" || name === "host_file_read") return readUserFile(args.path);
  if (name === "write_file" || name === "host_file_write") {
    const wrote = writeUserFile(args.path, args.content, { tasker: ctx.tasker, allow: ctx.allow });
    if (wrote.ok && ctx.allow && ctx.taskId && mutationHold({
      tasker: ctx.tasker,
      allow: false,
      exists: Boolean(wrote.spares?.length),
      write: true,
    })) saveTask({ id: ctx.taskId, allow: false });
    return wrote;
  }
  if (name === "subagent") {
    const { runSubagent } = await import("./subagent.js");
    return runSubagent(args, cfg, ctx);
  }
  if (name === "set_workdir") {
    const next = setWorkdir(args.path, { create: Boolean(args.create) });
    if (next.ok) sendTerminal(cdCommand(next.path));
    return next;
  }
  if (name === "term_read") return { ok: true, text: readTerminal() };
  if (name === "term_send") {
    const typed = shellToolName(args.text);
    if (typed) return { ok: false, error: `${typed} is a tool. Call ${typed}. Do not type it into the shell.` };
    return sendTerminal(args.text, args.enter !== false);
  }
  if (name === "list_dir") return listDir(args.path);
  if (name === "set_rules") return writeMemory("rules", args.content);
  if (name === "set_personality") return writeMemory("personality", args.content);
  if (name === "generate_image") return generateImage(args, cfg);
  if (isPackTool(name)) {
    const packed = await runPack(name, args);
    if (packed) return packed;
  }
  if (isDeskTool(name)) return runDesk(name, args);
  if (HNL_SEARCH.has(name) && !cfg.hnlSearch) {
    return { ok: false, error: "Search is bring-your-own. This app does not include web search." };
  }
  if (isHnlTool(name)) return runHnlTool(name, args, cfg);
  return { ok: false, error: `unknown tool ${name}` };
}

export function toolImage(name, result) {
  if (!result || typeof result !== "object") return null;
  const path = result.path;
  if ((name === "mac_screenshot" || (name === "desk" && result.path)) && path) {
    try {
      const buf = readFileSync(path);
      return { dataUrl: `data:image/jpeg;base64,${buf.toString("base64")}`, kind: "local" };
    } catch {
      return null;
    }
  }
  const image = result.data?.image || result.image;
  if (typeof image === "string" && image.trim()) {
    const mime = String(result.mime || result.data?.mime || "").toLowerCase();
    const type = image.startsWith("data:image/jpeg") || mime.includes("jpeg") ? "image/jpeg" : "image/png";
    const dataUrl = image.startsWith("data:") ? image : `data:${type};base64,${image}`;
    return { dataUrl, kind: name === "generate_image" ? "paint" : "hnl" };
  }
  return null;
}

export function compactResult(result, { max = 24_000 } = {}) {
  if (!result || typeof result !== "object") return String(result ?? "");
  const copy = { ...result };
  if (copy.data && typeof copy.data === "object") {
    copy.data = { ...copy.data };
    if (copy.data.image) copy.data.image = `[image ${String(copy.data.image).length} chars]`;
  }
  if (copy.image) copy.image = `[image ${String(copy.image).length} chars]`;
  if (copy.dataUrl) copy.dataUrl = "[image]";
  if (typeof copy.stdout === "string" && copy.stdout.length > max) copy.stdout = `${copy.stdout.slice(0, max)}…`;
  if (typeof copy.text === "string" && copy.text.length > max) copy.text = `${copy.text.slice(0, max)}…`;
  const text = redactSecrets(JSON.stringify(copy));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
