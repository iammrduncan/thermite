import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { mcpUrlProblem } from "../../../../src/common/mcp-client.ts";
import { KitRepos } from "../../../../src/control/kits/repos.ts";
import { McpServers } from "../../../../src/control/mcp-servers/index.ts";
import { SecretBox } from "../../../../src/control/secrets.ts";
import {
  KIT_MCP_CORE_JS,
  NEW_CAMPAIGN_JS,
} from "../../../../src/control/ui/campaigns/new/client.ts";
import { MCP_URL_CHECK_JS, PROVIDERS_JS } from "../../../../src/control/ui/providers/client.ts";
import { controlStack, signIn } from "../../../helpers/control-stack.ts";
import { startFakeMcp } from "../../../helpers/fake-mcp.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

/** A made-up key: the pages may show its last four characters, never more. */
const KEY = "Bearer pagekeyforthetestsonly";
const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const KIT_C = "1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e";

/** Control with kits and a CPU rig that reported its hardware, signed in; a fake MCP server. */
async function stack(t: TestContext, o: { kitJson?: unknown } = {}) {
  const fake = await startFakeMcp({ kind: "bearer", token: KEY.slice(7) });
  t.after(() => fake.close());
  const secrets = SecretBox.ephemeral();
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  let servers: McpServers | undefined;
  const { env, store, control, relay } = controlStack({
    env: makeJudgeEnv({ promotion: "auto" }),
    // Control's own MCP servers, which the tests also hold.
    options: (store) => {
      servers = new McpServers(store, secrets);
      return {
        mcpServers: servers,
        kits,
        secrets,
        publicUrl: "https://control.example.com",
        probeRepo: async () => ({ commit: C, files: 10, suggest: ["src/**"] }),
        readKit: async (url, commit) => {
          if (url.includes("broken"))
            throw new Error("the kit's commit has no kit.json at its top");
          return o.kitJson ?? { name: "q4-gemv-kit", commit, mcp_servers: [] };
        },
      };
    },
  });
  env.service.hardware = {
    collected_at: new Date().toISOString(),
    target: { type: "cpu", class: "generic-cpu", id: "cpu-a" },
    device_mode: "none",
    devices: [],
    cpu: { model: "Example CPU", host: 8, usable: 8, quota: null },
    memory: { host_mib: 16_000, limit_mib: null },
    disks: [],
    os: { kernel: "6.8", arch: "x64", node: "v22", image: null },
    toolchain: { cc: "cc 12", nvcc: null },
    errors: [],
  };
  await relay();
  const session = await signIn(control);
  const { get, page } = session;
  const csrf = session.csrfOf(await page("/ui/settings"));
  const post = (path: string, form: Record<string, string>) =>
    session.post(path, { csrf, ...form });
  return { fake, store, servers: servers as McpServers, kits, control, get, page, post };
}

/** The part of a page from one marker to the next, to look at one block alone. */
const between = (html: string, from: string, to: string) => {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a + from.length);
  assert.ok(a >= 0, `no ${from}`);
  return html.slice(a, b < 0 ? undefined : b);
};

/** Every label in a piece of a page has an info icon with its description. */
function everyLabelExplained(html: string) {
  const labels = html.match(/<label[^>]*>[\s\S]*?<\/label>/g) ?? [];
  assert.ok(labels.length > 0);
  for (const l of labels) {
    // The agents' chips are tick boxes whose words are their own label (their title says more).
    if (/data-who=/.test(l)) continue;
    assert.match(l, /class="ii" tabindex="0" data-tip="[^"]+"/, l.slice(0, 200));
  }
}

