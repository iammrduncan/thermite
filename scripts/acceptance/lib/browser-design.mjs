// @ts-check
// The browser acceptance check's part for the design system's site (goal 243), which control
// serves at /design beside the app (scripts/acceptance/browser.mjs). It builds the site from
// packages/design-system, so a build left over from other source never passes, then:
//
// 1. opens the site with no sign-in, under a policy with no inline script or style;
// 2. opens every page of the site at 1440, 820 and 390 pixels wide, in light and in dark, and
//    checks each as the sweep checks a page: errors in its console (a style or script the policy
//    refuses is one), requests that fail, anything loaded from another site, a page wider than
//    the window, controls on top of each other, text cut off and images that don't load. It
//    keeps a screenshot of each whole page;
// 3. uses the parts as a person does: an example's code opens and is written from the design
//    system's door, and the one dialog opens within a dialog's budget and closes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchedPage } from "./browser.mjs";
import { countScreen, overBudget } from "./browser-budget.mjs";
import { fullHeight, inspect, TALLEST } from "./browser-pages.mjs";

/** Where control serves the site (src/control/api/web.ts). */
const AT = "/design";
/** The widths the site is checked at: a desktop, a tablet, a phone. */
const WIDTHS = [
  { name: "1440px", width: 1440, height: 900 },
  { name: "820px", width: 820, height: 900 },
  { name: "390px", width: 390, height: 844 },
];
const SCHEMES = /** @type {const} */ (["light", "dark"]);

/**
 * Builds the site from packages/design-system into its dist, where control serves it from; or
 * why it could not be built.
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function buildSite() {
  const dir = join("packages", "design-system");
  const vite = join("node_modules", "vite", "bin", "vite.js");
  if (!existsSync(join(dir, vite)))
    return {
      ok: false,
      why: "the design system has no packages to build with: npm run web:install links the app's",
    };
  const built = spawnSync(process.execPath, [vite, "build"], { cwd: dir, encoding: "utf8" });
  if (built.status !== 0)
    return { ok: false, why: `the build failed:\n${built.stdout}\n${built.stderr}`.slice(0, 2000) };
  return existsSync(join(dir, "dist", "index.html"))
    ? { ok: true }
    : { ok: false, why: "the build wrote no index.html" };
}

/**
 * @param {import("playwright-core").Browser} browser
 * @param {import("./browser.mjs").Stand} c
 * @param {{ out: string, check: (name: string, ok: unknown, detail?: unknown) => boolean }} o
 */
