import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { serve } from "@hono/node-server";
import type { ControlTokens } from "../../src/control/api/context.ts";
import type { ControlOptions } from "../../src/control/api/index.ts";
import { startCampaign } from "../../src/control/campaigns/new.ts";
import { cancelCommand } from "../../src/control/issue/index.ts";
import { KitRepos } from "../../src/control/kits/repos.ts";
import { SecretBox } from "../../src/control/secrets.ts";
import { stageCommand } from "../../src/supervisor/staging.ts";
import { controlOnly, mcpClient, signIn } from "../helpers/control-stack.ts";

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";

async function control(extra: Partial<ControlOptions> = {}, tokens: Partial<ControlTokens> = {}) {
  const secrets = SecretBox.ephemeral();
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const {
    keys,
    store,
    control: api,
  } = controlOnly({
    tokens: { rigs: { "rig-a": "rig-token-aaaaaa", "rig-b": "rig-token-bbbbbb" }, ...tokens },
    options: { kits, secrets, ...extra },
  });
  const { page, csrfOf, post: send } = await signIn(api);
  const csrf = csrfOf(await page("/ui/settings"));
  const post = (path: string, form: Record<string, string>) => send(path, { csrf, ...form });
  return { keys, store, secrets, kits, api, page, post };
}

const draftOf = (access: string, url = "https://git.example.com/team/private.git") => ({
  mode: "hill_climb",
  campaign: "private-speed",
  title: "A private project",
  project: {
    url,
    access,
    commit: C,
    repo: "private",
    editable_paths: ["src/**"],
  },
  kit: {
    source: "here",
    build: "make",
    outputs: ["bench"],
    cases: [{ name: "small", params: { n: 1 }, work: 1 }],
    run: "{build}/bench {n} > {out}/r",
    check: "test -s {out}/r",
  },
});

