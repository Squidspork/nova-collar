const chat = document.getElementById("chat");
const input = document.getElementById("input");
const eyes = document.getElementById("eyes");
const creature = document.getElementById("creature");
const wake = document.getElementById("wake");
const pinBtn = document.getElementById("pin");
const dockBtn = document.getElementById("dock-btn");
const termBtn = document.getElementById("term-btn");
const chatsBtn = document.getElementById("chats-btn");
const chats = document.getElementById("chats");
const chatsList = document.getElementById("chats-list");
const crewBtn = document.getElementById("crew-btn");
const crewTag = document.getElementById("crew-tag");
const goalTag = document.getElementById("goal-tag");
let goalArchive = [];
const crew = document.getElementById("crew");
const crewList = document.getElementById("crew-list");
const crewEdit = document.getElementById("crew-edit");
let lastBots = [];
let packTeach = [];
let lastTasks = [];
let openChatId = "";
let lastPacks = [];
let lastPlaybooks = [];
let currentCrew = null;
let editingBot = null;
const senseBtn = document.getElementById("sense-btn");
const sense = document.getElementById("sense");
let lastSense = null;
const settingsBtn = document.getElementById("settings-btn");
const settings = document.getElementById("settings");
const themesList = document.getElementById("themes-list");
const voiceList = document.getElementById("voice-list");
const voiceNow = document.getElementById("voice-now");
const voiceWish = document.getElementById("voice-wish");
const voiceMake = document.getElementById("voice-make");
const modelBtn = document.getElementById("model-btn");
const models = document.getElementById("models");
const modelsList = document.getElementById("models-list");
const stage = document.getElementById("stage");
const split = document.getElementById("split");
const cwdForm = document.getElementById("cwd-form");
const cwdInput = document.getElementById("cwd");
document.body.dataset.os = window.pup.os || "";

const packsMachines = document.getElementById("packs-machines");
const packsWork = document.getElementById("packs-work");
const MACHINE_PACKS = new Set(["term", "host", "computer", "desk"]);
const packHint = document.getElementById("pack-hint");
const PACK_PREFIX = /^Use the \w+ pack\.\s*/i;
let selectedPack = "";
let queued = "";

try {
  selectedPack = localStorage.getItem("novapup-pack") || "";
} catch {
  selectedPack = "";
}

function showWorkdir(path, force) {
  if (!path) return;
  if (!force && document.activeElement === cwdInput) return;
  cwdInput.value = path;
  cwdForm.classList.remove("bad");
}

let live = null;
let pendingStep = null;
let pinned = false;
let busy = false;
let streamBuf = "";
let streamRaf = 0;
const sendBtn = document.getElementById("send");
const layout = {
  dock: "bottom",
  term: 180,
  termOn: false,
};

function loadLayout() {
  try {
    Object.assign(layout, JSON.parse(localStorage.getItem("novapup-layout") || "{}"));
  } catch {
    /* keep defaults */
  }
  applyLayout();
}

function saveLayout() {
  localStorage.setItem("novapup-layout", JSON.stringify(layout));
}

function uiScale() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  let u = w / 420;
  if (h < 380) u *= 0.88;
  return Math.round(Math.min(1.5, Math.max(0.68, u)) * 100) / 100;
}

function applyScale() {
  const u = uiScale();
  const w = window.innerWidth;
  const h = window.innerHeight;
  document.documentElement.style.setProperty("--u", String(u));
  document.body.dataset.compact = h < 500 || w < 460 ? "1" : "";
  document.body.dataset.size = w < 360 ? "s" : w < 640 ? "m" : "l";
  if (window.term) {
    const next = Math.max(10, Math.round(12 * u));
    if (window.term.options.fontSize !== next) window.term.options.fontSize = next;
  }
}

function applyLayout() {
  applyScale();
  stage.dataset.dock = layout.dock;
  stage.dataset.term = layout.termOn ? "on" : "off";
  stage.style.setProperty("--term", `${layout.term}px`);
  document.querySelector(".creature").style.setProperty("--term", `${layout.term}px`);
  const onRight = layout.dock === "side";
  dockBtn.hidden = !layout.termOn;
  dockBtn.textContent = onRight ? "bottom" : "right";
  dockBtn.title = onRight ? "Move the terminal to the bottom" : "Move the terminal to the right";
  termBtn?.classList.toggle("active", layout.termOn);
  if (layout.termOn) window.fit?.fit();
}

function when(ts) {
  if (!ts) return "";
  const delta = Date.now() - ts;
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return new Date(ts).toLocaleDateString();
}

function paintMessages(messages) {
  chat.innerHTML = "";
  live = null;
  pendingStep = null;
  closeTurn();
  for (const row of messages || []) {
    if (row.role === "step") {
      addStepCard(row, openTurn());
      continue;
    }
    if (!row?.content?.trim()) continue;
    add(row.role, row.content);
  }
}

function modelLabel(id, list) {
  return (list || []).find((row) => row.id === id)?.label || id || "Local 3.8";
}

function showModel(id, list, split) {
  modelBtn.textContent = split?.on ? `${split.fast} + ${split.think}` : modelLabel(id, list);
  modelBtn.title = split?.on ? `Fast: ${split.fast} · Thinking: ${split.think}` : modelLabel(id, list);
}

function paintPackHint() {
  if (!packHint) return;
  if (!selectedPack) {
    packHint.hidden = true;
    packHint.textContent = "";
    return;
  }
  packHint.hidden = false;
  packHint.textContent = `using ${selectedPack} · clear`;
}

function setPack(id) {
  selectedPack = id === selectedPack ? "" : id || "";
  try {
    if (selectedPack) localStorage.setItem("novapup-pack", selectedPack);
    else localStorage.removeItem("novapup-pack");
  } catch {
    /* ignore */
  }
  for (const btn of document.querySelectorAll(".packs button")) {
    btn.classList.toggle("on", btn.dataset.pack === selectedPack);
  }
  paintPackHint();
}

function safeShot(value) {
  const text = String(value || "").trim();
  return /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(text) ? text : "";
}

function whenSense(ts) {
  if (!ts) return "";
  const delta = Date.now() - Number(ts);
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  if (delta < 86_400_000) return `${Math.max(1, Math.round(delta / 3_600_000))}h ago`;
  return `${Math.max(1, Math.round(delta / 86_400_000))}d ago`;
}

