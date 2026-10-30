#!/usr/bin/env node
// Screenshots of the dashboard for the documentation site, taken from the dashboard demo, whose
// data is made up. Start the demo first, then run this with a local Chrome or Chromium:
//
//   node --experimental-strip-types scripts/dev/dashboard-demo/main.ts &
//   node scripts/docs/screenshots.mjs [--chrome PATH] [--demo http://127.0.0.1:8810] [--out DIR]
//
// It writes WebP files to docs/_site/src/assets/screenshots/ (or --out, to look at them first).
// Each shot is the page as a person sees it at 1440×900 in the light theme.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    chrome: {
      type: "string",
      default: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    demo: { type: "string", default: "http://127.0.0.1:8810" },
    token: { type: "string", default: "demo-admin-token-0123456789" },
    out: { type: "string" },
  },
});
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = values.out ? resolve(values.out) : join(root, "docs/_site/src/assets/screenshots");
mkdirSync(out, { recursive: true });

const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "thermite-shots-"));
const chrome = spawn(
  values.chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    "--no-first-run",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let next = 0;
const pending = new Map();
const waiters = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve: done, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else done(msg.result);
  } else if (msg.method) {
    for (const w of waiters.filter((w) => w.method === msg.method)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.done(msg.params);
    }
  }
});
const send = (method, params = {}) =>
  new Promise((done, reject) => {
    const id = ++next;
    pending.set(id, { resolve: done, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const once = (method) => new Promise((done) => waiters.push({ method, done }));

async function go(url) {
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url });
  await loaded;
  await sleep(400);
}
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });

  await go(`${values.demo}/ui/login`);
  const signedIn = once("Page.loadEventFired");
  await evaluate(
    `document.querySelector('input[name=token]').value = ${JSON.stringify(values.token)};` +
      "document.querySelector('form').submit();",
  );
  await signedIn;

  const firstLink = (prefix, skip = []) =>
    evaluate(
      `[...document.querySelectorAll('a')].map(a => a.getAttribute('href'))` +
        `.find(h => h && h.startsWith(${JSON.stringify(prefix)}) && h !== ${JSON.stringify(prefix)}` +
        ` && !${JSON.stringify(skip)}.includes(h))`,
    );
  /** The first link whose address the pattern matches whole. */
  const firstMatch = (pattern) =>
    evaluate(
      `[...document.querySelectorAll('a')].map(a => a.getAttribute('href'))` +
        `.find(h => h && new RegExp(${JSON.stringify(pattern)}).test(h))`,
    );
  // A hill climb shows the most: its champion chart, decisions and lanes.
  await go(`${values.demo}/ui/campaigns`);
  const campaign =
    (await evaluate(
      `[...document.querySelectorAll('a')].map(a => a.getAttribute('href'))` +
        `.find(h => h === '/ui/campaigns/decode-speed')`,
    )) ?? (await firstLink("/ui/campaigns/"));
  await go(`${values.demo}${campaign}`);
  // A run's page and its Live, under the campaign (goal 170).
  const run = await firstMatch(`^${campaign}/runs/[^/?#]+$`);
  const live = await firstMatch(`^${campaign}/runs/[^/?#]+/live$`);
  await go(`${values.demo}/ui/rigs`);
  // A rig's own page, not Add a rig, which comes first on the Rigs page.
  const rig = await firstLink("/ui/rigs/", ["/ui/rigs/add"]);

  const shots = [
    ["overview", "/ui"],
    ["campaigns", "/ui/campaigns"],
    ["run", run],
    ["experiments", run && `${run}/experiments`],
    ["journal", run && `${run}/journal`],
    ["live", live],
    // The Knowledge page open at the run's records: the tree down to its slots, and their table.
    [
      "knowledge",
      run?.replace(/^\/ui\/campaigns\/([^/]+)\/runs\/([^/]+)$/, "/ui/knowledge/$1/$2/records"),
    ],
    ["rig", rig],
  ];
  for (const [name, path] of shots) {
    if (!path) throw new Error(`no page for ${name}`);
    await go(`${values.demo}${path}`);
    const shot = await send("Page.captureScreenshot", { format: "webp", quality: 85 });
    writeFileSync(join(out, `${name}.webp`), Buffer.from(shot.data, "base64"));
    process.stdout.write(`${name}: ${path}\n`);
  }
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
