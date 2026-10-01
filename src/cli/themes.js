/** Console coats. High contrast, one accent, so the eye has a place to rest. */

export const THEMES = {
  den: { bg: 233, panel: 22, text: 194, dim: 65, accent: 46, warn: 214, hot: 196, ink: 233 },
  amber: { bg: 233, panel: 94, text: 229, dim: 136, accent: 214, warn: 208, hot: 196, ink: 233 },
  radar: { bg: 233, panel: 17, text: 195, dim: 67, accent: 45, warn: 214, hot: 196, ink: 233 },
  flare: { bg: 233, panel: 53, text: 225, dim: 132, accent: 213, warn: 214, hot: 196, ink: 233 },
  ledger: { bg: 187, panel: 180, text: 235, dim: 94, accent: 94, warn: 130, hot: 124, ink: 230 },
};

export const THEME_IDS = Object.keys(THEMES);

export function pickTheme(current, asked) {
  const name = String(asked || "").trim().toLowerCase();
  if (!name) return current;
  return THEMES[name] ? name : "";
}
