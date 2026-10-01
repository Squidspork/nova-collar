import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BIN, APP_HOME, ensureHome } from "./config.js";

let hideForShot = async (fn) => fn();

export function setDeskGuard(fn) {
  hideForShot = fn;
}

function runControl(command, flags = {}) {
  if (!existsSync(BIN)) {
    return Promise.resolve({
      ok: false,
      error: "Desktop control is not installed on this system. Screen tools are built for macOS.",
    });
  }
  return new Promise((resolve, reject) => {
    const argv = [command];
    for (const [key, value] of Object.entries(flags)) {
      if (value === undefined || value === null || value === "") continue;
      argv.push(`--${key}`, String(value));
    }
    const child = spawn(BIN, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const raw = out.trim() || err.trim();
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ ok: code === 0, error: raw || `mac-control exited ${code}` });
      }
    });
  });
}

let lastShot = null;

function mapPoint(args) {
  if (!lastShot || args.x == null || args.y == null) return args;
  return {
    ...args,
    x: Math.round(Number(args.x) * lastShot.display_width / lastShot.width),
    y: Math.round(Number(args.y) * lastShot.display_height / lastShot.height),
  };
}

export async function runDesk(name, args) {
  ensureHome();
  const action = name === "desk" ? String(args.action || "") : name.replace(/^mac_/, "").replace(/^desk_/, "");
  switch (action) {
    case "info":
      return runControl("info");
    case "screenshot": {
      mkdirSync(join(APP_HOME, "shots"), { recursive: true });
      const path = join(APP_HOME, "shots", `local-${Date.now()}.jpg`);
      const shot = await hideForShot(() => runControl("screenshot", { path, max: args.max || 1280 }));
      if (shot?.ok) lastShot = shot;
      return shot;
    }
    case "click": {
      const at = mapPoint(args);
      return runControl("click", { x: at.x, y: at.y });
    }
    case "double_click":
    case "dblclick": {
      const at = mapPoint(args);
      return runControl("dblclick", { x: at.x, y: at.y });
    }
    case "right_click":
    case "rightclick": {
      const at = mapPoint(args);
      return runControl("rightclick", { x: at.x, y: at.y });
    }
    case "move": {
      const at = mapPoint(args);
      return runControl("move", { x: at.x, y: at.y });
    }
    case "drag": {
      const start = mapPoint(args);
      const end = mapPoint({ x: args.x2, y: args.y2 });
      return runControl("drag", { x: start.x, y: start.y, x2: end.x, y2: end.y });
    }
    case "scroll": {
      const at = mapPoint(args);
      return runControl("scroll", {
        x: at.x,
        y: at.y,
        direction: args.direction || "down",
        amount: args.amount || 3,
      });
    }
    case "type":
      return runControl("type", { text: args.text });
    case "key":
      return runControl("key", { key: args.key });
    case "open": {
      const target = String(args.target || args.url || args.app || "");
      if (/^(file|javascript|data|vbscript):/i.test(target) || /(?:^|\/)\.novapup\/env(?:$|[/?#])/.test(target)) {
        return { ok: false, error: "blocked open target" };
      }
      return runControl("open", { target });
    }
    case "focus":
      return runControl("focus", { app: args.app || args.target });
    case "windows":
      return runControl("windows");
    default:
      return { ok: false, error: `unknown desk action ${action || name}` };
  }
}

export function isDeskTool(name) {
  return name === "desk" || name.startsWith("mac_") || name.startsWith("desk_");
}
