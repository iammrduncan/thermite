#!/usr/bin/env node
// @ts-check
// Browser acceptance (goal 239): the dashboard in headless Chrome, driven with Playwright as a
// person uses it. Control runs from this checkout's source, in Node, on the dashboard demo's
// made-up data with one more CPU rig (tests/stand-ins/dashboard/main.ts): no images, no compose.
//
// 1. New campaign, end to end. The page's own script builds each draft and the page's buttons send
//    it: a hill climb starts, a goal campaign's kit is tried, each choice of "Where each run's work
//    goes" is kept or refused in words, and a research campaign is saved (issue 68). What control
//    stored is read from its store.
// 2. Every kind of page, at each width (lib/browser-pages.mjs). The sweep follows the dashboard's
//    links from the Overview, a few pages of each kind, and checks each page: errors in its console,
//    requests that fail, links that lead nowhere, anything loaded from another site, a page wider
//    than the window, controls on top of each other, text cut off and images that don't load. It
//    keeps a screenshot of each whole page at each width.
//
// 3. The dashboard's app at /next (lib/browser-app.mjs): built from web/, then its sign-in, a
//    change that shows with no reload, and every screen at 1440, 820 and 390 pixels wide, in light
//    and in dark.
//
// 4. The design system's site at /design (lib/browser-design.mjs): built from
//    packages/design-system, then every page of it at the same widths, in light and in dark, an
//    example's code, and the one dialog within its budget.
//
// It writes report.json, the screenshots, index.html (every page's screenshots side by side),
// app.html (every screen of the app) and design.html (every page of the design system's site) to
// .dev/acceptance/browser/. Chrome is the installed Google Chrome, or THERMITE_BROWSER_CHROME,
// the path of a Chrome or Chromium executable. Nothing is downloaded, and the browser reaches
// nothing but control.
//
// Usage: node scripts/acceptance/browser.mjs [--only flows|pages|app|design] [--widths 1440,820]
//          [--max-pages N] [--headed]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { launchChrome, signedInPage, startControl } from "./lib/browser.mjs";
import { appCheck, buildApp } from "./lib/browser-app.mjs";
import { buildSite, designCheck } from "./lib/browser-design.mjs";
import { pageSweep } from "./lib/browser-pages.mjs";
import { acceptanceChecks } from "./lib/checks.mjs";

const { values } = parseArgs({
  options: {
    only: { type: "string" },
    widths: { type: "string", default: "1440,820" },
    "max-pages": { type: "string", default: "400" },
    headed: { type: "boolean", default: false },
  },
});
if (values.only && !["flows", "pages", "app", "design"].includes(values.only)) {
  console.error(`browser.mjs: --only is flows, pages, app or design, not ${values.only}`);
  process.exit(2);
}
/**
 * The widths every page is checked at: by default a desktop, and one under the dashboard's 900px
 * layout, where the sidebar still takes its room. New campaign is filled in at the first.
 * @type {import("./lib/browser.mjs").Width[]}
 */
const WIDTHS = String(values.widths)
  .split(",")
  .map((w) => {
    const width = Number(w.trim());
    if (!Number.isInteger(width) || width < 320 || width > 3840) {
      console.error(
        `browser.mjs: --widths takes widths in pixels from 320 to 3840, such as 1440,820; not ${w}`,
      );
      process.exit(2);
    }
    return { name: `${width}px`, width, height: 900 };
  });
const FIRST = /** @type {import("./lib/browser.mjs").Width} */ (WIDTHS[0]);
/** The sweep must reach at least this many pages, or it found no links to follow. */
const MIN_PAGES = 20;
const OUT = join(".dev", "acceptance", "browser");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "pages"), { recursive: true });
mkdirSync(join(OUT, "flows"), { recursive: true });

const { check, results, failed } = acceptanceChecks({ max: 1200 });

/**
 * New campaign, end to end, as a person fills it in.
 * @param {import("playwright-core").Browser} browser
 * @param {import("./lib/browser.mjs").Stand} c
 */
