import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { AdvisorsConfig } from "../../../../src/supervisor/advisors/index.ts";
import { limitIn } from "../../../../src/supervisor/advisors/limit.ts";
import {
  type AdviseConfig,
  type AdviseState,
  adviseOnce,
  emptyAdviseState,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";

/**
 * A headless advisor at a full usage window (the owner's decision of 2026-10-27, goal 169's
 * question 8): not a failed try. Its call is not counted, the advisor waits for the reset with its
 * open audits and reviews, Live says so, and they are tried again once it resets. Command-line
 * advisors stand in for the programs: each prints a usage limit with its reset on its error stream,
 * as a program does, until told to answer.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const LIMIT = "You've hit your usage limit (rate_limit_error): try again in 2 hours";

/** A command-line advisor: it notes each call, then meets the limit, or answers once `answer` exists. */
function advisor(dir: string, name: string, answer: unknown) {
  const calls = join(dir, `${name}.calls`);
  const go = join(dir, `${name}.answer`);
  const script = join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(calls)}, "x\\n");
if (fs.existsSync(${JSON.stringify(go)})) console.log(${JSON.stringify(JSON.stringify(answer))});
else { process.stderr.write(${JSON.stringify(LIMIT)}); process.exit(1); }
`,
  );
  return {
    runtime: { name, runtime: "cli", argv: [process.execPath, script], restricted: true },
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").length - 1 : 0),
    answer: () => appendFileSync(go, ""),
  };
}

function config(env: ReturnType<typeof makeJudgeEnv>, advisors: unknown, lines: string[]) {
  const api = createHarnessApi(env.service, tokens);
  const cfg: AdviseConfig = {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors: AdvisorsConfig.parse(advisors),
    retryMs: 0,
    live: (l) => lines.push(l.text),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      return api.request(`${url.pathname}${url.search}`, init as RequestInit);
    },
  };
  return cfg;
}

/** The advisor's window reset: its wait ends now. */
const reset = (state: AdviseState, name: string): AdviseState => ({
  ...state,
  limits: { ...state.limits, [name]: new Date(Date.now() - 1000).toISOString() },
});

describe("a headless advisor at a full usage window", () => {
  test("the words of a call's errors: a usage or rate limit with its reset, a weekly window's too", () => {
    const now = Date.parse("2026-11-01T10:00:00Z");
    assert.deepEqual(limitIn(LIMIT, now), {
      until: "2026-11-01T12:00:00.000Z",
      words: LIMIT,
    });
    // OpenAI's code for a full ChatGPT plan, which gives no reset: the 15 minutes agents wait.
    assert.equal(
      limitIn("subscription_sharing_usage_limit_exceeded", now)?.until,
      "2026-11-01T10:15:00.000Z",
    );
    // A weekly window: waited for too (the owner's decision of 2026-10-27).
    assert.equal(
      limitIn("usage limit: try again in 50 hours", now)?.until,
      "2026-11-03T12:00:00.000Z",
    );
    // No limit named, no reset given, or a reset past a week and a day: a failed try, as before.
    assert.equal(limitIn("connection reset, try again in 5 seconds", now), undefined);
    assert.equal(limitIn("usage limit reached", now), undefined);
    assert.equal(limitIn("usage limit: try again in 200 hours", now), undefined);
    assert.equal(limitIn(undefined, now), undefined);
  });

  test("an auditor's try is not counted: it waits for the reset, its audits with it, and answers then", async () => {
    const env = makeJudgeEnv({
      contract: {
        acceptance: {
          looks: [3, 6],
          confirm_blocks: 4,
          audit: { ratio_to_median: 3, absolute: 0.15 },
        },
      },
    });
    await env.service.applyCommand(env.assign);
    const id = (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(FAST_KERNEL), hypothesis: "h", known_flaws: [] },
        "t",
      )
    ).attempt;
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    const audit = Number(
      env.ledger.db.prepare("select id from audit where attempt = ?").get(id)?.id,
    );
    const dir = mkdtempSync(join(tmpdir(), "thermite-limit-"));
    const a = advisor(dir, "cli-auditor", {
      decision: "block",
      reasons: "the inner loop was removed",
      citations: ["diff"],
    });
    const lines: string[] = [];
    const cfg = config(env, { auditor: a.runtime }, lines);

    let state = await adviseOnce(cfg, emptyAdviseState());
    assert.equal(a.calls(), 1);
    assert.equal(state.tries[`audit:${audit}`], 0, "not counted");
    assert.equal(state.stats.errors, 0, "not a failure");
    const until = state.limits?.["cli-auditor"];
    assert.ok(until && Date.parse(until) - Date.now() > 110 * 60_000, `waits until ${until}`);
    assert.ok(
      lines.some((l) =>
        l.startsWith(
          `audit of ${id}: cli-auditor waits for its provider's usage limit to reset, until ${until}, and goes on then; it is not counted as a failed try.`,
        ),
      ),
      lines.join("\n"),
    );
    // More rounds than its tries while it waits: it is not called, and the audit never goes to
    // the owner.
    for (let n = 0; n < 6; n++) state = await adviseOnce(cfg, state);
    assert.equal(a.calls(), 1, "not called while it waits");
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    // The window resets: the audit is tried again at once, and its answer posted, on try 1.
    a.answer();
    state = await adviseOnce(cfg, reset(state, "cli-auditor"));
    assert.equal(a.calls(), 2);
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "audit_blocked");
    assert.equal(state.limits?.["cli-auditor"], undefined, "its wait is over");
    assert.ok(
      lines.some((l) => l.startsWith(`audit of ${id} (try 1): block`)),
      lines.join("\n"),
    );
  });

  test("a review in which a reviewer meets the limit is not posted or counted, and waits for that reviewer", async () => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 } });
    await env.service.applyCommand(env.assign);
    await env.drain();
    const dir = mkdtempSync(join(tmpdir(), "thermite-limit-"));
    const pass = { pass: true, reasons: "clear and small" };
    const one = advisor(dir, "reviewer-1", pass);
    const two = advisor(dir, "reviewer-2", pass);
    one.answer();
    const lines: string[] = [];
    const cfg = config(env, { review_panel: [one.runtime, two.runtime] }, lines);
    let state = await adviseOnce(cfg, emptyAdviseState());
    const review = Number(env.ledger.db.prepare("select id from review").get()?.id);
    assert.equal(state.tries[`review:${review}`], 0, "not counted");
    assert.ok(state.limits?.["reviewer-2"], "reviewer-2 waits");
    assert.equal(state.limits?.["reviewer-1"], undefined);
    const panel = () =>
      env.ledger.db.prepare("select panel_result from review where id = ?").get(review)
        ?.panel_result;
    assert.equal(panel(), null, "not posted");
    assert.ok(
      lines.some((l) =>
        l.startsWith(`review ${review}: reviewer-2 waits for its provider's usage limit`),
      ),
      lines.join("\n"),
    );
    // Past its tries while reviewer-2 waits: the review is not tried, nor posted as failed.
    for (let n = 0; n < 6; n++) state = await adviseOnce(cfg, state);
    assert.equal(two.calls(), 1, "not called while it waits");
    assert.equal(panel(), null);
    // Its window resets: the review is tried again and posted.
    two.answer();
    state = await adviseOnce(cfg, reset(state, "reviewer-2"));
    assert.equal(two.calls(), 2);
    assert.equal(panel(), "review_passed");
  });
});
