import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import { issueCommand } from "../../src/control/issue/index.ts";
import {
  McpServers,
  mcpRefusal,
  SIGN_IN_ANSWER_MAX,
  signInFetch,
} from "../../src/control/mcp-servers/index.ts";
import { SecretBox } from "../../src/control/secrets.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import { generateSigningKeys } from "../../src/core/commands.ts";
import { assigned } from "../helpers/assignments.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../helpers/control-stack.ts";
import { applied, controlStore, enrollRigs } from "../helpers/control-store.ts";
import { type FakeAuth, type FakeMcp, startFakeMcp } from "../helpers/fake-mcp.ts";
import { report } from "../helpers/view-events.ts";

/** Made-up secrets: each must reach only the fake server's headers, never a page, log or audit. */
const KEY = "Bearer brainkeyforthetestsonly";
const CLIENT_SECRET = "clientsecretforthetestsonly";
const RIG_TOKEN = "rig-token-aaaaaa";

async function fakeOf(t: TestContext, auth: FakeAuth) {
  const fake = await startFakeMcp(auth);
  t.after(() => fake.close());
  return fake;
}

function setup() {
  const store = new ControlStore(":memory:");
  const secrets = SecretBox.ephemeral();
  const servers = new McpServers(store, secrets);
  return { store, secrets, servers };
}

/** Everything control keeps or says: its tables, its audit and its log lines, as text. */
function everything(store: ControlStore): string {
  const tables = ["mcp_server", "mcp_sign_in", "audit"];
  return tables.map((t) => JSON.stringify(store.db.prepare(`select * from ${t}`).all())).join("\n");
}

/** The browser's part of an OAuth sign-in: open the server's page, which sends it back with a code. */
async function allow(signInUrl: string): Promise<{ state: string; code: string }> {
  const res = await fetch(signInUrl, { redirect: "manual" });
  const back = new URL(res.headers.get("location") ?? "");
  return { state: back.searchParams.get("state") ?? "", code: back.searchParams.get("code") ?? "" };
}

