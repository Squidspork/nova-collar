import { modelMetadata } from "./model-catalog.js";
import { smallModel } from "./split.js";

const tokens = value => typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0;

/** Resolve the window and reply reserve without routing, discovery or writes. */
export function requestBudget(cfg, target, extra = {}) {
  // modelMetadata owns catalog validation and intentionally omits local metadata.
  const metadata = modelMetadata(cfg, target);
  const lean = Boolean(target.local || smallModel(target.model));
  const catalogContext = tokens(metadata?.context), catalogOutput = tokens(metadata?.output);
  const explicitContext = tokens(extra.ctx), explicitOutput = tokens(extra.predict);
  // A local server is explicitly configured with this window in num_ctx. Its
  // budget must use that same effective window, rather than a hosted fallback.
  const contextTokens = target.local
    ? Math.min(catalogContext || Infinity, explicitContext || 12288)
    : catalogContext || explicitContext || (lean ? 12288 : 32768);
  const requested = explicitOutput || (lean ? 1536 : catalogOutput ? 8192 : 0);
  const outputTokens = Math.min(requested || 8192, catalogOutput || Infinity, Math.max(256, Math.floor(contextTokens / 4)));
  return { contextTokens, outputTokens, lean };
}
