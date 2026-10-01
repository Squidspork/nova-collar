const specBtn = document.getElementById("spec-btn");
const spec = document.getElementById("spec");
const doc = document.getElementById("spec-doc");
const status = document.getElementById("spec-status");
const menu = document.getElementById("spec-menu");
const ask = document.getElementById("spec-ask");
const askInput = document.getElementById("spec-ask-input");
const creature = document.getElementById("creature");

let caret = { start: 0, end: 0 };
let saveTimer = 0;
let busy = false;

function setStatus(text, bad) {
  status.textContent = text || "";
  status.dataset.bad = bad ? "1" : "";
}

function closeMenu() {
  menu.hidden = true;
  ask.hidden = true;
  askInput.value = "";
}

function closeSpec() {
  spec.hidden = true;
  creature.classList.remove("spec-open");
  specBtn.classList.remove("active");
  closeMenu();
}

function openSpec() {
  spec.hidden = false;
  creature.classList.add("spec-open");
  specBtn.classList.add("active");
  doc.focus();
}

function selection() {
  return doc.value.slice(doc.selectionStart, doc.selectionEnd);
}

function withBreak(index, text) {
  if (!text || index === 0 || doc.value[index - 1] === "\n" || text.startsWith("\n")) return text;
  return `\n${text}`;
}

function splice(start, end, text) {
  const next = doc.value.slice(0, start) + text + doc.value.slice(end);
  doc.value = next;
  const caretAt = start + text.length;
  doc.selectionStart = caretAt;
  doc.selectionEnd = caretAt;
  queueSave();
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.pup.specWrite(doc.value).catch(() => setStatus("Could not save the spec.", true));
  }, 400);
}

async function insert(mode, instruction) {
  if (busy) return;
  const start = caret.start;
  const end = caret.end;
  const selected = doc.value.slice(start, end);
  if ((mode === "from" || mode === "ref") && !selected.trim()) {
    setStatus("Highlight the text first.", true);
    return;
  }
  if (mode === "write" && !String(instruction || "").trim()) {
    setStatus("Say what should go there.", true);
    return;
  }
  busy = true;
  setStatus(mode === "complete" ? "Completing…" : "Writing…");
  closeMenu();
  try {
    const result = await window.pup.specComplete({
      mode,
      before: doc.value.slice(0, mode === "from" ? start : (mode === "ref" ? end : start)),
      after: doc.value.slice(mode === "from" ? end : (mode === "ref" ? end : end)),
      selection: selected,
      instruction: instruction || "",
    });
    if (!result?.ok) {
      setStatus(result?.error === "need-keys" ? "This window needs a model key first." : (result?.error || "That failed."), true);
      return;
    }
    if (mode === "from") splice(start, end, result.text);
    else if (mode === "ref") splice(end, end, withBreak(end, result.text));
    else if (mode === "write") splice(start, start, withBreak(start, result.text));
    else splice(start, start, result.text);
    setStatus("");
    doc.focus();
  } catch (error) {
    setStatus(error?.message || "That failed.", true);
  } finally {
    busy = false;
  }
}

specBtn.onclick = () => {
  const wasHidden = spec.hidden;
  window.hidePanels();
  if (wasHidden) openSpec();
};

document.getElementById("spec-close").onclick = () => closeSpec();

doc.addEventListener("input", queueSave);

doc.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  if (event.shiftKey) {
    event.preventDefault();
    splice(doc.selectionStart, doc.selectionEnd, "\t");
    return;
  }
  event.preventDefault();
  caret = { start: doc.selectionStart, end: doc.selectionStart };
  insert("complete");
});

doc.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  caret = { start: doc.selectionStart, end: doc.selectionEnd };
  const selected = selection().trim();
  menu.querySelector('[data-act="from"]').disabled = !selected;
  menu.querySelector('[data-act="ref"]').disabled = !selected;
  ask.hidden = true;
  menu.hidden = false;
  const pad = 8;
  const width = 240;
  const left = Math.min(event.clientX, window.innerWidth - width - pad);
  const top = Math.min(event.clientY, window.innerHeight - 160);
  menu.style.left = `${Math.max(pad, left)}px`;
  menu.style.top = `${Math.max(pad, top)}px`;
});

menu.addEventListener("click", (event) => {
  const act = event.target?.dataset?.act;
  if (!act) return;
  if (act === "write") {
    ask.hidden = false;
    askInput.focus();
    return;
  }
  insert(act);
});

ask.addEventListener("submit", (event) => {
  event.preventDefault();
  insert("write", askInput.value);
});

document.addEventListener("mousedown", (event) => {
  if (menu.hidden) return;
  if (menu.contains(event.target)) return;
  closeMenu();
});

window.pup.specRead().then((row) => {
  if (typeof row?.text === "string" && !doc.value) doc.value = row.text;
}).catch(() => {});