describe("MCP servers in Settings", () => {
  test("a key in a header: sealed, shown by its last four characters, and its tools read with it", async (t) => {
    const fake = await fakeOf(t, { kind: "header", header: "X-Brain-Key", value: KEY });
    const { store, servers } = setup();
    servers.put(
      { name: "gbrain", url: fake.url, auth: "key", header: "X-Brain-Key", secret: KEY },
      "owner:test",
    );
    assert.equal(await servers.check("gbrain"), null);
    const s = servers.get("gbrain");
    assert.equal(s?.status, "ok");
    assert.equal(s?.secret_hint, "…only");
    assert.deepEqual(
      s?.tools?.map((x) => [x.name, x.reads]),
      [
        ["search", true],
        ["get_page", true],
        ["put_page", false],
      ],
    );
    assert.equal(s?.tools?.[0]?.description, "Finds pages by words.");
    // The key went in its header, never in a URL; control called no tool.
    assert.ok(
      fake.requests.every((r) => r.headers["x-brain-key"] === KEY && !r.path.includes("only")),
    );
    assert.equal(fake.calls.length, 0);
    // Nothing control keeps or says holds the key: it is sealed.
    assert.ok(!everything(store).includes("brainkeyforthetestsonly"));
    assert.ok(JSON.stringify(servers.list()).includes("…only"));
    assert.ok(!JSON.stringify(servers.list()).includes("brainkeyforthetestsonly"));
  });

  test("a wrong key says the server answered 401, without the key", async (t) => {
    const fake = await fakeOf(t, { kind: "bearer", token: "the-right-one-for-tests" });
    const { store, servers } = setup();
    servers.put({ name: "gbrain", url: fake.url, auth: "key", secret: KEY }, "owner:test");
    const why = await servers.check("gbrain");
    assert.match(why ?? "", /401: check the key/);
    assert.equal(servers.get("gbrain")?.status, "failing");
    assert.ok(!everything(store).includes("brainkeyforthetestsonly"));
  });

  test("no sign-in: a public server's tools are read with no header", async (t) => {
    const fake = await fakeOf(t, { kind: "none" });
    const { servers } = setup();
    servers.put({ name: "docs-search", url: fake.url, auth: "none" }, "owner:test");
    assert.equal(await servers.check("docs-search"), null);
    assert.equal(servers.get("docs-search")?.tools?.length, 3);
    assert.ok(fake.requests.every((r) => !r.headers.authorization));
  });

  test("a client ID and secret: control gets a token with them, and keeps it until it nearly ends", async (t) => {
    const fake = await fakeOf(t, { kind: "oauth" });
    fake.clients.set("thermite-control", CLIENT_SECRET);
    const { store, servers } = setup();
    servers.put(
      {
        name: "arxiv-tools",
        url: fake.url,
        auth: "client",
        client_id: "thermite-control",
        client_secret: CLIENT_SECRET,
      },
      "owner:test",
    );
    assert.equal(await servers.check("arxiv-tools"), null);
    assert.equal(servers.get("arxiv-tools")?.secret_hint, "…only");
    assert.deepEqual(fake.grants, ["client_credentials"]);
    // The token is kept: a second read asks for none.
    assert.equal(await servers.check("arxiv-tools"), null);
    assert.deepEqual(fake.grants, ["client_credentials"]);
    assert.ok(!everything(store).includes(CLIENT_SECRET));
    // A wrong secret: no token, and the reason, without the secret.
    servers.put(
      {
        name: "bad-client",
        url: fake.url,
        auth: "client",
        client_id: "thermite-control",
        client_secret: "notthesecretatall",
      },
      "owner:test",
    );
    assert.match((await servers.check("bad-client")) ?? "", /no token/);
    assert.ok(!everything(store).includes("notthesecretatall"));
  });

  test("OAuth: the client registers itself, the sign-in uses PKCE, and the sign-in renews itself", async (t) => {
    const fake = await fakeOf(t, { kind: "oauth" });
    const { store, servers } = setup();
    servers.put({ name: "notion", url: fake.url, auth: "oauth" }, "owner:test");
    assert.equal(servers.get("notion")?.status, "needs_sign_in");
    const redirect = "https://control.example.com/v1/mcp-oauth/callback";
    const { url } = await servers.startSignIn("notion", redirect, "owner:test");
    const page = new URL(url);
    assert.equal(page.origin, fake.origin);
    assert.equal(page.searchParams.get("code_challenge_method"), "S256");
    assert.equal(page.searchParams.get("redirect_uri"), redirect);
    assert.deepEqual(fake.registered[0]?.redirect_uris, [redirect]);
    const { state, code } = await allow(url);
    const done = await servers.finishSignIn(state, code);
    assert.equal(done.error, undefined);
    assert.equal(done.tools, 3);
    const s = servers.get("notion");
    assert.equal(s?.signed_in, true);
    assert.equal(s?.status, "ok");
    // A state is used once.
    assert.match((await servers.finishSignIn(state, code)).error ?? "", /not known, or was used/);
    // Near its end the access token is renewed with the refresh token, once.
    fake.expiresIn = 60;
    const again = await servers.startSignIn("notion", redirect, "owner:test");
    const second = await allow(again.url);
    assert.equal((await servers.finishSignIn(second.state, second.code)).error, undefined);
    const before = fake.grants.filter((g) => g === "refresh_token").length;
    const h = await servers.headers("notion");
    assert.ok("headers" in h && /^Bearer access-/.test(h.headers.Authorization ?? ""));
    assert.equal(fake.grants.filter((g) => g === "refresh_token").length, before + 1);
    // A refresh token the server ended: the server waits for a new sign-in, and says so.
    fake.expiresIn = 60;
    await servers.headers("notion");
    fake.refreshTokens.clear();
    const ended = await servers.headers("notion");
    assert.ok("error" in ended && /sign in again/.test(ended.error));
    assert.equal(servers.get("notion")?.status, "needs_sign_in");
    // No token, code or verifier is kept in the clear.
    const kept = everything(store);
    for (const tok of [...fake.accessTokens, code, second.code])
      assert.ok(!kept.includes(tok), tok);
  });

  test("OAuth without registration: the owner gives the client ID; without one control says what to do", async (t) => {
    const fake = await fakeOf(t, { kind: "oauth" });
    fake.dcr = false;
    const { servers } = setup();
    servers.put({ name: "own-client", url: fake.url, auth: "oauth" }, "owner:test");
    await assert.rejects(
      servers.startSignIn("own-client", "https://control.example.com/cb", "owner:test"),
      /does not register clients by itself/,
    );
    fake.clients.set("given-client", "");
    servers.put(
      { name: "own-client", url: fake.url, auth: "oauth", client_id: "given-client" },
      "owner:test",
    );
    const { url } = await servers.startSignIn(
      "own-client",
      "https://control.example.com/cb",
      "owner:test",
    );
    assert.equal(new URL(url).searchParams.get("client_id"), "given-client");
    const { state, code } = await allow(url);
    assert.equal((await servers.finishSignIn(state, code)).error, undefined);
  });

  test("addresses: https only (http for localhost), no secret in them; another address needs the secret again", () => {
    const { servers } = setup();
    const put = (url: string, secret?: string) =>
      servers.put({ name: "x", url, auth: "key", secret }, "owner:test");
    assert.throws(() => put("http://brain.example.com/mcp", KEY), /Use https/);
    assert.throws(
      () => put("https://brain.example.com/mcp?token=abc", KEY),
      /no secret in the URL/,
    );
    assert.throws(() => put("https://user:pw@brain.example.com/mcp", KEY), /no user, password/);
    assert.throws(
      () => servers.put({ name: "Bad_Name", url: "https://a.example.com", auth: "none" }, "o"),
      /lowercase/,
    );
    assert.equal(put("https://brain.example.com/mcp", KEY), "created");
    // The same server keeps its sealed key; another server needs it again.
    assert.equal(put("https://brain.example.com/other"), "changed");
    assert.equal(servers.get("x")?.secret_hint, "…only");
    assert.throws(() => put("https://elsewhere.example.com/mcp"), /needs the key again/);
  });

  test("a server a kit names can't be deleted; one no kit names can", () => {
    const { store, servers } = setup();
    servers.put(
      { name: "gbrain", url: "https://brain.example.com/mcp", auth: "none" },
      "owner:test",
    );
    servers.put(
      { name: "spare", url: "https://spare.example.com/mcp", auth: "none" },
      "owner:test",
    );
    store.campaigns.put({
      campaign: "q4-gemv",
      version: 1,
      contract: {
        campaign: "q4-gemv",
        mode: "hill_climb",
        project: { kit: { repo: "q4-gemv-kit" } },
      },
      sha: "a".repeat(64),
      sources: { mcp_servers: [{ name: "gbrain", agents: ["workers"] }] },
      by: "owner:test",
    });
    assert.deepEqual(servers.delete("gbrain", "owner:test"), { named_by: ["q4-gemv-kit"] });
    assert.equal(servers.delete("spare", "owner:test"), "deleted");
    assert.equal(servers.get("spare"), undefined);
  });
});

