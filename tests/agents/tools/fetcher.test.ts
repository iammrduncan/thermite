import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { FetchRefused, statusRefusal } from "../../../src/agents/tools/fetcher.ts";
import { parseContract } from "../../../src/core/contract.ts";
import { Research } from "../../../src/harness/research/research/index.ts";
import { researchFixture } from "../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/** A site whose pages answer with the status their name gives; /busy answers 503 once, then 200. */
async function site() {
  let busy = 0;
  const server = createServer((req, res) => {
    if (req.url === "/busy.html" && ++busy > 1)
      return void res.writeHead(200, { "content-type": "text/html" }).end("<p>Up again.</p>");
    const status =
      {
        "/gone.html": 410,
        "/missing.html": 404,
        "/challenge.html": 403,
        "/limited.html": 429,
        "/busy.html": 503,
      }[req.url ?? ""] ?? 404;
    res
      .writeHead(status, { "content-type": "text/html" })
      .end("<p>Just a moment: checking your browser.</p>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function research() {
  const env = makeHarnessEnv("rig-r");
  const parsed = parseContract(researchFixture);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  const out = await env.service.applyCommand(
    env.sign("assign_campaign", {
      run: "r-1",
      contract: parsed.contract,
      contract_sha: parsed.sha,
      imports: [],
    }),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const r = new Research(env.service.ledger, env.service.paths.stateDir, { allowPrivate: true });
  const sources = () => env.service.ledger.db.prepare("select url from source").all().length;
  return { r, sources };
}

describe("a fetch whose answer is not a 2xx is never archived (goal 162)", () => {
  test("a 404, a 410 or a 403 page is refused for good, and never becomes a source", async (t) => {
    const s = await site();
    t.after(s.close);
    const { r, sources } = await research();
    for (const [page, status] of [
      ["missing", 404],
      ["gone", 410],
      ["challenge", 403],
    ] as const) {
      const a = (await r.fetch("r-1", "lane-1", `${s.base}/${page}.html`)) as { refused: string };
      assert.match(
        a.refused,
        new RegExp(
          `^the site answered HTTP ${status}: an error page is not a source\\. Asking again gives the same answer\\.`,
        ),
      );
      const again = (await r.fetch("r-1", "lane-1", `${s.base}/${page}.html`)) as {
        refused: string;
      };
      assert.match(again.refused, /Refused before: this run has asked for this URL 2 times/);
    }
    assert.equal(sources(), 0);
  });

  test("a 429 or a 503 can pass: it is not archived, and the next ask fetches again", async (t) => {
    const s = await site();
    t.after(s.close);
    const { r, sources } = await research();
    const limited = (await r.fetch("r-1", "lane-1", `${s.base}/limited.html`)) as {
      refused: string;
    };
    assert.match(
      limited.refused,
      /^fetch failed: the site answered HTTP 429: .*a later ask fetches it again/,
    );
    const busy = (await r.fetch("r-1", "lane-1", `${s.base}/busy.html`)) as { refused: string };
    assert.match(busy.refused, /HTTP 503/);
    assert.equal(sources(), 0);
    const up = (await r.fetch("r-1", "lane-1", `${s.base}/busy.html`)) as { source?: string };
    assert.ok(up.source, "fetched again once the site is up, and archived");
    assert.equal(sources(), 1);
  });

  test("the rule", () => {
    assert.doesNotThrow(() => statusRefusal(200));
    assert.doesNotThrow(() => statusRefusal(204));
    assert.throws(() => statusRefusal(404), FetchRefused);
    assert.throws(() => statusRefusal(301), FetchRefused);
    for (const passing of [408, 429, 500, 503])
      assert.throws(
        () => statusRefusal(passing),
        (e) => !(e instanceof FetchRefused),
      );
  });
});