function fillList(node, rows, empty) {
  if (!node) return;
  node.replaceChildren();
  const items = rows?.length ? rows : [empty];
  for (const row of items) {
    const li = document.createElement("li");
    li.textContent = row;
    node.append(li);
  }
}

function paintSense(doc) {
  lastSense = doc || lastSense;
  const intent = document.getElementById("sense-intent");
  const meta = document.getElementById("sense-meta");
  if (intent) intent.textContent = lastSense?.intent || "House sense is empty until a turn lands.";
  fillList(document.getElementById("sense-misses"), lastSense?.misses, "No verified miss yet.");
  fillList(document.getElementById("sense-friction"), lastSense?.friction, "No friction noted yet.");
  fillList(document.getElementById("sense-next"), lastSense?.next, "No next-time notes yet.");
  if (meta) {
    const src = lastSense?.source || "seed";
    const pain = Number.isFinite(lastSense?.pain) ? `pain ${lastSense.pain}/10` : "";
    const streak = lastSense?.streak > 1 ? `streak ${lastSense.streak}` : "";
    meta.textContent = [src, pain, streak, lastSense?.updated ? whenSense(lastSense.updated) : ""].filter(Boolean).join(" · ");
  }
}

function renderPacks(state) {
  lastPacks = state.packs || lastPacks;
  packsMachines?.replaceChildren();
  packsWork?.replaceChildren();
  for (const row of state.packs || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.pack = row.id;
    btn.textContent = row.title || row.id;
    btn.title = row.blurb || `${row.title} pack`;
    btn.classList.toggle("on", row.id === selectedPack);
    btn.onclick = () => {
      setPack(row.id);
      input.focus();
    };
    (MACHINE_PACKS.has(row.id) ? packsMachines : packsWork)?.appendChild(btn);
  }
  paintPackHint();
  const machines = document.getElementById("drawer-machines");
  const work = document.getElementById("drawer-work");
  if (machines) machines.hidden = !packsMachines?.childElementCount;
  if (work) work.hidden = !packsWork?.childElementCount;
}

function laneOptions(state, current) {
  const options = new Map();
  for (const row of state.models || []) options.set(row.id, row.label || row.id);
  if (current && !options.has(current)) options.set(current, current);
  return options;
}

function renderModels(state) {
  modelsList.innerHTML = "";
  const active = document.createElement("p");
  active.className = "model-active";
  active.textContent = `${state.host || "This system"} · ${state.split?.on ? `Fast: ${state.split.fast} + Think: ${state.split.think}` : state.local ? `Local: ${state.localModel}` : `Hosted: ${state.model}`}`;
  modelsList.append(active);
  const refresh = document.createElement("button");
  refresh.className = "chat-item";
  refresh.textContent = "Refresh available models";
  refresh.onclick = async () => {
    refresh.disabled = true;
    refresh.textContent = "Checking model servers…";
    try { renderModels(await window.pup.refreshModels()); }
    catch (error) { refresh.textContent = `Refresh failed: ${error.message}`; refresh.disabled = false; }
  };
  modelsList.append(refresh);
  if (state.modelScanError) {
    const error = document.createElement("p"); error.className = "lane-note"; error.textContent = state.modelScanError; modelsList.append(error);
  }
  if (/^https:\/\/ai\.hungrynova\.com(?:\/|$)/.test(state.providerUrl || "")) {
    const pair = document.createElement("button");
    pair.className = "chat-item";
    pair.textContent = "Use hosted 4B + 27B (no local GPU)";
    pair.disabled = busy;
    pair.onclick = async () => { const next = await window.pup.useHostedPair(); showModel(next.model, next.models, next.split); renderModels(next); };
    modelsList.append(pair);
  }

  const lanesHead = document.createElement("p");
  lanesHead.className = "sheet-sub";
  lanesHead.textContent = "lanes";
  modelsList.append(lanesHead);

  const box = document.createElement("div");
  box.className = "lanes-pick";
  for (const lane of ["fast", "think"]) {
    const current = state.lanes?.[lane] || "";
    const row = document.createElement("label");
    row.className = "lane-row";
    const tag = document.createElement("b");
    tag.className = lane;
    tag.textContent = lane;
    const sel = document.createElement("select");
    const off = document.createElement("option");
    off.value = "";
    off.textContent = lane === "fast" ? "off — one model" : "same as chat";
    sel.append(off);
    for (const [id, label] of laneOptions(state, current)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = label;
      if (id === current) opt.selected = true;
      sel.append(opt);
    }
    sel.disabled = busy;
    sel.title = state.laneEndpoints?.[lane] || "Uses the configured provider";
    sel.onchange = async () => {
      if (busy) return;
      const next = await window.pup.setLane(lane, sel.value);
      showModel(next.model, next.models, next.split);
      renderModels(next);
    };
    row.append(tag, sel);
    box.append(row);
  }
  modelsList.append(box);

  const note = document.createElement("p");
  note.className = "lane-note";
  note.textContent = state.split?.on
    ? `Split on — fast ${state.split.fast} · think ${state.split.think}. Thinking role plans and checks; fast role handles tool work.`
    : "One model handles the turn. Set a fast model to enable separate roles.";
  modelsList.append(note);
  const chatHead = document.createElement("p");
  chatHead.className = "sheet-sub";
  chatHead.textContent = "Choose one model (turns off the pair)";
  modelsList.append(chatHead);

  const localRows = (state.localModels || []).map((row) => ({ ...row, localChoice: true, label: row.model, hint: "local" }));
  let group = "";
  for (const row of [...localRows, ...(state.models || []).filter((row) => row.id !== "local-3.8" || !localRows.length)]) {
    const nextGroup = row.localChoice || row.id === "local-3.8" ? "Local Ollama / LM Studio" : "Hosted provider";
    if (group !== nextGroup) { const label = document.createElement("p"); label.className = "sheet-sub"; label.textContent = nextGroup; modelsList.append(label); group = nextGroup; }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-item";
    if (row.localChoice ? state.local && row.model === state.localModel && row.url === state.chatUrl : row.id === state.model) btn.classList.add("current");
    const title = document.createElement("span");
    title.textContent = row.label || row.id;
    title.title = [row.model || row.id, row.description].filter(Boolean).join("\n");
    const hint = document.createElement("em");
    hint.textContent = row.hint || "";
    btn.append(title, hint);
    btn.onclick = async () => {
      if (busy) return;
      const next = row.localChoice ? (await window.pup.setupUse({ url: row.url, model: row.model })).state : await window.pup.setModel(row.id);
      if (!next) return;
      showModel(next.model, next.models, next.split);
      renderModels(next);
    };
    modelsList.appendChild(btn);
  }


}

