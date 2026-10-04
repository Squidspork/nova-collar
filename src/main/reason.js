const OPEN = "<think>";
const CLOSE = "</think>";

function keepTail(buf, tag) {
  const max = Math.min(tag.length - 1, buf.length);
  for (let n = max; n > 0; n -= 1) {
    if (tag.startsWith(buf.slice(-n))) return n;
  }
  return 0;
}

/** Split a content chunk into the answer and the text inside <think> tags. */
export function pushThink(filter, chunk) {
  filter.buf += String(chunk || "");
  let answer = "";
  let thought = "";
  while (filter.buf) {
    if (filter.hide) {
      const end = filter.buf.indexOf(CLOSE);
      if (end < 0) {
        const hold = keepTail(filter.buf, CLOSE);
        thought += filter.buf.slice(0, filter.buf.length - hold);
        filter.buf = hold ? filter.buf.slice(-hold) : "";
        break;
      }
      thought += filter.buf.slice(0, end);
      filter.buf = filter.buf.slice(end + CLOSE.length);
      filter.hide = false;
      continue;
    }
    const start = filter.buf.indexOf(OPEN);
    if (start < 0) {
      const hold = keepTail(filter.buf, OPEN);
      answer += filter.buf.slice(0, filter.buf.length - hold);
      filter.buf = hold ? filter.buf.slice(-hold) : "";
      break;
    }
    answer += filter.buf.slice(0, start);
    filter.buf = filter.buf.slice(start + OPEN.length);
    filter.hide = true;
  }
  return { answer, thought };
}

/** OpenAI-compatible content and reasoning fields contain deltas, not snapshots. */
export function streamPiece(have, piece) {
  const next = String(piece || "");
  return { text: String(have || "") + next, added: next };
}

/** True when the recent text is the same phrase repeating. */
export function thoughtLoop(text) {
  const sample = String(text || "").slice(-2000);
  if (sample.length < 240) return false;
  const tail = sample.slice(-720);
  for (const size of [24, 40, 80, 120, 200]) {
    if (tail.length < size * 3) continue;
    const a = tail.slice(-size);
    const b = tail.slice(-size * 2, -size);
    const c = tail.slice(-size * 3, -size * 2);
    if (a === b && b === c && new Set(a).size > 4) return true;
  }
  const end = sample.slice(-180);
  for (let period = 12; period <= 60; period += 1) {
    const phrase = end.slice(-period);
    if (phrase.trim().length < 8) continue;
    if (end.endsWith(phrase.repeat(3))) return true;
  }
  return false;
}
