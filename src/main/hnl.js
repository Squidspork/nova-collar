import { publicHttpsUrl } from "./safe.js";

const COMPUTER_ACTIONS = new Set([
  "screenshot",
  "click",
  "double_click",
  "right_click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "open",
  "wait",
  "exec",
  "read",
  "write",
  "pi",
  "guide",
]);

export function isHnlTool(name) {
  return (
    name === "web_search" ||
    name === "extract" ||
    name === "scrape" ||
    name === "docs_search" ||
    name === "memory_remember" ||
    name === "memory_recall" ||
    name === "memory_search" ||
    name === "computer" ||
    name.startsWith("computer_")
  );
}

async function recallFromSearch(cfg, q) {
  const search = await fetch(`${cfg.toolsUrl}/tools/memory_search`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.toolsKey}`,
      "content-type": "application/json",
      "user-agent": "NovaCollar/0.1",
    },
    body: JSON.stringify({ q }),
    signal: AbortSignal.timeout(20_000),
  });
  const found = JSON.parse(await search.text());
  const hits = found.data?.hits || found.hits || [];
  if (!search.ok || !Array.isArray(hits)) return null;
  return {
    ok: true,
    fallback: "search",
    content: hits.map((hit) => hit.text || hit.content || "").filter(Boolean).join("\n") || "No stored notes yet.",
    hits,
  };
}

export async function runHnlTool(name, args, cfg) {
  if (!cfg.toolsKey) {
    return { ok: false, error: "No tools key. Add one in settings if you connect your own tools." };
  }
  const toolId = name.startsWith("computer_") || name === "computer" ? "computer" : name;
  const body = { ...args };
  if (name.startsWith("computer_")) {
    body.action = name.slice("computer_".length);
  }
  if (toolId === "computer" && body.action && !COMPUTER_ACTIONS.has(body.action)) {
    return { ok: false, error: `unknown computer action ${body.action}` };
  }
  if ((name === "extract" || name === "scrape" || name === "computer_open" || body.action === "open") && body.url) {
    const allowed = publicHttpsUrl(body.url);
    if (!allowed.ok) return allowed;
    body.url = allowed.url;
  }
  if (toolId === "computer" && !body.model) body.model = cfg.model;
  const path = toolId === "computer" ? "/tools/computer" : `/tools/${toolId}`;
  let response;
  try {
    response = await fetch(`${cfg.toolsUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.toolsKey}`,
        "content-type": "application/json",
        "user-agent": "NovaCollar/0.1",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(name === "memory_recall" ? 12_000 : 120_000),
    });
  } catch (error) {
    if (name === "memory_recall") {
      try {
        const fallback = await recallFromSearch(cfg, String(body.q || body.query || "").trim());
        if (fallback) return fallback;
      } catch {
        /* keep timeout error */
      }
    }
    return { ok: false, error: error.message || "tool request failed" };
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!response.ok) {
    if (name === "memory_recall") {
      try {
        const fallback = await recallFromSearch(cfg, String(body.q || body.query || "").trim());
        if (fallback) return fallback;
      } catch {
        /* keep original recall error */
      }
    }
    return { ok: false, error: json?.error?.message || text.slice(0, 800) || `HTTP ${response.status}` };
  }
  if (!json) return { ok: false, error: text.slice(0, 800) || `HTTP ${response.status}` };
  return { ok: true, ...json };
}