function renderChats(session) {
  openChatId = session?.current || "";
  chatsList.innerHTML = "";
  for (const row of session?.chats || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-item";
    if (row.id === session.current) btn.classList.add("current");
    const title = document.createElement("span");
    title.textContent = row.title || "New chat";
    const time = document.createElement("em");
    time.textContent = when(row.updated);
    btn.append(title, time);
    btn.onclick = async () => {
      if (busy) return;
      chats.hidden = true;
      chatsBtn.classList.remove("active");
      if (row.id === session.current) return;
      const next = await window.pup.openChat(row.id);
      applyCrew(next);
      paintMessages(next.messages);
      renderChats(next.session);
      if (!next.messages?.length && next.ready) {
        add("assistant", "New page. Same pup.");
      }
    };
    chatsList.appendChild(btn);
  }
}

const now = document.getElementById("now");
const nowWord = document.getElementById("now-word");
const nowWords = {
  think: "thinking",
  write: "writing",
  code: "running",
  search: "looking",
  paint: "painting",
  desk: "watching",
  tool: "working",
};

let stickToEnd = true;

function followChat() {
  if (stickToEnd) chat.scrollTop = chat.scrollHeight;
  paintSpine();
}

function releaseFollow() {
  stickToEnd = false;
}

function holdFollow() {
  stickToEnd = true;
  followChat();
}

window.followChat = followChat;
window.holdFollow = holdFollow;

const spine = document.getElementById("spine");
const spineThumb = document.getElementById("spine-thumb");
let spineW = 12;
try {
  const saved = Number(localStorage.getItem("np-spine"));
  if (saved) spineW = saved;
} catch {
  spineW = 12;
}
spineW = Math.max(8, Math.min(36, spineW));
document.documentElement.style.setProperty("--spine-w", `${spineW}px`);

function paintSpine() {
  if (!spine || !spineThumb) return;
  const track = spine.clientHeight;
  const max = chat.scrollHeight - chat.clientHeight;
  if (max <= 0) {
    spineThumb.style.top = "10px";
    spineThumb.style.height = `${Math.max(48, track - 20)}px`;
    spineThumb.style.opacity = "0.4";
    return;
  }
  const height = Math.max(48, (chat.clientHeight / chat.scrollHeight) * track);
  const travel = Math.max(1, track - height);
  spineThumb.style.height = `${height}px`;
  spineThumb.style.top = `${(chat.scrollTop / max) * travel}px`;
  spineThumb.style.opacity = "1";
}

chat.addEventListener("scroll", paintSpine, { passive: true });
chat.addEventListener("wheel", releaseFollow, { passive: true });
chat.addEventListener("touchmove", releaseFollow, { passive: true });
window.addEventListener("resize", paintSpine);
paintSpine();

spine?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  spine.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startY = event.clientY;
  const startW = spineW;
  const rect = spine.getBoundingClientRect();
  let mode = "";
  const move = (next) => {
    const dx = next.clientX - startX;
    const dy = next.clientY - startY;
    if (!mode && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
      mode = Math.abs(dx) > Math.abs(dy) ? "size" : "scroll";
    }
    if (mode === "size") {
      spineW = Math.max(8, Math.min(36, startW + dx));
      document.documentElement.style.setProperty("--spine-w", `${spineW}px`);
      paintSpine();
      return;
    }
    if (mode === "scroll") {
      releaseFollow();
      const max = chat.scrollHeight - chat.clientHeight;
      const y = Math.min(rect.bottom, Math.max(rect.top, next.clientY));
      const ratio = (y - rect.top) / rect.height;
      chat.scrollTop = ratio * Math.max(0, max);
    }
  };
  const up = () => {
    spine.removeEventListener("pointermove", move);
    spine.removeEventListener("pointerup", up);
    try {
      localStorage.setItem("np-spine", String(spineW));
    } catch {
      /* ignore */
    }
  };
  spine.addEventListener("pointermove", move);
  spine.addEventListener("pointerup", up);
});

function add(role, text, extra) {
  const el = document.createElement("div");
  el.className = `msg ${role} pop`;
  fillMessage(el, text, role === "assistant" && String(text || "").trim());
  if (extra) el.appendChild(extra);
  if (role === "assistant") openTurn().appendChild(el);
  else {
    closeTurn();
    chat.appendChild(el);
  }
  followChat();
  return el;
}

function paintSend() {
  sendBtn.classList.toggle("busy", busy);
  sendBtn.classList.toggle("stop", busy);
  sendBtn.title = busy ? "Stop" : "Send";
  sendBtn.setAttribute("aria-label", sendBtn.title);
}

function setMood(name, word) {
  const next = name || "idle";
  const label = word || nowWords[next] || "working";
  if (creature.dataset.mood === next && sendBtn.classList.contains("busy") === (next !== "idle")) {
    if (next === "idle") now.hidden = true;
    else if (word) nowWord.textContent = label;
    return;
  }
  eyes.dataset.mood = next;
  creature.dataset.mood = next;
  document.body.dataset.mood = next;
  paintSend();
  if (next === "idle") {
    now.hidden = true;
    return;
  }
  now.hidden = false;
  now.dataset.mood = next;
  nowWord.textContent = label;
}

function flushStream() {
  if (!live || !streamBuf) return;
  live.textContent += streamBuf;
  streamBuf = "";
  streamRaf = 0;
  followChat();
}

function pushDelta(text) {
  const box = openTurn();
  if (!live || live.parentNode !== box || box.lastElementChild !== live) startAssistant();
  live.classList.add("streaming");
  streamBuf += text;
  if (!streamRaf) streamRaf = requestAnimationFrame(flushStream);
}

function startAssistant() {
  if (live && !live.textContent && !streamBuf) live.remove();
  live = document.createElement("div");
  live.className = "msg assistant streaming";
  openTurn().appendChild(live);
}

