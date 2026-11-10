// @ts-check
// The browser acceptance check's sweep (scripts/acceptance/browser.mjs): every kind of page the
// dashboard links to, at each width, checked for errors and for layout, with a screenshot of each.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { signedInPage } from "./browser.mjs";

/** Links the sweep does not follow: signing out, files to download, and what pages fetch. */
const SKIP =
  /^\/ui\/(logout|login)\b|^\/ui\/assets\/|\/stream$|\.(patch|diff|zip|tar\.gz|tgz|json|jsonl|ndjson|md|txt|csv|log|pdf|png|jpe?g|svg)$/;
/** Pages of one kind the sweep opens: enough to see each kind of page with different data. */
const PER_KIND = 4;
/** Route parts that pick a kind of page, not a thing: a run's tab, an area of Settings. */
const KINDS = new Set(["tab", "area"]);
/** The tallest a page is drawn, to see all of it: the dashboard scrolls inside its content. */
export const TALLEST = 12_000;

/**
 * The route a path is a page of (raw, as the router has it) and its kind: the route with its kind
 * parts filled in, so that each run tab is a kind of its own. A path no route matches is its own.
 * @param {string[]} routes
 */
function routeOf(routes) {
  const compiled = routes.map((r) => {
    const re = r
      .split("/")
      .map((s) => {
        if (s === "*") return ".*";
        const m = /^:(\w+)(?:\{(.+)\})?$/.exec(s);
        if (!m) return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        return `(${m[2] ?? "[^/]+"})`;
      })
      .join("/");
    return {
      r,
      re: new RegExp(`^${re}$`),
      literal: r.split("/").filter((s) => s && !s.startsWith(":") && s !== "*").length,
    };
  });
  return (/** @type {string} */ path) => {
    /** @type {{ c: (typeof compiled)[number], m: RegExpExecArray } | undefined} */
    let best;
    for (const c of compiled) {
      const m = c.re.exec(path);
      if (m && (!best || c.literal > best.c.literal)) best = { c, m };
    }
    if (!best) return { raw: path, kind: path };
    const { c, m } = best;
    let i = 0;
    const kind = c.r.replace(/:(\w+)(\{[^}]+\})?/g, (_, /** @type {string} */ name) => {
      const v = m[++i] ?? "";
      return KINDS.has(name) ? v : `:${name}`;
    });
    return { raw: c.r, kind };
  };
}

/**
 * What a page shows wrong at the width it is drawn at. Runs in the page, so it reaches the browser
 * through globalThis. A control counts as shown when the browser draws it (checkVisibility) and no
 * box between it and its scroll area clips it away (a closed section that hides its content).
 * @returns {{ wider: number, overlaps: string[], clipped: string[], images: string[], links: string[] }}
 */
