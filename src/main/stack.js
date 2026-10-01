export function shortTool(name) {
  return String(name || "tool")
    .replace(/^(host_file_|host_|computer_|mac_)/, "")
    .replace(/_check$/, "")
    .replaceAll("_", " ");
}

export function tidyBlurb(name, blurb) {
  const label = shortTool(name);
  const text = String(blurb || "").trim();
  if (!text || !label) return text;
  const next = text.replace(new RegExp(`^${label}\\s+`, "i"), "");
  return next || text;
}

export function stackStep(prev, next) {
  if (!prev || !next || prev.name !== next.name) return null;
  const hits = (Number(prev.hits) || 1) + 1;
  const okHits = (Number(prev.okHits) || (prev.ok === false ? 0 : 1)) + (next.ok === false ? 0 : 1);
  const bad = hits - okHits;
  const last = tidyBlurb(next.name, next.blurb) || (next.ok === false ? "Didn’t work." : "Done.");
  const blurb = bad ? `${last} · ${okHits} ok · ${bad} failed` : `${last} · ${hits}`;
  const detail = [prev.detail, next.detail].filter(Boolean).join("\n---\n").slice(0, 8000);
  return { ...next, hits, okHits, ok: bad === 0, blurb, detail };
}
