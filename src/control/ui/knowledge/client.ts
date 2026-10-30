/**
 * The Knowledge page's script (goal 176), served from control (/ui/assets/knowledge.js; no inline
 * script runs under the dashboard's CSP). Without it the page still works: every folder, sort,
 * filter, chip and page is a link or a form, and a filter's popover has an Apply button. With it:
 * one dropdown filter opens at a time, a pick applies at once and its popover opens again on the
 * page that comes, Esc or a click outside closes it; a chevron opens a folder of the tree in place,
 * asking control for its folders the first time (GET /ui/kb/tree, drawn and escaped by control);
 * Folders shows the tree at phone width, and Esc hides it again; Copy copies an item's address.
 * An item opens in the preview pane in place: the script asks control for the page with the item
 * in its address, takes its pane, and puts that address in the browser's history, so Back and
 * Forward step through what was open; × and Esc close it the same way.
 */
export const KNOWLEDGE_JS = `
(() => {
  "use strict";
  const kx = document.querySelector(".kx");
  if (!kx) return;
  const AGAIN = "thermite.kx.again";
  const dds = [...kx.querySelectorAll("details.kx-dd")];
  const closeAll = (but) => dds.forEach((d) => { if (d !== but) d.open = false; });
  dds.forEach((d) => d.addEventListener("toggle", () => { if (d.open) closeAll(d); }));
  document.addEventListener("click", (ev) => {
    if (!(ev.target instanceof Element) || !ev.target.closest("details.kx-dd")) closeAll();
  });
  const foldBtn = kx.querySelector(".kx-foldbtn");
  const folders = (open) => {
    kx.dataset.folders = open ? "open" : "closed";
    if (foldBtn) foldBtn.setAttribute("aria-expanded", String(open));
  };
  // ------------------------------------------------ the preview pane
  const body = kx.querySelector(".kx-body");
  const itemOf = (href) => new URL(href, location.href).searchParams.get("item") || "";
  const mark = (href) => {
    const item = itemOf(href);
    kx.querySelectorAll("tr[data-item-href]").forEach((r) => r.classList.toggle("on", !!item && itemOf(r.dataset.itemHref) === item));
  };
  const close = (href, push) => {
    const pane = kx.querySelector("#kx-prev");
    if (pane) pane.remove();
    mark(href);
    if (push) history.pushState(null, "", href);
  };
  const preview = async (href, push) => {
    let pane = null;
    try {
      const res = await fetch(href, { credentials: "same-origin" });
      if (res.ok) pane = new DOMParser().parseFromString(await res.text(), "text/html").querySelector("#kx-prev");
    } catch {
      // Control did not answer: the address opens as a page instead, below.
    }
    if (!pane) { location.href = href; return; }
    const old = kx.querySelector("#kx-prev");
    if (old) old.replaceWith(pane); else body.append(pane);
    mark(href);
    if (push) history.pushState(null, "", href);
    pane.focus({ preventScroll: true });
  };
  window.addEventListener("popstate", () => {
    if (itemOf(location.href)) preview(location.href, false); else close(location.href, false);
  });
  const plain = (ev) => ev.button === 0 && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const open = dds.find((d) => d.open) || [...kx.querySelectorAll("details.kx-ver[open]")][0];
    const pclose = kx.querySelector("#kx-prev [data-pclose]");
    if (open) { open.open = false; open.querySelector("summary").focus(); }
    else if (kx.dataset.folders === "open") { folders(false); if (foldBtn) foldBtn.focus(); }
    else if (pclose) close(pclose.getAttribute("href"), true);
  });
  const form = kx.querySelector("form.kx-filters");
  if (form) form.addEventListener("change", (ev) => {
    const box = ev.target;
    if (!(box instanceof HTMLInputElement) || box.type !== "checkbox") return;
    try { sessionStorage.setItem(AGAIN, box.name + "=" + box.value); } catch {
      // No session storage in this browser: the page comes with its popover closed.
    }
    form.requestSubmit();
  });
  try {
    const again = sessionStorage.getItem(AGAIN) || "";
    sessionStorage.removeItem(AGAIN);
    const [name, value] = again.split("=");
    const d = name ? kx.querySelector('details.kx-dd[data-dd="' + CSS.escape(name) + '"]') : null;
    if (d) {
      d.open = true;
      const box = [...d.querySelectorAll("input[type=checkbox]")].find((i) => i.value === value);
      if (box) box.focus();
    }
  } catch {
    // No session storage in this browser: no popover opens again.
  }

  kx.addEventListener("click", async (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t) return;
    const copy = t.closest("button[data-copy]");
    if (copy && navigator.clipboard) {
      const said = copy.querySelector("span");
      navigator.clipboard.writeText(copy.dataset.copy).then(() => {
        if (!said) return;
        said.textContent = "Copied";
        setTimeout(() => (said.textContent = "Copy"), 1600);
      }, () => {
        // The browser refused the clipboard: the address stays on the page to select.
      });
      return;
    }
    if (t.closest(".kx-foldbtn")) {
      folders(kx.dataset.folders !== "open");
      return;
    }
    const shut = t.closest("a[data-pclose]");
    if (shut && plain(ev)) {
      ev.preventDefault();
      close(shut.getAttribute("href"), true);
      return;
    }
    const link = t.closest("a[data-item]");
    const row = link ? null : t.closest("tr[data-item-href]");
    if ((link || (row && !t.closest("a, button, input, select, .ii"))) && plain(ev)) {
      ev.preventDefault();
      preview(link ? link.getAttribute("href") : row.dataset.itemHref, true);
      return;
    }
    const chev = t.closest("button.kx-chev[data-tree]");
    if (!chev) return;
    const li = chev.closest("li");
    const open = chev.getAttribute("aria-expanded") !== "true";
    let ul = li.querySelector(":scope > ul");
    if (open && !ul) {
      chev.disabled = true;
      try {
        const res = await fetch("/ui/kb/tree?at=" + encodeURIComponent(chev.dataset.tree), { credentials: "same-origin" });
        if (res.ok) { li.insertAdjacentHTML("beforeend", await res.text()); ul = li.querySelector(":scope > ul"); }
      } catch {
        // Control did not answer: the folder stays closed, and its link still opens it.
      }
      chev.disabled = false;
      if (!ul) return;
    }
    if (ul) ul.hidden = !open;
    const name = li.querySelector(".nm");
    chev.setAttribute("aria-expanded", String(open));
    chev.setAttribute("aria-label", (open ? "Collapse " : "Expand ") + (name ? name.textContent : ""));
  });
})();
`;
