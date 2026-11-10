import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  HOME,
  RUN_OVERVIEW,
  SESSION,
  SESSION_END,
  SESSION_START,
  SESSION_TOKEN_HEADER,
  STREAM_PATH,
} from "../../../src/core/api/control/dashboard.ts";
import { ADMIN, controlOnly, signIn } from "../../helpers/control-stack.ts";
import { controlStore } from "../../helpers/control-store.ts";
import { seedDemo } from "../../helpers/demo/index.ts";

/**
 * The dashboard's app as control serves it (goal 243): the owner's session on /v1, with its
 * token on every change; the app's files at /next under a policy with no inline style; and the
 * reads of Home and of a run's Overview, each as its contract says.
 */

const JSON_TYPE = { "content-type": "application/json" };

/** A folder of built files, as Vite leaves them: the page with the nonce's placeholder. */
function builtApp(): string {
  const dir = mkdtempSync(join(tmpdir(), "thermite-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html><head><meta property="csp-nonce" nonce="__CSP_NONCE__"><script type="module" nonce="__CSP_NONCE__" src="/next/assets/app-abc.js"></script></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(dir, "assets", "app-abc.js"), "export {};\n");
  writeFileSync(join(dir, "licenses.md"), "# Licenses\n");
  return dir;
}

/** Control over the demo's data, and a way to sign in as the app does. */
async function demo(webDir?: string) {
  const store = controlStore();
  await seedDemo(store);
  const { control } = controlOnly({ store, options: webDir ? { webDir } : {} });
  const start = async (token = ADMIN) =>
    await control.request(SESSION_START.path, {
      method: "POST",
      headers: JSON_TYPE,
      body: JSON.stringify({ token }),
    });
  const app = async () => {
    const res = await start();
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const { token } = (await res.json()) as { token: string };
    return { cookie, token };
  };
  return { store, control, start, app };
}

describe("the owner's session on /v1", () => {
  test("a browser with no session is told so, and reads nothing", async () => {
    const { control } = await demo();
    const s = await control.request(SESSION.path);
    assert.equal(s.status, 200);
    const said = SESSION.answer.parse(await s.json());
    assert.equal(said.signed_in, false);
    assert.equal(said.token, undefined);
    assert.equal((await control.request(HOME.path)).status, 401);
  });

  test("a wrong token signs nobody in", async () => {
    const { control, start } = await demo();
    const res = await start("not-the-token");
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("set-cookie"), null);
    assert.match(String(((await res.json()) as { error: string }).error), /not the owner's token/);
    assert.equal((await control.request(HOME.path)).status, 401);
  });

  test("the owner's token signs in: one cookie for every path, and a token for changes", async () => {
    const { control, start } = await demo();
    const res = await start();
    assert.equal(res.status, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^thermite_session=[\w-]+;/);
    assert.match(setCookie, /Path=\/;|Path=\/$/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const said = SESSION_START.answer.parse(await res.json());
    assert.equal(said.signed_in, true);
    assert.match(said.token ?? "", /^[0-9a-f]{64}$/);
    // The same session reads the owner's routes of /v1, and opens the pages at /ui.
    const cookie = setCookie.split(";")[0] ?? "";
    assert.equal((await control.request(HOME.path, { headers: { cookie } })).status, 200);
    assert.equal((await control.request("/v1/rigs", { headers: { cookie } })).status, 200);
    assert.equal((await control.request("/ui", { headers: { cookie } })).status, 200);
  });

  test("a session made at /ui serves the app too", async () => {
    const { control } = await demo();
    const { cookie } = await signIn(control);
    const s = SESSION.answer.parse(
      await (await control.request(SESSION.path, { headers: { cookie } })).json(),
    );
    assert.equal(s.signed_in, true);
    assert.equal((await control.request(HOME.path, { headers: { cookie } })).status, 200);
  });

  test("a change needs the session's token in its header", async () => {
    const { control, app, store } = await demo();
    const { cookie, token } = await app();
    const archive = (headers: Record<string, string>) =>
      control.request("/v1/campaigns/sum-speed/archive", {
        method: "POST",
        headers: { cookie, ...JSON_TYPE, ...headers },
        body: "{}",
      });
    const without = await archive({});
    assert.equal(without.status, 403);
    assert.deepEqual(await without.json(), { error: "bad session token" });
    assert.equal((await archive({ [SESSION_TOKEN_HEADER]: "0".repeat(64) })).status, 403);
    assert.equal(store.archive.list().length, 0);
    // With it, the route answers as it does for the owner's token: here, its own refusal or yes.
    const withIt = await archive({ [SESSION_TOKEN_HEADER]: token });
    assert.notEqual(withIt.status, 401);
    assert.notEqual(withIt.status, 403);
  });

  test("a token that is not the owner's is refused whatever the cookie", async () => {
    const { control, app } = await demo();
    const { cookie } = await app();
    const res = await control.request(HOME.path, {
      headers: { cookie, authorization: "Bearer someone-else" },
    });
    assert.equal(res.status, 401);
  });

  test("signing out ends the session on control", async () => {
    const { control, app } = await demo();
    const { cookie } = await app();
    const out = await control.request(SESSION_END.path, { method: "DELETE", headers: { cookie } });
    assert.equal(out.status, 200);
    assert.equal((await control.request(HOME.path, { headers: { cookie } })).status, 401);
    assert.equal((await control.request("/ui", { headers: { cookie } })).status, 303);
  });
});

describe("the app's files at /next", () => {
  test("the page carries a fresh nonce, and a policy with no inline script or style", async () => {
    const { control } = await demo(builtApp());
    const a = await control.request("/next");
    const b = await control.request("/next/campaigns/decode-speed/runs/decode-b");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const policy = a.headers.get("content-security-policy") ?? "";
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'self';/);
    assert.match(policy, /frame-ancestors 'none'/);
    const nonce = /style-src 'self' 'nonce-([^']+)'/.exec(policy)?.[1] ?? "";
    assert.ok(nonce.length >= 16, policy);
    const html = await a.text();
    assert.doesNotMatch(html, /__CSP_NONCE__/);
    assert.ok(html.includes(`nonce="${nonce}"`));
    // Each answer has a nonce of its own.
    assert.ok(!(b.headers.get("content-security-policy") ?? "").includes(nonce));
    assert.equal(a.headers.get("cache-control"), "no-store");
    assert.equal(a.headers.get("x-content-type-options"), "nosniff");
  });

  test("a built file is served as what it is, and kept by the browser", async () => {
    const { control } = await demo(builtApp());
    const js = await control.request("/next/assets/app-abc.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.match(js.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await control.request("/next/assets/none.js")).status, 404);
    // The licences of the app's packages go out with it, as text a browser shows.
    const licences = await control.request("/next/licenses.md");
    assert.equal(licences.status, 200);
    assert.match(licences.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(await licences.text(), "# Licenses\n");
  });

  test("nothing outside the app's folder is served", async () => {
    const dir = builtApp();
    writeFileSync(join(dir, "..", "thermite-web-secret.txt"), "secret");
    const { control } = await demo(dir);
    for (const path of [
      "/next/../thermite-web-secret.txt",
      "/next/%2e%2e/thermite-web-secret.txt",
    ]) {
      const res = await control.request(path);
      assert.doesNotMatch(await res.text(), /^secret$/, path);
    }
  });

  test("a control with no built app says so", async () => {
    const { control } = await demo(join(tmpdir(), "thermite-web-none"));
    const res = await control.request("/next");
    assert.equal(res.status, 503);
    assert.match(await res.text(), /not built here/);
  });
});

describe("the app's reads", () => {
  test("Home is what needs the owner, what is at work and what happened, as its contract says", async () => {
    const { control, app } = await demo();
    const { cookie } = await app();
    const res = await control.request(HOME.path, { headers: { cookie } });
    assert.equal(res.status, 200);
    const home = HOME.answer.parse(await res.json());
    // The demo: four decisions wait, and runs are at work.
    assert.ok(home.needs.length >= 4, `needs: ${home.needs.length}`);
    const promotion = home.needs.find((n) => n.kind === "promotion");
    assert.ok(promotion);
    assert.equal(promotion.label, "Your decision");
    assert.match(promotion.headline, /made a change\. The judge measured it/);
    assert.match(promotion.why, /waits for you|asks you to decide/);
    assert.match(promotion.page, /^\/ui\/campaigns\/[^/]+\/runs\/[^/]+\/attempts\//);
    // The rows are words: nothing of the pages' markup comes through.
    assert.doesNotMatch(JSON.stringify(home), /<[a-z]+[ >]|&amp;|&lt;/);
    assert.ok(home.at_work.length >= 1);
    const climb = home.at_work.find((r) => r.mode === "hill_climb");
    assert.ok(climb);
    assert.match(climb.figure.text ?? "", /^[+-]\d/);
    assert.ok(climb.figure.steps.length >= 1);
    assert.ok(climb.now.some((l) => l.who === "judge"));
    assert.ok(home.happened.length >= 1);
    assert.ok(home.nav.campaigns.some((k) => k.name === "decode-speed"));
    // One number for the list: every row counts, a rig that stopped reporting too.
    assert.equal(home.counts.needs, home.needs.length);
    assert.ok(home.needs.some((n) => n.kind === "stale"));
  });

  test("a run's Overview says how it stands, as its contract says", async () => {
    const { control, app } = await demo();
    const { cookie } = await app();
    const res = await control.request("/v1/runs/decode-b/overview", { headers: { cookie } });
    assert.equal(res.status, 200);
    const run = RUN_OVERVIEW.answer.parse(await res.json());
    assert.equal(run.row.run, "decode-b");
    assert.equal(run.row.campaign, "decode-speed");
    assert.match(run.said, /^Champion #\d+ is [+-][\d.]+% against where the run started\./);
    assert.equal(run.metric?.better, "higher is better");
    assert.ok(run.recent.length >= 1);
    assert.equal(run.page, "/ui/campaigns/decode-speed/runs/decode-b");
    assert.doesNotMatch(JSON.stringify(run), /<[a-z]+[ >]|&amp;|&lt;/);
    const none = await control.request("/v1/runs/no-such-run/overview", { headers: { cookie } });
    assert.equal(none.status, 404);
    assert.deepEqual(await none.json(), { error: "no run no-such-run" });
  });

  test("the stream of changes opens for the owner alone", async () => {
    const { control, app } = await demo();
    assert.equal((await control.request(STREAM_PATH)).status, 401);
    const { cookie } = await app();
    const res = await control.request(STREAM_PATH, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    const reader = res.body?.getReader();
    const first = new TextDecoder().decode((await reader?.read())?.value);
    assert.match(first, /event: beat/);
    await reader?.cancel();
  });
});
