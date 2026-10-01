import { basename } from "node:path";
import { homedir } from "node:os";
import { packFor } from "./packs.js";
import { redactSecrets } from "./safe.js";

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function short(text, max = 88) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function prettyPath(path) {
  const full = String(path || "");
  const home = homedir();
  return full.startsWith(home) ? `~${full.slice(home.length)}` : full;
}

function fileName(path) {
  return path ? basename(String(path)) : "";
}

function firstLine(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function clip(text, max = 4000) {
  const value = redactSecrets(String(text || "")).trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function lines(parts) {
  return parts.filter(Boolean).join("\n");
}

export function describeTool(name, rawArgs, result = {}) {
  const args = parseArgs(rawArgs);
  const ok = result?.ok !== false;
  const path = result.path || args.path || "";
  const command = args.command || args.text || args.q || args.url || "";
  let blurb = ok ? "Done." : (result.error || result.stderr || "Didn’t work.");
  let detail = "";
  if (result.killed === "disk") blurb = "Caught a runaway write.";
  else if (result.killed === "timeout") blurb = "Stopped a hung command.";
  else if (result.killed === "stop") blurb = "Stopped.";

  if (name === "bash" || name === "host_run") {
    const out = firstLine(result.stdout);
    blurb = ok
      ? (out ? `${short(command, 42)} → ${short(out, 48)}` : `Ran ${short(command, 70)}`)
      : `Failed: ${short(result.stderr || command, 80)}`;
    detail = lines([
      command && `$ ${command}`,
      result.cwd && `cwd ${prettyPath(result.cwd)}`,
      clip(result.stdout),
      result.stderr && clip(result.stderr),
    ]);
  } else if (name === "write_file" || name === "host_file_write") {
    const bytes = result.bytes != null ? ` (${result.bytes} bytes)` : "";
    blurb = ok ? `Wrote ${fileName(path) || "file"}${bytes}` : `Couldn’t write ${fileName(path) || "file"}`;
    detail = lines([prettyPath(path), bytes.trim()]);
  } else if (name === "read_file" || name === "host_file_read") {
    blurb = ok ? `Read ${fileName(path) || "file"}` : `Couldn’t read ${fileName(path) || "file"}`;
    detail = lines([prettyPath(path), result.directory && "directory", clip(result.text)]);
  } else if (name === "list_dir") {
    const count = result.entries?.length;
    blurb = ok ? `Listed ${count ?? 0} in ${fileName(path) || prettyPath(path) || "folder"}` : "Couldn’t list folder";
    detail = lines([
      prettyPath(result.path || path),
      (result.entries || []).map((entry) => (entry.dir ? `${entry.name}/` : entry.name)).join("\n"),
    ]);
  } else if (name === "set_workdir") {
    blurb = ok ? `Now working in ${prettyPath(result.path || path)}` : "Couldn’t set folder";
    detail = prettyPath(result.path || path);
  } else if (name === "generate_image") {
    blurb = ok ? "Painted an image" : "Image failed";
    detail = args.prompt || "";
  } else if (name === "memory_remember") {
    blurb = ok ? `Remembered ${short(args.text || result.id, 60)}` : "Memory write failed";
    detail = args.text || "";
  } else if (name === "memory_recall") {
    blurb = ok ? `Recalled ${short(args.q, 60)}` : "Memory recall failed";
    detail = lines([args.q, clip(result.content)]);
  } else if (name === "memory_search") {
    const count = result.hits?.length || 0;
    blurb = ok ? `Memory search: ${count} for ${short(args.q, 40)}` : "Memory search failed";
    detail = lines([args.q, ...(result.hits || []).map((hit) => hit.text)]);
  } else if (name === "web_search" || name === "docs_search") {
    blurb = ok ? `Searched ${short(args.q, 60)}` : "Search failed";
    detail = args.q || "";
  } else if (name === "extract" || name === "scrape") {
    blurb = ok ? `Read ${short(args.url, 60)}` : "Page fetch failed";
    detail = args.url || "";
  } else if (name === "say_plain") {
    blurb = ok ? "In your voice" : "Couldn’t rephrase";
    detail = clip(result.stdout || result.text || result.error || "");
  } else if (name === "term_send") {
    blurb = ok ? `Typed in the terminal: ${short(args.text, 50)}` : "Terminal send failed";
    detail = args.text || "";
  } else if (name === "term_read") {
    blurb = ok ? "Read the live terminal" : "Couldn’t read terminal";
    detail = clip(result.text);
  } else if (name === "harness") {
    blurb = ok ? (result.blurb || "harness ok") : (result.blurb || "harness failed");
    detail = clip(result.detail || result.error || result.path || "");
  } else if (name.startsWith("mac_")) {
    blurb = ok ? `This system: ${name.replace("mac_", "").replaceAll("_", " ")}` : "Screen action failed";
    detail = clip(JSON.stringify(result, null, 2));
  } else if (name === "pack_task") {
    blurb = ok ? `Pack task → ${short(args.title || result.title, 52)}` : "Pack task failed";
    detail = lines([args.goal, result.bot, result.chat]);
  } else if (name === "subagent") {
    blurb = ok
      ? `${args.pack || result.pack || "pack"} agent → ${short(result.summary || (result.used || []).join(", ") || "done", 52)}`
      : `Sub-agent failed: ${short(result.error, 60)}`;
    detail = lines([result.summary, (result.used || []).join(", "), ...(result.notes || [])]);
  } else if (name.startsWith("computer_")) {
    blurb = ok ? `Remote desk: ${name.replace("computer_", "").replaceAll("_", " ")}` : "Remote desk failed";
    detail = clip(JSON.stringify({ action: args.action, ...result, image: undefined, dataUrl: undefined }, null, 2));
  } else if (packFor(name)) {
    const out = firstLine(result.stdout || result.content || result.error);
    blurb = ok
      ? `${name.replaceAll("_", " ")} → ${short(out || "ok", 48)}`
      : `Failed: ${short(result.error || result.stderr || name, 80)}`;
    detail = clip(result.stdout || result.text || result.error || JSON.stringify(result, null, 2));
  } else if (!ok) {
    blurb = short(result.error || result.stderr || "Didn’t work.", 90);
    detail = clip(result.stderr || result.error || "");
  } else {
    blurb = short(command || path || "Done.", 90);
    detail = clip(result.stdout || result.text || prettyPath(path));
  }

  const pack = packFor(name)
    || (name.startsWith("mac_") ? "desk" : "")
    || (name.startsWith("computer") ? "computer" : "")
    || (name.startsWith("memory_") || ["web_search", "extract", "scrape", "docs_search"].includes(name) ? "hnl" : "");
  return {
    role: "step",
    name,
    pack,
    ok,
    blurb,
    detail: clip(detail, 6000),
  };
}
