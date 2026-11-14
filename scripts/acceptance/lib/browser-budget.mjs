// @ts-check
// The budget of a screen's first view (goal 243): how much a screen may show as it loads, with
// nothing opened, by its kind. The browser check counts each screen of the app against the budget
// of the kind it names (`data-screen="<kind>"` on its body), so a screen that is too heavy fails
// (docs/_site/src/content/docs/project/contributing.md, "A screen's budget").
//
// The frame is not counted: the navigation, a screen's top bar and a run's top are outside the
// body that names the kind. The same count says where a screen's text is off the brand's type:
// four sizes (22, 16, 14 and 12 pixels) and two weights (400 and 600).

/**
 * @typedef {{ height: number, words: number, blocks: number, tables: number, controls: number, buttons: number, links: number }} Counts
 */

/**
 * The most each kind of screen may show: its height in pixels at a desk's width, its words, its
 * blocks (sections with a title), its tables, its form controls, its buttons and its links.
 * @type {Record<string, Counts>}
 */
export const BUDGETS = {
  home: { height: 900, words: 250, blocks: 3, tables: 1, controls: 1, buttons: 3, links: 15 },
  list: { height: 900, words: 250, blocks: 1, tables: 1, controls: 3, buttons: 2, links: 12 },
  detail: { height: 1300, words: 400, blocks: 5, tables: 1, controls: 1, buttons: 4, links: 20 },
  form: { height: 900, words: 200, blocks: 2, tables: 0, controls: 7, buttons: 3, links: 3 },
  dialog: { height: 400, words: 60, blocks: 1, tables: 0, controls: 2, buttons: 2, links: 1 },
  explore: { height: 1600, words: 560, blocks: 2, tables: 1, controls: 6, buttons: 2, links: 90 },
  tool: { height: 1200, words: 450, blocks: 4, tables: 1, controls: 4, buttons: 4, links: 60 },
};

/** What each count is called in a finding. */
const NAMES = /** @type {const} */ ({
  height: "pixels high",
  words: "words",
  blocks: "blocks",
  tables: "tables",
  controls: "form controls",
  buttons: "buttons",
  links: "links",
});

/**
 * Counts the open screen's first view. Runs in the page, so it uses nothing from this file.
 * Null when the screen names no kind.
 * @returns {{ kind: string, type: string[], counts: Counts } | null}
 */
export function countScreen() {
  const g = /** @type {any} */ (globalThis);
  // An open dialog is the first view while it is open: it names its own kind.
  const all = Array.from(g.document.querySelectorAll("[data-screen]"));
  const body =
    all.find((/** @type {any} */ el) => el.closest('[role="dialog"], [role="alertdialog"]')) ??
    all[0];
  if (!body) return null;
  const shown = (/** @type {any} */ el) =>
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
    el.getBoundingClientRect().width >= 1;
  const count = (/** @type {string} */ selector) =>
    Array.from(body.querySelectorAll(selector)).filter(shown).length;
  // The words a person sees, not hidden ones.
  // biome-ignore lint/performance/useDomNodeTextContent: innerText leaves out what is not drawn
  const words = String(body.innerText ?? "")
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const controls =
    'input:not([type="hidden"]), select, textarea, [role="combobox"], [role="switch"], [role="checkbox"], [role="radio"], [role="slider"]';
  // The brand's type: four sizes and two weights. Text in a picture is drawn to the picture's scale.
  /** @type {Set<string>} */
  const off = new Set();
  for (const el of body.querySelectorAll("*")) {
    if (!shown(el) || el.closest("svg")) continue;
    const own = Array.from(el.childNodes).some(
      (/** @type {any} */ n) => n.nodeType === 3 && n.textContent.trim(),
    );
    if (!own && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
    const style = g.getComputedStyle(el);
    const size = Math.round(Number.parseFloat(style.fontSize));
    if (![22, 16, 14, 12].includes(size)) off.add(`${size} px text`);
    if (!["400", "600"].includes(style.fontWeight)) off.add(`weight ${style.fontWeight}`);
  }
  return {
    kind: String(body.getAttribute("data-screen")),
    type: Array.from(off),
    counts: {
      height: Math.round(body.scrollHeight),
      words,
      blocks: count("section[aria-label]"),
      tables: count("table"),
      controls: count(controls),
      buttons: count(
        'button:not([role="combobox"]):not([role="switch"]):not([role="checkbox"]):not([role="radio"]), [role="button"], a[data-slot="button"]',
      ),
      links: count('a[href]:not([data-slot="button"]):not([role="button"])'),
    },
  };
}

/**
 * Where a screen is over its kind's budget, in words; none when it is within it.
 * @param {string} kind
 * @param {Counts} counts
 * @param {{ height?: boolean }} [o] `height: false` leaves the height out: it is held at a desk's
 *   width only, since a narrow window makes every screen taller.
 * @returns {string[]}
 */
export function overBudget(kind, counts, o = {}) {
  const budget = BUDGETS[kind];
  if (!budget) return [`"${kind}" is no kind of screen: one of ${Object.keys(BUDGETS).join(", ")}`];
  /** @type {string[]} */
  const over = [];
  for (const key of /** @type {(keyof Counts)[]} */ (Object.keys(NAMES))) {
    if (key === "height" && o.height === false) continue;
    if (counts[key] > budget[key])
      over.push(`${counts[key]} ${NAMES[key]}, and a ${kind} screen may have ${budget[key]}`);
  }
  return over;
}

/**
 * A made-up screen that is over a form's budget, for the check to prove it would fail one: more
 * words and more fields than a form may have.
 */
export const OVER_BUDGET_PAGE = `<!doctype html><meta charset="utf-8"><main data-screen="form">
<section aria-label="One">${"<p>word word word word word word word word word word</p>".repeat(25)}</section>
${'<input type="text">'.repeat(9)}
</main>`;
