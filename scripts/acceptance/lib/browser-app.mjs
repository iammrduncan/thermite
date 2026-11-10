// @ts-check
// The browser acceptance check's part for the dashboard's app (goal 243), which control serves at
// /next (scripts/acceptance/browser.mjs). It builds the app from web/, so a build left over from
// other source never passes, then:
//
// 1. signs in on the app's own page as a person does: a wrong token is refused in words, the
//    owner's token opens Home, and the same session opens the pages at /ui;
// 2. makes a change on control from outside the browser and waits for the open screen to show it,
//    with no reload;
// 3. opens every screen at 1440, 820 and 390 pixels wide, in light and in dark, in both variants
//    of the navigation, and checks each as the sweep checks a page: errors in its console (a
//    style or script the page's Content Security Policy refuses is one), requests that fail,
//    anything loaded from another site, a screen wider than the window, controls on top of each
//    other, text cut off and images that don't load. It keeps a screenshot of each whole screen;
// 4. signs out, and control must then refuse the session.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watchedPage } from "./browser.mjs";
import { fullHeight, inspect, TALLEST } from "./browser-pages.mjs";

/** The widths the app is checked at: a desktop, a tablet, a phone. */
const WIDTHS = [
  { name: "1440px", width: 1440, height: 900 },
  { name: "820px", width: 820, height: 900 },
  { name: "390px", width: 390, height: 844 },
];
const SCHEMES = /** @type {const} */ (["light", "dark"]);
/** The folder the check makes on control, to see the open screen take a change. */
const FOLDER = "Browser check";

/** How many times the page was loaded: one, while nothing reloads it. Runs in the page. */
const navigations = () =>
  /** @type {any} */ (globalThis).performance.getEntriesByType("navigation").length;

/**
 * Builds the app from web/ into web/dist, where control serves it from. The sizes of its script
 * and its styles, in bytes; or why it could not be built.
 * @returns {{ ok: true, script: number, styles: number } | { ok: false, why: string }}
 */
export function buildApp() {
  const vite = join("node_modules", "vite", "bin", "vite.js");
  if (!existsSync(join("web", vite)))
    return { ok: false, why: "the app's packages are not installed: npm run web:install" };
  const built = spawnSync(process.execPath, [vite, "build"], { cwd: "web", encoding: "utf8" });
  if (built.status !== 0)
    return { ok: false, why: `the build failed:\n${built.stdout}\n${built.stderr}`.slice(0, 2000) };
  /** @type {Record<string, number>} */
  const sizes = { ".js": 0, ".css": 0 };
  const assets = join("web", "dist", "assets");
  for (const line of built.stdout.split("\n")) {
    const name = /dist\/assets\/(\S+\.(?:js|css))\b/.exec(line)?.[1];
    if (!name) continue;
    const kind = name.endsWith(".js") ? ".js" : ".css";
    sizes[kind] = (sizes[kind] ?? 0) + statSync(join(assets, name)).size;
  }
  return { ok: true, script: sizes[".js"] ?? 0, styles: sizes[".css"] ?? 0 };
}

/**
 * @param {import("playwright-core").Browser} browser
 * @param {import("./browser.mjs").Stand} c
 * @param {{ out: string, check: (name: string, ok: unknown, detail?: unknown) => boolean }} o
 */
