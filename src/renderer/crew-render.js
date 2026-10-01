/* Crew: the roster, the task board, hire cards, the dossier, and the task form.
   Loaded before app.js so these definitions exist before boot() runs. All the
   crew element refs, state, and event wiring stay in app.js. */

function applyCrew(state) {
  currentCrew = state?.bot || null;
  lastBots = state?.bots || lastBots;
  lastPacks = state?.packs || lastPacks;
  lastPlaybooks = state?.playbooks || lastPlaybooks;
  if (Array.isArray(state?.packTeach)) packTeach = state.packTeach;
  if (Array.isArray(state?.tasks)) lastTasks = state.tasks;
  if (currentCrew) {
    crewTag.hidden = false;
    crewTag.textContent = currentCrew.name;
    input.placeholder = `task for ${currentCrew.name}`;
  } else {
    crewTag.hidden = true;
    crewTag.textContent = "";
    input.placeholder = "Talk to Nova Collar";
  }
  paintBrief();
}

function setCrewPage(on) {
  creature.classList.toggle("crew-open", Boolean(on));
}

function clipLine(text, max = 90) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function paintBrief() {
  const bar = document.getElementById("crew-brief");
  if (!bar) return;
  if (!currentCrew) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  document.getElementById("crew-brief-name").textContent = currentCrew.name;
  document.getElementById("crew-brief-title").textContent = [currentCrew.title, currentCrew.pack].filter(Boolean).join(" · ");
  document.getElementById("crew-brief-job").textContent = currentCrew.role || "Job is standing law. Chat is this task.";
  const learned = document.getElementById("crew-brief-pack");
  const mine = packTeach.filter((row) => row.pack === currentCrew.pack && row.from !== currentCrew.id);
  if (learned) {
    learned.hidden = !mine.length;
    learned.textContent = mine.length ? `From the crew: ${mine[0].fromName}: ${clipLine(mine[0].text, 110)}` : "";
  }
  const starts = document.getElementById("crew-starts");
  starts.replaceChildren();
  for (const line of String(currentCrew.starts || "").split("\n").map((row) => row.trim()).filter(Boolean).slice(0, 3)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = line;
    btn.onclick = () => {
      input.value = line;
      input.focus();
    };
    starts.append(btn);
  }
}

function paintHire(into, { fillOnly = false } = {}) {
  if (!into) return;
  into.replaceChildren();
  for (const book of lastPlaybooks) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hire-card" + (editingBot?.playbook === book.id ? " on" : "");
    btn.innerHTML = `<b></b><em></em><span></span>`;
    btn.querySelector("b").textContent = book.name;
    btn.querySelector("em").textContent = book.title;
    btn.querySelector("span").textContent = book.blurb;
    btn.onclick = () => (fillOnly ? fillPlaybook(book) : hirePlaybook(book));
    into.append(btn);
  }
}

function paintLearned() {
  const box = document.getElementById("pack-learn");
  if (!box) return;
  box.replaceChildren();
  if (!packTeach.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nothing taught yet. Correct one person, and the others who use those tools learn it.";
    box.append(empty);
    return;
  }
  for (const row of packTeach.slice(0, 6)) {
    const line = document.createElement("p");
    line.className = "empty";
    line.textContent = `${row.fromName} · ${row.pack}: ${clipLine(row.text, 120)}`;
    box.append(line);
  }
}

function taskWho(task) {
  return task.bot || lastBots.find((bot) => bot.id === task.botId)?.name || "unassigned";
}

function paintBoard() {
  const box = document.getElementById("kanban");
  if (!box) return;
  box.replaceChildren();
  const groups = [
    ["open", lastTasks.filter((row) => row.status !== "doing" && row.status !== "done")],
    ["doing", lastTasks.filter((row) => row.status === "doing")],
    ["done", lastTasks.filter((row) => row.status === "done")],
  ];
  for (const [name, rows] of groups) {
    const col = document.createElement("section");
    const title = document.createElement("h3");
    title.textContent = name;
    col.append(title);
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "—";
      col.append(empty);
    }
    for (const row of rows) {
      const card = document.createElement("button");
      card.type = "button";
      const who = document.createElement("b");
      who.textContent = row.title;
      const goal = document.createElement("p");
      goal.textContent = row.goal || row.title;
      card.append(who, goal);
      const meta = [taskWho(row), row.every ? `${row.every}m` : "once", row.note].filter(Boolean).join(" · ");
      const em = document.createElement("em");
      em.textContent = meta;
      card.append(em);
      card.onclick = () => openTaskChat(row.chatId);
      col.append(card);
    }
    box.append(col);
  }
}

async function openTaskChat(id) {
  if (!id || busy) return;
  try {
    const next = await window.pup.openChat(id);
    applyCrew(next);
    renderChats(next.session);
    paintMessages(next.messages || []);
    hidePanels();
    input.focus();
  } catch (error) {
    add("error", error.message || "Could not open that chat.");
  }
}

function showNotice(event) {
  const box = document.getElementById("notice");
  if (!box || !event?.title) return;
  box.hidden = false;
  box.dataset.chat = event.chatId || "";
  document.getElementById("notice-title").textContent = `Pack finished · ${event.title}`;
  document.getElementById("notice-body").textContent = clipLine(event.text, 140);
  document.getElementById("notice-open").hidden = !event.chatId;
}

