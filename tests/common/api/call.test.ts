import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { z } from "zod";
import { ApiError, type ApiTarget, callRoute } from "../../../src/common/api/call.ts";
import type { Route } from "../../../src/core/api/route.ts";

/** A route for the tests: a parameter in its path, a JSON body and an answer with one field read. */
const ROUTE = {
  method: "POST",
  path: "/v1/things/:id",
  what: "thing",
  body: z.object({ n: z.number() }),
  answer: z.looseObject({ ok: z.boolean() }),
} as const satisfies Route;

/** What a fake fetch saw, and a target whose calls it answers with `answer`. */
function faked(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: { url: string; init: RequestInit }[] = [];
  const target: ApiTarget = {
    whose: "the test's",
    url: "http://api",
    token: "tok",
    timeoutMs: 5000,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init: init ?? {} });
      return await answer(String(input), init ?? {});
    }) as typeof fetch,
  };
  return { seen, target };
}

/** The error a call rejects with. */
async function failure(call: Promise<unknown>): Promise<ApiError> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof ApiError, String(err));
    return err;
  }
  assert.fail("the call did not fail");
}

describe("a call of a route (common/api/call.ts)", () => {
  test("sends its path, query, body and token, and hands the answer on as it came", async () => {
    const { seen, target } = faked(() =>
      Response.json({ extra: [1], ok: true, after: { b: 1, a: 2 } }),
    );
    const out = await callRoute(target, ROUTE, {
      params: { id: "a b/c" },
      query: { kinds: "goal,research", none: undefined, n: 2 },
      body: { n: 1 },
    });
    // Every field, in its order: an advisor reads its brief in order.
    assert.deepEqual(Object.keys(out), ["extra", "ok", "after"]);
    assert.deepEqual(Object.keys(out.after as object), ["b", "a"]);
    const [call] = seen;
    assert.equal(call?.url, "http://api/v1/things/a%20b%2Fc?kinds=goal,research&n=2");
    assert.equal(call?.init.method, "POST");
    const headers = new Headers(call?.init.headers);
    assert.equal(headers.get("authorization"), "Bearer tok");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(call?.init.body, '{"n":1}');
  });

  test("bytes go as application/octet-stream; a path parameter not given is refused", async () => {
    const { seen, target } = faked(() => Response.json({ ok: true }));
    await callRoute(target, ROUTE, { params: { id: "1" }, bytes: new Uint8Array([1, 2]) });
    assert.equal(
      new Headers(seen[0]?.init.headers).get("content-type"),
      "application/octet-stream",
    );
    assert.deepEqual([...((seen[0]?.init.body ?? []) as Uint8Array)], [1, 2]);
    await assert.rejects(callRoute(target, ROUTE), /\/v1\/things\/:id needs its id/);
  });

  test("an answer that refuses is an ApiError with a code to act on: its own, else its status's", async () => {
    const cases: [Response, string][] = [
      [
        Response.json(
          { error: "control did not assign it", code: "not_assigned" },
          { status: 404 },
        ),
        "not_assigned",
      ],
      [Response.json({ error: "no such run" }, { status: 404 }), "not_found"],
      [Response.json({ error: "busy" }, { status: 409 }), "refused"],
      [new Response("Payload Too Large", { status: 413 }), "too_large"],
      [Response.json({ error: "bad" }, { status: 400 }), "bad_input"],
      [Response.json({ error: "unauthorized" }, { status: 401 }), "unauthorized"],
      [Response.json({ error: "rejected" }, { status: 403 }), "forbidden"],
      [Response.json({ error: "not the patch" }, { status: 422 }), "unprocessable"],
      [new Response("down", { status: 502 }), "server"],
    ];
    for (const [answer, code] of cases) {
      const { target } = faked(() => answer.clone());
      const err = await failure(callRoute(target, ROUTE, { params: { id: "1" }, body: { n: 1 } }));
      assert.equal(err.code, code, `${answer.status}`);
      assert.equal(err.status, answer.status);
      assert.equal(err.url, "http://api/v1/things/1");
      // The words for people: the answer's error, else its text.
      assert.equal(
        err.words,
        err.text.startsWith("{") ? (JSON.parse(err.text) as { error: string }).error : err.text,
      );
      assert.match(err.message, new RegExp(`^the test's thing: HTTP ${answer.status}: `));
    }
    // The answer's fields stay readable on the error: control's place in a 409, say.
    const { target } = faked(() =>
      Response.json({ error: "a gap", expected_cursor: 7 }, { status: 409 }),
    );
    const err = await failure(callRoute(target, ROUTE, { params: { id: "1" }, body: { n: 1 } }));
    assert.deepEqual(err.answer, { error: "a gap", expected_cursor: 7 });
  });

  test("an answer the route's schema does not take is bad_answer; no answer at all is unreachable", async () => {
    const odd = faked(() => Response.json({ ok: "yes" }));
    const bad = await failure(
      callRoute(odd.target, ROUTE, { params: { id: "1" }, body: { n: 1 } }),
    );
    assert.equal(bad.code, "bad_answer");
    assert.equal(bad.status, 200);
    const down = faked(() => {
      throw new TypeError("fetch failed");
    });
    const gone = await failure(
      callRoute(down.target, ROUTE, { params: { id: "1" }, body: { n: 1 } }),
    );
    assert.equal(gone.code, "unreachable");
    assert.equal(gone.status, undefined);
    assert.equal(gone.message, "the test's thing: fetch failed");
  });

  test("a call that gets no answer within its time ends as a timeout", async (t) => {
    // A real server that takes the request and never answers.
    const server = createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const target: ApiTarget = {
      whose: "the test's",
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: "tok",
      timeoutMs: 200,
    };
    const started = Date.now();
    const err = await failure(callRoute(target, ROUTE, { params: { id: "1" }, body: { n: 1 } }));
    assert.equal(err.code, "timeout");
    assert.equal(err.message, "the test's thing: no answer within 0.2 seconds");
    assert.ok(Date.now() - started < 5000, "it ended at its time, not later");
    // A call's own time limit, as a large upload has, takes the place of its client's.
    const own = await failure(
      callRoute({ ...target, timeoutMs: 60_000 }, ROUTE, {
        params: { id: "1" },
        body: { n: 1 },
        timeoutMs: 100,
      }),
    );
    assert.equal(own.message, "the test's thing: no answer within 0.1 seconds");
  });
});