export async function appCheck(browser, c, { out, check }) {
  mkdirSync(join(out, "app"), { recursive: true });
  /** A change made on control from outside the browser, with the owner's token. */
  const change = async (/** @type {string} */ path, /** @type {unknown} */ body) => {
    const res = await fetch(`${c.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  };
  /** Signs in on the app's page. */
  const signIn = async (/** @type {import("playwright-core").Page} */ page) => {
    await page.goto(`${c.url}/next`);
    await page.fill('input[type="password"]', c.token);
    await page.press('input[type="password"]', "Enter");
    await page.waitForSelector('section[aria-label="What happened"]');
  };
  /** @type {{ name: string, path: string, ready: string }[]} */
  let screens = [];

  // ------------------------------------------------------------------ sign-in and a live change
  {
    const tab = await watchedPage(browser, c, WIDTHS[0] ?? { width: 1440, height: 900 });
    const page = tab.page;
    const res = await page.goto(`${c.url}/next`);
    const policy = res?.headers()["content-security-policy"] ?? "";
    check(
      "control serves the app at /next, with a policy that allows no inline script or style",
      res?.status() === 200 && /script-src 'self';/.test(policy) && !/unsafe-inline/.test(policy),
      { status: res?.status(), policy },
    );
    await page.waitForSelector('input[type="password"]');
    check(
      "signed out, the app shows its sign-in page and nothing else",
      (await page.locator("a[href]").count()) === 0,
    );
    await page.fill('input[type="password"]', "not-the-token");
    await page.press('input[type="password"]', "Enter");
    const refused = await page.locator('[role="alert"]').first().textContent();
    check(
      "a wrong token is refused in words",
      /not the owner's token/.test(refused ?? ""),
      refused,
    );
    // The refusal is a 403, which the browser also writes to its console: expected here.
    const wrong = tab.take();
    check(
      "the refusal is the only thing that failed on the sign-in page",
      wrong.requests.length === 1 && wrong.errors.every((e) => /403/.test(e)),
      wrong,
    );
    await signIn(page);
    const home =
      /** @type {{ needs: unknown[], nav: { campaigns: { name: string, mode: string | null, run: string | null }[] } }} */ (
        await page.evaluate(async () => (await fetch("/v1/home")).json())
      );
    const needs = await page.locator('section[aria-label="Needs you"] li').count();
    check(
      "the owner's token opens Home, with what control says needs the owner",
      home.needs.length > 0 && needs === home.needs.length,
      { control: home.needs.length, shown: needs },
    );
    const old = await page.goto(`${c.url}/ui`);
    check(
      "the app's session opens the pages at /ui",
      old?.status() === 200 && new URL(page.url()).pathname === "/ui",
      page.url(),
    );

    // One run of each mode the demo has, by the navigation's own campaigns.
    const campaigns = home.nav.campaigns;
    screens = [{ name: "home", path: "/next", ready: 'section[aria-label="What happened"]' }];
    for (const mode of ["hill_climb", "goal", "research"]) {
      const k = campaigns.find((x) => x.mode === mode && x.run);
      if (k)
        screens.push({
          name: `run-${mode.replace("_", "-")}`,
          path: `/next/campaigns/${encodeURIComponent(k.name)}/runs/${encodeURIComponent(k.run ?? "")}`,
          ready: 'section[aria-label="Now"]',
        });
    }
    check("the demo has a run of each mode to open", screens.length === 4, screens.length);
    screens.push(
      { name: "settings", path: "/next/settings", ready: 'nav[aria-label="Settings"]' },
      {
        name: "settings-about",
        path: "/next/settings/about",
        ready: 'section[aria-label="This browser"]',
      },
      { name: "not-found", path: "/next/nowhere", ready: "h1" },
    );

    // A change made elsewhere shows on the open screen, with no reload.
    await page.goto(`${c.url}/next`);
    await page.waitForSelector('section[aria-label="What happened"]');
    const loads = await page.evaluate(navigations);
    const moved = campaigns[0]?.name ?? "";
    const made = [
      await change("/v1/campaign-folders", { name: FOLDER }),
      await change(`/v1/campaigns/${encodeURIComponent(moved)}/folder`, { folder: FOLDER }),
    ];
    const shown = await page
      .waitForFunction(
        // biome-ignore lint/performance/useDomNodeTextContent: the words a person sees, not hidden ones
        (name) => /** @type {any} */ (globalThis).document.body.innerText.includes(name),
        FOLDER,
        { timeout: 15_000 },
      )
      .then(
        () => true,
        () => false,
      );
    check(
      "a change made on control shows on the open screen, with no reload",
      shown && loads === (await page.evaluate(navigations)),
      { made },
    );
    const p = tab.take();
    check(
      "sign-in and the live change: no console error and no failed request",
      p.errors.length === 0 && p.requests.length === 0 && p.outside.length === 0,
      p,
    );

    // Signing out ends the session on control, for /ui and /v1 too.
    await page.goto(`${c.url}/next/settings/about`);
    await page.click('section[aria-label="This browser"] button');
    await page.waitForSelector('input[type="password"]');
    const after = await page.evaluate(async () => (await fetch("/v1/home")).status);
    check("Sign out ends the session: control then refuses it", after === 401, after);
    await tab.context.close();
  }

  // ------------------------------------------------------------------ every screen, each look
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
      /** Draws the whole screen at once, checks it and keeps its screenshot. */
      const keep = async (/** @type {string} */ name) => {
        await page.evaluate(() => /** @type {any} */ (globalThis).document.fonts.ready);
        await page.waitForTimeout(250);
        const height = Math.min(TALLEST, Math.max(w.height, await page.evaluate(fullHeight)));
        if (height > w.height) {
          await page.setViewportSize({ width: w.width, height });
          await page.waitForTimeout(150);
        }
        const here = await page.evaluate(inspect);
        const file = `app/${name}@${look}.jpg`;
        await page.screenshot({ path: join(out, file), type: "jpeg", quality: 75 });
        if (height > w.height) await page.setViewportSize({ width: w.width, height: w.height });
        row(name).shots[look] = file;
        if (here.wider > 1) l.wider.push(`${name}: ${here.wider}px wider than the window`);
        for (const x of here.overlaps) l.overlaps.push(`${name}: ${x}`);
        for (const x of here.clipped) l.clipped.push(`${name}: ${x}`);
        for (const x of here.images) l.images.push(`${name}: ${x}`);
      };
      /**
       * The navigation's places, by the names a person or a screen reader gets. On a phone the
       * navigation is a sheet: it is opened, kept as a screenshot and closed again.
       */
      const places = async (/** @type {string} */ name) => {
        const phone = w.width < 768;
        if (phone) {
          await page.click('[data-sidebar="trigger"]');
          await page.waitForSelector('[data-mobile="true"]');
          await page.waitForTimeout(400);
          const file = `app/${name}@${look}.jpg`;
          await page.screenshot({ path: join(out, file), type: "jpeg", quality: 75 });
          row(name).shots[look] = file;
        }
        const names = await page
          .locator('[data-sidebar="sidebar"] a')
          .evaluateAll((all) =>
            all.map((a) => (a.getAttribute("aria-label") ?? a.textContent ?? "").trim()),
          );
        if (phone) {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(300);
        }
        const missing = ["Home", "Live", "Rigs", "Library", "Usage", "Logs", "Settings"].filter(
          (n) => !names.some((x) => x.startsWith(n)),
        );
        if (missing.length)
          unopened.push(`${name} ${at}: the navigation lacks ${missing.join(", ")}`);
      };
      try {
        await page.goto(`${c.url}/next`);
        await page.waitForSelector('input[type="password"]');
        await keep("sign-in");
        await signIn(page);
        for (const s of screens) {
          const o = await tab.open(s.path);
          if (!("status" in o) || o.status !== 200) {
            unopened.push(`${s.path} ${at}: ${JSON.stringify(o)}`);
            continue;
          }
          await tab.page.waitForSelector(s.ready);
          await keep(s.name);
        }
        await places("navigation-rows");
        // The navigation's other variant: Library, Usage and Logs as icons at its foot.
        await page.goto(`${c.url}/next?nav=foot`);
        await page.waitForSelector('section[aria-label="What happened"]');
        await keep("home-icons-at-the-foot");
        await places("navigation-icons-at-the-foot");
      } catch (err) {
        unopened.push(`${at}: ${String(err).split("\n")[0]}`);
      }
      const p = tab.take();
      for (const e of p.errors) errors.push(`${at}, ${e}`);
      for (const e of p.requests) requests.push(`${at}, ${e}`);
      for (const e of p.outside) outside.push(`${at}, ${e}`);
      check(`the app ${at}: no screen is wider than the window`, l.wider.length === 0, l.wider);
      check(
        `the app ${at}: no controls lie on top of each other`,
        l.overlaps.length === 0,
        l.overlaps,
      );
      check(`the app ${at}: no text is cut off`, l.clipped.length === 0, l.clipped);
      check(`the app ${at}: every image loads`, l.images.length === 0, l.images);
      await tab.context.close();
    }
  check(
    "every screen of the app opens, at each width and in each look",
    unopened.length === 0,
    unopened,
  );
  check(
    "no screen of the app has a console error, an uncaught exception or a refused style",
    errors.length === 0,
    errors,
  );
  check("no request a screen of the app makes fails", requests.length === 0, requests);
  check("no screen of the app loads anything from another site", outside.length === 0, outside);

  const looks = SCHEMES.flatMap((s) => WIDTHS.map((w) => `${w.width}-${s}`));
  const cell = (/** @type {string | undefined} */ f) =>
    f ? `<a href="${f}"><img src="${f}" loading="lazy"></a>` : "";
  writeFileSync(
    join(out, "app.html"),
    `<!doctype html><meta charset="utf-8"><title>Thermite's app, every screen</title>
<style>body{font:14px system-ui;margin:20px}table{border-collapse:collapse}td,th{border-top:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}img{width:300px;border:1px solid #ccc}</style>
<h1>Every screen of the app at /next</h1><p>${rows.length} screens; each at ${WIDTHS.map((w) => w.name).join(", ")}, in light and in dark. Each screenshot is the whole screen. Findings: report.json.</p>
<table><tr><th>Screen</th>${looks.map((x) => `<th>${x}</th>`).join("")}</tr>
${rows.map((r) => `<tr><td>${r.name}</td>${looks.map((x) => `<td>${cell(r.shots[x])}</td>`).join("")}</tr>`).join("\n")}
</table>`,
  );
}
