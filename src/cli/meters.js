/** Meter math for the console. Load is the 1-minute average. Memory is what can still be used. */

export function loadReadout(value, cores, width = 12) {
  const cap = Math.max(1, Number(cores) || 1);
  const load = Number.isFinite(value) ? Math.max(0, value) : 0;
  const fill = Math.max(0, Math.min(width, Math.round((load / cap) * width)));
  const bar = `${"#".repeat(fill)}${".".repeat(width - fill)}`;
  return `${load.toFixed(2)}/${cap} [${bar}]`;
}

/** macOS vm_stat: free pages plus inactive and speculative cache. */
export function availableFromVmStat(text) {
  const page = Number((String(text).match(/page size of (\d+)/) || [])[1]);
  if (!page) return NaN;
  const pages = (name) => {
    const hit = String(text).match(new RegExp(`${name}:\\s+(\\d+)`));
    return hit ? Number(hit[1]) : NaN;
  };
  const free = pages("Pages free");
  const inactive = pages("Pages inactive");
  const speculative = pages("Pages speculative");
  if (![free, inactive, speculative].every(Number.isFinite)) return NaN;
  return (free + inactive + speculative) * page;
}
