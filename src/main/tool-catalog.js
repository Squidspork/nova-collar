import { join } from "node:path";
import { ROOT } from "./config.js";
import { estimatedTokens } from "./context.js";

export const TOOL_DISCOVERY_TOOL = { type: "function", function: {
  name: "discover_tools",
  description: "Search the permitted tool catalog by query, or select up to 6 exact names to offer their full schemas on the next request. Discovery does not execute tools or expand permissions. Large catalogs are disclosed progressively to preserve context.",
  parameters: { type: "object", additionalProperties: false, properties: {
    query: { type: "string", maxLength: 120 },
    names: { type: "array", maxItems: 6, items: { type: "string" } },
    offset: { type: "integer", minimum: 0 },
  } },
} };

const nameOf = tool => tool?.function?.name || tool?.name || "";
const bodyOf = tool => tool.function || tool;
const ESSENTIAL = new Set(["host_file_read", "host_file_write", "host_run", "list_dir", "set_workdir", "subagent", "list_skills", "read_skill", "project_memory_search", "project_lookup"]);
const FIXED = new Set(["context_info", "ask_user"]);
const words = value => [...new Set(String(value || "").toLowerCase().match(/[a-z0-9]{3,}/g) || [])].filter(word => !["the", "this", "that", "with", "and", "for", "please", "what", "have", "from", "can", "you"].includes(word));

/** The immutable catalog is already role/remote/search/explicit-tool filtered.
 * Disclosure changes schema visibility, never this authority boundary. */
export function createToolCatalog(tools, { ask = "", contextTokens = 32768, preferred = [] } = {}) {
  const catalog = [...new Map((Array.isArray(tools) ? tools : []).filter(tool => nameOf(tool) && nameOf(tool) !== "discover_tools").map(tool => [nameOf(tool), tool])).values()];
  const byName = new Map(catalog.map(tool => [nameOf(tool), tool]));
  const limit = Math.max(256, Math.floor(contextTokens * 0.30));
  const progressive = catalog.length > 0 && estimatedTokens(catalog) > limit;
  const fixed = catalog.filter(tool => FIXED.has(nameOf(tool)));
  const preferredNames = new Set(preferred.map(nameOf));
  const queryWords = words(ask);
  const ranked = catalog.filter(tool => !FIXED.has(nameOf(tool))).map((tool, index) => {
    const name = nameOf(tool), description = String(bodyOf(tool).description || "").toLowerCase();
    const score = queryWords.reduce((sum, word) => sum + (name.includes(word) ? 30 : description.includes(word) ? 3 : 0), 0)
      + (ESSENTIAL.has(name) ? 10 : 0) + (preferredNames.has(name) ? 1 : 0);
    return { tool, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index).map(row => row.tool);
  let selected = [];

  function compose(names = selected) {
    if (!progressive) return catalog.slice();
    const offered = [...fixed, TOOL_DISCOVERY_TOOL];
    const seen = new Set(offered.map(nameOf));
    for (const name of names) if (!seen.has(name)) { offered.push(byName.get(name)); seen.add(name); }
    if (estimatedTokens(offered) > limit) return null;
    for (const tool of ranked) {
      if (seen.has(nameOf(tool))) continue;
      if (estimatedTokens([...offered, tool]) <= limit) { offered.push(tool); seen.add(nameOf(tool)); }
    }
    return offered;
  }

  function inspect(args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => !["query", "names", "offset"].includes(key))
      || (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 120))
      || (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0))
      || (args.names !== undefined && (!Array.isArray(args.names) || args.names.length > 6 || args.names.some(name => typeof name !== "string" || !name || name.length > 100)))) {
      return { ok: false, error: "Use query (at most 120 characters) and/or up to 6 exact permitted tool names." };
    }
    const names = args.names === undefined ? null : [...new Set(args.names)];
    if (names) {
      if (names.some(name => !byName.has(name))) return { ok: false, error: "A selected tool is outside this turn's permitted catalog. Selection was unchanged." };
      if (!compose(names)) return { ok: false, error: "Selected schemas exceed the disclosure budget. Select fewer tools; selection was unchanged." };
      selected = names;
    }
    const terms = words(args.query);
    const matches = catalog.filter(tool => {
      const text = `${nameOf(tool)} ${bodyOf(tool).description || ""}`.toLowerCase();
      return !terms.length || terms.every(term => text.includes(term));
    });
    const offset = Math.min(args.offset || 0, matches.length);
    const rows = names ? names.map(name => byName.get(name)) : matches.slice(offset, offset + 12);
    return { ok: true, selected: selected.slice(), total: matches.length, omitted: names ? 0 : Math.max(0, matches.length - rows.length),
      ...(names || offset + rows.length >= matches.length ? {} : { nextOffset: offset + rows.length }),
      tools: rows.map(tool => ({ name: nameOf(tool), description: String(bodyOf(tool).description || "").slice(0, 120) })),
      note: "Catalog metadata only; no tool executed. Selected tools' intact schemas are offered on the next request. Selection does not expand permissions." };
  }

  return {
    progressive,
    permitted: catalog,
    offered: () => compose() || [...fixed, TOOL_DISCOVERY_TOOL],
    inspect,
    section: () => ({ name: "Tool disclosure", chars: 0,
      representation: progressive ? `progressive schemas from ${catalog.length} permitted tools; discover_tools loads exact schemas` : `${catalog.length} tools in the permitted catalog; request schema counts shown separately`,
      sources: [join(ROOT, "src/main/tools.js"), join(ROOT, "src/main/tool-catalog.js")] }),
  };
}
