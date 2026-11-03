// What every page of the site's own frame does: the theme switch, reveal on scroll, copy buttons
// and counters. The theme switch writes the docs' own setting, so the docs follow it.

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("starlight-theme", next);
  } catch {}
  window.dispatchEvent(new CustomEvent("themechange", { detail: next }));
});

// Reveal: an element with data-reveal fades in once, when it first comes on screen.
const reveal = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add("is-in");
        reveal.unobserve(e.target);
      }
    }
  },
  { rootMargin: "0px 0px -8% 0px", threshold: 0.06 },
);
for (const el of document.querySelectorAll("[data-reveal]")) reveal.observe(el);

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

// Counters: an element with data-count="30.06" counts up to it, once, when it comes on screen.
for (const el of document.querySelectorAll<HTMLElement>("[data-count]")) {
  const target = Number(el.dataset.count);
  const from = Number(el.dataset.from ?? 0);
  const decimals = (el.dataset.count?.split(".")[1] ?? "").length;
  const fmt = (v: number) =>
    v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (reduced.matches) continue;
  el.textContent = fmt(from);
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    io.disconnect();
    const t0 = performance.now();
    const duration = Number(el.dataset.duration ?? 1400);
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      el.textContent = fmt(from + (target - from) * (1 - (1 - p) ** 4));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  io.observe(el);
}
