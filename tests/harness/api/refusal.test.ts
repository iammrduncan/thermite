import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import { z } from "zod";
import { CLAIM_LIMITS_WORDS, researchTool } from "../../../src/agents/tools/research.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { researchAgentTools } from "../../../src/harness/agents/tools/research.ts";
import { researchHelp, trialCli } from "../../../src/harness/agents/trial-cli.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { pathWords, REFUSAL_PROBLEMS, refusalWords } from "../../../src/harness/api/refusal.ts";
import { ClaimInput } from "../../../src/harness/research/research/index.ts";
import { makeResearchRun } from "../../helpers/research-run.ts";

/**
 * Goal 143: a request the harness API's schema refuses says which field and what is wrong, so an
 * agent can fix it instead of guessing. On the lab a worker got only "invalid request" for a quote
 * of a few characters, and wrote a lesson for later trials: "Retry on 400".
 */

const words = (schema: z.ZodType, body: unknown) => {
  const r = schema.safeParse(body);
  assert.equal(r.success, false);
  return refusalWords((r as { error: z.ZodError }).error, body);
};

const QUOTE = "The harness archived 42 pages in its first run.";
const claim = (o: Record<string, unknown> = {}) => ({
  text: "The first run archived 42 pages.",
  quotes: [{ source: "s-1", quote: QUOTE }],
  ...o,
});

describe("a refused request says which field and why (goal 143)", () => {
  test("each kind of problem, in words, with what the body sent", () => {
    assert.equal(
      words(ClaimInput, claim({ quotes: [{ source: "s-1", quote: "v10.0.130" }] })),
      "quotes[0].quote has 9 characters; it needs at least 20",
    );
    assert.equal(
      words(ClaimInput, claim({ quotes: undefined })),
      "quotes is missing: it must be a list",
    );
    assert.equal(
      words(ClaimInput, claim({ confidence: "high" })),
      "confidence is a string; it must be a number",
    );
    assert.equal(
      words(ClaimInput, claim({ question: 1.5 })),
      "question is the number 1.5; it must be a whole number",
    );
    assert.equal(
      words(ClaimInput, claim({ question: -1 })),
      "question is -1; it must be at least 0",
    );
    assert.equal(
      words(ClaimInput, claim({ quotes: Array(11).fill({ source: "s-1", quote: QUOTE }) })),
      "quotes has 11 items; it can have at most 10",
    );
    assert.equal(
      words(ClaimInput, claim({ quotes: [{ source: "s-1", quote: "x".repeat(2001) }] })),
      "quotes[0].quote has 2,001 characters; it can have at most 2,000",
    );
    assert.equal(words(ClaimInput, "a claim"), "the request is a string; it must be an object");
    assert.equal(
      words(z.strictObject({ a: z.string() }), { a: "x", b: 1, c: 2 }),
      "the request has fields it does not take: b, c",
    );
    assert.equal(
      words(z.object({ kind: z.enum(["observation", "lesson"]) }), { kind: "idea" }),
      'kind is "idea"; it must be "observation" or "lesson"',
    );
    assert.equal(
      words(z.object({ q: z.union([z.number(), z.null()]) }), { q: "1" }),
      "q is a string; it must be a number or a null",
    );
    assert.equal(words(z.object({ u: z.url() }), { u: "nope" }), "u is not a valid url");
  });

  test("without the body, the limit alone", () => {
    const r = ClaimInput.safeParse(claim({ quotes: [{ source: "s-1", quote: "short" }] }));
    assert.equal(r.success, false);
    assert.equal(
      refusalWords(r.error as z.ZodError),
      "quotes[0].quote needs at least 20 characters",
    );
  });

  test(`at most ${REFUSAL_PROBLEMS} problems, and how many more`, () => {
    const many = z.object(Object.fromEntries([..."abcdefg"].map((k) => [k, z.string()])));
    const said = words(many, {});
    assert.equal(said.split("; ").length, REFUSAL_PROBLEMS + 1);
    assert.match(said, /^a is missing: it must be a string; .*; and 2 more$/);
  });

  test("a path as the agent wrote it", () => {
    assert.equal(pathWords([]), "the request");
    assert.equal(pathWords(["quotes", 0, "quote"]), "quotes[0].quote");
    assert.equal(pathWords([3]), "[3]");
  });

  test("add_claim's text and research help give the limits", () => {
    assert.match(CLAIM_LIMITS_WORDS, /each quote has 20 to 2,000 characters/);
    assert.match(CLAIM_LIMITS_WORDS, /1 to 10 quotes/);
    assert.match(CLAIM_LIMITS_WORDS, /The text has 5 to 4,000 characters/);
    assert.ok(researchTool("add_claim")?.description.includes(CLAIM_LIMITS_WORDS));
    assert.ok(researchTool("add_claim")?.usage.includes(CLAIM_LIMITS_WORDS));
    assert.match(researchHelp(), /\n\nadd_claim: The text has 5 to 4,000 characters/);
  });
});

