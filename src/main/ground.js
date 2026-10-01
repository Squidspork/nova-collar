export const FACT_LAW = "Facts: if you did not read it this turn (search, docs, or a file), do not state it. Say you don't know. No invented names, dates, prices, APIs, or news. Names, years, and prices must appear in what you read.";

const LOOKUP = new Set([
  "web_search",
  "extract",
  "scrape",
  "docs_search",
  "memory_recall",
  "memory_search",
  "host_file_read",
  "host_file_list",
  "host_find",
  "read_file",
  "computer_read",
  "http_check",
  "net_report",
  "tls_inspect",
  "whois_lookup",
]);

const FILE_LOOKUP = new Set([
  "host_file_read",
  "host_file_list",
  "host_find",
  "read_file",
  "computer_read",
]);

/** A fact about the folder in front of the operator. The web is not a source for that. */
export function folderAsk(text) {
  return /\b(this folder|this file|this project|this directory|this repo)\b/i.test(String(text || ""));
}

const CODE = /\b(write|fix|patch|compile|indent|function|script|tui|program)\b/i;
const FACT = /\b(who (?:is|was|wrote|owns|founded)|when (?:did|was|is|will)|where (?:is|was)|how much|what (?:year|date|company|price|version|cost)|latest|current (?:price|version|news|release)|official|look up|according to|is it true)\b/i;
const STOP = new Set([
  "About", "After", "Also", "Before", "From", "Here", "That", "Then", "There", "These", "This", "Those",
  "Today", "With", "Into", "According", "Founded", "Please", "Sorry", "Based", "Using", "Looking",
]);

export function factAsk(text) {
  const raw = String(text || "");
  if (!FACT.test(raw)) return false;
  if (CODE.test(raw) && !/\b(docs?|api|official|release|price|who (?:made|wrote|owns))\b/i.test(raw)) return false;
  return true;
}

export function admitsUnknown(text) {
  return /\b(i don't know|i do not know|not sure|couldn't find|no (?:result|source)|unknown|can't verify|cannot verify|won't invent|will not invent|i can't|i cannot|i won't|i will not|not something i(?:'ll| will)|won't (?:surface|look(?: that)? up))\b/i.test(String(text || ""));
}

export function claimTokens(text) {
  const raw = String(text || "");
  const out = [];
  const add = (value) => {
    const item = String(value || "").trim();
    if (item.length < 2 || out.some((row) => row.toLowerCase() === item.toLowerCase())) return;
    out.push(item);
  };
  for (const hit of raw.matchAll(/\b(?:19|20)\d{2}\b/g)) add(hit[0]);
  for (const hit of raw.matchAll(/\$\d[\d,]*(?:\.\d+)?/g)) add(hit[0]);
  for (const hit of raw.matchAll(/\b\d+\.\d+(?:\.\d+)?\b/g)) add(hit[0]);
  for (const hit of raw.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g)) add(hit[0]);
  for (const hit of raw.matchAll(/\b[A-Z][a-z]{4,}\b/g)) {
    if (!STOP.has(hit[0])) add(hit[0]);
  }
  return out.slice(0, 8);
}

export function missingClaims(answer, evidence) {
  const blob = String(evidence || "").toLowerCase();
  if (!blob.trim()) return claimTokens(answer);
  return claimTokens(answer).filter((item) => !blob.includes(item.toLowerCase()));
}

function evidenceOf(result) {
  if (!result || typeof result !== "object") return "";
  const hits = result.hits || result.data?.hits || [];
  const hitText = hits.map((hit) => [hit.text, hit.content, hit.title, hit.url, hit.snippet].filter(Boolean).join(" ")).join("\n");
  return [result.content, result.text, result.stdout, result.summary, result.blurb, hitText].filter(Boolean).join("\n");
}

export function createGround() {
  let seen = false;
  let fileSeen = false;
  let evidence = "";
  return {
    note(name, result) {
      if (FILE_LOOKUP.has(name)) fileSeen = true;
      if (!LOOKUP.has(name)) return;
      seen = true;
      evidence += `\n${evidenceOf(result)}`;
    },
    seen() {
      return seen;
    },
    fileSeen() {
      return fileSeen;
    },
    unsupported(answer, ask) {
      if (folderAsk(ask) && !fileSeen) {
        const claims = claimTokens(answer);
        return claims.length ? claims : ["this folder"];
      }
      if (!seen) return claimTokens(answer);
      return missingClaims(answer, evidence);
    },
  };
}