describe("a campaign whose kit names a server Settings lacks can't start", () => {
  const keys = generateSigningKeys();
  const contract = {
    schema_version: 1,
    campaign: "survey",
    version: 1,
    title: "t",
    mode: "research",
    project: { repo: "notes" },
    topic: "t",
    questions: ["q"],
    min_duration: "1h",
  };
  const assign = (store: ControlStore, payload: Record<string, unknown>) =>
    issueCommand(store, keys.privateKeyPem, {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: { run: "survey-1", contract_sha: "b".repeat(64), imports: [], ...payload },
      issuedBy: "owner:test",
    });

  test("refused with the server's name and what to do; started once Settings has it", () => {
    const { store, servers } = setup();
    enrollRigs(store, ["rig-a"]);
    assert.throws(
      () =>
        assign(store, { contract, mcp_servers: [{ name: "paper-search", agents: ["advisors"] }] }),
      /names the MCP server paper-search, and Settings has no server of that name/,
    );
    assert.equal(
      mcpRefusal(store, [{ name: "paper-search", agents: ["workers"] }]).length > 0,
      true,
    );
    servers.put(
      { name: "paper-search", url: "https://papers.example.com/mcp", auth: "none" },
      "owner:test",
    );
    assert.ok(
      assign(store, { contract, mcp_servers: [{ name: "paper-search", agents: ["advisors"] }] }).id,
    );
  });

  test("an agent's token may not name MCP servers in an assignment; the owner's may", () => {
    const { store, servers } = setup();
    enrollRigs(store, ["rig-a"]);
    servers.put(
      { name: "paper-search", url: "https://papers.example.com/mcp", auth: "none" },
      "owner:test",
    );
    const uses = [{ name: "paper-search", agents: ["advisors"] }];
    for (const payload of [
      { contract, mcp_servers: uses },
      // A research contract names them itself.
      { contract: { ...contract, mcp_servers: uses } },
    ])
      assert.throws(
        () =>
          issueCommand(store, keys.privateKeyPem, {
            rig: "rig-a",
            kind: "assign_campaign",
            payload: { run: "survey-2", contract_sha: "b".repeat(64), imports: [], ...payload },
            issuedBy: "agent:mcp",
            agent: true,
          }),
        /An agent's token may not name MCP servers in an assignment/,
      );
    assert.equal(store.commands.pending("rig-a").length, 0);
    assert.ok(assign(store, { contract, mcp_servers: uses }).id);
  });

  test("a research contract's servers go into its assignment, and a different list is refused", () => {
    const { store, servers } = setup();
    enrollRigs(store, ["rig-a"]);
    servers.put(
      { name: "gbrain", url: "https://brain.example.com/mcp", auth: "none" },
      "owner:test",
    );
    const named = {
      ...contract,
      mcp_servers: [{ name: "gbrain", agents: ["workers", "advisors"] }],
    };
    const { id } = assign(store, { contract: named });
    const signed = JSON.parse(
      String(
        (store.db.prepare("select signed from command where id = ?").get(id) as { signed: string })
          .signed,
      ),
    ) as { envelope: { payload: { mcp_servers: unknown } } };
    assert.deepEqual(signed.envelope.payload.mcp_servers, named.mcp_servers);
    assert.throws(
      () =>
        assign(store, { contract: named, mcp_servers: [{ name: "gbrain", agents: ["workers"] }] }),
      /Leave mcp_servers out/,
    );
  });
});