export function inspect() {
  const g = /** @type {any} */ (globalThis);
  const doc = g.document;
  const style = (/** @type {any} */ el) => g.getComputedStyle(el);
  const name = (/** @type {any} */ el) => {
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`
        : "";
    const words = String(
      el.textContent || el.getAttribute("aria-label") || el.getAttribute("name") || "",
    )
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 40);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}${words ? ` "${words}"` : ""}`;
  };
  /** The part of el's box that can be seen: clipped by each box that hides overflow, up to its scroll area. */
  const seen = (/** @type {any} */ el) => {
    const r = el.getBoundingClientRect();
    let [left, top, right, bottom] = [r.left, r.top, r.right, r.bottom];
    for (let e = el.parentElement; e && e !== doc.documentElement; e = e.parentElement) {
      const s = style(e);
      if (/(auto|scroll)/.test(s.overflowX + s.overflowY)) break;
      if (/(hidden|clip)/.test(s.overflowX + s.overflowY)) {
        const b = e.getBoundingClientRect();
        [left, top, right, bottom] = [
          Math.max(left, b.left),
          Math.max(top, b.top),
          Math.min(right, b.right),
          Math.min(bottom, b.bottom),
        ];
      }
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const shown = (/** @type {any} */ el) => {
    // The browser's own answer first: not in a closed details, a hidden or see-through box, or
    // content it skips drawing. A closed menu's pop-up keeps a size, so size alone is not enough.
    if (
      !el.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
      })
    )
      return false;
    const v = seen(el);
    return v.width >= 1 && v.height >= 1;
  };
  /** Inside something fixed or sticky (a sidebar, a status bar): drawn over the page by design. */
  const pinned = (/** @type {any} */ el) => {
    for (let e = el; e && e !== doc.body; e = e.parentElement) {
      const p = style(e).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };
  const wider =
    Math.max(doc.documentElement.scrollWidth, doc.body.scrollWidth) - Number(g.innerWidth);

  /** @type {any[]} */
  const all = [
    ...doc.querySelectorAll(
      'button, input:not([type="hidden"]), select, textarea, [role="button"]',
    ),
  ];
  const controls = all
    .filter((el) => shown(el) && !pinned(el))
    .map((el) => ({ el, box: seen(el) }));
  /** @type {string[]} */
  const overlaps = [];
  controls.forEach((a, i) => {
    for (const b of controls.slice(i + 1)) {
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (x > 2 && y > 2) overlaps.push(`${name(a.el)} over ${name(b.el)}`);
    }
  });

  // Text cut off: an element whose own text is wider than its box, hidden, with no ellipsis.
  /** @type {string[]} */
  const clipped = [];
  for (const el of doc.body.querySelectorAll("*")) {
    if (
      ![...el.childNodes].some(
        (/** @type {any} */ n) => n.nodeType === 3 && /\S/.test(n.textContent ?? ""),
      )
    )
      continue;
    // A box one pixel wide holds words for screen readers alone: nobody sees them cut.
    if (el.scrollWidth <= el.clientWidth + 1 || el.clientWidth <= 1 || !shown(el)) continue;
    const s = style(el);
    if ((s.overflowX === "hidden" || s.overflowX === "clip") && s.textOverflow !== "ellipsis")
      clipped.push(name(el));
  }

  /** @type {string[]} */
  const images = [...doc.images]
    .filter((img) => img.complete && img.naturalWidth === 0 && shown(img))
    .map((img) => img.src);
  // Links to follow: control's own, apart from files to download.
  /** @type {string[]} */
  const links = [...doc.querySelectorAll("a[href]:not([download])")]
    .map((a) => String(a.href))
    .filter((h) => h.startsWith(g.location.origin));
  return { wider, overlaps: overlaps.slice(0, 10), clipped: clipped.slice(0, 10), images, links };
}

/** The height that shows all of a page: its own, or its tallest scroll area's content. Runs in the page. */
export function fullHeight() {
  const g = /** @type {any} */ (globalThis);
  let h = Number(g.document.documentElement.scrollHeight);
  for (const el of g.document.querySelectorAll("*")) {
    const s = g.getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight) {
      const r = el.getBoundingClientRect();
      h = Math.max(h, r.top + el.scrollHeight + (g.innerHeight - r.bottom));
    }
  }
  return Math.ceil(h);
}

/**
 * Opens every kind of page the dashboard links to, at each width, and checks each one; writes the
 * screenshots and index.html to `out`.
 * @param {import("playwright-core").Browser} browser
 * @param {import("./browser.mjs").Stand} c
 * @param {{ widths: import("./browser.mjs").Width[], out: string, maxPages: number, minPages: number, check: (name: string, ok: unknown, detail?: unknown) => boolean }} o
 */
