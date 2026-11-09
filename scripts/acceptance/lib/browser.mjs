// @ts-check
// The browser acceptance check's parts that start things (scripts/acceptance/browser.mjs): control
// from this checkout's source (tests/stand-ins/dashboard/main.ts), headless Chrome that reaches
// nothing but control, and a signed-in tab that collects what goes wrong on its pages.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";

/**
 * Control as the stand-in started it: its address, the owner's token, its store, the commit every
 * project is looked up at, and the dashboard's GET routes under /ui.
 * @typedef {{ url: string, token: string, db: string, commit: string, pages: string[] }} Stand
 */
/** @typedef {{ name: string, width: number, height: number }} Width */

/**
 * Starts control from the source, on the demo's data, on a free port. Its log goes to
 * `out`/control.log.
 * @param {string} out
 * @returns {Promise<Stand & { stop: () => void }>}
 */
export async function startControl(out) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "tests/stand-ins/dashboard/main.ts",
      "--port",
      "0",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const stop = () => {
    child.kill("SIGTERM");
  };
  const lines = createInterface({
    input: /** @type {import("node:stream").Readable} */ (child.stdout),
  });
  /** @type {Stand} */
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("control did not start within 90 s")), 90_000);
    child.once("exit", (code) =>
      reject(new Error(`control exited with code ${code} before it listened`)),
    );
    // Control's own log lines are JSON too: they go to control.log. Its ready line has url and token.
    lines.on("line", (line) => {
      appendFileSync(join(out, "control.log"), `${line}\n`);
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof o?.url !== "string" || typeof o?.token !== "string") return;
      clearTimeout(timer);
      resolve(o);
    });
  });
  return { ...ready, stop };
}

/**
 * Headless Chrome: the installed Google Chrome (Playwright's "chrome" channel), or
 * THERMITE_BROWSER_CHROME, a Chrome or Chromium executable. Only this machine's address resolves
 * and no proxy is used, so no page, and no redirect, reaches another site.
 * @param {boolean} headed
 */
export async function launchChrome(headed) {
  const executablePath = process.env.THERMITE_BROWSER_CHROME;
  try {
    return await chromium.launch({
      headless: !headed,
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      args: ["--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", "--no-proxy-server"],
    });
  } catch (err) {
    throw new Error(
      `no Chrome to run (${String(err).split("\n")[0]}): install Google Chrome, or set THERMITE_BROWSER_CHROME to a Chrome or Chromium executable`,
    );
  }
}

/**
 * A signed-in tab at one width, with what goes wrong on it collected, each with the page shown
 * when it happened: console errors, uncaught exceptions, control's own requests that fail, and
 * anything a page asks of another site, which is refused.
 * @param {import("playwright-core").Browser} browser
 * @param {Stand} c
 * @param {{ width: number, height: number }} size
 */
export async function signedInPage(browser, c, size) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
  });
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const requests = [];
  /** @type {string[]} */
  const outside = [];
  /** The site a navigation last tried to reach other than control (a redirect elsewhere). */
  let leftTo = "";
  /** @type {import("playwright-core").Page} */
  let page;
  const here = () => {
    const u = new URL(page.url());
    return u.origin === c.url ? u.pathname + u.search : u.href;
  };
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.origin === c.url || u.protocol === "data:" || u.protocol === "blob:")
      return route.continue();
    outside.push(
      `${here()}: ${route.request().isNavigationRequest() ? "leads to" : "loads"} ${u.origin}${u.pathname}`,
    );
    return route.abort("blockedbyclient");
  });
  /** A new tab in the signed-in context, watched. */
  const newTab = async () => {
    const p = await context.newPage();
    p.on("request", (r) => {
      if (r.isNavigationRequest() && !r.url().startsWith(c.url) && /^https?:/.test(r.url()))
        leftTo = new URL(r.url()).origin;
    });
    p.on("console", (m) => {
      // A request refused above shows in the console too; it is noted once, as outside.
      if (m.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(m.text()))
        errors.push(`${here()}: console: ${m.text().slice(0, 300)}`);
    });
    p.on("pageerror", (e) =>
      errors.push(`${here()}: exception: ${String(e.message).slice(0, 300)}`),
    );
    p.on("requestfailed", (r) => {
      const why = r.failure()?.errorText ?? "";
      // Aborted: the page went on to another before the request ended (a live stream, a poll).
      if (r.url().startsWith(c.url) && !/ERR_ABORTED/.test(why))
        requests.push(`${here()}: ${r.method()} ${new URL(r.url()).pathname}: ${why}`);
    });
    p.on("response", (r) => {
      // A page's own address is checked where it is opened; this is what the page asks for after.
      if (r.url().startsWith(c.url) && r.status() >= 400 && !r.request().isNavigationRequest())
        requests.push(
          `${here()}: ${r.request().method()} ${new URL(r.url()).pathname}: ${r.status()}`,
        );
    });
    return p;
  };
  page = await newTab();
  await page.goto(`${c.url}/ui/login`);
  await page.fill('input[name="token"]', c.token);
  await Promise.all([page.waitForURL(`${c.url}/ui`), page.press('input[name="token"]', "Enter")]);
  /** Takes what went wrong since the last call. */
  const take = () => ({
    errors: errors.splice(0),
    requests: requests.splice(0),
    outside: outside.splice(0),
  });
  /**
   * Opens one of control's pages. Its status; or the site it led to, which can't resolve here (a
   * sign-in elsewhere); or what went wrong. A failed opening closes the tab and the next page opens
   * in a new one, so that a late error page cuts nothing short.
   * @param {string} path
   * @returns {Promise<{ status: number } | { away: string } | { error: string }>}
   */
  const open = async (path) => {
    leftTo = "";
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await page.goto(`${c.url}${path}`, { waitUntil: "load" });
        return { status: res?.status() ?? 0 };
      } catch (err) {
        const words = String(err).split("\n")[0] ?? "";
        await page.close().catch(() => {});
        page = await newTab();
        if (/ERR_NAME_NOT_RESOLVED|ERR_BLOCKED_BY_CLIENT/.test(words))
          return { away: leftTo || "another site" };
        if (attempt === 1 && /interrupted by another navigation/.test(words)) continue;
        return { error: words };
      }
    }
  };
  return {
    context,
    take,
    open,
    /** The tab in use: a new one after a failed opening. */
    get page() {
      return page;
    },
  };
}