/** A research run with one open trial, and the harness API as its worker reaches it. */
async function trialApi(t: TestContext) {
  const r = await makeResearchRun();
  t.after(() => r.close());
  new Registry(r.env.service.ledger).startTrial({
    id: "t-0123456789abcdef",
    run: r.run,
    lane: "lane-1",
    epoch: 1,
    family: "f",
    parent: "p",
    token: "tok-1",
  });
  const api = createHarnessApi(r.env.service, { supervisor: "s" }, { research: r.research });
  // As the worker's and thermite-trial's own calls: a refusal is an error with its answer.
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: { authorization: "Bearer trial.tok-1", "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new Error(`${res.status}: ${text}`);
    return JSON.parse(text) as unknown;
  };
  return { ...r, call };
}

const SHORT = "invalid request: quotes\\[0\\]\\.quote has 9 characters; it needs at least 20";

describe("an agent sees why its claim was refused (goal 143)", () => {
  test("through the harness API", async (t) => {
    const s = await trialApi(t);
    await assert.rejects(
      s.call(
        "POST",
        "/v1/research/claim",
        claim({ quotes: [{ source: "s-1", quote: "v10.0.130" }] }),
      ),
      new RegExp(`400: \\{"error":"${SHORT}"\\}$`),
    );
  });

  test("through thermite-trial", async (t) => {
    const s = await trialApi(t);
    const body = claim({ quotes: [{ source: "s-1", quote: "v10.0.130" }] });
    await assert.rejects(
      trialCli(
        ["research", "add_claim", "-"],
        { harnessUrl: "http://h", auth: "trial.tok-1", workspace: ".", editablePaths: [] },
        s.call,
        async () => JSON.stringify(body),
      ),
      new RegExp(SHORT),
    );
  });

  test("through Pi's tool", async (t) => {
    const s = await trialApi(t);
    const [tool] = researchAgentTools(
      ["add_claim"],
      (op, args) => s.call("POST", `/v1/research/${op}`, args),
      { run: s.run, lane: "lane-1" },
      () => undefined,
    );
    await assert.rejects(
      (tool as NonNullable<typeof tool>).execute(
        "call-1",
        claim({ quotes: [{ source: "s-1", quote: "v10.0.130" }] }) as never,
      ),
      new RegExp(SHORT),
    );
  });
});

describe("a worker's bad input is a 400, never the harness's 500 (goal 125, T4)", () => {
  test("a report section's name it can't take", async (t) => {
    const s = await trialApi(t);
    await assert.rejects(
      s.call("POST", "/v1/research/section", { name: "../summary", body: "y" }),
      /^Error: 400: \{"error":"section names are short words"\}$/,
    );
    assert.deepEqual(await s.call("POST", "/v1/research/section", { name: "summary", body: "y" }), {
      section: "summary",
    });
  });
});
