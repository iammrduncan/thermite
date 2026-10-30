import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ModelSource } from "../../../src/harness/agents/model/source.ts";
import { handModelRoute } from "../../../src/supervisor/model-route.ts";
import { stack } from "./stack.ts";

/**
 * Subscriptions on the settings page: a Claude subscription's token and a ChatGPT sign-in, from
 * the form to the rig's model route, their usage and their sign-out.
 */

describe("control dashboard", () => {
  test("a Claude subscription: its token sealed with no call to Anthropic, its models only in Claude Code, its usage from the rigs", async () => {
    const calls: string[] = [];
    const providerFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const s = await stack("owner_approval", { providerFetch });
    const dir = mkdtempSync(join(tmpdir(), "thermite-claude-route-"));
    s.env.service.models = new ModelSource(join(dir, "model-route.json"), undefined);
    await s.relay();
    let page = await (await s.get("/ui/settings")).text();
    const csrf = s.csrfFrom(page);
    const where = (r: Response) => decodeURIComponent(r.headers.get("location") ?? "");
    const token = "sk-ant-oat01-test-subscription-token-7777"; // public-check: allow (a made-up token for tests)
    assert.match(
      where(
        await s.post("/ui/settings/add", {
          csrf,
          type: "claude",
          name: "claude-max",
          claude_token: "not-a-token",
        }),
      ),
      /not a token from claude setup-token/,
    );
    assert.match(
      where(
        await s.post("/ui/settings/add", {
          csrf,
          type: "claude",
          name: "claude-max",
          claude_token: token,
        }),
      ),
      /"claude-max" is saved: its 5 models run only in Claude Code/,
    );
    assert.deepEqual(calls, [], "control never calls Anthropic with a subscription's token");
    page = await (await s.get("/ui/settings")).text();
    assert.match(page, /claude-code:opus-5\.5\[1m\]/);
    assert.match(page, /runs only in Claude Code, Anthropic's own program/);
    assert.match(page, /token …7777/);
    assert.ok(
      !JSON.stringify([
        page,
        s.store.db.prepare("select * from model_provider").all(),
        s.store.db.prepare("select * from audit").all(),
      ]).includes(token),
    );
    // Its model goes to a rig in Claude Code, whatever harness the form named.
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      harness: "pi",
      choice: "claude-max|opus-5.5%5B1m%5D",
    });
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.harness, "claude-code");
    const route = (await s.rigConfig("model-route")) as unknown as {
      route: { type: string; harness: string; model: string; api_key: string };
    };
    assert.equal(route.route.type, "claude");
    assert.equal(route.route.harness, "claude-code");
    assert.equal(route.route.model, "claude-opus-5-5");
    assert.equal(route.route.api_key, token);
    const sync = s.cfg;
    assert.equal(await handModelRoute(sync, (await s.rigConfig("model-route")) as never), "set");
    const m = s.env.service.models.current();
    assert.equal(m?.api, "claude");
    assert.equal(m?.harness, "claude-code");
    // The rig reports the windows Claude Code showed; the subscription's row shows them.
    s.env.service.subscriptionUsage = {
      five_hour: { utilization: 0.34, resets_at: "2026-10-18T15:40:00.000Z" },
      seven_day: { utilization: 0.61, resets_at: "2026-10-20T09:00:00.000Z" },
      at: new Date().toISOString(),
    };
    await s.relay();
    page = await (await s.get("/ui/settings")).text();
    assert.match(page, /<b>5-hour window<\/b> · 34% used · resets 2026-10-18 15:40 UTC/);
    assert.match(page, /<b>Weekly window<\/b> · 61% used/);
    assert.match(page, /Its agents run under Claude Code with claude-opus-5-5 from claude-max/);
    // Claude Code with any other provider is refused.
    await s.post("/ui/settings/providers", {
      csrf,
      name: "keyed",
      type: "anthropic",
      api_key: "sk-ant-api-x",
    });
    assert.match(
      where(
        await s.post("/ui/settings/rigs", {
          csrf,
          rig: "rig-a",
          harness: "claude-code",
          choice: "keyed|claude-test",
        }),
      ),
      /does not list that model|Claude Code runs only with a Claude subscription/,
    );
  });

  test("a ChatGPT subscription: signed in with a pasted address, renewed by control alone, its token in the rig's route, signed out on delete", async () => {
    // A stand-in for OpenAI's sign-in, token, model-list and sign-out endpoints.
    const calls: { url: string; form?: URLSearchParams | undefined; auth?: string | undefined }[] =
      [];
    let issued = 0;
    let refuse = false;
    let shortLived = false;
    const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
    const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const form = init?.body instanceof URLSearchParams ? init.body : undefined;
      calls.push({ url, form, auth: new Headers(init?.headers).get("authorization") ?? undefined });
      if (url === "https://auth.openai.com/api/accounts/oauth/token") {
        if (refuse) return Response.json({ error: "invalid_grant" }, { status: 400 });
        issued++;
        await new Promise((r) => setTimeout(r, 20));
        return Response.json({
          access_token: `access-${issued}`,
          refresh_token: `refresh-${issued}`,
          id_token: "id",
          token_type: "Bearer",
          // The first is nearly spent, so the first route renews it.
          expires_in: issued === 1 || shortLived ? 60 : 3600,
          scope: SCOPE,
          earliest_refresh_at: Math.floor(Date.now() / 1000) - 1,
        });
      }
      if (url === "https://api.openai.com/v1/models")
        return Response.json({
          models: [
            { slug: "gpt-test", visibility: "list" },
            { slug: "gpt-hidden", visibility: "hide" },
          ],
        });
      if (url === "https://auth.openai.com/.well-known/openid-configuration")
        return Response.json({ revocation_endpoint: "https://auth.openai.com/oauth/revoke" });
      if (url === "https://auth.openai.com/oauth/revoke") return new Response("", { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const s = await stack("owner_approval", { providerFetch });
    await s.relay();
    let page = await (await s.get("/ui/settings")).text();
    const csrf = s.csrfFrom(page);
    assert.match(page, /<option value="chatgpt">ChatGPT subscription/);
    const where = (r: Response) => decodeURIComponent(String(r.headers.get("location")));
    // Control sends the browser to OpenAI's sign-in page, as Thermite, with its own host ID.
    const start = await s.get("/ui/settings/chatgpt/start");
    assert.equal(start.status, 302);
    const signIn = new URL(String(start.headers.get("location")));
    assert.equal(
      `${signIn.origin}${signIn.pathname}`,
      "https://auth.openai.com/api/accounts/authorize",
    );
    const q = signIn.searchParams;
    assert.equal(q.get("client_id"), "dynamic_agent_client");
    assert.equal(q.get("agent_name_hint"), "Thermite");
    assert.match(q.get("ext_agent_host_id") ?? "", /^urn:uuid:[0-9a-f-]{36}$/);
    assert.equal(q.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
    assert.equal(q.get("resource"), "https://api.openai.com/v1");
    assert.equal(q.get("scope"), SCOPE);
    assert.equal(q.get("code_challenge_method"), "S256");
    const state = q.get("state") ?? "";
    const pasted = `http://127.0.0.1:1455/auth/callback?code=code-1&state=${state}&client_id=oaiapp_test0001`;
    const add = (o: Record<string, string>) =>
      s.post("/ui/settings/add", { csrf, type: "chatgpt", name: "chatgpt-pro", ...o });
    // Nothing is exchanged without the owner's consent, or for a sign-in control did not start.
    assert.match(where(await add({ chatgpt_url: pasted })), /Tick the box/);
    const foreign = pasted.replace(state, "not-control-s");
    assert.match(
      where(await add({ chatgpt_url: foreign, chatgpt_consent: "1" })),
      /did not start this sign-in/,
    );
    assert.equal(calls.length, 0);
    const added = await add({ chatgpt_url: pasted, chatgpt_consent: "1" });
    assert.match(
      where(added),
      /"chatgpt-pro" is signed in: its 1 model run in Pi, OpenCode v2 or Codex/,
    );
    const exchange = calls.find((c) => c.form?.get("grant_type") === "authorization_code");
    assert.equal(exchange?.form?.get("client_id"), "oaiapp_test0001");
    assert.equal(exchange?.form?.get("code"), "code-1");
    const verifier = exchange?.form?.get("code_verifier") ?? "";
    assert.equal(
      createHash("sha256").update(verifier).digest("base64url"),
      q.get("code_challenge"),
    );
    // Used once: the same address can't be exchanged again.
    assert.match(
      where(await add({ chatgpt_url: pasted, chatgpt_consent: "1" })),
      /did not start this sign-in/,
    );
    assert.deepEqual(
      s.store.modelProviders.get("chatgpt-pro")?.models.map((m) => m.id),
      ["gpt-test"],
      "only the models OpenAI lists for display",
    );
    const audit = JSON.stringify(
      await (
        await s.control.request("/v1/audit?limit=50", {
          headers: { authorization: "Bearer admin-token-abcdef" },
        })
      ).json(),
    );
    assert.match(audit, /unattended_use/);
    page = await (await s.get("/ui/settings")).text();
    assert.match(page, /chatgpt:gpt-test/);
    assert.ok(!/access-1|refresh-1/.test(page + audit), "the login shows nowhere");
    // Given to the rig: the first routes renew the nearly spent token once, though two ask at once.
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "chatgpt-pro|gpt-test",
      harness: "opencode",
    });
    const asRig = async () =>
      (await s.rigConfig("model-route")) as unknown as {
        route: Record<string, unknown> | null;
        error?: string;
      };
    const [a, b] = await Promise.all([asRig(), asRig()]);
    assert.equal(a.route?.type, "chatgpt");
    assert.equal(a.route?.harness, "opencode");
    assert.equal(a.route?.base_url, "https://api.openai.com/v1");
    assert.equal(a.route?.model, "gpt-test");
    assert.equal(a.route?.api_key, "access-2");
    assert.equal(b.route?.api_key, "access-2");
    const renewals = () => calls.filter((c) => c.form?.get("grant_type") === "refresh_token");
    assert.equal(renewals().length, 1);
    assert.equal(renewals()[0]?.form?.get("refresh_token"), "refresh-1");
    assert.equal(renewals()[0]?.form?.get("client_id"), "oaiapp_test0001");
    assert.equal(renewals()[0]?.form?.get("resource"), "https://api.openai.com/v1");
    assert.equal((await asRig()).route?.revision, a.route?.revision, "fresh: taken as it is");
    assert.equal(renewals().length, 1);
    // The Codex CLI as the workers' harness, chosen on Edit rig: the route says so (a new
    // revision), and the planner that follows the workers runs in Codex too.
    let edit = await (await s.get("/ui/rigs/rig-a/edit")).text();
    assert.match(edit, /<option value="codex">Codex<\/option>/);
    const editForm = (harness: string) => ({
      csrf: s.csrfFrom(edit),
      choice: "chatgpt-pro|gpt-test",
      harness,
      lanes: "1",
      trial_minutes: "20",
      max_turns: "",
      promotion: "owner_approval",
      ...Object.fromEntries(
        ["judge", "workers", "planner", "auditor", "teachers", "review", "exports"].map((k) => [
          k,
          "1",
        ]),
      ),
    });
    const toCodex = await s.post("/ui/rigs/rig-a/edit", editForm("codex"));
    assert.match(decodeURIComponent(String(toCodex.headers.get("location"))), /a new model/);
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.harness, "codex");
    const codexRoute = await asRig();
    assert.equal(codexRoute.route?.harness, "codex");
    assert.equal(codexRoute.route?.type, "chatgpt");
    assert.notEqual(codexRoute.route?.revision, a.route?.revision);
    edit = await (await s.get("/ui/rigs/rig-a/edit")).text();
    assert.match(edit, /<option value="codex" selected>Codex<\/option>/);
    // The workers' Runs in says Codex; the planner, with no model of its own, follows them.
    assert.match(
      edit,
      /name="harness" data-runs-in="workers"[^>]*>(?:(?!<\/select>)[\s\S])*<option value="codex" selected>Codex<\/option>/,
    );
    assert.match(edit, /data-ctx-sum="planner"><span class="muted">as the workers: [^<]+ · 80%</);
    page = await (await s.get("/ui/settings")).text();
    assert.match(page, /<option value="codex" selected>Codex<\/option>/);
    // Left to control, a ChatGPT sign-in keeps Pi.
    await s.post("/ui/settings/rigs", { csrf, rig: "rig-a", choice: "chatgpt-pro|gpt-test" });
    assert.equal(s.store.agentModels.byRig()["rig-a"]?.harness, "pi");
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "chatgpt-pro|gpt-test",
      harness: "opencode",
    });
    // The harness gets it through its supervisor.
    s.env.service.models = new ModelSource(
      join(mkdtempSync(join(tmpdir(), "thermite-chatgpt-")), "model-route.json"),
      undefined,
    );
    const sync = s.cfg;
    assert.equal(await handModelRoute(sync, (await s.rigConfig("model-route")) as never), "set");
    assert.equal(s.env.service.models?.current()?.api, "chatgpt");
    // Signing in again keeps the issued client ID and the host ID.
    const again = new URL(
      String((await s.get("/ui/settings/chatgpt/start?name=chatgpt-pro")).headers.get("location")),
    );
    assert.equal(again.searchParams.get("client_id"), "oaiapp_test0001");
    assert.equal(again.searchParams.get("agent_name_hint"), null);
    assert.equal(again.searchParams.get("ext_agent_host_id"), q.get("ext_agent_host_id"));
    // Deleted once no rig uses it: signed out at OpenAI with the newest refresh token.
    await s.post("/ui/settings/rigs", { csrf, rig: "rig-a", choice: "" });
    const del = await s.post("/ui/settings/providers/chatgpt-pro/delete", { csrf });
    assert.match(where(del), /OpenAI confirmed the sign-out/);
    const revoke = calls.find((c) => c.url === "https://auth.openai.com/oauth/revoke");
    assert.equal(revoke?.form?.get("token"), "refresh-2");
    assert.equal(revoke?.form?.get("token_type_hint"), "refresh_token");
    assert.equal(revoke?.form?.get("client_id"), "oaiapp_test0001");
    // A login OpenAI ended can't be renewed: the rig is told, and Providers says to sign in again.
    shortLived = true;
    const second = new URL(
      String((await s.get("/ui/settings/chatgpt/start")).headers.get("location")),
    );
    const pasted2 = `http://127.0.0.1:1455/auth/callback?code=code-2&state=${second.searchParams.get("state")}&client_id=oaiapp_test0002`;
    assert.match(where(await add({ chatgpt_url: pasted2, chatgpt_consent: "1" })), /is signed in/);
    await s.post("/ui/settings/rigs", { csrf, rig: "rig-a", choice: "chatgpt-pro|gpt-test" });
    refuse = true;
    const ended = await asRig();
    assert.equal(ended.route, undefined);
    assert.match(String(ended.error), /sign in again/);
    page = await (await s.get("/ui/settings")).text();
    assert.match(
      page,
      /its ChatGPT sign-in ended \(OpenAI answered HTTP 400 \(invalid_grant\)\): sign in again/,
    );
  });
});
