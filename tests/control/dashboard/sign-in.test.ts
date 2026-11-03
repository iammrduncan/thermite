import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { Credential } from "../../../src/control/credential.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { ADMIN, controlOnly, controlStack, signIn } from "../../helpers/control-stack.ts";
import { stack } from "./stack.ts";

/**
 * Signing in to the dashboard: the icons without it, a wrong token, an admin token kept only as
 * its hash, and a session across restarts of control.
 */

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

describe("control dashboard", () => {
  test("the icons come with no sign-in, and every page, the sign-in page too, links them", async () => {
    const s = await stack();
    for (const [path, type] of [
      ["/favicon.svg", "image/svg+xml"],
      ["/favicon.ico", "image/x-icon"],
      ["/apple-touch-icon.png", "image/png"],
    ] as const) {
      const r = await s.control.request(path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers.get("content-type"), type, path);
      assert.ok((await r.arrayBuffer()).byteLength > 100, path);
    }
    const login = await (await s.control.request("/ui/login")).text();
    const page = await (await s.get("/ui")).text();
    for (const html of [login, page])
      assert.match(html, /<link rel="icon" href="\/favicon\.ico" sizes="32x32">/);
  });

  test("sign-in is required, and a wrong token gets nowhere", async () => {
    const s = await stack();
    const { login } = await signIn(s.control);
    assert.equal(login.status, 303);
    const anon = await s.control.request("/ui");
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get("location"), "/ui/login");
    const { login: bad } = await signIn(s.control, "wrong");
    assert.equal(bad.headers.get("set-cookie"), null);
    // Signed in, a form needs the page's form token; signing out needs none.
    const ui = await signIn(s.control);
    const forged = await ui.post("/ui/settings/rigs", { csrf: "0".repeat(48) });
    assert.equal(forged.status, 403);
    assert.equal(await forged.text(), "bad form token");
    const out = await ui.post("/ui/logout", {});
    assert.equal(out.headers.get("location"), "/ui/login");
    assert.equal((await ui.get("/ui")).status, 303);
  });

  test("failed sign-ins are counted for each address apart: one that fails too often waits, and another still signs in", async () => {
    const { control, store } = controlStack({});
    const from = (address: string, token: string) =>
      control.request(
        "/ui/login",
        {
          method: "POST",
          body: new URLSearchParams({ token }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        },
        { incoming: { socket: { remoteAddress: address } } },
      );
    for (let i = 0; i < 20; i++)
      assert.equal((await from("192.0.2.7", "wrong")).status, 303, `failure ${i + 1}`);
    const waits = await from("192.0.2.7", ADMIN);
    assert.equal(waits.status, 429);
    assert.equal(await waits.text(), "too many failed sign-ins; wait a minute");
    const other = await from("198.51.100.9", ADMIN);
    assert.equal(other.status, 303);
    assert.equal(other.headers.get("location"), "/ui");
    assert.equal(store.auditLog.list(200, { action: "login_throttled" }).length, 1);
  });

  test("with only the token's hash, the owner signs in with the token, and the hash signs in no one", async () => {
    const { control } = controlStack({
      tokens: { admin: Credential.ofHash(sha256(ADMIN)), rigs: {} },
    });
    const { login: ok, cookie } = await signIn(control, "admin-token-abcdef");
    assert.equal(ok.headers.get("location"), "/ui");
    assert.equal((await control.request("/ui", { headers: { cookie } })).status, 200);
    const { login: hash } = await signIn(control, sha256("admin-token-abcdef"));
    assert.equal(hash.headers.get("location"), "/ui/login");
  });

  test("a session survives a restart of control, renews in use, and ends with a new token", async () => {
    // Each control is started again over the same store, with the same signing key.
    const store = new ControlStore(":memory:");
    const keys = generateSigningKeys();
    const control = (admin: string) => controlOnly({ store, keys, tokens: { admin } }).control;
    const first = control("admin-token-abcdef");
    const { login, cookie } = await signIn(first, "admin-token-abcdef");
    const set = login.headers.get("set-cookie") ?? "";
    assert.match(set, /Max-Age=2592000/);
    // Only a hash of the session id is stored.
    const rows = store.db.prepare("select id_hash from ui_session").all() as { id_hash: string }[];
    assert.equal(rows.length, 1);
    assert.ok(!cookie.includes(rows[0]?.id_hash ?? "x"));
    // A new control process over the same store: still signed in, with the same form token.
    const formToken = async (app: ReturnType<typeof control>) => {
      const r = await app.request("/ui", { headers: { cookie } });
      assert.equal(r.status, 200);
      return /name="csrf" value="([0-9a-f]+)"/.exec(await r.text())?.[1];
    };
    const before = await formToken(first);
    const restarted = control("admin-token-abcdef");
    assert.equal(await formToken(restarted), before);
    // Deployed with only the token's hash, control knows the same session.
    const hashed = controlOnly({
      store,
      keys,
      tokens: { admin: Credential.ofHash(sha256("admin-token-abcdef")), rigs: {} },
    }).control;
    assert.equal(await formToken(hashed), before);
    // A session older than a day is renewed when used.
    store.db.prepare("update ui_session set expires_at = ?").run(Date.now() + 3_600_000);
    const used = await restarted.request("/ui", { headers: { cookie } });
    assert.match(used.headers.get("set-cookie") ?? "", /Max-Age=2592000/);
    const row = store.db.prepare("select expires_at from ui_session").get() as {
      expires_at: number;
    };
    assert.ok(row.expires_at > Date.now() + 29 * 24 * 3_600_000);
    // A new admin token ends every session.
    const rotated = control("another-admin-token-0123");
    const out = await rotated.request("/ui", { headers: { cookie } });
    assert.equal(out.status, 303);
    // Signing out removes it.
    await restarted.request("/ui/logout", { method: "POST", headers: { cookie } });
    assert.equal((await restarted.request("/ui", { headers: { cookie } })).status, 303);
  });
});