async function newCampaignFlows(browser, c) {
  const tab = await signedInPage(browser, c, FIRST);
  const page = tab.page;
  const project = "https://git.example.com/team/tiny.git";
  const next = async () => {
    await page.click(".pane:not([hidden]) [data-next]");
    return page.getAttribute(".pane:not([hidden])", "data-pane");
  };
  /**
   * Steps 1 to 5 of a hill climb or a goal campaign on a tiny project, its kit described on the
   * page, filled in as a person does.
   * @param {{ mode: string, campaign: string, results: { to: string, git?: string, access?: string } }} o
   */
  const fill = async ({ mode, campaign, results: r }) => {
    await page.goto(`${c.url}/ui/campaigns/new`);
    await page.click(`.ch[data-group="mode"][data-value="${mode}"]`);
    await page.fill('input[name="campaign"]', campaign);
    await page.fill('input[name="title"]', `Browser check: ${campaign}`);
    const panes = [await next()];
    panes.push(await next());
    await page.fill('input[name="project_url"]', project);
    await page.fill('input[name="project_ref"]', "main");
    await page.fill('textarea[name="editable_paths"]', "bench.c");
    await page.click(`.ch[data-group="results"][data-value="${r.to}"]`);
    if (r.git) await page.fill('input[name="results_git"]', r.git);
    if (r.access) await page.selectOption('select[name="results_access"]', r.access);
    panes.push(await next());
    await page.fill('input[name="build"]', "cc -O2 -o bench bench.c");
    await page.fill('input[name="outputs"]', "bench");
    const firstCase = page.locator("#cases tbody tr").first().locator("input");
    await firstCase.nth(0).fill("small");
    await firstCase.nth(1).fill("50");
    await page.fill('input[name="run"]', "{build}/bench {args} > {out}/result.txt");
    await page.fill('input[name="check"]', 'test "$(cat {out}/result.txt)" = {args}');
    await page.selectOption('select[name="runs_per_case"]', "1");
    if (mode === "goal") {
      const goal = page.locator("#goals tbody tr").first();
      await goal.locator("input").nth(0).fill("The bench prints its n");
      await goal.locator("input").nth(1).fill("small");
      await goal.locator("select").selectOption("check");
    }
    panes.push(await next());
    await page.selectOption('select[name="lanes"]', "1");
    await page.click('.ch[data-group="rig"][data-value="rig-browser"]');
    panes.push(await next());
    return panes.join(" ");
  };
  /** The draft that Review and start shows, as the page's script builds it. */
  const draft = async () => JSON.parse((await page.textContent("#draft-preview")) ?? "{}");
  /**
   * Presses one of Review and start's buttons and waits for control's answer.
   * @param {"start" | "try" | "save"} value
   */
  const press = async (value) => {
    await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/ui/campaigns/new",
      ),
      page.click(`.pane[data-pane="review"] button[name="start"][value="${value}"]`),
    ]);
    await page.waitForLoadState("load");
    // biome-ignore lint/performance/useDomNodeTextContent: the words a person sees, not hidden ones
    const text = await page.innerText("body");
    return { path: new URL(page.url()).pathname, text };
  };
  /** @param {string} text */
  const refused = (text) => /Not started|fix these first|Unrecognized key/.test(text);
  /** What control stored as where each run's work goes, for a campaign's newest version. */
  const stored = (/** @type {string} */ campaign) => {
    const db = new DatabaseSync(c.db, { readOnly: true });
    try {
      const row = /** @type {{ sources: string } | undefined} */ (
        db
          .prepare("select sources from campaign_version where campaign = ? order by version desc")
          .get(campaign)
      );
      return row ? (JSON.parse(row.sources).results ?? null) : undefined;
    } finally {
      db.close();
    }
  };
  const shot = (/** @type {string} */ name) =>
    page.screenshot({ path: join(OUT, "flows", `${name}.png`), fullPage: true });

  // A hill climb, Only on control, Start the campaign: the case issue 68 reported.
  const steps = await fill({ mode: "hill_climb", campaign: "br-hill", results: { to: "control" } });
  check(
    "New campaign's steps go the brief, the project, how to measure, where it runs, review",
    steps === "brief project measure where review",
    steps,
  );
  let d = await draft();
  check(
    "the draft on Review and start says the work stays on control",
    JSON.stringify(d.results) === '{"to":"control"}',
    d.results,
  );
  await shot("1-hill-review");
  let r = await press("start");
  await shot("1-hill-started");
  check(
    "Start the campaign: no refusal, and the run's page opens",
    !refused(r.text) && r.path === "/ui/campaigns/br-hill/runs/br-hill-1",
    r.path,
  );
  check(
    "control keeps no destination for Only on control",
    stored("br-hill") === null,
    stored("br-hill"),
  );

  // A goal campaign, Only on control, Try the kit first.
  await fill({ mode: "goal", campaign: "br-goal", results: { to: "control" } });
  d = await draft();
  check(
    "a goal campaign's draft carries its goal and where its work goes",
    d.goals?.length === 1 && d.results?.to === "control",
    { goals: d.goals, results: d.results },
  );
  r = await press("try");
  await shot("2-goal-try");
  check(
    "Try the kit first: no refusal, and the try's page opens",
    !refused(r.text) && r.path === "/ui/campaigns/br-goal/runs/br-goal-try-1",
    r.path,
  );

  // Branches of this repository with no Git access: refused in words, the answers kept.
  await fill({ mode: "hill_climb", campaign: "br-no-access", results: { to: "project" } });
  r = await press("save");
  await shot("3-no-access");
  check(
    "Branches of this repository with no Git access: refused in words",
    /choose a Git access that can push there, or Only on control/.test(r.text) &&
      !/Unrecognized key/.test(r.text),
    r.text.match(/Not started[^\n]*\n[^\n]*/)?.[0],
  );
  const kept = {
    results: await page.getAttribute('.ch.on[data-group="results"]', "data-value"),
    campaign: await page.inputValue('input[name="campaign"]'),
  };
  check(
    "the page sent back keeps the answers, Branches of this repository chosen",
    kept.results === "project" && kept.campaign === "br-no-access",
    kept,
  );
  check("nothing is saved for a refused campaign", stored("br-no-access") === undefined);

  // A deploy key, made on Settings' Git access, to push with. Nothing is pushed here.
  await page.goto(`${c.url}/ui/settings`);
  const added = await page.evaluate(async () => {
    const g = /** @type {any} */ (globalThis);
    const csrf = String(g.document.querySelector('input[name="csrf"]').value);
    const res = await fetch("/ui/settings/add", {
      method: "POST",
      body: new URLSearchParams({ csrf, type: "gitkey", name: "br-push", host: "git.example.com" }),
    });
    return res.status;
  });
  check("Settings made a deploy key, br-push", added === 200, added);

  // Branches of this repository, pushed with the deploy key: saved, and kept.
  await fill({
    mode: "hill_climb",
    campaign: "br-to-project",
    results: { to: "project", access: "br-push" },
  });
  r = await press("save");
  await shot("4-to-project");
  check(
    "Branches of this repository with a deploy key: saved",
    !refused(r.text) && r.path === "/ui/campaigns/br-to-project",
    r.path,
  );
  check(
    "control keeps the project as where the work goes, with its access",
    JSON.stringify(stored("br-to-project")) === '{"access":"br-push","to":"project"}',
    stored("br-to-project"),
  );

  // A separate results repository, pushed with the deploy key: saved, and kept.
  const git = "git@git.example.com:team/tiny-results.git";
  await fill({
    mode: "hill_climb",
    campaign: "br-to-repo",
    results: { to: "repository", git, access: "br-push" },
  });
  r = await press("save");
  await shot("5-to-repo");
  check(
    "A separate results repository with a deploy key: saved",
    !refused(r.text) && r.path === "/ui/campaigns/br-to-repo",
    r.path,
  );
  check(
    "control keeps the repository, its address and its access",
    JSON.stringify(stored("br-to-repo")) ===
      JSON.stringify({ access: "br-push", git, to: "repository" }),
    stored("br-to-repo"),
  );

  // A research campaign, whose draft has no destination: saved.
  await page.goto(`${c.url}/ui/campaigns/new`);
  await page.click('.ch[data-group="mode"][data-value="research"]');
  await page.fill('input[name="campaign"]', "br-research");
  await page.fill('input[name="title"]', "Browser check: research");
  await next();
  await page.fill('input[name="topic"]', "How small C benchmarks are timed");
  await page
    .locator('[data-bl="questions"] textarea, [data-bl="questions"] input')
    .first()
    .fill("Which clock do they use?");
  // Straight to the last step, as a person may: the step list leads to any step.
  await page.click('#steps li[data-step="review"]');
  d = await draft();
  check(
    "a research campaign's draft has no destination",
    d.mode === "research" && d.results === undefined,
    { mode: d.mode, results: d.results },
  );
  r = await press("save");
  await shot("6-research");
  check(
    "a research campaign: saved",
    !refused(r.text) && r.path === "/ui/campaigns/br-research",
    r.path,
  );

  const problems = tab.take();
  check(
    "New campaign: no console error or uncaught exception",
    problems.errors.length === 0,
    problems.errors,
  );
  await tab.context.close();
}

