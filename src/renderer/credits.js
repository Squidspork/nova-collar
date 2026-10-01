(() => {
  const layer = document.getElementById("credits");
  const crawl = document.getElementById("credits-crawl");
  const brand = document.getElementById("brand");
  if (!layer || !crawl) return;

  let taps = 0;
  let tapAt = 0;

  function openCredits() {
    layer.hidden = false;
    crawl.style.animation = "none";
    void crawl.offsetWidth;
    crawl.style.animation = "";
  }

  function closeCredits() {
    layer.hidden = true;
  }

  window.openCredits = openCredits;

  document.getElementById("credits-close")?.addEventListener("click", closeCredits);
  layer.addEventListener("click", (event) => {
    if (event.target === layer || event.target.classList.contains("credits-sky")) closeCredits();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || layer.hidden) return;
    event.preventDefault();
    closeCredits();
  });

  brand?.addEventListener("click", () => {
    const now = Date.now();
    taps = now - tapAt < 700 ? taps + 1 : 1;
    tapAt = now;
    if (taps >= 3) {
      taps = 0;
      openCredits();
    }
  });
})();