export async function pageSweep(browser, c, { widths, out, maxPages, minPages, check }) {
  const at = await Promise.all(
    widths.map(async (w) => ({
      w,
      tab: await signedInPage(browser, c, w),
      /** @type {{ wider: string[], overlaps: string[], clipped: string[], images: string[] }} */
      layout: { wider: [], overlaps: [], clipped: [], images: [] },
    })),
  );
  const route = routeOf(c.pages);
  /** @type {Map<string, string>} the page, and the page that first linked to it */
  const queue = new Map([["/ui", "(start)"]]);
  const opened = new Set();
  /** @type {Map<string, number>} pages taken of each kind */
  const taken = new Map();
  /** @type {{ answers: string[], errors: string[], requests: string[], outside: string[] }} */
  const found = { answers: [], errors: [], requests: [], outside: [] };
  /** @type {{ path: string, kind: string, shots: Record<string, string> }[]} */
  const pages = [];
  /** Kinds of page opened, and the routes they are pages of. */
  const kinds = new Set();
  const raws = new Set();

  for (const [path, from] of queue) {
    if (pages.length >= maxPages) break;
    queue.delete(path);
    opened.add(path);
    const { raw, kind } = route(path.split("?")[0] ?? path);
    kinds.add(kind);
    raws.add(raw);
    const slug =
      path
        .replace(/^\/ui\/?/, "")
        .replace(/[^A-Za-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 120) || "overview";
    /** @type {Record<string, string>} */
    const shots = {};
    for (const [index, { w, tab, layout: l }] of at.entries()) {
      const o = await tab.open(path);
      // A link that leaves control (a redirect to a sign-in elsewhere) is noted, not followed.
      if ("away" in o) {
        found.outside.push(`${path}: leads to ${o.away}`);
        break;
      }
      if ("error" in o) {
        found.answers.push(`${path} (linked from ${from}): ${o.error}`);
        break;
      }
      if (o.status >= 400) {
        found.answers.push(`${path} answers ${o.status} (linked from ${from})`);
        break;
      }
      const page = tab.page;
      // Let the page's scripts draw it, and its first poll answer. Then draw all of it at once.
      await page.waitForTimeout(500);
      const height = Math.min(TALLEST, Math.max(w.height, await page.evaluate(fullHeight)));
      if (height > w.height) {
        await page.setViewportSize({ width: w.width, height });
        await page.waitForTimeout(150);
      }
      const here = await page.evaluate(inspect);
      const file = `pages/${slug}@${w.width}.jpg`;
      await page.screenshot({ path: join(out, file), type: "jpeg", quality: 70 });
      if (height > w.height) await page.setViewportSize({ width: w.width, height: w.height });
      shots[w.name] = file;
      if (here.wider > 1) l.wider.push(`${path}: ${here.wider}px wider than the window`);
      for (const x of here.overlaps) l.overlaps.push(`${path}: ${x}`);
      for (const x of here.clipped) l.clipped.push(`${path}: ${x}`);
      for (const x of here.images) l.images.push(`${path}: ${x}`);
      if (index > 0) continue;
      for (const href of here.links) {
        const u = new URL(href);
        if (!u.pathname.startsWith("/ui") || SKIP.test(u.pathname)) continue;
        const key = u.pathname + u.search;
        if (opened.has(key) || queue.has(key)) continue;
        // A page opened with a query (a form for a new thing, a filter) is a kind of its own.
        const names = [...new Set(u.searchParams.keys())].sort().join("&");
        const k = route(u.pathname).kind + (names ? `?${names}` : "");
        const n = taken.get(k) ?? 0;
        if (n >= PER_KIND) continue;
        taken.set(k, n + 1);
        queue.set(key, path);
      }
    }
    pages.push({ path, kind, shots });
  }
  for (const [index, { w, tab }] of at.entries()) {
    const p = tab.take();
    for (const e of p.errors) found.errors.push(`at ${w.width}px, ${e}`);
    for (const e of p.requests) found.requests.push(`at ${w.width}px, ${e}`);
    if (index === 0) found.outside.push(...p.outside);
  }
  // Leaving control by a link (signing in with ChatGPT, an MCP server's sign-in) is expected;
  // a page that loads something from another site is not.
  const loads = found.outside.filter((x) => / loads /.test(x));
  const leaves = [...new Set(found.outside.filter((x) => / leads to /.test(x)))];

  check(
    `the sweep reached at least ${minPages} pages`,
    pages.length >= minPages,
    `${pages.length} pages of ${kinds.size} kinds${queue.size ? `, ${queue.size} more not opened (--max-pages ${maxPages})` : ""}`,
  );
  check("every page linked from the dashboard answers", found.answers.length === 0, found.answers);
  check(
    "no page has a console error or an uncaught exception",
    found.errors.length === 0,
    found.errors,
  );
  check("no request a page makes fails", found.requests.length === 0, found.requests);
  check("no page loads anything from another site", loads.length === 0, loads);
  for (const { w, layout: l } of at) {
    check(`at ${w.name}, no page is wider than the window`, l.wider.length === 0, l.wider);
    check(
      `at ${w.name}, no controls lie on top of each other`,
      l.overlaps.length === 0,
      l.overlaps,
    );
    check(`at ${w.name}, no text is cut off`, l.clipped.length === 0, l.clipped);
    check(`at ${w.name}, every image loads`, l.images.length === 0, l.images);
  }
  for (const { tab } of at) await tab.context.close();
  // What the sweep did not open: routes no link led to with the demo's data.
  const notReached = c.pages.filter((p) => !raws.has(p) && !SKIP.test(p));
  if (leaves.length) console.log(`Links that leave control (not followed): ${leaves.join("; ")}`);
  if (notReached.length) console.log(`Routes the sweep did not reach: ${notReached.join(", ")}`);

  const cell = (/** @type {string | undefined} */ f) =>
    f ? `<a href="${f}"><img src="${f}" loading="lazy"></a>` : "";
  const html = (/** @type {string} */ s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  writeFileSync(
    join(out, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Thermite dashboard, every kind of page</title>
<style>body{font:14px system-ui;margin:20px}table{border-collapse:collapse}td,th{border-top:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}img{width:420px;border:1px solid #ccc}code{font-size:13px}</style>
<h1>Every kind of page the sweep opened</h1><p>${pages.length} pages of ${kinds.size} kinds; widths ${widths.map((w) => w.name).join(", ")}. Each screenshot is the whole page. Findings: report.json.</p>
<table><tr><th>Page</th>${widths.map((w) => `<th>${w.name}</th>`).join("")}</tr>
${pages.map((p) => `<tr><td><code>${html(p.path)}</code><br><small>${html(p.kind)}</small></td>${widths.map((w) => `<td>${cell(p.shots[w.name])}</td>`).join("")}</tr>`).join("\n")}
</table>`,
  );
}
