import { execFileSync, spawn } from "node:child_process";
import { arch, freemem, platform, totalmem } from "node:os";

const PROBES = [
  { name: "Ollama", url: "http://127.0.0.1:11434", kind: "ollama" },
  { name: "LM Studio", url: "http://127.0.0.1:1234", kind: "openai" },
  { name: "llama.cpp", url: "http://127.0.0.1:8080", kind: "openai" },
  { name: "local model", url: "http://127.0.0.1:8000", kind: "openai" },
];

function which(name) {
  try {
    return execFileSync(platform() === "win32" ? "where.exe" : "which", [name], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/)[0];
  } catch {
    return "";
  }
}

export function memoryPlan() {
  const totalGb = totalmem() / 1024 ** 3;
  const freeGb = freemem() / 1024 ** 3;
  const round = (n) => Math.round(n * 10) / 10;
  let model = null;
  if (totalGb >= 32) model = { name: "qwen2.5:14b", diskGb: 9, runGb: 12 };
  else if (totalGb >= 16) model = { name: "qwen2.5:7b", diskGb: 5, runGb: 8 };
  else if (totalGb >= 8) model = { name: "qwen2.5:3b", diskGb: 2.2, runGb: 4 };
  return {
    totalGb: round(totalGb),
    freeGb: round(freeGb),
    appGb: 0.4,
    layaDiskGb: 1,
    layaRamGb: 2,
    model,
    platform: platform(),
    arch: arch(),
    ollamaBin: Boolean(which("ollama")),
    brew: Boolean(which("brew")),
  };
}

async function readJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(700) });
  if (!response.ok) return null;
  return response.json();
}

async function probe(row) {
  try {
    if (row.kind === "ollama") {
      const data = await readJson(`${row.url}/api/tags`);
      if (!data) return null;
      const models = (data.models || []).map((item) => item.name).filter(Boolean);
      return { name: row.name, url: `${row.url}/v1`, models, kind: row.kind };
    }
    const data = await readJson(`${row.url}/v1/models`);
    const models = (data?.data || []).map((item) => item.id).filter(Boolean);
    if (!models.length && !data?.data) return null;
    return { name: row.name, url: `${row.url}/v1`, models, kind: row.kind };
  } catch {
    return null;
  }
}

export async function scanLocalModels() {
  const found = (await Promise.all(PROBES.map(probe))).filter(Boolean);
  return { memory: memoryPlan(), found };
}

function run(cmd, args, onLine, env = process.env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }
    const take = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const text = line.replace(/\s+/g, " ").trim();
        if (text) onLine(text.slice(0, 240));
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("exit", (code) => resolve({ ok: code === 0, error: code === 0 ? "" : `stopped (${code})` }));
  });
}

async function waitForOllama() {
  for (let i = 0; i < 16; i += 1) {
    const hit = await probe(PROBES[0]);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

export async function ensureOllama(onLine) {
  const plan = memoryPlan();
  if (!plan.model) return { ok: false, error: "This system has under 8 GB of memory. A local model will not fit." };
  const already = await probe(PROBES[0]);
  if (!already && !plan.ollamaBin) {
    if (plan.platform === "win32") return { ok: false, error: "Install Ollama for Windows from https://ollama.com/download/windows, open it, then scan again." };
    onLine(plan.platform === "darwin" ? "Installing Ollama with Homebrew." : "Installing Ollama.");
    const installed = plan.platform === "darwin" && plan.brew
      ? await run("brew", ["install", "ollama"], onLine)
      : await run("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], onLine);
    if (!installed.ok) return installed;
  }
  if (!await probe(PROBES[0])) {
    const bin = which("ollama") || "ollama";
    onLine("Starting Ollama on 127.0.0.1.");
    const child = spawn(bin, ["serve"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11434" },
    });
    child.on("error", () => {});
    child.unref();
    const up = await waitForOllama();
    if (!up) return { ok: false, error: "Ollama did not answer on 127.0.0.1:11434." };
  }
  onLine(`Downloading ${plan.model.name}. About ${plan.model.diskGb} GB.`);
  const pulled = await run(which("ollama") || "ollama", ["pull", plan.model.name], onLine, {
    ...process.env,
    OLLAMA_HOST: "127.0.0.1:11434",
  });
  if (!pulled.ok) return pulled;
  return { ok: true, url: "http://127.0.0.1:11434/v1", model: plan.model.name };
}