function paintGoal(text, archive) {
  if (!goalTag) return;
  if (Array.isArray(archive)) goalArchive = archive;
  const goal = String(text ?? goalTag.dataset.goal ?? "").trim();
  if (text !== undefined) goalTag.dataset.goal = goal;
  const last = goalArchive.at(-1);
  goalTag.hidden = !goal && !last;
  goalTag.textContent = goal ? goal.slice(0, 48) : (last ? `check ${last.verdict}` : "");
  const lines = goalArchive.slice(-3).map((row) => `${row.verdict}: ${row.opposite || row.claim || row.detail || ""}`);
  const hint = goal ? "Click to change it. /goal clear ends it." : "Click to set a goal.";
  goalTag.title = [goal ? `Goal: ${goal}` : "", ...lines, hint].filter(Boolean).join("\n");
}

goalTag?.addEventListener("click", () => {
  hidePanels();
  input.value = `/goal ${goalTag.dataset.goal || ""}`;
  growInput();
  input.focus();
  input.setSelectionRange(6, input.value.length);
});

window.pup.on((event) => {
  if (event.type === "models") {
    showModel(event.state.model, event.state.models, event.state.split);
    if (!models.hidden) renderModels(event.state);
  }
  if (event.type === "mood") setMood(event.mood, event.text);
  if (event.type === "goal") {
    if (event.check) {
      goalArchive = [...goalArchive, { verdict: event.check, opposite: event.opposite || "", claim: "" }].slice(-6);
    }
    paintGoal(event.text, event.archive);
  }
  if (event.type === "retract") {
    flushStream();
    if (live) live.remove();
    live = null;
    streamBuf = "";
    streamRaf = 0;
  }
  if (event.type === "delta") pushDelta(event.text);
  if (event.type === "tool") {
    flushStream();
    if (live && !live.textContent.trim()) {
      live.remove();
      live = null;
    } else if (live) {
      live.classList.remove("streaming");
      live = null;
    }
    pendingStep = addStepCard({ name: event.name, pack: event.pack || "", pending: true, blurb: "working…" }, openTurn());
  }
  if (event.type === "tool_result") {
    if (pendingStep) fillStepCard(pendingStep, event);
    else addStepCard(event, openTurn());
    pendingStep = null;
    followChat();
  }
  if (event.type === "shot") {
    const dataUrl = safeShot(event.dataUrl);
    if (!dataUrl) return;
    if (event.kind === "paint") addStepArt(pendingStep, dataUrl);
  }
  if (event.type === "cwd") showWorkdir(event.path);
  if (event.type === "term" && window.term) window.term.write(event.data);
  if (event.type === "error") {
    flushStream();
    if (live) {
      live.classList.remove("streaming");
      live.classList.add("error");
      fillMessage(live, event.text || "That failed.", true);
    } else {
      add("error", event.text || "That failed.");
    }
    live = null;
    closeTurn();
    busy = false;
    setMood("idle");
    flushQueue();
  }
  if (event.type === "done") {
    flushStream();
    const body = String(event.text || "").trim() || (live ? live.textContent.trim() : "");
    if (live) {
      live.classList.remove("streaming");
      if (body) fillMessage(live, body, true);
      else live.remove();
    } else if (body) {
      add("assistant", body);
    }
    live = null;
    closeTurn();
    busy = false;
    setMood("idle");
    flushQueue();
  }
  if (event.type === "intuition") {
    paintSense(event.intuition);
    senseBtn?.classList.add("fresh");
  }
  if (event.type === "pack" && Array.isArray(event.lessons)) {
    packTeach = event.lessons;
    paintBrief();
    paintLearned();
  }
  if (event.type === "board" && Array.isArray(event.tasks)) {
    lastTasks = event.tasks;
    paintBoard();
  }
  if (event.type === "notice") {
    showNotice(event);
    if (event.chatId && event.chatId === openChatId && event.text) add("assistant", event.text);
  }
});

function growInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

input.addEventListener("input", growInput);
packHint?.addEventListener("click", () => setPack(""));

function flushQueue() {
  paintSend();
  const next = queued;
  queued = "";
  if (!next) {
    if (currentCrew) input.placeholder = `task for ${currentCrew.name}`;
    else input.placeholder = "Talk to Nova Collar";
    return;
  }
  input.value = next;
  send();
}

async function send() {
  const raw = input.value.replace(PACK_PREFIX, "").trim();
  if (!raw) return;
  if (/^\/?credits$/i.test(raw)) {
    input.value = "";
    input.style.height = "";
    window.openCredits?.();
    return;
  }
  if (busy) {
    queued = raw;
    input.value = "";
    input.style.height = "";
    input.placeholder = "queued — finishing this first";
    return;
  }
  input.value = "";
  input.style.height = "";
  holdFollow();
  add("user", raw);
  busy = true;
  live = null;
  pendingStep = null;
  closeTurn();
  streamBuf = "";
  paintSend();
  setMood("think");
  const result = await window.pup.chat(raw, selectedPack);
  if (result?.error === "need-keys") {
    wake.hidden = false;
    busy = false;
    setMood("idle");
    flushQueue();
  }
}

window.openSpecInChat = async (text) => {
  const raw = String(text || "").trim();
  if (raw.length < 80) return { ok: false, error: "The spec is too thin to start." };
  if (busy) return { ok: false, error: "Finish the current chat first." };
  const previous = (await window.pup.state())?.workdir || "";
  const folder = raw.match(/^Folder:\s*(.+)$/m)?.[1]?.trim();
  if (folder) {
    const moved = await window.pup.setWorkdir(folder);
    if (moved?.path) showWorkdir(moved.path);
  }
  const next = await window.pup.newChat();
  paintMessages([]);
  renderChats(next.session);
  applyCrew(next);
  hidePanels();
  input.value = raw;
  growInput();
  try {
    await send();
  } finally {
    if (folder && previous && previous !== folder) {
      const back = await window.pup.setWorkdir(previous);
      if (back?.path) showWorkdir(back.path);
    }
  }
  return { ok: true };
};