describe("what a rig gets", () => {
  async function api(t: TestContext, fake: FakeMcp) {
    const store = new ControlStore(":memory:");
    const secrets = SecretBox.ephemeral();
    const servers = new McpServers(store, secrets);
    const { control: app } = controlOnly({
      store,
      tokens: { rigs: { "rig-a": RIG_TOKEN, "rig-b": "rig-token-bbbbbb" } },
      options: { secrets, mcpServers: servers },
    });
    t.after(() => undefined);
    void fake;
    return { store, servers, app };
  }

  test("only the servers its runs' kits name, with their sign-in; what it gets is audited without it", async (t) => {
    const fake = await fakeOf(t, { kind: "header", header: "Authorization", value: KEY });
    const { store, servers } = await api(t, fake);
    servers.put({ name: "gbrain", url: fake.url, auth: "key", secret: KEY }, "owner:test");
    servers.put(
      { name: "github", url: "https://code.example.com/mcp", auth: "none" },
      "owner:test",
    );
    assigned(store, "rig-a", "pn-1", "pn", {
      mcp_servers: [
        { name: "gbrain", agents: ["workers", "advisors"] },
        { name: "gone", agents: ["planner"] },
      ],
    });
    // What control writes to the rig's config on the bus (bus/config.ts), audited as it writes.
    const ask = async (rig: string) => {
      const given = await servers.forRig(rig);
      servers.handed(rig, given);
      return given;
    };
    const r = await ask("rig-a");
    assert.deepEqual(
      r.servers.map((s) => [s.name, s.headers.Authorization, s.agents]),
      [["gbrain", KEY, ["workers", "advisors"]]],
    );
    assert.deepEqual(
      r.unavailable.map((u) => u.name),
      ["gone"],
    );
    // Another rig, whose runs name nothing, gets nothing.
    const b = await ask("rig-b");
    assert.deepEqual(b.servers, []);
    // Audited once for what changed, never with the key.
    await ask("rig-a");
    const audits = store.db
      .prepare("select body from audit where action = 'mcp_servers_handed'")
      .all() as { body: string }[];
    // rig-a's servers once; rig-b got none, which is what it had: nothing to audit.
    assert.equal(audits.length, 1);
    assert.deepEqual(JSON.parse(audits[0]?.body ?? "{}"), {
      servers: ["gbrain"],
      unavailable: ["gone"],
    });
    assert.ok(!everything(store).includes("brainkeyforthetestsonly"));
  });

  test("a rig keeps a server only while a live run names it: not once the run closed, nor for an assignment that failed", async (t) => {
    const fake = await fakeOf(t, { kind: "header", header: "Authorization", value: KEY });
    const store = controlStore();
    const servers = new McpServers(store, SecretBox.ephemeral());
    servers.put({ name: "gbrain", url: fake.url, auth: "key", secret: KEY }, "owner:test");
    const uses = { mcp_servers: [{ name: "gbrain", agents: ["workers"] }] };
    const given = async () => (await servers.forRig("rig-a")).servers.map((x) => x.name);
    assigned(store, "rig-a", "pn-1", "pn", uses);
    assert.deepEqual(await given(), ["gbrain"]);
    // The run closes: its rig no longer gets the server.
    await report(store, "rig-a", "ledger-a", [
      { kind: "run_created", subject: "pn-1", body: { campaign: "pn", mode: "goal" } },
      { kind: "run_status", subject: "pn-1", body: { status: "closed", reason: "done" } },
    ]);
    await applied(store);
    assert.deepEqual(await given(), []);
    // An assignment that failed gives nothing either.
    assigned(store, "rig-a", "pn-2", "pn", uses);
    assert.deepEqual(await given(), ["gbrain"]);
    store.db.prepare("update command set status = 'failed' where id = ?").run("cmd-rig-a-pn-2");
    assert.deepEqual(await given(), []);
  });

  test("the owner's REST routes and the settings page never show a secret", async (t) => {
    const fake = await fakeOf(t, { kind: "header", header: "Authorization", value: KEY });
    const { store, app } = await api(t, fake);
    const owner = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
    const added = await app.request("/v1/mcp-servers", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ name: "gbrain", url: fake.url, auth: "key", secret: KEY }),
    });
    assert.equal(added.status, 201);
    const body = await added.text();
    assert.ok(!body.includes("brainkeyforthetestsonly"));
    assert.match(body, /"status":"ok"/);
    const listed = await (await app.request("/v1/mcp-servers", { headers: owner })).text();
    assert.ok(listed.includes("…only") && !listed.includes("brainkeyforthetestsonly"));
    // A new key replaces the old one; the owner's token alone may do any of it.
    assert.equal(
      (await app.request("/v1/mcp-servers", { headers: { authorization: "Bearer nope" } })).status,
      401,
    );
    const changed = await app.request("/v1/mcp-servers/gbrain", {
      method: "PUT",
      headers: owner,
      body: JSON.stringify({ secret: "Bearer anotherkeyfortests" }),
    });
    assert.equal(changed.status, 200);
    assert.ok(!(await changed.text()).includes("anotherkeyfortests"));
    // The settings page shows the row, its tools and its hint, never the key.
    const page = await (await signIn(app)).page("/ui/settings");
    assert.match(page, /<h2>MCP servers<\/h2>/);
    assert.match(page, /data-mcp="gbrain"/);
    assert.match(page, /put_page/);
    assert.ok(!page.includes("anotherkeyfortests") && !page.includes("brainkeyforthetestsonly"));
    assert.ok(!everything(store).includes("anotherkeyfortests"));
    const deleted = await app.request("/v1/mcp-servers/gbrain", {
      method: "DELETE",
      headers: owner,
    });
    assert.equal(deleted.status, 200);
  });

  test("the OAuth callback finishes a sign-in and sends the tab back to Settings", async (t) => {
    const fake = await fakeOf(t, { kind: "oauth" });
    const { servers, app } = await api(t, fake);
    const owner = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
    // With no THERMITE_CONTROL_PUBLIC_URL, a request that names control by another address gets
    // no sign-in: the server is kept, and the answer says which setting to set.
    const named = (await (
      await app.request("http://control.example.com/v1/mcp-servers", {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ name: "notion", url: fake.url, auth: "oauth" }),
      })
    ).json()) as { sign_in_url?: string; error?: string };
    assert.equal(named.sign_in_url, undefined);
    assert.match(
      String(named.error),
      /set THERMITE_CONTROL_PUBLIC_URL to the address you reach control at/,
    );
    const again = await app.request("http://control.example.com/v1/mcp-servers/notion/sign-in", {
      method: "POST",
      headers: owner,
    });
    assert.equal(again.status, 409);
    // Reached on control's own machine, the browser comes back there.
    const added = (await (
      await app.request("http://127.0.0.1:8800/v1/mcp-servers/notion/sign-in", {
        method: "POST",
        headers: owner,
      })
    ).json()) as { url: string };
    const signInUrl = added.url;
    assert.equal(
      new URL(signInUrl).searchParams.get("redirect_uri"),
      "http://127.0.0.1:8800/v1/mcp-oauth/callback",
    );
    const { state, code } = await allow(signInUrl);
    const back = await app.request(`/v1/mcp-oauth/callback?state=${state}&code=${code}`);
    assert.equal(back.status, 303);
    assert.match(
      decodeURIComponent(back.headers.get("location") ?? ""),
      /Signed in to notion.*read 3 tools/,
    );
    assert.equal(servers.get("notion")?.status, "ok");
    // A made-up state is refused.
    const forged = await app.request(`/v1/mcp-oauth/callback?state=made-up&code=${code}`);
    const to = forged.headers.get("location") ?? "";
    assert.match(to, /error=note-[0-9a-f]+&at=mcp/);
    assert.match(await (await signIn(app)).page(to), /not known/);
  });
});

