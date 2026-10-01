function shortTool(name) {
  return String(name || "tool")
    .replace(/^(host_file_|host_|computer_|mac_)/, "")
    .replace(/_check$/, "")
    .replaceAll("_", " ");
}

function tidyBlurb(name, blurb) {
  const label = shortTool(name);
  const text = String(blurb || "").trim();
  if (!text || !label) return text;
  const next = text.replace(new RegExp(`^${label}\\s+`, "i"), "");
  return next || text;
}

function stackStep(prev, next) {
  if (!prev || !next || prev.name !== next.name) return null;
  const hits = (Number(prev.hits) || 1) + 1;
  const okHits = (Number(prev.okHits) || (prev.ok === false ? 0 : 1)) + (next.ok === false ? 0 : 1);
  const bad = hits - okHits;
  const last = tidyBlurb(next.name, next.blurb) || (next.ok === false ? "Didn’t work." : "Done.");
  const blurb = bad ? `${last} · ${okHits} ok · ${bad} failed` : `${last} · ${hits}`;
  const detail = [prev.detail, next.detail].filter(Boolean).join("\n---\n").slice(0, 8000);
  return { ...next, hits, okHits, ok: bad === 0, blurb, detail };
}

function lastStep(host) {
  return [...(host?.children || [])].filter((node) => node.classList?.contains("step")).at(-1) || null;
}

function readCard(card) {
  return {
    name: card.dataset.name,
    ok: !card.classList.contains("bad"),
    hits: Number(card.dataset.hits) || 1,
    okHits: Number(card.dataset.okHits) || (card.classList.contains("bad") ? 0 : 1),
    blurb: card.querySelector(".blurb")?.textContent || "",
    detail: card.querySelector("pre")?.textContent || "",
  };
}

function paintCard(card, step) {
  card.className = `step ${step.pending ? "busy pop" : `land ${step.ok === false ? "bad" : "ok"}`}`;
  if (step.name) card.dataset.name = step.name;
  if (step.hits) card.dataset.hits = String(step.hits);
  if (step.okHits != null) card.dataset.okHits = String(step.okHits);
  const name = card.querySelector("summary b");
  if (name && step.name) name.textContent = shortTool(step.name);
  const blurb = card.querySelector(".blurb");
  if (blurb) blurb.textContent = step.pending ? "working…" : (step.blurb || tidyBlurb(step.name, step.blurb) || (step.ok === false ? "Didn’t work." : "Done."));
  let body = card.querySelector(".step-body");
  if (!body) {
    body = document.createElement("div");
    body.className = "step-body";
    card.appendChild(body);
  }
  body.replaceChildren();
  if (step.detail) {
    const pre = document.createElement("pre");
    pre.textContent = step.detail;
    body.appendChild(pre);
  }
}

function openTurn() {
  const chat = document.getElementById("chat");
  if (openTurn.now?.isConnected) return openTurn.now;
  const box = document.createElement("article");
  box.className = "turn pop";
  chat.appendChild(box);
  openTurn.now = box;
  return box;
}

function closeTurn() {
  openTurn.now = null;
}

function addStepCard(step, into) {
  const host = into || openTurn();
  const prior = lastStep(host);
  if (prior && prior.dataset.name === step.name && step.blurb !== "cleared") {
    if (step.pending) {
      prior.classList.add("busy");
      prior.classList.remove("land", "ok", "bad");
      const blurb = prior.querySelector(".blurb");
      if (blurb) blurb.textContent = "working…";
      return prior;
    }
    if (prior.dataset.settled === "1") {
      paintCard(prior, stackStep(readCard(prior), step));
      return prior;
    }
  }
  const card = document.createElement("details");
  card.dataset.hits = "1";
  card.dataset.okHits = step.ok === false ? "0" : "1";
  const summary = document.createElement("summary");
  summary.append(document.createElement("i"), document.createElement("b"), document.createElement("span"));
  summary.querySelector("i").className = "mark";
  summary.querySelector("span").className = "blurb";
  card.append(summary, document.createElement("div"));
  card.lastChild.className = "step-body";
  paintCard(card, step);
  if (!step.pending) card.dataset.settled = "1";
  host.appendChild(card);
  const chat = document.getElementById("chat");
  if (window.followChat) window.followChat();
  else chat.scrollTop = chat.scrollHeight;
  return card;
}

function fillStepCard(card, step) {
  if (!card) return;
  if (card.dataset.settled === "1" && card.dataset.name === step.name && step.blurb !== "cleared") {
    paintCard(card, stackStep(readCard(card), step));
  } else {
    paintCard(card, { ...step, hits: 1, okHits: step.ok === false ? 0 : 1, blurb: tidyBlurb(step.name, step.blurb) || step.blurb });
  }
  card.dataset.settled = "1";
}

function addStepArt(card, dataUrl) {
  if (!card || !dataUrl) return;
  let body = card.querySelector(".step-body");
  if (!body) {
    body = document.createElement("div");
    body.className = "step-body";
    card.appendChild(body);
  }
  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "generated image";
  img.className = "art";
  body.appendChild(img);
}