async function boot() {
  if (PACK_PREFIX.test(input.value)) {
    input.value = input.value.replace(PACK_PREFIX, "");
    growInput();
  }
  const state = await window.pup.state();
  document.body.dataset.os = state.os || window.pup.os || "";
  wake.hidden = state.ready;
  showWorkdir(state.workdir);
  showModel(state.model, state.models, state.split);
  renderPacks(state);
  renderModels(state);
  renderChats(state.session);
  applyCrew(state);
  paintGoal(state.goal || "", state.archive || []);
  paintSense(state.intuition);
  if (state.messages?.length) paintMessages(state.messages);
  else if (!state.ready) add("assistant", "Hungry Nova, in this window. Drop a chat key and I’ll wake.");
  else add("assistant", "Here. Ask, and I’ll do it.");
  if (!state.setupDone) window.openSetup?.();
}

sendBtn.onclick = () => {
  if (busy) window.pup.stop();
  else send();
};
input.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && busy) {
    event.preventDefault();
    window.pup.stop();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});

pinBtn.onclick = async () => {
  pinned = !pinned;
  await window.pup.pin(pinned);
  pinBtn.classList.toggle("active", pinned);
};

function toggleTerm() {
  layout.termOn = !layout.termOn;
}

async function onTermToggle() {
  toggleTerm();
  if (layout.termOn && window.innerHeight < 420) {
    await window.pup.grow({ height: 520 });
  }
  applyLayout();
  saveLayout();
}

termBtn.onclick = onTermToggle;
document.getElementById("term-fold").onclick = onTermToggle;

dockBtn.onclick = () => {
  layout.dock = layout.dock === "side" ? "bottom" : "side";
  applyLayout();
  saveLayout();
};

split.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  split.classList.add("dragging");
  const side = layout.dock === "side";
  const start = side ? event.clientX : event.clientY;
  const startSize = layout.term;
  const move = (next) => {
    const delta = side ? start - next.clientX : start - next.clientY;
    const max = side ? stage.clientWidth - 220 : stage.clientHeight - 140;
    layout.term = Math.max(120, Math.min(max, startSize + delta));
    applyLayout();
  };
  const up = () => {
    split.classList.remove("dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    saveLayout();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
});

const PROVIDERS = [
  {
    id: "hnl",
    label: "Hungry Nova Labs",
    url: "https://ai.hungrynova.com/v1",
    kind: "https",
    fixedUrl: true,
    models: ["nova-pup:27b", "nova-pup:4b", "nova-pup:3.8", "nova-master:next"],
    note: "Enter the API key we gave you and connect. Then choose the hosted 4B + 27B pair in Models.",
  },
  {
    id: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1",
    kind: "https",
    models: ["gpt-4o-mini", "gpt-4o"],
    note: "Your OpenAI API key.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    kind: "https",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet"],
    note: "Your OpenRouter API key. Any model it lists.",
  },
  {
    id: "groq",
    label: "Groq",
    url: "https://api.groq.com/openai/v1",
    kind: "https",
    models: ["llama-3.3-70b-versatile"],
    note: "Your Groq API key.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    url: "",
    kind: "https",
    models: [],
    note: "Any OpenAI-compatible https address, with your own key and model.",
  },
  {
    id: "local",
    label: "On this computer (Ollama / LM Studio)",
    url: "",
    kind: "local",
    models: [],
    note: "Scan this computer for a local model server. No key needed.",
  },
];

const wakeProvider = document.getElementById("wake-provider");
const wakeNote = document.getElementById("wake-note");
const wakeUrlRow = document.getElementById("wake-url-row");
const wakeUrl = document.getElementById("wake-url");
const wakeModelRow = document.getElementById("wake-model-row");
const wakeModel = document.getElementById("wake-model");
const wakeModels = document.getElementById("wake-models");
const wakeKeyRow = document.getElementById("wake-key-row");
const wakeToolsRow = document.getElementById("wake-tools-row");
const wakeBtn = document.getElementById("wake-btn");
const chatKeyInput = document.getElementById("chat-key");

function currentProvider() {
  return PROVIDERS.find((row) => row.id === wakeProvider.value) || PROVIDERS[0];
}

function applyProvider() {
  const p = currentProvider();
  wakeNote.textContent = p.note || "";
  const local = p.kind === "local";
  const fixed = Boolean(p.fixedUrl);
  wakeUrlRow.hidden = local || fixed;
  wakeModelRow.hidden = local;
  wakeKeyRow.hidden = local;
  wakeToolsRow.hidden = local;
  if (!local && !fixed) wakeUrl.value = p.url || "";
  wakeModels.replaceChildren();
  for (const id of p.models || []) {
    const opt = document.createElement("option");
    opt.value = id;
    wakeModels.append(opt);
  }
  if (!local) wakeModel.value = (p.models && p.models[0]) || "";
  wakeBtn.textContent = local ? "Scan this computer" : "Connect";
}

for (const p of PROVIDERS) {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = p.label;
  wakeProvider.append(opt);
}
wakeProvider.onchange = applyProvider;
applyProvider();

wakeBtn.onclick = async () => {
  const p = currentProvider();
  if (p.kind === "local") {
    wake.hidden = true;
    window.openSetup?.();
    return;
  }
  const url = (p.fixedUrl ? p.url : wakeUrl.value.trim()) || "";
  const model = wakeModel.value.trim();
  const chatKey = chatKeyInput.value.trim();
  const toolsKey = document.getElementById("tools-key").value.trim();
  if (!chatKey && !toolsKey) {
    wakeNote.textContent = "Add your API key to connect.";
    return;
  }
  if (!url) {
    wakeNote.textContent = "Add the https address for this provider.";
    return;
  }
  if (!model) {
    wakeNote.textContent = "Name the model to use.";
    return;
  }
  wakeBtn.disabled = true;
  let next;
  try { next = await window.pup.saveKeys({ chatKey, toolsKey, model, chatUrl: url }); }
  catch (error) { wakeNote.textContent = `Could not save settings: ${error.message}`; return; }
  finally { wakeBtn.disabled = false; }
  if (next.urlRejected) {
    wakeNote.textContent = "That address was not accepted. Use a public https URL.";
    return;
  }
  if (next.ready) {
    wake.hidden = true;
    showModel(next.model, next.models, next.split);
    renderModels(next);
    add("assistant", "Provider saved. The next message will test the connection.");
  } else {
    wakeNote.textContent = "Still not connected. Check the key and address.";
  }
};

