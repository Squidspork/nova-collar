(() => {
  const dialog = document.getElementById("approval-dialog");
  const queue = new Map();
  let current = null;
  let restoreFocus = null;
  function showNext() {
    current = queue.values().next().value || null;
    if (!current) { if (dialog.open) dialog.close(); restoreFocus?.focus?.(); return; }
    document.getElementById("approval-title").textContent = current.title;
    document.getElementById("approval-reason").textContent = current.reason;
    document.getElementById("approval-source").textContent = `${current.source} · ${current.tool}`;
    document.getElementById("approval-detail").textContent = current.detail;
    for (const button of dialog.querySelectorAll("button")) button.disabled = false;
    if (!dialog.open) { restoreFocus = document.activeElement; dialog.showModal(); }
    document.getElementById("approval-deny").focus();
  }
  async function answer(allowed) {
    if (!current) return;
    for (const button of dialog.querySelectorAll("button")) button.disabled = true;
    const id = current.id;
    try {
      await window.pup.resolveApproval(id, allowed);
      queue.delete(id);
      showNext();
    } catch {
      document.getElementById("approval-reason").textContent = "Could not send the decision. The action is still paused. Try again.";
      for (const button of dialog.querySelectorAll("button")) button.disabled = false;
    }
  }
  document.getElementById("approval-deny").onclick = () => answer(false);
  document.getElementById("approval-allow").onclick = () => answer(true);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); answer(false); });
  window.pup.on((event) => {
    if (event.type === "approval") { queue.set(event.request.id, event.request); if (!current) showNext(); }
    if (event.type === "approval-closed") { queue.delete(event.id); if (current?.id === event.id) showNext(); }
  });
  window.pup.state().then((state) => { for (const request of state.approvals || []) queue.set(request.id, request); if (!current && queue.size) showNext(); });
})();