describe("Git access for private repositories", () => {
  test("a deploy key is made in Settings: its public half shown, its private half never", async () => {
    const s = await control();
    // Each access is for one host, named when it is made.
    const hostless = await s.post("/ui/settings/git", { name: "github-deploy", kind: "ssh" });
    assert.match(decodeURIComponent(String(hostless.headers.get("location"))), /Name the host/);
    assert.equal(s.store.gitAccess.get("github-deploy"), undefined);
    const made = await s.post("/ui/settings/git", {
      name: "github-deploy",
      kind: "ssh",
      host: "GitHub.com",
    });
    assert.equal(made.status, 303);
    const settings = await s.page("/ui/settings");
    assert.match(settings, /for github\.com only/);
    const g = s.store.gitAccess.get("github-deploy");
    assert.equal(g?.host, "github.com");
    assert.ok(g?.public_key && settings.includes(g.public_key));
    assert.ok(!settings.includes("PRIVATE KEY"));
    assert.match(s.secrets.open(g.secret_sealed), /^-----BEGIN OPENSSH [A-Z]+ KEY-----\n/);
    // A token: sealed, shown only by its hint; a name is used once.
    await s.post("/ui/settings/git", {
      name: "gitlab-token",
      kind: "token",
      token: "glpat-secret-value-1234",
      username: "oauth2",
      host: "gitlab.example.com",
    });
    const page = await s.page("/ui/settings");
    assert.ok(!page.includes("glpat-secret-value-1234"));
    assert.match(page, /token …1234 · user oauth2/);
    const again = await s.post("/ui/settings/git", {
      name: "gitlab-token",
      kind: "token",
      token: "x",
      host: "gitlab.example.com",
    });
    assert.match(String(again.headers.get("location")), /exists/);
    // The new-campaign page offers both.
    assert.match(
      await s.page("/ui/campaigns/new"),
      /<option value="github-deploy">github-deploy · SSH deploy key<\/option>/,
    );
    await s.post("/ui/settings/git/gitlab-token/delete", {});
    assert.equal(s.store.gitAccess.get("gitlab-token"), undefined);
  });

  test("Providers lists models and Git access together, one form adds either, and access can be tried", async () => {
    const tried: string[] = [];
    const s = await control({
      probeRepo: async (url, _ref, access) => {
        tried.push(`${url} ${access?.auth.kind}`);
        if (url.includes("nope")) throw new Error("the host refused the key");
        return { commit: C, files: 12, suggest: [] };
      },
      providerFetch: async () => Response.json({ data: [{ id: "model-a" }] }),
    });
    const where = (r: Response) => decodeURIComponent(String(r.headers.get("location")));
    assert.match(
      where(
        await s.post("/ui/settings/add", {
          type: "gitkey",
          name: "github-deploy",
          host: "git.example.com",
        }),
      ),
      /Made the deploy key "github-deploy"/,
    );
    await s.post("/ui/settings/add", {
      type: "gittoken",
      name: "gitlab-token",
      token: "glpat-secret-value-1234",
      username: "oauth2",
      host: "git.example.com",
    });
    await s.post("/ui/settings/add", {
      type: "openai",
      name: "lab-models",
      base_url: "https://models.example.com/v1",
      api_key: "sk-model-key-9876",
    });
    assert.equal(s.store.gitAccess.get("gitlab-token")?.kind, "token");
    assert.deepEqual(
      s.store.modelProviders.get("lab-models")?.models.map((m) => m.id),
      ["model-a"],
    );
    const page = await s.page("/ui/settings");
    assert.match(page, /<title>Providers · Thermite<\/title>/);
    assert.equal(page.match(/class="kind m">Models</g)?.length, 1);
    assert.equal(page.match(/class="kind g">Git access</g)?.length, 2);
    assert.match(page, /<script src="\/ui\/assets\/providers.js" defer><\/script>/);
    assert.ok(!page.includes("glpat-secret-value-1234") && !page.includes("sk-model-key-9876"));
    // Every label on the page says what it is for.
    const labels = page.match(/class="lb"/g)?.length ?? 0;
    const tips = page.match(/class="ii" tabindex="0" data-tip="[^"]+"/g)?.length ?? 0;
    assert.ok(labels > 8 && tips === labels, `${labels} labels, ${tips} with descriptions`);
    const script = await (await s.api.request("/ui/assets/providers.js")).text();
    assert.doesNotThrow(() => new Function(script));
    // Trying it on a repository says what it found, or why not.
    assert.match(
      where(
        await s.post("/ui/settings/git/github-deploy/test", {
          url: "git@git.example.com:team/private.git",
        }),
      ),
      /reads git@git.example.com:team\/private.git: its default branch is at 9a41c07, with 12 files/,
    );
    assert.match(
      await s.page(
        where(
          await s.post("/ui/settings/git/github-deploy/test", {
            url: "git@git.example.com:team/nope.git",
          }),
        ),
      ),
      /could not read git@git.example.com:team\/nope.git: the host refused the key/,
    );
    // A repository on another host is not tried with it.
    assert.match(
      await s.page(
        where(
          await s.post("/ui/settings/git/github-deploy/test", {
            url: "git@elsewhere.example.net:team/private.git",
          }),
        ),
      ),
      /is for git\.example\.com only, and git@elsewhere\.example\.net:team\/private\.git is on elsewhere\.example\.net/,
    );
    assert.deepEqual(tried, [
      "git@git.example.com:team/private.git ssh",
      "git@git.example.com:team/nope.git ssh",
    ]);
    // A token is replaced under the same name.
    await s.post("/ui/settings/git/gitlab-token/token", { token: "glpat-new-value-5678" });
    const g = s.store.gitAccess.get("gitlab-token");
    assert.equal(g && s.secrets.open(g.secret_sealed), "glpat-new-value-5678");
    assert.match(await s.page("/ui/settings"), /token …5678 · user oauth2/);
    // Access a campaign fetches with can't be deleted.
    const saved = await startCampaign(
      { store: s.store, kits: s.kits, privateKeyPem: s.keys.privateKeyPem },
      {
        draft: draftOf("gitlab-token"),
        rig: "rig-a",
        target: { type: "cpu", class: "generic-cpu" },
        start: false,
        by: "owner:ui",
      },
    );
    assert.ok(saved.ok, JSON.stringify(!saved.ok && saved.errors));
    assert.deepEqual(s.store.campaigns.usingGitAccess("gitlab-token"), ["private-speed"]);
    assert.match(
      where(await s.post("/ui/settings/git/gitlab-token/delete", {})),
      /"gitlab-token" is used by private-speed/,
    );
    assert.ok(s.store.gitAccess.get("gitlab-token"));
    assert.match(await s.page("/ui/settings"), /In use by private-speed/);
  });

  test("a rig gets Git access only while a live assignment of it names it, and only for its host", async () => {
    const s = await control();
    await s.post("/ui/settings/git", {
      name: "gitlab-token",
      kind: "token",
      token: "glpat-secret-value-1234",
      username: "oauth2",
      host: "git.example.com",
    });
    const ask = (rig: string, token: string) =>
      s.api.request(`/v1/rigs/${rig}/git-access/gitlab-token`, {
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await ask("rig-a", "rig-token-aaaaaa")).status, 404);
    s.store.enrollments.setConfiguredRigs(["rig-a", "rig-b"]);
    const start = (draft: ReturnType<typeof draftOf>, rig = "rig-a") =>
      startCampaign(
        { store: s.store, kits: s.kits, privateKeyPem: s.keys.privateKeyPem },
        { draft, rig, target: { type: "cpu", class: "generic-cpu" }, start: true, by: "owner:ui" },
      );
    // A repository on another host is refused before anything is signed.
    await assert.rejects(
      start(draftOf("gitlab-token", "https://elsewhere.example.net/team/private.git")),
      /The Git access gitlab-token is for git\.example\.com only, and [^ ]+ comes from elsewhere\.example\.net/,
    );
    assert.equal(s.store.commands.pending("rig-a").length, 0);
    const r = await start(draftOf("gitlab-token"));
    assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
    // The signed command names the access, never its secret.
    const signed = s.store.db.prepare("select id, signed from command").get() as {
      id: string;
      signed: string;
    };
    assert.ok(
      signed.signed.includes('"access":"gitlab-token"') && !signed.signed.includes("glpat-secret"),
    );
    const got = await ask("rig-a", "rig-token-aaaaaa");
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("cache-control"), "no-store");
    assert.deepEqual(await got.json(), {
      kind: "token",
      token: "glpat-secret-value-1234",
      username: "oauth2",
      host: "git.example.com",
    });
    // Another rig, or the right rig with a wrong token, gets nothing.
    assert.equal((await ask("rig-b", "rig-token-bbbbbb")).status, 404);
    assert.equal((await ask("rig-a", "rig-token-bbbbbb")).status, 401);
    // An assignment that failed, or that the owner withdrew, gives nothing: not for good.
    s.store.commands.ack("rig-a", signed.id, "failed", { error: "the kit did not build" });
    assert.equal((await ask("rig-a", "rig-token-aaaaaa")).status, 404);
    const again = await start({ ...draftOf("gitlab-token"), campaign: "private-speed-2" });
    assert.ok(again.ok, JSON.stringify(!again.ok && again.errors));
    assert.equal((await ask("rig-a", "rig-token-aaaaaa")).status, 200);
    const pending = s.store.commands.pending("rig-a").map((c) => c.envelope.id);
    for (const id of pending) cancelCommand(s.store, id, "owner:ui");
    assert.equal((await ask("rig-a", "rig-token-aaaaaa")).status, 404);
  });

  test("an agent's token may not name a Git access or a source; the owner's and the operator's may", async () => {
    const s = await control({}, { agent: "agent-token-abcdef", operator: "operator-token-abcdef" });
    await s.post("/ui/settings/git", {
      name: "gitlab-token",
      kind: "token",
      token: "glpat-secret-value-1234",
      host: "git.example.com",
    });
    s.store.enrollments.setConfiguredRigs(["rig-a"]);
    const payload = (run: string, source: Record<string, string>) => ({
      run,
      contract: { campaign: "private-speed", mode: "hill_climb" },
      contract_sha: "0".repeat(64),
      seed: { repo: "private", commit: C },
      imports: [
        { kind: "repo_bundle", path: "repos/p.bundle", repo: "private", commit: C, source },
      ],
    });
    const call = async (token: string, run: string, source: Record<string, string>) => {
      const client = await mcpClient(s.api, token);
      try {
        return (await client.callTool({
          name: "issue_command",
          arguments: { rig: "rig-a", kind: "assign_campaign", payload: payload(run, source) },
        })) as { isError?: boolean; content: { text: string }[] };
      } finally {
        await client.close();
      }
    };
    const access = { git: "https://git.example.com/team/private.git", access: "gitlab-token" };
    for (const source of [access, { git: "https://git.example.com/team/public.git" }]) {
      const refused = await call("agent-token-abcdef", "agent-1", source);
      assert.equal(refused.isError, true);
      assert.match(String(refused.content[0]?.text), /An agent's token may not name/);
    }
    assert.equal(s.store.commands.pending("rig-a").length, 0);
    const byOperator = await call("operator-token-abcdef", "op-1", access);
    assert.ok(!byOperator.isError, byOperator.content[0]?.text);
    assert.equal(s.store.commands.pending("rig-a").length, 1);
  });

  test("the supervisor fetches a private repository with the token control hands it", async () => {
    const s = await control();
    // A private repository behind HTTP basic auth (git's plain protocol).
    const root = mkdtempSync(join(tmpdir(), "thermite-private-"));
    const work = join(root, "work");
    mkdirSync(work);
    const g = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
        cwd: work,
        encoding: "utf8",
      }).trim();
    g("init", "--quiet", "-b", "main");
    writeFileSync(join(work, "a.txt"), "secret code\n");
    g("add", "-A");
    g("commit", "--quiet", "-m", "one");
    const commit = g("rev-parse", "HEAD");
    execFileSync("git", ["clone", "--quiet", "--bare", work, join(root, "private.git")]);
    execFileSync("git", ["--git-dir", join(root, "private.git"), "update-server-info"]);
    const expected = `Basic ${Buffer.from("oauth2:glpat-secret-value-1234").toString("base64")}`;
    // HTTPS, as a token may only be sent there: a certificate made for this test, trusted by
    // the git that staging runs.
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(root, "tls.key"),
        "-out",
        join(root, "tls.crt"),
      ],
      { stdio: "ignore" },
    );
    process.env.GIT_SSL_CAINFO = join(root, "tls.crt");
    const tls = {
      key: readFileSync(join(root, "tls.key")),
      cert: readFileSync(join(root, "tls.crt")),
    };
    const repoServer = createServer(tls, (req, res) => {
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="git"' }).end();
        return;
      }
      const path = String(req.url).split("?")[0] ?? "";
      try {
        res.writeHead(200).end(readFileSync(join(root, path)));
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => repoServer.listen(0, "127.0.0.1", r));
    const ctl = serve({ fetch: s.api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => ctl.once("listening", r));
    try {
      const repoUrl = `https://127.0.0.1:${(repoServer.address() as AddressInfo).port}/private.git`;
      await s.post("/ui/settings/git", {
        name: "gitlab-token",
        kind: "token",
        token: "glpat-secret-value-1234",
        username: "oauth2",
        host: "127.0.0.1",
      });
      s.store.enrollments.setConfiguredRigs(["rig-a"]);
      const r = await startCampaign(
        { store: s.store, kits: s.kits, privateKeyPem: s.keys.privateKeyPem },
        {
          draft: {
            ...draftOf("gitlab-token", repoUrl),
            project: { ...draftOf("gitlab-token", repoUrl).project, commit },
          },
          rig: "rig-a",
          target: { type: "cpu", class: "generic-cpu" },
          start: true,
          by: "owner:ui",
        },
      );
      assert.ok(r.ok);
      // Staging, as the supervisor runs it, for an import from that repository; the signed
      // import names the access.
      const inbox = join(root, "inbox");
      mkdirSync(inbox);
      const cmdFrom = (id: string, url: string) =>
        ({
          envelope: {
            id,
            rig: "rig-a",
            kind: "assign_campaign",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            payload: {
              imports: [
                {
                  kind: "repo_bundle",
                  path: "repos/private.bundle",
                  repo: "private",
                  commit,
                  source: { git: url, access: "gitlab-token" },
                },
              ],
            },
          },
          signature: "",
        }) as never;
      const cmd = cmdFrom("c-private", repoUrl);
      const cfg = {
        rig: "rig-a",
        inboxDir: inbox,
        resultsRepo: join(root, "home", "results.git"),
        sourcesDir: join(root, "home", "sources"),
        controlUrl: `http://127.0.0.1:${(ctl.address() as AddressInfo).port}`,
        controlToken: "rig-token-aaaaaa",
      };
      const stage = async (c: never) => {
        let res: unknown = "wait";
        for (let i = 0; i < 200 && res === "wait"; i++) {
          res = await stageCommand(cfg, c);
          if (res === "wait") await new Promise((x) => setTimeout(x, 50));
        }
        return res;
      };
      // The supervisor uses the access only on the host control bound it to.
      const off = await stage(cmdFrom("c-off", "https://elsewhere.example.net/private.git"));
      assert.match(
        JSON.stringify(off),
        /Git access gitlab-token is for 127\.0\.0\.1 only, and repos\/private\.bundle comes from elsewhere\.example\.net/,
      );
      const res = await stage(cmd);
      assert.equal(res, "ready", JSON.stringify(res));
      const heads = execFileSync(
        "git",
        ["bundle", "list-heads", join(inbox, "repos", "private.bundle")],
        { encoding: "utf8" },
      );
      assert.match(heads, new RegExp(`^${commit} `));
    } finally {
      delete process.env.GIT_SSL_CAINFO;
      repoServer.close();
      ctl.close();
    }
  });
});