// The app is built before control starts: control serves what is in web/dist.
const part = (/** @type {string} */ name) => !values.only || values.only === name;
let app = false;
if (part("app")) {
  const built = buildApp();
  app = check(
    "the dashboard's app builds from web/",
    built.ok,
    built.ok ? `script ${built.script} bytes, styles ${built.styles} bytes` : built.why,
  );
}
// So is the design system's site: control serves what is in packages/design-system/dist.
let design = false;
if (part("design")) {
  const built = buildSite();
  design = check(
    "the design system's site builds from packages/design-system",
    built.ok,
    built.ok ? undefined : built.why,
  );
}
const control = await startControl(OUT);
let browser;
try {
  browser = await launchChrome(Boolean(values.headed));
  console.log(`Chrome ${browser.version()}, control at ${control.url}`);
  if (part("flows")) await newCampaignFlows(browser, control);
  if (app) await appCheck(browser, control, { out: OUT, check });
  if (design) await designCheck(browser, control, { out: OUT, check });
  if (part("pages"))
    await pageSweep(browser, control, {
      widths: WIDTHS,
      out: OUT,
      maxPages: Number(values["max-pages"]),
      minPages: MIN_PAGES,
      check,
    });
} catch (err) {
  check(
    "the browser check ran to its end",
    false,
    String(err instanceof Error ? (err.stack ?? err.message) : err),
  );
} finally {
  await browser?.close();
  control.stop();
}
writeFileSync(
  join(OUT, "report.json"),
  `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log(
  `\n${results.length - failed()} of ${results.length} checks passed. Report, screenshots and index.html: ${OUT}/`,
);
process.exit(failed() ? 1 : 0);