export async function designCheck(browser, c, { out, check }) {
  mkdirSync(join(out, "design"), { recursive: true });
  /** The site's pages, by their addresses, from its own sidebar. */
  /** @type {string[]} */
  let pages = [];

  // ------------------------------------------------------------------ served, and used
  {
    const tab = await watchedPage(browser, c, WIDTHS[0] ?? { width: 1440, height: 900 });
    const page = tab.page;
    const res = await page.goto(`${c.url}${AT}`);
    const policy = res?.headers()["content-security-policy"] ?? "";
    check(
      "control serves the design system's site at /design with no sign-in, under a policy that allows no inline script or style",
      res?.status() === 200 && /script-src 'self';/.test(policy) && !/unsafe-inline/.test(policy),
      { status: res?.status(), policy },
    );
    await page.waitForSelector('[data-sidebar="sidebar"] a[aria-current="page"]');
    pages = await page
      .locator('[data-sidebar="sidebar"] nav a')
      .evaluateAll((all) => all.map((a) => a.getAttribute("href") ?? ""));
    check("the site lists its pages in its sidebar", pages.length >= 10, pages);

    // An example's code opens, and is written as an app writes it.
    const buttons = pages.find((p) => p.endsWith("/buttons")) ?? "";
    await page.goto(`${c.url}${buttons}`);
    await page.waitForSelector('[data-example="buttons"]');
    await page.locator("summary", { hasText: "Its code" }).first().click();
    const code = (await page.locator("pre").first().textContent()) ?? "";
    check(
      "an example shows its code, written from the design system's door",
      /from "@ds";/.test(code) && /<Act look="main"/.test(code),
      code.slice(0, 200),
    );

    // The one dialog opens within a dialog's budget, and its first button keeps things.
    const opens = pages.find((p) => p.endsWith("/opens")) ?? "";
    await page.goto(`${c.url}${opens}`);
    await page.waitForSelector('[data-example="dialog"]');
    await page.locator('[data-example="dialog"] button').click();
    await page.waitForSelector('[role="alertdialog"]');
    await page.waitForTimeout(300);
    const first = await page.evaluate(countScreen);
    const over = first ? overBudget(first.kind, first.counts) : ["the dialog names no kind"];
    check(
      "the one dialog is within a dialog's budget, in the brand's sizes and weights of text",
      first?.kind === "dialog" && over.length === 0 && first.type.length === 0,
      { first, over },
    );
    await page.getByRole("button", { name: "Keep it running" }).click();
    await page.waitForTimeout(300);
    check(
      "the dialog's first button keeps things, and closes it",
      (await page.locator('[role="alertdialog"]').count()) === 0,
    );
    const p = tab.take();
    check(
      "the site, used: no console error and no failed request",
      p.errors.length === 0 && p.requests.length === 0 && p.outside.length === 0,
      p,
    );
    await tab.context.close();
  }

  // ------------------------------------------------------------------ every page, each look
  /** @type {{ name: string, shots: Record<string, string> }[]} */
  const rows = [];
  const row = (/** @type {string} */ name) => {
    let r = rows.find((x) => x.name === name);
    if (!r) {
      r = { name, shots: {} };
      rows.push(r);
    }
    return r;
  };
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const requests = [];
  /** @type {string[]} */
  const outside = [];
  /** @type {string[]} */
  const unopened = [];
  for (const scheme of SCHEMES)
    for (const w of WIDTHS) {
      const look = `${w.width}-${scheme}`;
      const at = `at ${w.name} in ${scheme}`;
      /** @type {{ wider: string[], overlaps: string[], clipped: string[], images: string[] }} */
      const l = { wider: [], overlaps: [], clipped: [], images: [] };
      const tab = await watchedPage(browser, c, w, { colorScheme: scheme });
      const page = tab.page;
      try {
        for (const path of pages) {
          const name = path === AT ? "foundations" : path.slice(AT.length + 1);
          const o = await tab.open(path);
          if (!("status" in o) || o.status !== 200) {
            unopened.push(`${path} ${at}: ${JSON.stringify(o)}`);
            continue;
          }
          await page.waitForSelector("[data-example]");
          await page.evaluate(() => /** @type {any} */ (globalThis).document.fonts.ready);
          await page.waitForTimeout(250);
          const height = Math.min(TALLEST, Math.max(w.height, await page.evaluate(fullHeight)));
          if (height > w.height) {
            await page.setViewportSize({ width: w.width, height });
            await page.waitForTimeout(150);
          }
          const here = await page.evaluate(inspect);
          const file = `design/${name}@${look}.jpg`;
          await page.screenshot({ path: join(out, file), type: "jpeg", quality: 75 });
          if (height > w.height) await page.setViewportSize({ width: w.width, height: w.height });
          row(name).shots[look] = file;
          if (here.wider > 1) l.wider.push(`${name}: ${here.wider}px wider than the window`);
          for (const x of here.overlaps) l.overlaps.push(`${name}: ${x}`);
          for (const x of here.clipped) l.clipped.push(`${name}: ${x}`);
          for (const x of here.images) l.images.push(`${name}: ${x}`);
        }
        // On a phone the sidebar is a menu: it opens with every page in it.
        if (w.width < 768) {
          await page.click('[data-sidebar="trigger"]');
          await page.waitForSelector('[data-mobile="true"]');
          await page.waitForTimeout(400);
          const file = `design/menu@${look}.jpg`;
          await page.screenshot({ path: join(out, file), type: "jpeg", quality: 75 });
          row("menu").shots[look] = file;
          const listed = await page.locator('[data-mobile="true"] nav a').count();
          if (listed !== pages.length)
            unopened.push(`the menu ${at} lists ${listed} pages of ${pages.length}`);
        }
      } catch (err) {
        unopened.push(`${at}: ${String(err).split("\n")[0]}`);
      }
      const p = tab.take();
      for (const e of p.errors) errors.push(`${at}, ${e}`);
      for (const e of p.requests) requests.push(`${at}, ${e}`);
      for (const e of p.outside) outside.push(`${at}, ${e}`);
      check(`the site ${at}: no page is wider than the window`, l.wider.length === 0, l.wider);
      check(
        `the site ${at}: no controls lie on top of each other`,
        l.overlaps.length === 0,
        l.overlaps,
      );
      check(`the site ${at}: no text is cut off`, l.clipped.length === 0, l.clipped);
      check(`the site ${at}: every image loads`, l.images.length === 0, l.images);
      await tab.context.close();
    }
  check(
    "every page of the site opens, at each width and in each look",
    unopened.length === 0,
    unopened,
  );
  check(
    "no page of the site has a console error, an uncaught exception or a refused style",
    errors.length === 0,
    errors,
  );
  check("no request a page of the site makes fails", requests.length === 0, requests);
  check("no page of the site loads anything from another site", outside.length === 0, outside);

  const looks = SCHEMES.flatMap((s) => WIDTHS.map((w) => `${w.width}-${s}`));
  const cell = (/** @type {string | undefined} */ f) =>
    f ? `<a href="${f}"><img src="${f}" loading="lazy"></a>` : "";
  writeFileSync(
    join(out, "design.html"),
    `<!doctype html><meta charset="utf-8"><title>The design system's site, every page</title>
<style>body{font:14px system-ui;margin:20px}table{border-collapse:collapse}td,th{border-top:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}img{width:300px;border:1px solid #ccc}</style>
<h1>Every page of the design system's site at /design</h1><p>${rows.length} pages; each at ${WIDTHS.map((w) => w.name).join(", ")}, in light and in dark. Each screenshot is the whole page. Findings: report.json.</p>
<table><tr><th>Page</th>${looks.map((x) => `<th>${x}</th>`).join("")}</tr>
${rows.map((r) => `<tr><td>${r.name}</td>${looks.map((x) => `<td>${cell(r.shots[x])}</td>`).join("")}</tr>`).join("\n")}
</table>`,
  );
}
