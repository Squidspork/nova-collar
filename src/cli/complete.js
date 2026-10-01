/** Tab matches for the console. Theme names stay in themes.js. */

import { THEME_IDS } from "./themes.js";

/** name, hint, and whether the command still needs an argument. */
const COMMANDS = [
  ["/cd", "working folder", true],
  ["/chats", "shared chats", false],
  ["/disk", "disk on this machine", false],
  ["/dns", "A record", true],
  ["/docker", "containers", false],
  ["/exit", "leave", false],
  ["/facts", "OS, CPU, memory", false],
  ["/goal", "standing goal", false],
  ["/help", "command list", false],
  ["/http", "status code", true],
  ["/load", "busiest processes", false],
  ["/logs", "last lines of a log", true],
  ["/model", "show or set the model", false],
  ["/new", "new shared chat", false],
  ["/open", "open a chat by number", true],
  ["/ping", "three pings", true],
  ["/ports", "listening ports", false],
  ["/ps", "busiest processes", false],
  ["/quit", "leave", false],
  ["/service", "macOS launchd or brew, Linux systemd", true],
  ["/tcp", "host and port", true],
  ["/theme", "coat", false],
  ["/whois", "whois query", true],
];

function commonPrefix(list) {
  if (!list.length) return "";
  let prefix = list[0];
  for (const item of list) {
    while (prefix && !item.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

/** Empty string means `/theme` with no name yet. Null means this is not a theme line. */
export function themePartial(line) {
  const match = String(line || "").trim().match(/^\/themes?(?:\s+(\S*))?$/i);
  if (!match) return null;
  return (match[1] || "").toLowerCase();
}

function themeOptions(partial) {
  return THEME_IDS.filter((id) => id.startsWith(partial)).map((id) => ({
    id,
    label: id,
    hint: "",
    fill: `/theme ${id}`,
    run: true,
  }));
}

function commandOptions(prefix) {
  return COMMANDS.filter(([name]) => name.startsWith(prefix)).map(([name, hint, takes]) => ({
    id: name,
    label: name,
    hint,
    fill: takes ? `${name} ` : name,
    run: !takes,
  }));
}

export function completeInput(line) {
  const text = String(line ?? "");
  const raw = text.trim();
  const partial = themePartial(raw);
  if (partial !== null) {
    const options = themeOptions(partial);
    const filled = options.length === 1 ? options[0].fill : text;
    return { filled, kind: "theme", options };
  }
  if (!raw.startsWith("/") || raw.includes(" ")) return { filled: text, kind: "", options: [] };
  const options = commandOptions(raw.toLowerCase());
  if (options.length === 1) return { filled: options[0].fill, kind: "complete", options };
  const prefix = commonPrefix(options.map((row) => row.id));
  return { filled: prefix || text, kind: options.length ? "complete" : "", options };
}
