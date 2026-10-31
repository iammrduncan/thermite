import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ModelSource } from "../../../src/harness/agents/model/source.ts";
import { classifyProviderError } from "../../../src/harness/agents/provider-errors.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/** A provider that answers every request and records what it was sent. */
async function provider() {
  const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: String(req.url), headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

describe("the model proxy", () => {
  test("adds the provider's key for a valid credential, and nothing else gets through", async () => {
    const p = await provider();
    try {
      const env = makeJudgeEnv();
      const file = join(mkdtempSync(join(tmpdir(), "thermite-proxy-")), "model-route.json");
      env.service.models = new ModelSource(file, {
        baseUrl: `${p.url}/v1`,
        model: "m",
        apiKey: "real-provider-key",
        contextWindow: 0,
        maxTokens: 8192,
      });
      const api = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
      const token = env.service.mintProxyToken();
      const ask = (headers: Record<string, string>) =>
        api.request("/v1/model-proxy/chat/completions?x=1", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ model: "m", stream: true }),
        });
      const ok = await ask({ authorization: `Bearer ${token}` });
      assert.equal(ok.status, 200);
      assert.equal(await ok.text(), "data: one\n\ndata: [DONE]\n\n");
      assert.equal(p.seen[0]?.url, "/v1/chat/completions?x=1");
      assert.equal(p.seen[0]?.headers.authorization, "Bearer real-provider-key");
      assert.equal(p.seen[0]?.body, JSON.stringify({ model: "m", stream: true }));
      // A wrong or missing credential, or a trial that is not open, reaches nothing.
      const refused: Record<string, string>[] = [
        {},
        { authorization: "Bearer proxy.nope" },
        { authorization: "Bearer trial.nope" },
      ];
      for (const h of refused) assert.equal((await ask(h)).status, 401);
      assert.equal(p.seen.length, 1);
      // An Anthropic route gets the key as x-api-key; its client may send the credential that way.
      env.service.models = new ModelSource(file, {
        api: "anthropic",
        baseUrl: p.url,
        model: "m",
        apiKey: "real-anthropic-key",
        contextWindow: 0,
        maxTokens: 8192,
      });
      const ant = await api.request("/v1/model-proxy/v1/messages", {
        method: "POST",
        headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
        body: "{}",
      });
      assert.equal(ant.status, 200);
      assert.equal(p.seen[1]?.url, "/v1/messages");
      assert.equal(p.seen[1]?.headers["x-api-key"], "real-anthropic-key");
      assert.equal(p.seen[1]?.headers["anthropic-version"], "2023-06-01");
      assert.equal(p.seen[1]?.headers.authorization, undefined);
    } finally {
      p.server.close();
    }
  });

  test("a ChatGPT sign-in: only the Responses API and the model list, each request made to fit, with the newest token", async () => {
    const p = await provider();
    try {
      const env = makeJudgeEnv();
      const file = join(mkdtempSync(join(tmpdir(), "thermite-proxy-")), "model-route.json");
      env.service.models = new ModelSource(file, undefined);
      const route = (token: string, revision: string) => ({
        name: "chatgpt-pro",
        type: "chatgpt" as const,
        harness: "opencode" as const,
        version: 1,
        base_url: `${p.url}/v1`,
        model: "gpt-test",
        context_window: 0,
        max_tokens: 0,
        reasoning: null,
        key_hint: "…0001",
        revision,
        api_key: token,
      });
      env.service.models.set(route("access-token-one", "aaaaaaaa"));
      const api = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
      const auth = { authorization: `Bearer ${env.service.mintProxyToken()}` };
      const sent = await api.request("/v1/model-proxy/responses", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          model: "gpt-test",
          stream: false,
          store: true,
          max_output_tokens: 32000,
          temperature: 0.2,
          previous_response_id: "resp_old",
          instructions: "Be brief.",
          input: [
            { role: "system", content: "You are a worker." },
            { type: "message", role: "user", content: "hi" },
          ],
        }),
      });
      assert.equal(sent.status, 200);
      assert.equal(p.seen[0]?.url, "/v1/responses");
      assert.equal(p.seen[0]?.headers.authorization, "Bearer access-token-one");
      assert.deepEqual(JSON.parse(String(p.seen[0]?.body)), {
        model: "gpt-test",
        stream: true,
        store: false,
        instructions: "Be brief.",
        input: [
          { role: "developer", content: "You are a worker." },
          { type: "message", role: "user", content: "hi" },
        ],
      });
      // Control renewed the token: the next call carries the new one.
      env.service.models.set(route("access-token-two", "bbbbbbbb"));
      assert.equal((await api.request("/v1/model-proxy/models", { headers: auth })).status, 200);
      assert.equal(p.seen[1]?.url, "/v1/models");
      assert.equal(p.seen[1]?.headers.authorization, "Bearer access-token-two");
      // Nothing else reaches OpenAI with the plan's token.
      for (const [method, path] of [
        ["POST", "chat/completions"],
        ["GET", "responses"],
        ["POST", "files"],
      ] as const) {
        const r = await api.request(`/v1/model-proxy/${path}`, {
          method,
          headers: { "content-type": "application/json", ...auth },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        assert.equal(r.status, 403, `${method} ${path}`);
      }
      const notJson = await api.request("/v1/model-proxy/responses", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: "not json",
      });
      assert.equal(notJson.status, 400);
      assert.equal(p.seen.length, 2);
    } finally {
      p.server.close();
    }
  });

  test("a ChatGPT plan's refusal goes on as it came, and the proxy keeps OpenAI's answer, its code in it, for the agents that lose the code", async () => {
    const answers = [
      { status: 429, code: "subscription_sharing_usage_limit_exceeded" },
      { status: 500, code: "server_error" },
    ];
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const a = answers.shift() ?? { status: 200, code: "" };
        res.writeHead(a.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Refused for now.", code: a.code } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const env = makeJudgeEnv();
      const file = join(mkdtempSync(join(tmpdir(), "thermite-proxy-")), "model-route.json");
      env.service.models = new ModelSource(file, undefined);
      env.service.models.set({
        name: "chatgpt-pro",
        type: "chatgpt",
        harness: "codex",
        version: 1,
        base_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        model: "gpt-test",
        context_window: 0,
        max_tokens: 0,
        reasoning: null,
        key_hint: "…0001",
        revision: "aaaaaaaa",
        api_key: "access-token-one",
      });
      const api = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
      const ask = () =>
        api.request("/v1/model-proxy/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${env.service.mintProxyToken()}`,
          },
          body: JSON.stringify({ model: "gpt-test", input: "hi" }),
        });
      const before = Date.now();
      const full = await ask();
      assert.equal(full.status, 429);
      assert.match(await full.text(), /subscription_sharing_usage_limit_exceeded/);
      // The answer, with OpenAI's code, for a trial to read once its program stops (goal 079).
      const kept = env.service.providerAnswerSince("proxy", before);
      assert.equal(kept?.status, 429);
      assert.match(String(kept?.body), /subscription_sharing_usage_limit_exceeded/);
      // Not for a run that started after it; another error answer is the newest.
      assert.equal(env.service.providerAnswerSince("proxy", Date.now() + 1), undefined);
      const other = await ask();
      assert.equal(other.status, 500);
      assert.match(await other.text(), /server_error/);
      assert.match(String(env.service.providerAnswerSince("proxy", before)?.body), /server_error/);
    } finally {
      server.close();
    }
  });

  test("a stream that goes silent is broken off for OpenCode and Codex: a 504 before an answer, a broken connection during one, and the trial's Live says so (goal 079)", async () => {
    const env = makeHarnessEnv();
    const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    const registry = new Registry(env.service.ledger);
    registry.startTrial({
      id: "t-proxy-silent",
      run: "smoke-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seedCommit,
      token: "silent-trial-token",
    });
    const file = join(mkdtempSync(join(tmpdir(), "thermite-proxy-")), "model-route.json");
    const api = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
    env.service.modelStallMs = 300;
    const ask = () =>
      api.request("/v1/model-proxy/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer trial.silent-trial-token",
        },
        body: JSON.stringify({ model: "m", stream: true, messages: [] }),
      });
    const lines = () =>
      env.service.live
        .since(0, 1000)
        .entries.filter((l) => l.source === "trial:t-proxy-silent")
        .map((l) => l.text);
    for (const silent of ["no_answer", "open", "keep_alive"] as const) {
      const fake = await startFakeModel(() => ({ silent }));
      try {
        env.service.models = new ModelSource(file, {
          baseUrl: fake.url,
          model: "m",
          apiKey: "real-provider-key",
          contextWindow: 0,
          maxTokens: 0,
        });
        const since = Date.now();
        const before = lines().length;
        const r = await ask();
        if (silent === "no_answer") {
          // No answer at all: a gateway's 504, with the words.
          assert.equal(r.status, 504);
          assert.match(await r.text(), /the model's stream went silent for 0\.3 s/);
        } else {
          // During the answer: the program's connection breaks off.
          assert.equal(r.status, 200);
          await assert.rejects(r.text(), /the model's stream went silent for 0\.3 s/);
        }
        // The provider's connection is closed; the trial's answer is the provider's passing fault
        // in the words, so its program's next stop goes on in the same session.
        const end = Date.now() + 2000;
        while (fake.closedEarly < 1 && Date.now() < end)
          await new Promise((x) => setTimeout(x, 10));
        assert.equal(fake.closedEarly, 1, silent);
        const answer = env.service.providerAnswerSince("t-proxy-silent", since);
        assert.equal(answer?.status, 504, silent);
        assert.equal(classifyProviderError(String(answer?.body), answer).kind, "server", silent);
        assert.deepEqual(lines().slice(before), [
          "the model's stream went silent for 0.3 s: retried. The harness broke the call off; the trial goes on in the same session.",
        ]);
      } finally {
        await fake.close();
      }
    }
  });

  test("a trial's tokens are what the proxy saw in the provider's answers, whatever its program reports; its run's budget counts them", async () => {
    const env = makeHarnessEnv();
    const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    const registry = new Registry(env.service.ledger);
    const trials = env.service.ledger.trials;
    for (const id of ["t-seen", "t-own"])
      registry.startTrial({
        id,
        run: "smoke-1",
        lane: "lane-1",
        epoch: 1,
        family: "f",
        parent: env.seedCommit,
        token: `${id}-token`,
      });
    trials.countByProxy("t-seen");
    // Each API's answer, streamed or whole, as a provider sends it. A figure in the model's own
    // text is escaped there, and never counts.
    const answers: { type: string; body: string }[] = [
      {
        type: "text/event-stream",
        body: `data: {"choices":[{"delta":{"content":"\\"output_tokens\\": 999999"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":100}}}\n\ndata: [DONE]\n\n`,
      },
      {
        type: "text/event-stream",
        body: `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":200,"cache_creation_input_tokens":5,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":40}}\n\n`,
      },
      {
        type: "application/json",
        body: JSON.stringify({ output: [], usage: { input_tokens: 7, output_tokens: 3 } }),
      },
    ];
    let next = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const a = answers[next++ % answers.length] as { type: string; body: string };
        res.writeHead(200, { "content-type": a.type });
        // In parts that split a key, as a stream may.
        res.write(a.body.slice(0, 50));
        res.end(a.body.slice(50));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const file = join(mkdtempSync(join(tmpdir(), "thermite-proxy-")), "model-route.json");
      env.service.models = new ModelSource(file, {
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        model: "m",
        apiKey: "real-provider-key",
        contextWindow: 0,
        maxTokens: 0,
      });
      const api = createHarnessApi(env.service, { supervisor: "sup-token-abcdef" });
      for (let i = 0; i < 3; i++) {
        const r = await api.request("/v1/model-proxy/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer trial.t-seen-token",
          },
          body: JSON.stringify({ model: "m", stream: true, messages: [] }),
        });
        assert.equal(r.status, 200);
        await r.text();
      }
      const seen = env.service.ledger.db
        .prepare(
          "select proxy_tokens_in as i, proxy_tokens_out as o from trial where id = 't-seen'",
        )
        .get() as { i: number; o: number };
      assert.deepEqual({ ...seen }, { i: 120 + 215 + 7, o: 30 + 40 + 3 });
      // Its program says it used fewer; the other trial, which the proxy does not count, keeps its own.
      trials.setCounters("t-seen", { turns: 3, tool_calls: 0, tokens_in: 1, tokens_out: 1 });
      trials.setCounters("t-own", { turns: 1, tool_calls: 0, tokens_in: 50, tokens_out: 5 });
      assert.deepEqual(registry.tokensUsed("smoke-1"), { in: 342 + 50, out: 73 + 5 });
    } finally {
      server.close();
    }
  });
});