const THEMES = [
  { id: "den", title: "den", blurb: "moss floor · fireflies" },
  { id: "amber", title: "amber", blurb: "DEC tube · phosphor" },
  { id: "radar", title: "radar", blurb: "night watch · rings" },
  { id: "ledger", title: "ledger", blurb: "matte stock · ink" },
  { id: "flare", title: "flare", blurb: "incident · siren" },
  { id: "candy", title: "candy", blurb: "cotton floss · bubbles" },
  { id: "arcade", title: "arcade", blurb: "neon grid · pulse" },
  { id: "bloom", title: "bloom", blurb: "confetti · pop" },
];

const TERM_PAINT = {
  den: { background: "#080c0a", foreground: "#d7e0db", cursor: "#10b981", selectionBackground: "rgba(16,185,129,0.28)" },
  amber: { background: "#100b07", foreground: "#ffb000", cursor: "#ffb000", selectionBackground: "rgba(255,176,0,0.28)" },
  radar: { background: "#050910", foreground: "#b8d4e8", cursor: "#4aa6ff", selectionBackground: "rgba(74,166,255,0.28)" },
  ledger: { background: "#9a907c", foreground: "#2a241c", cursor: "#5c3324", selectionBackground: "rgba(92,51,36,0.22)" },
  flare: { background: "#0c0608", foreground: "#f0d0c8", cursor: "#ff5a3a", selectionBackground: "rgba(255,90,58,0.28)" },
  candy: { background: "#12091a", foreground: "#ffe3f6", cursor: "#ff5fd0", selectionBackground: "rgba(255,95,208,0.28)" },
  arcade: { background: "#0a0618", foreground: "#e8e3ff", cursor: "#2ff0ff", selectionBackground: "rgba(47,240,255,0.28)" },
  bloom: { background: "#141018", foreground: "#fff2e8", cursor: "#ff7a3c", selectionBackground: "rgba(255,122,60,0.26)" },
};

let currentTheme = "den";
try {
  currentTheme = localStorage.getItem("novapup-theme") || "den";
} catch {
  currentTheme = "den";
}

function applyTheme(id) {
  const theme = THEMES.find((row) => row.id === id) || THEMES[0];
  currentTheme = theme.id;
  document.documentElement.dataset.theme = theme.id;
  document.body.dataset.theme = theme.id;
  try {
    localStorage.setItem("novapup-theme", theme.id);
  } catch {
    /* ignore */
  }
  if (window.term) window.term.options.theme = TERM_PAINT[theme.id] || TERM_PAINT.den;
  paintThemes();
}

function paintThemes() {
  if (!themesList) return;
  themesList.replaceChildren();
  for (const row of THEMES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-item";
    if (row.id === currentTheme) btn.classList.add("current");
    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.dataset.theme = row.id;
    swatch.innerHTML = "<b></b><b></b><b></b>";
    const title = document.createElement("span");
    title.textContent = row.title;
    const hint = document.createElement("em");
    hint.textContent = row.blurb;
    btn.append(swatch, title, hint);
    btn.onclick = () => {
      if (document.startViewTransition) document.startViewTransition(() => applyTheme(row.id));
      else applyTheme(row.id);
    };
    themesList.appendChild(btn);
  }
}

function hidePanels() {
  chats.hidden = true;
  models.hidden = true;
  if (settings) settings.hidden = true;
  if (crew) crew.hidden = true;
  if (crewEdit) crewEdit.hidden = true;
  const taskEdit = document.getElementById("task-edit");
  if (taskEdit) taskEdit.hidden = true;
  if (sense) sense.hidden = true;
  const specSheet = document.getElementById("spec");
  if (specSheet) specSheet.hidden = true;
  document.getElementById("spec-menu")?.setAttribute("hidden", "");
  creature.classList.remove("spec-open");
  document.getElementById("spec-btn")?.classList.remove("active");
  setCrewPage(false);
  chatsBtn.classList.remove("active");
  modelBtn.classList.remove("active");
  settingsBtn?.classList.remove("active");
  crewBtn?.classList.remove("active");
  senseBtn?.classList.remove("active");
}
window.hidePanels = hidePanels;

for (const btn of document.querySelectorAll(".sheet-x:not(#spec-close)")) {
  btn.onclick = () => {
    hidePanels();
    if (btn.dataset.back === "crew") crewBtn.click();
  };
}

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const field = document.activeElement;
  if (field?.closest(".sheet") && field.matches("input, textarea, select")) {
    field.blur();
    return;
  }
  if (!document.querySelector(".sheet:not([hidden])")) return;
  event.preventDefault();
  hidePanels();
});

modelBtn.onclick = async () => {
  const open = models.hidden;
  hidePanels();
  if (!open) return;
  const state = await window.pup.state();
  showModel(state.model, state.models, state.split);
  renderModels(state);
  models.hidden = false;
  modelBtn.classList.add("active");
  const next = await window.pup.refreshModels({ force: false });
  if (!models.hidden) {
    showModel(next.model, next.models, next.split);
    renderModels(next);
  }
};

chatsBtn.onclick = async () => {
  const open = chats.hidden;
  hidePanels();
  if (!open) return;
  const state = await window.pup.state();
  renderChats(state.session);
  chats.hidden = false;
  chatsBtn.classList.add("active");
};

senseBtn.onclick = async () => {
  const open = sense.hidden;
  hidePanels();
  if (!open) return;
  const state = await window.pup.state();
  paintSense(state.intuition);
  sense.hidden = false;
  senseBtn.classList.add("active");
  senseBtn.classList.remove("fresh");
};

document.getElementById("sense-now").onclick = async () => {
  const next = await window.pup.reviewSense();
  paintSense(next.intuition);
  senseBtn.classList.remove("fresh");
};

window.noteSetup = (text) => {
  if (text) add("assistant", text);
};

window.afterSetup = (state) => {
  if (!state) return;
  wake.hidden = state.ready;
  showModel(state.model, state.models, state.split);
};

