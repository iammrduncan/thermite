import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as advisors from "../../../src/core/api/harness/advisors.ts";
import * as proposer from "../../../src/core/api/harness/proposer.ts";
import { RESEARCH_KINDS } from "../../../src/core/api/harness/research.ts";
import * as supervisor from "../../../src/core/api/harness/supervisor.ts";
import { pathOf, type Route } from "../../../src/core/api/route.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };

/** The routes a contract module names: each export that is a route. */
function routesOf(module: Record<string, unknown>): [string, Route][] {
  return Object.entries(module).filter(
    (e): e is [string, Route] =>
      typeof e[1] === "object" && e[1] !== null && "method" in e[1] && "path" in e[1],
  );
}

const ROUTES: [string, Route][] = [
  ...routesOf(supervisor),
  ...routesOf(advisors),
  ...routesOf(proposer),
  ...RESEARCH_KINDS.map((k): [string, Route] => [`research ${k}`, advisors.researchList(k)]),
];

describe("the harness's API has one contract (core/api/harness/)", () => {
  test("each route is named once, and the harness serves every route its supervisor and the command line call", async () => {
    const seen = new Set<string>();
    for (const [name, r] of ROUTES) {
      const key = `${r.method} ${r.path}`;
      assert.ok(!seen.has(key), `${name}: ${key} is named twice`);
      seen.add(key);
      assert.match(r.path, /^\/v1\//, name);
    }
    const env = makeHarnessEnv();
    const api = createHarnessApi(env.service, tokens);
    for (const [name, r] of ROUTES) {
      const path = pathOf(r, { id: "1", run: "smoke-1" });
      const token = name === "ATTEMPTS" || name === "ATTEMPT" ? tokens.proposer : tokens.supervisor;
      const res = await api.request(path, {
        method: r.method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(r.method === "GET" ? {} : { body: "{}" }),
      });
      // Hono's own answer to a path it has no route for; any other is the route's.
      assert.notEqual(await res.text(), "404 Not Found", `${name}: ${r.method} ${path}`);
    }
  });

  test("a body past its route's limit is answered 413, the code its sender acts on", async () => {
    const api = createHarnessApi(makeHarnessEnv().service, tokens);
    const res = await api.request(supervisor.ADVISORS.path, {
      method: "PUT",
      headers: { authorization: `Bearer ${tokens.supervisor}`, "content-type": "application/json" },
      body: JSON.stringify({
        auditor: true,
        review_panel: 0,
        pad: "x".repeat(supervisor.ADVISORS.maxBytes),
      }),
    });
    assert.equal(res.status, 413);
  });

  test("its routes take what the supervisor sends today, and the supervisor reads what the harness answers", async () => {
    const env = makeHarnessEnv();
    const api = createHarnessApi(env.service, tokens);
    const get = async (path: string) =>
      (
        await api.request(path, { headers: { authorization: `Bearer ${tokens.supervisor}` } })
      ).json();
    // The answers the supervisor reads, from the real harness.
    assert.ok(
      supervisor.SNAPSHOT.answer.safeParse(await get("/v1/snapshot?cursor=0&limit=500")).success,
    );
    env.service.live.append({ source: "judge", kind: "log", text: "idle" });
    const messages = await get("/v1/live/messages?after=0&limit=500");
    assert.ok(supervisor.LIVE_MESSAGES.answer.safeParse(messages).success);
    assert.equal((messages as { messages: unknown[] }).messages.length, 1);
    assert.ok(supervisor.SETTINGS.answer.safeParse(await get("/v1/settings")).success);
    assert.ok(supervisor.MCP_SERVERS_GET.answer.safeParse(await get("/v1/mcp-servers")).success);
    assert.ok(advisors.RUNS.answer.safeParse(await get("/v1/runs")).success);
    // The bodies, as the supervisor's code builds them (the fixtures of its tests).
    const bodies: [Route & { body: { safeParse(v: unknown): { success: boolean } } }, unknown][] = [
      [supervisor.ADVISORS, { auditor: true, review_panel: 0, writer: false }],
      [supervisor.EXPORTS_DONE, { names: ["20261020T120000Z-0123abcd"] }],
      [supervisor.MCP_EVENTS, { run: "smoke-1", server: "gbrain", ok: false, error: "it failed" }],
      [supervisor.KB, { run: "smoke-1", items: [{ seq: 1 }], collections: ["smoke-matmul"] }],
      [
        advisors.AUDITS,
        {
          attempt: "a-1",
          decision: "needs_owner",
          reasons: "the auditor could not answer after 5 tries: no detail",
          citations: [],
          auditor: "auditor",
        },
      ],
      [advisors.REVIEW_TRIES, { try: 1, error: "1 of 2 reviewers of the review panel answered" }],
      [
        advisors.QUEUE,
        {
          run: "smoke-1",
          role: "auditor",
          add: [{ title: "Re-measure a-1", why: "a doubt", family: "check", position: "top" }],
          move: [],
        },
      ],
      [
        advisors.ADVISOR_MESSAGES,
        { run: "smoke-1", role: "teachers", read: [1], answers: [{ message: 1, text: "Yes." }] },
      ],
      [advisors.JOURNAL, { run: "smoke-1", role: "teachers", by: "teacher-1", notes: [] }],
    ];
    for (const [r, body] of bodies)
      assert.ok(r.body.safeParse(body).success, `${r.method} ${r.path}`);
    // The queue takes as many experiments in one request as the supervisor sends in a part.
    const add = Array.from({ length: advisors.QUEUE_PART_MAX }, (_, i) => ({
      title: `idea ${i}`,
      why: "why",
    }));
    assert.ok(advisors.QUEUE.body.safeParse({ run: "r", role: "teacher", add }).success);
    assert.ok(
      !advisors.QUEUE.body.safeParse({ run: "r", role: "teacher", add: [...add, add[0]] }).success,
    );
  });

  test("the runs and attempts the advisors' packages name are IDs, which the supervisor's record files are named by", () => {
    const attempt = "a-0123456789abcdef";
    const run = "smoke-1";
    const answers = (
      r: string,
      a: string,
    ): [Route & { answer: { safeParse(v: unknown): { success: boolean } } }, unknown][] => [
      [advisors.RUNS, { runs: [{ id: r, campaign: "c", mode: "hill_climb", status: "running" }] }],
      [advisors.AUDITS_PENDING, { audits: [{ id: 1, attempt: a, run: r }] }],
      [advisors.REVIEWS_PENDING, { reviews: [{ id: 1, run: r }] }],
      [advisors.CARDS_PENDING, { runs: [{ run: r }] }],
      [advisors.PAPERS_PENDING, { papers: [{ run: r, review: 1 }] }],
    ];
    for (const [route, answer] of answers(run, attempt))
      assert.ok(
        route.answer.safeParse(answer).success,
        `${route.path} takes ${run} and ${attempt}`,
      );
    // A name with a path in it, or one that is not an attempt's: refused, so the advisors' pass
    // stops on that answer and writes no file.
    for (const [r, a] of [
      ["../../home/x", attempt],
      ["smoke/1", attempt],
      [run, "../../home/x"],
      [run, "a-1/../x"],
    ] as const)
      for (const [route, answer] of answers(r, a)) {
        const named = JSON.stringify(answer);
        if (named.includes("..") || named.includes("/"))
          assert.ok(!route.answer.safeParse(answer).success, `${route.path} refuses ${named}`);
      }
  });
});
