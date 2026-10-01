/** Full-screen console. Meters stay put. Motion stays in the gap, not in the words. */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, hostname, loadavg, platform, totalmem } from "node:os";
import { join } from "node:path";
import { APP_HOME } from "../main/config.js";
import { availableFromVmStat, loadReadout } from "./meters.js";
import { THEMES, pickTheme } from "./themes.js";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function clip(text, width) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= width) return clean;
  return `${clean.slice(0, Math.max(0, width - 1))}…`;
}

function fit(text, width) {
  const chars = [...String(text || "").replace(/\n/g, " ")];
  const cut = chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join("")}…` : chars.join("");
  return cut + " ".repeat(Math.max(0, width - [...cut].length));
}

function paint(color, back, text, width) {
  return `\x1b[48;5;${back}m\x1b[38;5;${color}m${fit(text, width)}\x1b[0m\x1b[K`;
}

function readTheme() {
  try {
    const saved = JSON.parse(readFileSync(join(APP_HOME, "console.json"), "utf8")).theme;
    if (THEMES[saved]) return saved;
  } catch {
    /* first run */
  }
  return "amber";
}

function saveTheme(name) {
  try {
    mkdirSync(APP_HOME, { recursive: true });
    writeFileSync(join(APP_HOME, "console.json"), `${JSON.stringify({ theme: name })}\n`);
  } catch {
    /* the screen still switches */
  }
}

function gauge(label, pct) {
  const known = Number.isFinite(pct);
  const p = known ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  const inner = 16;
  const fill = known ? Math.round((p / 100) * inner) : 0;
  const bar = `${"#".repeat(fill)}${".".repeat(inner - fill)}`;
  const num = known ? `${String(p).padStart(3)}%` : "  ..";
  return `${label} ${bar} ${num}`;
}

function heat(theme, pct) {
  if (!Number.isFinite(pct)) return theme.dim;
  if (pct >= 90) return theme.hot;
  if (pct >= 75) return theme.warn;
  return theme.accent;
}

export function watchDisk(onPercent) {
  const target = process.platform === "darwin" ? "/System/Volumes/Data" : "/";
  const child = spawn("df", ["-P", target], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.on("close", () => {
    const pct = (out.trim().split("\n").pop() || "").match(/(\d+)%/);
    if (pct) onPercent(`${pct[1]}%`);
  });
}

export function createScreen({ plain = false } = {}) {
  const tty = Boolean(process.stdout.isTTY) && !plain;
  let frame = 0;
  let timer = null;
  let memTimer = null;
  let memBusy = false;
  let availBytes = NaN;
  let input = "";
  let busy = false;
  let lines = [];
  let tools = [];
  let draftOn = false;
  let disk = "";
  let model = "";
  let goal = "";
  let themeName = readTheme();
  let menu = null;

  function theme() {
    return THEMES[themeName] || THEMES.amber;
  }

  function size() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    return { cols: Math.max(40, cols), rows: Math.max(16, rows) };
  }

  function sampleMemory() {
    if (process.platform !== "darwin" || memBusy) return;
    memBusy = true;
    const child = spawn("vm_stat", [], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("close", () => {
      memBusy = false;
      const next = availableFromVmStat(out);
      if (!Number.isFinite(next)) return;
      availBytes = Math.min(next, totalmem());
      draw();
    });
  }

  function lineColor(line, coat) {
    if (line.startsWith("you")) return coat.accent;
    if (line.startsWith("collar")) return coat.text;
    return coat.dim;
  }

  function idle(count, cols, coat) {
    const out = Array.from({ length: count }, () => "");
    if (count > 0) {
      const mark = busy ? SPIN[frame % SPIN.length] : "*";
      out[count - 1] = ` ${mark}  ${busy ? "working" : "ready"}    /disk  /ports  /load  /facts  /theme`;
    }
    return out.map((line) => paint(coat.dim, coat.bg, line, cols));
  }

  function draw() {
    if (!tty) return;
    const coat = theme();
    const { cols, rows } = size();
    const spin = busy ? SPIN[frame % SPIN.length] : "*";
    const clock = new Date().toLocaleTimeString([], { hour12: false });
    const diskPct = disk ? Number(String(disk).replace("%", "")) : NaN;
    const total = totalmem();
    const freeBytes = process.platform === "darwin" ? availBytes : freemem();
    const memKnown = Number.isFinite(freeBytes) && total > 0;
    const memPct = memKnown ? (1 - Math.min(freeBytes, total) / total) * 100 : NaN;
    const host = `${spin} Nova Collar   ${clip(hostname(), 22)}   ${platform()} ${cpus().length}c   ${clock}   ${themeName}`;
    const leftW = Math.floor(cols / 2);
    const rightW = cols - leftW;
    const free = memKnown ? `${(Math.min(freeBytes, total) / 1024 ** 3).toFixed(1)}G avail` : "avail ..";
    const goalBit = goal ? clip(goal, 28) : "no goal";
    const diskLabel = process.platform === "darwin" ? "DATA" : "DISK";
    const load = `LOAD ${loadReadout(loadavg()[0], cpus().length)}   ${free}   ${clip(model, 16)}   ${goalBit}`;
    const menuView = visibleMenu();
    const bodyRows = Math.max(1, rows - 7 - menuView.length);
    const room = Math.max(0, bodyRows - 1);
    const shown = room ? lines.slice(-room) : [];
    const body = [
      ...idle(Math.max(0, bodyRows - shown.length), cols, coat),
      ...shown.map((line) => paint(lineColor(line, coat), coat.bg, line, cols)),
    ];
    const sweep = frame % Math.min(cols, 32);
    const rule = `${"-".repeat(sweep)}+${"-".repeat(Math.max(0, 24 - sweep))}`;
    const caret = frame % 8 < 4 ? "_" : " ";
    const out = [
      paint(coat.ink, coat.accent, ` ${host}`, cols),
      paint(heat(coat, diskPct), coat.bg, ` ${gauge(diskLabel, diskPct)}`, leftW)
        + paint(heat(coat, memPct), coat.bg, ` ${gauge("MEM", memPct)}`, rightW),
      paint(coat.text, coat.bg, ` ${load}`, cols),
      paint(coat.dim, coat.bg, rule, cols),
      ...body,
      ...menuView.map(({ row, on }) => paint(
        on ? coat.ink : coat.text,
        on ? coat.accent : coat.bg,
        `${on ? ">" : " "} ${row.label}${row.hint ? `  ${row.hint}` : ""}`,
        cols,
      )),
      paint(coat.accent, coat.panel, ` ${tools.at(-1) || "tools idle"}`, cols),
      paint(coat.text, coat.bg, ` > ${input}${busy ? "" : caret}`, cols),
      paint(coat.text, coat.panel, " /goal  /new  /theme  /disk  /ports  /load  /http  /help", cols),
    ];
    process.stdout.write(`\x1b[H\x1b[?25l${out.join("\n")}`);
  }

  function visibleMenu() {
    if (!menu?.rows.length) return [];
    const height = Math.min(6, menu.rows.length);
    let start = Math.min(menu.index, menu.rows.length - height);
    start = Math.max(0, start);
    return menu.rows.slice(start, start + height).map((row, offset) => ({
      row,
      on: start + offset === menu.index,
    }));
  }

  function push(text) {
    const width = Math.max(24, (process.stdout.columns || 80) - 4);
    for (const raw of String(text || "").split("\n")) {
      let rest = raw.trimEnd();
      if (!rest) {
        lines.push("");
        continue;
      }
      let first = true;
      while (rest.length > width) {
        let cut = rest.lastIndexOf(" ", width);
        if (cut < 16) cut = width;
        const chunk = rest.slice(0, cut).trimEnd();
        lines.push(first ? chunk : `  ${chunk.trimStart()}`);
        rest = rest.slice(cut).trimStart();
        first = false;
      }
      lines.push(first ? rest : `  ${rest}`);
    }
    if (lines.length > 400) lines = lines.slice(-400);
  }

  return {
    tty,
    start() {
      if (!tty) return;
      process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
      process.stdout.on("resize", draw);
      sampleMemory();
      timer = setInterval(() => {
        frame += 1;
        draw();
      }, 90);
      memTimer = setInterval(sampleMemory, 2000);
      draw();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (memTimer) clearInterval(memTimer);
      if (tty) {
        process.stdout.off("resize", draw);
        process.stdout.write("\x1b[?25h\x1b[?1049l");
      }
    },
    setMeta({ model: nextModel, goal: nextGoal, disk: nextDisk } = {}) {
      if (nextModel != null) model = nextModel;
      if (nextGoal != null) goal = nextGoal;
      if (nextDisk != null) disk = nextDisk;
      draw();
    },
    setInput(text) {
      input = text;
      draw();
    },
    setStatus(text) {
      tools.push(clip(text, 140));
      if (tools.length > 8) tools = tools.slice(-8);
      draw();
    },
    setBusy(on) {
      busy = Boolean(on);
      draw();
    },
    themeId() {
      return themeName;
    },
    menuKind() {
      return menu?.kind || "";
    },
    menuRow() {
      return menu?.rows[menu.index] || null;
    },
    setMenu(next) {
      if (!next?.rows?.length) {
        menu = null;
      } else {
        const count = next.rows.length;
        const index = ((next.index % count) + count) % count;
        menu = { kind: next.kind, rows: next.rows, index };
      }
      draw();
    },
    moveMenu(delta) {
      if (!menu?.rows.length) return null;
      const count = menu.rows.length;
      menu.index = ((menu.index + delta) % count + count) % count;
      draw();
      return menu.rows[menu.index];
    },
    clearMenu() {
      if (!menu) return;
      menu = null;
      draw();
    },
    applyTheme(asked) {
      const next = pickTheme(themeName, asked);
      if (!next) return "";
      themeName = next;
      saveTheme(themeName);
      draw();
      return themeName;
    },
    setDraft(text) {
      if (!tty) return;
      const width = Math.max(20, (process.stdout.columns || 80) - 2);
      const line = clip(`collar  ${text}`, width);
      if (!draftOn) {
        lines.push(line);
        draftOn = true;
      } else lines[lines.length - 1] = line;
      draw();
    },
    clearDraft() {
      if (draftOn) lines.pop();
      draftOn = false;
    },
    say(text) {
      if (!tty) {
        process.stdout.write(`${String(text || "")}\n`);
        return;
      }
      push(text);
      draw();
    },
  };
}