describe("the update from goal 065's outside knowledge base", () => {
  test("it becomes a server with a key, its token kept; copies and the advisors' grants end", () => {
    const store = new ControlStore(":memory:");
    const secrets = SecretBox.ephemeral();
    store.kb();
    store.db.exec(`create table outside_kb (name text primary key, mcp_url text not null, token_sealed text not null,
      token_hint text not null, search_tool text not null, write_tool text, tools text, checked_at text,
      check_error text, created_at text not null, created_by text not null, updated_at text not null);
      create table outside_kb_copy (kb text not null, campaign text not null, enabled_by text not null,
      enabled_at text not null, cursor integer not null default 0, written integer not null default 0,
      primary key (kb, campaign));`);
    const token = "outsidetokenkeptforthetests";
    store.db
      .prepare(
        "insert into outside_kb values ('team.brain', 'https://brain.example.com/mcp', ?, '…ests', 'search', 'put_page', '[\"search\",\"put_page\"]', '2026-10-19T00:00:00Z', null, '2026-10-01T00:00:00Z', 'owner:ui', '2026-10-01T00:00:00Z')",
      )
      .run(secrets.seal(token));
    store.db
      .prepare(
        "insert into outside_kb_copy (kb, campaign, enabled_by, enabled_at) values ('team.brain', 'pn', 'owner:ui', 'x')",
      )
      .run();
    store.kb().grant("pn", "outside:team.brain", "owner:ui");
    store.kb().grant("pn", "other", "owner:ui");
    const servers = new McpServers(store, secrets);
    const s = servers.get("team-brain");
    assert.equal(s?.auth, "key");
    assert.equal(s?.header, "Authorization");
    assert.equal(s?.migrated_from, "outside_kb");
    assert.deepEqual(
      s?.tools?.map((x) => x.name),
      ["search", "put_page"],
    );
    // The token is kept, as a bearer key.
    return servers.headers("team-brain").then((h) => {
      assert.ok("headers" in h);
      assert.equal(h.headers.Authorization, `Bearer ${token}`);
      // Copies stop, the advisors' grant goes, other grants stay; the audit says so.
      const tables = store.db
        .prepare("select name from sqlite_master where name like 'outside_kb%'")
        .all();
      assert.deepEqual(tables, []);
      assert.deepEqual(store.kb().reads("pn"), ["other"]);
      const audit = store.auditLog.last("control", "outside_kb_migrated") as Record<
        string,
        unknown
      >;
      assert.deepEqual(audit, {
        outside_kb: "team.brain",
        mcp_server: "team-brain",
        token: "kept",
        copies_stopped: ["pn"],
        grants_removed: ["pn"],
      });
      assert.ok(!everything(store).includes(token));
      // A second start finds nothing to move.
      new McpServers(store, secrets);
      assert.equal(servers.list().length, 1);
    });
  });
});

