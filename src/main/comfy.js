import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_HOME } from "./config.js";

const WORKFLOW = {
  70: { class_type: "UNETLoader", inputs: { unet_name: "flux-2-klein-4b.safetensors", weight_dtype: "default" } },
  71: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "flux2", device: "default" } },
  72: { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" } },
  74: { class_type: "CLIPTextEncode", inputs: { clip: ["71", 0], text: "" } },
  76: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["74", 0] } },
  63: {
    class_type: "CFGGuider",
    inputs: { model: ["70", 0], positive: ["74", 0], negative: ["76", 0], cfg: 1 },
  },
  73: { class_type: "RandomNoise", inputs: { noise_seed: 0 } },
  61: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
  62: { class_type: "Flux2Scheduler", inputs: { steps: 10, width: 1024, height: 1024 } },
  66: { class_type: "EmptyFlux2LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
  64: {
    class_type: "SamplerCustomAdvanced",
    inputs: { noise: ["73", 0], guider: ["63", 0], sampler: ["61", 0], sigmas: ["62", 0], latent_image: ["66", 0] },
  },
  65: { class_type: "VAEDecode", inputs: { samples: ["64", 0], vae: ["72", 0] } },
  9: { class_type: "SaveImage", inputs: { filename_prefix: "HNL-NovaPup-Flux2Klein", images: ["65", 0] } },
};

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function headers(cfg) {
  const out = { "user-agent": "NovaPup/1.0 (HungryNovaLabs generate_image)" };
  if (cfg.labToken) out["x-hnl-lab-token"] = cfg.labToken;
  return out;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 400) };
  }
}

async function comfyFetch(base, path, cfg, init = {}) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...headers(cfg), ...(init.headers || {}) },
    signal: init.signal || AbortSignal.timeout(30_000),
  });
}

async function waitForImage(base, cfg, promptId, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const response = await comfyFetch(base, `/history/${promptId}`, cfg);
    if (response.ok) {
      const data = await readJson(response);
      const outputs = data[promptId]?.outputs || {};
      for (const node of Object.values(outputs)) {
        const image = node?.images?.[0];
        if (image?.filename) return image;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return null;
}

export async function generateImage(args, cfg) {
  const bases = [cfg.comfyUrl, cfg.comfyFallback].filter(Boolean);
  if (!bases.length) return { ok: false, error: "ComfyUI URL is not configured." };
  const prompt = String(args.prompt || "").trim();
  if (prompt.length < 3) return { ok: false, error: "prompt required" };
  const width = clamp(args.width, 512, 1536, 1024);
  const height = clamp(args.height, 512, 1536, 1024);
  const steps = clamp(args.steps, 1, 40, 10);
  const seed = args.seed >= 0 ? clamp(args.seed, 0, 2_147_483_647, 0) : Math.floor(Math.random() * 2_147_483_647);
  const workflow = structuredClone(WORKFLOW);
  workflow[70].inputs.unet_name = cfg.comfyModel || "flux-2-klein-4b.safetensors";
  workflow[74].inputs.text = prompt;
  workflow[62].inputs.steps = steps;
  workflow[62].inputs.width = width;
  workflow[62].inputs.height = height;
  workflow[66].inputs.width = width;
  workflow[66].inputs.height = height;
  workflow[73].inputs.noise_seed = seed;

  let lastError = "ComfyUI unreachable";
  for (const base of bases) {
    try {
      const health = await comfyFetch(base, "/system_stats", cfg, { signal: AbortSignal.timeout(8_000) });
      if (!health.ok) {
        lastError = `ComfyUI unhealthy at ${base} (HTTP ${health.status})`;
        continue;
      }
      const queued = await comfyFetch(base, "/prompt", cfg, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: workflow }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await readJson(queued);
      if (!queued.ok) {
        lastError = body.error || body.text || `HTTP ${queued.status}`;
        continue;
      }
      const promptId = String(body.prompt_id || "");
      if (!promptId) {
        lastError = "Comfy returned no prompt_id";
        continue;
      }
      const meta = await waitForImage(base, cfg, promptId, 180_000);
      if (!meta) {
        lastError = `Timed out waiting for prompt ${promptId}`;
        continue;
      }
      const qs = new URLSearchParams({
        filename: meta.filename,
        subfolder: meta.subfolder || "",
        type: meta.type || "output",
      });
      const view = await comfyFetch(base, `/view?${qs}`, cfg, { signal: AbortSignal.timeout(45_000) });
      if (!view.ok) {
        lastError = `Comfy /view failed HTTP ${view.status}`;
        continue;
      }
      const bytes = Buffer.from(await view.arrayBuffer());
      const dir = join(APP_HOME, "inbox", "generated");
      mkdirSync(dir, { recursive: true });
      const name = String(meta.filename || `novapup-${Date.now()}.png`).replace(/[^\w.-]/g, "_");
      const path = join(dir, name);
      writeFileSync(path, bytes);
      return {
        ok: true,
        engine: "comfyui",
        model: workflow[70].inputs.unet_name,
        steps,
        width,
        height,
        seed,
        prompt,
        path,
        image: `data:image/png;base64,${bytes.toString("base64")}`,
      };
    } catch (error) {
      lastError = error.message;
    }
  }
  return { ok: false, error: lastError };
}
