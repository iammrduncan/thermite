// What every page of the site's own frame does: the theme switch and the copy buttons. The theme
// switch writes the docs' own setting, so the docs follow it.

document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("starlight-theme", next);
  } catch {}
  window.dispatchEvent(new CustomEvent("themechange", { detail: next }));
});

// Copy: a button with data-copy copies that text, and says so for a moment.
for (const btn of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  const label = btn.querySelector("[data-label]");
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy ?? "");
    } catch {
      return;
    }
    btn.setAttribute("data-done", "");
    if (label) label.textContent = "Copied";
    window.setTimeout(() => {
      btn.removeAttribute("data-done");
      if (label) label.textContent = "Copy";
    }, 1600);
  });
}