describe("control's log lines", () => {
  test("a failing server, a refused page and a rig's share are logged and audited without a secret", async (t) => {
    const fake = await fakeOf(t, { kind: "bearer", token: "not-the-key-given" });
    const store = new ControlStore(":memory:");
    const secrets = SecretBox.ephemeral();
    const servers = new McpServers(store, secrets);
    const { control: app } = controlOnly({
      store,
      tokens: { rigs: { "rig-a": RIG_TOKEN } },
      options: { secrets, mcpServers: servers },
    });
    {
      const owner = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
      await app.request("/v1/mcp-servers", {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ name: "gbrain", url: fake.url, auth: "key", secret: KEY }),
      });
      await app.request("/v1/mcp-servers/gbrain/check", { method: "POST", headers: owner });
      // The page's Read tools again is refused, and control logs why.
      const ui = await signIn(app);
      const csrf = ui.csrfOf(await ui.page("/ui/settings"));
      await ui.post("/ui/settings/mcp/gbrain/check", { csrf });
      assigned(store, "rig-a", "pn-1", "pn", {
        mcp_servers: [{ name: "gbrain", agents: ["workers"] }],
      });
      servers.handed("rig-a", await servers.forRig("rig-a"));
    }
    // Control logs a refused page with the same words it writes to its audit (api.ts): the
    // reason is there (the server answered 401), the key is not.
    const refused = store.auditLog.last("owner:ui", "refused") as { why?: string } | undefined;
    assert.match(refused?.why ?? "", /401/);
    assert.ok(!everything(store).includes("brainkeyforthetestsonly"));
  });
});