describe("Settings › MCP servers", () => {
  test("added with a key: kept, read, shown with its tools and its last four characters only", async (t) => {
    const s = await stack(t);
    const empty = await s.page("/ui/settings");
    const block = between(
      empty,
      '<div class="block" id="mcp">',
      '<div class="block"><div class="head"><h2>Harness',
    );
    assert.match(block, /No MCP server yet/);
    assert.match(block, /<h2>Add an MCP server<\/h2>/);
    everyLabelExplained(between(block, 'id="mcp-add"', "</form>"));
    const added = await s.post("/ui/settings/mcp", {
      name: "gbrain",
      url: s.fake.url,
      auth: "key",
      header: "Authorization",
      secret: KEY,
    });
    assert.equal(added.status, 303);
    const to = added.headers.get("location") ?? "";
    assert.match(
      decodeURIComponent(to),
      /gbrain is kept, sealed\. Control read 3 tools, and called none of them/,
    );
    const html = await s.page(to);
    const row = between(html, 'data-mcp="gbrain"', "</details>");
    assert.match(row, /Connected · 3 tools/);
    assert.match(row, /Authorization · key …only/);
    assert.match(row, /no kit names it/);
    assert.match(row, /put_page[\s\S]*?writes/);
    assert.match(row, /search[\s\S]*?reads/);
    everyLabelExplained(between(row, 'class="form-grid"', "</form>"));
    assert.ok(!html.includes("pagekeyforthetests"));
    // The note is said in the block, not at the top of the page.
    assert.ok(html.indexOf("Control read 3 tools") > html.indexOf('id="mcp"'));
    // Read tools again; then a failing server says why, and the rows say which kits name it.
    s.fake.down = true;
    const again = await s.post("/ui/settings/mcp/gbrain/check", {});
    assert.match(await s.page(again.headers.get("location") ?? ""), /can't read its tools/);
    s.store.campaigns.put({
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
    const failing = await s.page("/ui/settings");
    const bad = between(failing, 'data-mcp="gbrain"', "</details>");
    assert.match(failing, /<details class="dq dq-bad" data-mcp="gbrain"/);
    assert.match(bad, /named by q4-gemv-kit/);
    assert.match(bad, /Runs that use that kit go on without its tools until it works again/);
    assert.match(bad, /Take it out of that kit first/);
    const refused = await s.post("/ui/settings/mcp/gbrain/delete", {});
    assert.match(decodeURIComponent(refused.headers.get("location") ?? ""), /q4-gemv-kit name it/);
  });

  test("OAuth: kept, then a sign-in link opens the server's page; the tab comes back signed in", async (t) => {
    const s = await stack(t);
    s.fake.auth = { kind: "oauth" };
    const added = await s.post("/ui/settings/mcp", {
      name: "notion",
      url: s.fake.url,
      auth: "oauth",
    });
    const to = added.headers.get("location") ?? "";
    assert.match(to, /signin=notion/);
    const html = await s.page(to);
    assert.match(html, /Now sign in to notion\./);
    assert.match(html, /href="\/ui\/settings\/mcp\/notion\/sign-in" target="_blank"/);
    const signIn = await s.get("/ui/settings/mcp/notion/sign-in");
    assert.equal(signIn.status, 302);
    const page = new URL(signIn.headers.get("location") ?? "");
    assert.equal(page.origin, s.fake.origin);
    assert.equal(
      page.searchParams.get("redirect_uri"),
      "https://control.example.com/v1/mcp-oauth/callback",
    );
    const allowed = await fetch(page.href, { redirect: "manual" });
    const back = new URL(allowed.headers.get("location") ?? "");
    const done = await s.control.request(`/v1/mcp-oauth/callback${back.search}`);
    assert.match(decodeURIComponent(done.headers.get("location") ?? ""), /Signed in to notion/);
    const row = between(await s.page("/ui/settings"), 'data-mcp="notion"', "</details>");
    assert.match(row, /signed in · the sign-in renews itself/);
    assert.match(row, /Sign in again with another account/);
  });

  test("an outside knowledge base kept at the update is told once, until Got it", async (t) => {
    const s = await stack(t);
    s.store.db
      .prepare(
        "insert into mcp_server (name, url, auth, header, status, migrated_from, created_at, created_by, updated_at) values ('gbrain', 'https://brain.example.com/mcp', 'key', 'Authorization', 'unchecked', 'outside_kb', 'x', 'control', 'x')",
      )
      .run();
    const html = await s.page("/ui/settings");
    assert.match(html, /The outside knowledge base is now an MCP server/);
    assert.match(html, /Moved here from the outside knowledge base at the update to 0\.1\.0/);
    await s.post("/ui/settings/mcp-moved", {});
    assert.ok(!(await s.page("/ui/settings")).includes("is now an MCP server"));
  });

  test("the add form's script shows each kind's fields and says what is wrong before sending", () => {
    for (const piece of [
      "data-auth",
      "Paste the key's value.",
      "Fill in the client ID and its secret.",
      "Use https.",
      "Put no secret in the URL.",
      "/sign-in",
    ])
      assert.ok(PROVIDERS_JS.includes(piece), piece);
    assert.doesNotThrow(() => new Function(PROVIDERS_JS));
  });

  test("the form's URL check takes the local addresses control takes, [::1] too (goal 161)", () => {
    const check = new Function(`return ${MCP_URL_CHECK_JS}`)() as (u: string) => string | null;
    for (const url of [
      "http://localhost:8000/mcp",
      "http://127.0.0.1/mcp",
      "http://[::1]:8000/mcp",
      "https://mcp.example.com/x",
      "http://mcp.example.com/x",
      "http://localhost.example.com/x",
      "https://mcp.example.com/x?api_key=1",
    ])
      assert.equal(check(url) === null, mcpUrlProblem(url) === null, url);
    assert.equal(check("http://[::1]:8000/mcp"), null);
    assert.match(check("http://mcp.example.com/x") ?? "", /^Use https\./);
  });
});

describe("New campaign › MCP servers for the agents", () => {
  test("each server of Settings, its agents, and an Advanced part with a tick per tool and kind", async (t) => {
    const s = await stack(t);
    s.servers.put({ name: "gbrain", url: s.fake.url, auth: "key", secret: KEY }, "owner:test");
    assert.equal(await s.servers.check("gbrain"), null);
    const html = await s.page("/ui/campaigns/new");
    for (const prefix of ["k", "r"]) {
      const block = between(html, `id="${prefix}-mcp"`, "How the agents reach them");
      assert.match(block, /<h2>MCP servers for the agents<\/h2>/);
      assert.match(block, /data-srv="gbrain" data-tools="3"/);
      assert.match(block, /data-who="workers"[\s\S]*data-who="planner"[\s\S]*data-who="advisors"/);
      assert.match(
        block,
        /<details class="adv mcp-adv"[^>]*><summary>Advanced: its tools for each kind of agent/,
      );
      assert.match(
        block,
        /<tr data-tool="put_page">[\s\S]*?writes[\s\S]*?data-tool-who="workers" checked/,
      );
      assert.match(block, /Servers<i class="ii" tabindex="0" data-tip=/);
      assert.match(block, /Tools<i class="ii" tabindex="0" data-tip=/);
      assert.ok(!block.includes("pagekeyforthetests"));
    }
    assert.match(html, /What goes into kit\.json/);
    assert.match(html, /What goes into the campaign/);
    assert.doesNotThrow(() => new Function(NEW_CAMPAIGN_JS));
    for (const piece of [
      "mcp_servers",
      "data-tool-who",
      "is not in Settings: this campaign can't start",
      "/ui/campaigns/new/kit-repo",
    ])
      assert.ok(NEW_CAMPAIGN_JS.includes(piece), piece);
  });

  test("a kit described here gets them in kit.json, narrowed tools only where narrowed; the run names them", async (t) => {
    const s = await stack(t);
    s.servers.put({ name: "gbrain", url: s.fake.url, auth: "key", secret: KEY }, "owner:test");
    const uses = [
      { name: "gbrain", agents: ["workers", "planner"], tools: { planner: ["search"] } },
    ];
    const res = await s.post("/ui/campaigns/new", {
      draft: JSON.stringify(draftWith(uses)),
      rig: "rig-a",
      start_value: "start",
    });
    assert.equal(res.status, 303, await res.text());
    const kitJson = JSON.parse(
      execFileSync("git", ["--git-dir", s.kits.path("matmul-speed-kit"), "show", "HEAD:kit.json"], {
        encoding: "utf8",
      }),
    ) as { mcp_servers: unknown };
    assert.deepEqual(kitJson.mcp_servers, uses);
    assert.deepEqual(s.store.campaigns.versions("matmul-speed")[0]?.sources.mcp_servers, uses);
    const cmd = s.store.db
      .prepare("select signed from command where kind = 'assign_campaign'")
      .get() as { signed: string };
    assert.deepEqual(JSON.parse(cmd.signed).envelope.payload.mcp_servers, uses);
  });

  test("a server Settings lacks stops the start, with what to do", async (t) => {
    const s = await stack(t);
    const res = await s.post("/ui/campaigns/new", {
      draft: JSON.stringify(draftWith([{ name: "paper-search", agents: ["advisors"] }])),
      rig: "rig-a",
      start_value: "start",
    });
    assert.equal(res.status, 200);
    assert.match(
      await res.text(),
      /The kit names the MCP server paper-search, and Settings has no server of that name\. Add an MCP server named paper-search in Settings › Providers, or take it out of the kit\./,
    );
  });

  test("a kit in a repository: control reads the servers its kit.json names", async (t) => {
    const s = await stack(t, {
      kitJson: { name: "q4-gemv-kit", mcp_servers: [{ name: "gbrain", agents: ["workers"] }] },
    });
    const ok = await s.post("/ui/campaigns/new/kit-repo", {
      url: "https://git.example.com/kits/q4.git",
      commit: KIT_C,
    });
    assert.deepEqual(await ok.json(), {
      name: "q4-gemv-kit",
      mcp_servers: [{ name: "gbrain", agents: ["workers"] }],
    });
    const broken = await s.post("/ui/campaigns/new/kit-repo", {
      url: "https://git.example.com/kits/broken.git",
      commit: KIT_C,
    });
    assert.equal(broken.status, 400);
    assert.match(((await broken.json()) as { error: string }).error, /no kit\.json/);
  });

  test("an uploaded kit keeps the servers and tool limits the page can't show", () => {
    type Use = { name: string; agents: string[]; tools?: Record<string, string[]> };
    /** The page-free part, exactly as the browser runs it. */
    const keep = new Function(`${KIT_MCP_CORE_JS}; return keepKitMcp;`)() as (
      ticked: Use[],
      own: Use[],
      known: string[],
      listed: string[],
    ) => Use[];
    const own: Use[] = [
      { name: "gbrain", agents: ["workers", "planner"], tools: { planner: ["search"] } },
      { name: "paper-search", agents: ["advisors"] },
      { name: "github", agents: ["workers"], tools: { workers: ["get_issue"] } },
    ];
    // Settings has gbrain, whose tools it never read, and github, whose tools it read; not
    // paper-search. The page ticks what Settings has, as the kit names them.
    const ticked: Use[] = [
      { name: "gbrain", agents: ["workers", "planner"] },
      { name: "github", agents: ["workers"], tools: { workers: ["get_issue", "list_issues"] } },
    ];
    assert.deepEqual(keep(ticked, own, ["gbrain", "github"], ["github"]), [
      // No tool to tick on the page: the kit's limit stays.
      { name: "gbrain", agents: ["workers", "planner"], tools: { planner: ["search"] } },
      // Its tools are on the page: what the owner ticked there goes.
      { name: "github", agents: ["workers"], tools: { workers: ["get_issue", "list_issues"] } },
      // Not in Settings: kept, and the page says so.
      { name: "paper-search", agents: ["advisors"] },
    ]);
    // A server the owner unticked goes; an agent the owner unticked takes its limit with it.
    assert.deepEqual(
      keep([{ name: "gbrain", agents: ["workers"] }], own, ["gbrain", "github"], ["github"]),
      [
        { name: "gbrain", agents: ["workers"] },
        { name: "paper-search", agents: ["advisors"] },
      ],
    );
    // The page's script runs it for an uploaded kit, and says what a missing server needs.
    assert.ok(NEW_CAMPAIGN_JS.includes(KIT_MCP_CORE_JS));
    assert.match(NEW_CAMPAIGN_JS, /return keepKitMcp\(list, kitOwn,/);
    assert.match(
      NEW_CAMPAIGN_JS,
      /The uploaded kit names it: add it in Settings, or upload the kit without it\./,
    );
    assert.doesNotThrow(() => new Function(NEW_CAMPAIGN_JS));
  });
});

/** A campaign described on the page, with these MCP servers. */
function draftWith(mcp_servers: unknown[]) {
  return {
    mode: "hill_climb",
    campaign: "matmul-speed",
    title: "Make the matrix multiply faster",
    project: {
      url: "https://git.example.com/team/fastmat.git",
      ref: "main",
      repo: "fastmat",
      editable_paths: ["src/kernels/**"],
    },
    kit: {
      source: "here",
      build: "make bench",
      outputs: ["bench"],
      cases: [{ name: "small", params: { n: 64 }, work: 524288 }],
      run: "{build}/bench --n {n} --out {out}/result.txt",
      check: "test -s {out}/result.txt",
    },
    score: { name: "throughput", unit: "FLOP/s", direction: "max", min_effect: 0.05 },
    lanes: 2,
    mcp_servers,
  };
}