function paintVoices(voices, current = "") {
  if (!voiceList) return;
  voiceList.replaceChildren();
  for (const row of voices || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-item voice-pick";
    if (row.text === current) btn.classList.add("current");
    const name = document.createElement("em");
    name.textContent = row.name;
    const body = document.createElement("span");
    body.textContent = row.text;
    btn.append(name, body);
    btn.onclick = async () => {
      const saved = await window.pup.setVoice(row.text);
      if (!saved?.ok) {
        if (voiceNow) voiceNow.textContent = saved?.error || "Couldn’t keep that.";
        return;
      }
      if (voiceNow) voiceNow.textContent = row.name;
      paintVoices(voices, row.text);
    };
    voiceList.appendChild(btn);
  }
}

settingsBtn.onclick = async () => {
  const open = settings.hidden;
  hidePanels();
  if (!open) return;
  paintThemes();
  settings.hidden = false;
  settingsBtn.classList.add("active");
  const current = await window.pup.readVoice();
  if (voiceNow) voiceNow.textContent = current?.text ? current.text : "How I talk.";
};

voiceMake.onclick = async () => {
  const wish = voiceWish?.value.trim() || "";
  if (wish.length < 8) {
    if (voiceNow) voiceNow.textContent = "Say a little more about the voice.";
    return;
  }
  voiceMake.disabled = true;
  voiceMake.textContent = "writing";
  const made = await window.pup.makeVoices(wish);
  voiceMake.disabled = false;
  voiceMake.textContent = "make four voices";
  if (!made?.ok) {
    if (voiceNow) voiceNow.textContent = made?.error || "That failed.";
    return;
  }
  const current = await window.pup.readVoice();
  paintVoices(made.voices, current?.text || "");
  if (voiceNow) voiceNow.textContent = "Pick one. This window keeps it.";
};

document.getElementById("voice-form").addEventListener("submit", (event) => {
  event.preventDefault();
  voiceMake.click();
});

cwdForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const next = await window.pup.setWorkdir(cwdInput.value.trim());
  if (next?.ok) {
    showWorkdir(next.path, true);
    cwdInput.blur();
    return;
  }
  cwdForm.classList.add("bad");
});

document.getElementById("cwd-pick").onclick = async () => {
  const next = await window.pup.pickWorkdir();
  if (next?.ok) showWorkdir(next.path);
};

document.getElementById("new-chat").onclick = async () => {
  if (busy) return;
  const next = await window.pup.newChat();
  paintMessages([]);
  renderChats(next.session);
  applyCrew(next);
  chats.hidden = true;
  chatsBtn.classList.remove("active");
  add("assistant", "New page. Same pup.");
};

crewBtn.onclick = async () => {
  const taskEdit = document.getElementById("task-edit");
  const open = crew.hidden && crewEdit.hidden && (!taskEdit || taskEdit.hidden);
  hidePanels();
  if (!open) return;
  const next = await window.pup.bots();
  applyCrew(next);
  paintCrew();
  crew.hidden = false;
  setCrewPage(true);
  crewBtn.classList.add("active");
};

crewTag.onclick = () => {
  hidePanels();
  if (currentCrew) {
    openDossier(currentCrew);
    crewBtn.classList.add("active");
    return;
  }
  crewBtn.click();
};

document.getElementById("crew-new").onclick = () => openDossier(null);

document.getElementById("task-new").onclick = () => openTaskForm();
document.getElementById("task-bot").onchange = () => {
  const member = document.getElementById("task-member");
  if (member) member.open = !document.getElementById("task-bot").value;
};

document.getElementById("task-save").onclick = async () => {
  const title = document.getElementById("task-title").value.trim();
  if (!title) return;
  const botId = document.getElementById("task-bot").value;
  const payload = {
    title,
    goal: document.getElementById("task-goal").value,
    every: document.getElementById("task-every").value,
    botId,
  };
  if (!botId) {
    payload.member = {
      name: document.getElementById("task-name").value,
      title: document.getElementById("task-job").value,
      role: document.getElementById("task-role").value || title,
      voice: document.getElementById("task-voice").value,
      pack: document.getElementById("task-pack").value,
    };
  }
  try {
    const next = await window.pup.saveTask(payload);
    applyCrew(next);
    paintCrew();
    document.getElementById("task-edit").hidden = true;
    crew.hidden = false;
    setCrewPage(true);
    crewBtn.classList.add("active");
  } catch (error) {
    add("error", error.message || "Could not assign that task.");
  }
};

document.getElementById("task-form").onsubmit = (event) => {
  event.preventDefault();
  document.getElementById("task-save").click();
};

document.getElementById("notice-dismiss").onclick = () => {
  document.getElementById("notice").hidden = true;
};

document.getElementById("notice-open").onclick = () => {
  const id = document.getElementById("notice").dataset.chat;
  document.getElementById("notice").hidden = true;
  openTaskChat(id);
};

document.getElementById("crew-save").onclick = async () => {
  try {
    const next = await window.pup.saveBot({
      id: editingBot?.id || "",
      name: document.getElementById("bot-name").value,
      title: document.getElementById("bot-title").value,
      role: document.getElementById("bot-role").value,
      voice: document.getElementById("bot-voice").value,
      pack: document.getElementById("bot-pack").value,
      ask: document.getElementById("bot-ask").value,
      starts: document.getElementById("bot-starts").value,
      playbook: document.getElementById("bot-playbook").value,
    });
    applyCrew(next);
    paintCrew();
    crewEdit.hidden = true;
    crew.hidden = false;
    setCrewPage(true);
    crewBtn.classList.add("active");
  } catch (error) {
    add("error", error.message || "Could not save teammate.");
  }
};

document.getElementById("crew-delete").onclick = async () => {
  if (!editingBot?.id || busy) return;
  try {
    const next = await window.pup.removeBot(editingBot.id);
    applyCrew(next);
    renderChats(next.session);
    paintMessages(next.messages || []);
    paintCrew();
    crewEdit.hidden = true;
    crew.hidden = false;
    setCrewPage(true);
    crewBtn.classList.add("active");
  } catch (error) {
    add("error", error.message || "Could not delete teammate.");
  }
};

document.getElementById("crew-form").onsubmit = (event) => {
  event.preventDefault();
  document.getElementById("crew-save").click();
};

function drawerOpen(id, open) {
  const el = document.getElementById(`drawer-${id}`);
  if (!el) return;
  el.classList.toggle("open", open);
  el.querySelector(".drawer-toggle")?.setAttribute("aria-expanded", open ? "true" : "false");
}

