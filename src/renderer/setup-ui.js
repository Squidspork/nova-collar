(() => {
  const root = document.getElementById("setup");
  const kicker = document.getElementById("setup-kicker");
  const title = document.getElementById("setup-title");
  const body = document.getElementById("setup-body");
  const list = document.getElementById("setup-list");
  const log = document.getElementById("setup-log");
  const acts = document.getElementById("setup-acts");
  if (!root) return;

  let report = null;

  function button(label, fn, primary) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = primary ? "go" : "";
    btn.textContent = label;
    btn.onclick = fn;
    return btn;
  }

  function show(step) {
    root.hidden = false;
    root.dataset.step = step;
    log.hidden = step !== "install";
  }

  function hello() {
    show("hello");
    kicker.textContent = "setup";
    title.textContent = "Set up the install";
    body.textContent = "This looks at the computer Nova Collar is installed on. It can use a model server already there, or download Ollama and a model that fits that computer. Nothing is installed until you say so.";
    list.replaceChildren();
    acts.replaceChildren(button("Scan this install", scan, true), button("Skip", skip));
  }

  async function scan() {
    show("scan");
    kicker.textContent = "scanning";
    title.textContent = "Looking for a local model";
    body.textContent = "Checking the computer running Nova Collar for Ollama, LM Studio, and other model servers. No other machine is scanned.";
    list.replaceChildren();
    acts.replaceChildren();
    root.classList.add("busy");
    try {
      report = await window.pup.setupScan();
    } finally {
      root.classList.remove("busy");
    }
    found();
  }

  function found() {
    show("found");
    const mem = report?.memory || {};
    kicker.textContent = "memory";
    title.textContent = `${mem.totalGb || "?"} GB on the install`;
    const lines = [
      `${mem.freeGb || "?"} GB is free on the computer running Nova Collar. The window itself is about ${mem.appGb} GB.`,
      `Laya, the decision check, is optional: about ${mem.layaDiskGb} GB on disk and about ${mem.layaRamGb} GB while it is loaded. The window still answers without it.`,
    ];
    if (mem.model) {
      lines.push(`${mem.model.name} fits this install: about ${mem.model.diskGb} GB on disk and about ${mem.model.runGb} GB while answering.`);
    } else {
      lines.push("This install has under 8 GB of memory, so a local model will not fit. Use a chat endpoint instead.");
    }
    body.textContent = lines.join(" ");
    list.replaceChildren();
    for (const hit of report?.found || []) {
      const model = hit.models?.[0] || "";
      const row = document.createElement("button");
      row.type = "button";
      row.className = "chat-item";
      row.textContent = model ? `${hit.name} · ${model}` : hit.name;
      row.onclick = () => useHit(hit, model);
      list.append(row);
    }
    acts.replaceChildren();
    if (mem.model) acts.append(button(`Download ${mem.model.name}`, install, true));
    acts.append(button("Skip", skip));
  }

  async function install() {
    show("install");
    kicker.textContent = "download";
    title.textContent = "Setting up Ollama";
    body.textContent = "Ollama is installed on the computer running Nova Collar and listens on 127.0.0.1 only. The download can take a while.";
    log.textContent = "";
    acts.replaceChildren();
    root.classList.add("busy");
    let result;
    try {
      result = await window.pup.setupInstall();
    } finally {
      root.classList.remove("busy");
    }
    if (!result?.ok) {
      body.textContent = result?.error || "The install stopped.";
      acts.replaceChildren(button("Back", found), button("Skip", skip));
      return;
    }
    close(result.state, `Local model ${result.model} is ready.`);
  }

  async function useHit(hit, model) {
    const result = await window.pup.setupUse({ url: hit.url, model });
    if (!result?.ok) {
      body.textContent = result?.error || "Could not save that server.";
      return;
    }
    close(result.state, `${hit.name} is the local model.`);
  }

  async function skip() {
    const result = await window.pup.setupSkip();
    close(result?.state, "");
  }

  function close(state, note) {
    root.hidden = true;
    root.classList.remove("busy");
    if (note) window.noteSetup?.(note);
    window.afterSetup?.(state);
  }

  window.pup.on((event) => {
    if (event.type !== "setup-log") return;
    log.hidden = false;
    log.textContent += `${event.line}\n`;
    log.scrollTop = log.scrollHeight;
  });

  window.openSetup = hello;
})();