describe("MCP servers over control's own MCP", () => {
  test("the owner adds, lists and deletes one; the audit holds the secret's last four characters only", async (t) => {
    const fake = await fakeOf(t, { kind: "header", header: "Authorization", value: KEY });
    const { store, control } = controlOnly({
      tokens: { operator: "operator-token-abcdef", rigs: {} },
      options: { secrets: SecretBox.ephemeral() },
    });
    const owner = await mcpClient(control);
    const added = await owner.callTool({
      name: "mcp_server_add",
      arguments: { name: "gbrain", url: fake.url, auth: "key", secret: KEY },
    });
    const said = JSON.stringify(added);
    assert.match(said, /\\"status\\": \\"ok\\"/);
    assert.ok(!said.includes("brainkeyforthetestsonly"));
    const listed = JSON.stringify(await owner.callTool({ name: "mcp_servers", arguments: {} }));
    assert.match(listed, /put_page/);
    // An operator may list them, never add one.
    const operator = await mcpClient(control, "operator-token-abcdef");
    const tools = (await operator.listTools()).tools.map((x) => x.name);
    assert.ok(tools.includes("mcp_servers") && !tools.includes("mcp_server_add"));
    const gone = await owner.callTool({ name: "mcp_server_delete", arguments: { name: "gbrain" } });
    assert.match(JSON.stringify(gone), /deleted/);
    assert.ok(!everything(store).includes("brainkeyforthetestsonly"));
    assert.match(everything(store), /given \(…only\)/);
  });
  test("a sign-in's calls go only to addresses an MCP server's may be, each answer within its limit", async () => {
    const asked: string[] = [];
    let signal: AbortSignal | undefined;
    const answers: Record<string, () => Response> = {
      "https://auth.example.com/token": () => Response.json({ access_token: "a" }),
      "https://auth.example.com/huge": () =>
        new Response("x".repeat(SIGN_IN_ANSWER_MAX + 1), {
          headers: { "content-length": String(SIGN_IN_ANSWER_MAX + 1) },
        }),
      // Streamed, with no length given.
      "https://auth.example.com/stream": () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(SIGN_IN_ANSWER_MAX / 2));
              c.close();
            },
          }),
        ),
    };
    const call = signInFetch(async (input, init) => {
      asked.push(String(input));
      signal = init?.signal ?? undefined;
      return (answers[String(input)] ?? (() => new Response("no", { status: 404 })))();
    });
    const ok = await call("https://auth.example.com/token", { method: "POST" });
    assert.ok(ok instanceof Response);
    assert.deepEqual(await ok.json(), { access_token: "a" });
    assert.ok(signal && !signal.aborted, "each call has a time limit");
    await assert.rejects(
      call("http://auth.example.com/token"),
      /^Error: the sign-in leads to http:\/\/auth\.example\.com, which control does not call: Use https\./,
    );
    await assert.rejects(call("https://auth.example.com/token?api_key=x"), /no secret in the URL/);
    assert.equal(asked.length, 1, "a refused address is never called");
    for (const path of ["huge", "stream"])
      await assert.rejects(
        call(`https://auth.example.com/${path}`),
        new RegExp(
          `https://auth\\.example\\.com answered with more than ${SIGN_IN_ANSWER_MAX} bytes`,
        ),
      );
  });
});