let drawers = {};
try {
  drawers = JSON.parse(localStorage.getItem("np-drawers") || "{}");
} catch {
  drawers = {};
}
for (const btn of document.querySelectorAll(".drawer-toggle")) {
  const id = btn.dataset.drawer;
  drawerOpen(id, Boolean(drawers[id]));
  btn.onclick = () => {
    const el = document.getElementById(`drawer-${id}`);
    const open = !el.classList.contains("open");
    drawerOpen(id, open);
    drawers[id] = open;
    try {
      localStorage.setItem("np-drawers", JSON.stringify(drawers));
    } catch {
      /* ignore */
    }
  };
}

function applyHome(open) {
  creature.dataset.home = open ? "on" : "off";
  const fold = document.getElementById("home-fold");
  fold?.setAttribute("aria-expanded", open ? "true" : "false");
  fold?.setAttribute("title", open ? "Hide the bar" : "Show the bar");
  if (!open) hidePanels();
}

let homeOpen = true;
try {
  homeOpen = localStorage.getItem("np-home") !== "off";
} catch {
  homeOpen = true;
}
applyHome(homeOpen);
document.getElementById("home-fold").onclick = () => {
  homeOpen = creature.dataset.home !== "on";
  applyHome(homeOpen);
  try {
    localStorage.setItem("np-home", homeOpen ? "on" : "off");
  } catch {
    /* ignore */
  }
};

document.getElementById("min").onclick = () => window.pup.min();
document.getElementById("quit").onclick = () => window.pup.quit();

try {
  const term = new Terminal({
    cursorBlink: false,
    scrollback: 400,
    fontSize: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    theme: TERM_PAINT[currentTheme] || TERM_PAINT.den,
  });
  const Fit = window.FitAddon?.FitAddon || window.FitAddon;
  const fit = new Fit();
  term.loadAddon(fit);
  term.open(document.getElementById("terminal"));
  fit.fit();
  term.onData((data) => window.pup.termWrite(data));
  window.term = term;
  window.fit = fit;
  // One quiet line so the terminal is a two-way door: the user can ask the agent
  // from here, and the agent can type back. Only shown when the CLI is installed.
  window.pup
    .state()
    .then((s) => {
      if (s?.npReady) {
        term.write('\x1b[2m# ask the agent here:  np "what you want"   — it can type in this terminal too\x1b[0m\r\n');
      }
    })
    .catch(() => {});
  let fitTimer = 0;
  let lastBox = "";
  const refit = () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      const node = document.getElementById("terminal");
      const box = `${Math.round(node.clientWidth)}x${Math.round(node.clientHeight)}`;
      if (box === lastBox) return;
      lastBox = box;
      fit.fit();
      window.pup.termResize({ cols: term.cols, rows: term.rows });
    }, 80);
  };
  window.addEventListener("resize", () => {
    applyLayout();
    refit();
  });
  new ResizeObserver(refit).observe(document.getElementById("terminal"));
} catch (error) {
  document.getElementById("terminal").textContent = error.message;
}

function scrollPort(node) {
  const transcript = document.getElementById("chat");
  if (transcript && node instanceof Element && transcript.contains(node)) return transcript;
  let el = node instanceof Element ? node : null;
  while (el && el !== document.documentElement) {
    if (el.classList.contains("xterm")) return el.querySelector(".xterm-viewport") || el;
    const style = getComputedStyle(el);
    const scrollY = /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2;
    const scrollX = /(auto|scroll|overlay)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2;
    if (scrollY || scrollX || el.classList.contains("xterm-viewport")) return el;
    el = el.parentElement;
  }
  return null;
}

function enableFingerScroll() {
  const hold = "input, textarea, select, button, a, .split";
  let drag = null;
  let mode = "";
  let glide = 0;
  const stop = () => {
    cancelAnimationFrame(glide);
    glide = 0;
  };
  const begin = (target, x, y, stamp) => {
    if (!(target instanceof Element) || target.closest(hold)) return;
    const port = scrollPort(target);
    if (!port) return;
    stop();
    drag = { port, y, x, vy: 0, t: stamp };
  };
  const moveBy = (x, y, stamp) => {
    if (!drag) return false;
    const dy = drag.y - y;
    const dx = drag.x - x;
    const dt = Math.max(8, stamp - drag.t);
    drag.y = y;
    drag.x = x;
    drag.t = stamp;
    drag.vy = dy / dt;
    const port = drag.port;
    if (port.id === "chat") releaseFollow();
    if (Math.abs(dy) >= Math.abs(dx)) {
      const before = port.scrollTop;
      port.scrollTop += dy;
      if (port.scrollTop === before && port.classList.contains("xterm-viewport") && window.term) {
        window.term.scrollLines(dy > 0 ? Math.max(1, Math.round(dy / 18)) : Math.min(-1, Math.round(dy / 18)));
      }
    } else {
      port.scrollLeft += dx;
    }
    return true;
  };
  const end = () => {
    if (!drag) {
      mode = "";
      return;
    }
    const port = drag.port;
    let velocity = drag.vy * 16;
    drag = null;
    mode = "";
    const coast = () => {
      if (Math.abs(velocity) < 0.35) return;
      port.scrollTop += velocity;
      velocity *= 0.92;
      glide = requestAnimationFrame(coast);
    };
    if (Math.abs(velocity) > 0.8) coast();
  };
  document.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    mode = "touch";
    const touch = event.touches[0];
    begin(event.target, touch.clientX, touch.clientY, event.timeStamp);
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    if (mode !== "touch" || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (moveBy(touch.clientX, touch.clientY, event.timeStamp)) event.preventDefault();
  }, { passive: false });
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", end);
  document.addEventListener("pointerdown", (event) => {
    if (mode === "touch" || event.pointerType === "mouse" || !event.isPrimary) return;
    mode = "pointer";
    begin(event.target, event.clientX, event.clientY, event.timeStamp);
  });
  document.addEventListener("pointermove", (event) => {
    if (mode !== "pointer" || event.pointerType === "mouse") return;
    moveBy(event.clientX, event.clientY, event.timeStamp);
  });
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
}

applyTheme(currentTheme);
loadLayout();
enableFingerScroll();
boot();