function paintCrew() {
  paintHire(document.getElementById("crew-hire"));
  paintBoard();
  paintLearned();
  crewList.innerHTML = "";
  if (!lastBots.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No one here yet. Pick a starter or write one.";
    crewList.append(empty);
    return;
  }
  for (const bot of lastBots) {
    const row = document.createElement("div");
    row.className = "mate" + (currentCrew?.id === bot.id ? " current" : "");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "open";
    const turns = bot.count ? `${bot.count} turns` : "new";
    open.innerHTML = "<b></b><em></em><span></span>";
    open.querySelector("b").textContent = bot.name;
    open.querySelector("em").textContent = [bot.title || "operator", bot.pack || "auto", turns].filter(Boolean).join(" · ");
    open.querySelector("span").textContent = clipLine(bot.role) || "Job is standing law. Chat is this task.";
    open.onclick = () => openCrew(bot);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit";
    edit.textContent = "teach";
    edit.onclick = () => openDossier(bot);
    row.append(open, edit);
    crewList.append(row);
  }
}

async function openCrew(bot) {
  if (busy || !bot?.id) return;
  try {
    const next = await window.pup.openBot(bot.id);
    applyCrew(next);
    renderChats(next.session);
    paintMessages(next.messages || []);
    if (next.bot?.pack) setPack(next.bot.pack);
    hidePanels();
    input.focus();
  } catch (error) {
    add("error", error.message || "Could not open operator.");
  }
}

function fillPlaybook(book) {
  if (!book) return;
  editingBot = { ...editingBot, playbook: book.id };
  document.getElementById("bot-name").value = book.name || "";
  document.getElementById("bot-title").value = book.title || "";
  document.getElementById("bot-role").value = book.role || lastPlaybooks.find((row) => row.id === book.id)?.how || "";
  document.getElementById("bot-voice").value = book.voice || "";
  document.getElementById("bot-ask").value = book.ask || "";
  document.getElementById("bot-starts").value = book.starts || "";
  document.getElementById("bot-playbook").value = book.id || "";
  fillPackSelect();
  document.getElementById("bot-pack").value = book.pack || "";
  document.getElementById("crew-edit-label").textContent = book.name || "new operator";
  paintHire(document.getElementById("dossier-hire"), { fillOnly: true });
}

async function hirePlaybook(book) {
  if (!book?.id || busy) return;
  try {
    const next = await window.pup.saveBot({ playbook: book.id });
    const hired = (next.bots || []).find((row) => row.playbook === book.id) || next.bots?.[0];
    applyCrew(next);
    if (hired) await openCrew(hired);
  } catch (error) {
    add("error", error.message || "Could not hire.");
  }
}

function fillPackSelect() {
  const sel = document.getElementById("bot-pack");
  if (!sel) return;
  const keep = sel.value;
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "auto";
  sel.append(auto);
  for (const pack of lastPacks) {
    const opt = document.createElement("option");
    opt.value = pack.id;
    opt.textContent = pack.id;
    sel.append(opt);
  }
  sel.value = keep;
  const taskPack = document.getElementById("task-pack");
  if (taskPack) {
    const held = taskPack.value;
    taskPack.innerHTML = sel.innerHTML;
    taskPack.value = held;
  }
}

function openDossier(bot) {
  editingBot = bot || {};
  document.getElementById("crew-edit-label").textContent = bot?.id ? bot.name : "new operator";
  document.getElementById("bot-name").value = bot?.name || "";
  document.getElementById("bot-title").value = bot?.title || "";
  document.getElementById("bot-role").value = bot?.role || "";
  document.getElementById("bot-voice").value = bot?.voice || "";
  document.getElementById("bot-ask").value = bot?.ask || "";
  document.getElementById("bot-starts").value = bot?.starts || "";
  document.getElementById("bot-playbook").value = bot?.playbook || "";
  fillPackSelect();
  document.getElementById("bot-pack").value = bot?.pack || "";
  document.getElementById("crew-delete").hidden = !bot?.id;
  crew.hidden = true;
  crewEdit.hidden = false;
  setCrewPage(true);
  paintHire(document.getElementById("dossier-hire"), { fillOnly: true });
}

function fillTaskBots() {
  const sel = document.getElementById("task-bot");
  if (!sel) return;
  const keep = sel.value;
  sel.replaceChildren();
  const made = document.createElement("option");
  made.value = "";
  made.textContent = "new member";
  sel.append(made);
  for (const bot of lastBots) {
    const opt = document.createElement("option");
    opt.value = bot.id;
    opt.textContent = bot.name;
    sel.append(opt);
  }
  if (keep && [...sel.options].some((opt) => opt.value === keep)) sel.value = keep;
  else sel.value = lastBots[0]?.id || "";
  const member = document.getElementById("task-member");
  if (member) member.open = !sel.value;
}

function openTaskForm() {
  fillPackSelect();
  fillTaskBots();
  document.getElementById("task-title").value = "";
  document.getElementById("task-goal").value = "";
  document.getElementById("task-every").value = "0";
  document.getElementById("task-name").value = "";
  document.getElementById("task-job").value = "";
  document.getElementById("task-role").value = "";
  document.getElementById("task-voice").value = "";
  document.getElementById("task-pack").value = "";
  crew.hidden = true;
  crewEdit.hidden = true;
  document.getElementById("task-edit").hidden = false;
  setCrewPage(true);
  crewBtn.classList.add("active");
}
