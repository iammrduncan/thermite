import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { makeResearchRun } from "../helpers/research-run.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };

describe("a review's failed tries (goal 116)", () => {
  test("the supervisor posts a try it could not post; the harness keeps it with the review's run", async (t) => {
    const r = await makeResearchRun("r-1");
    t.after(() => r.close());
    const ledger = r.env.service.ledger;
    const review = Number(
      ledger.db
        .prepare(
          "insert into review (run, goal, commit_sha, package, requested_at) values ('r-1', 'research', 'items:0v1', '{}', ?) returning id",
        )
        .get(new Date().toISOString())?.id,
    );
    const api = createHarnessApi(r.env.service, tokens);
    const post = (path: string, body: unknown, token = tokens.supervisor) =>
      api.request(path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await post(`/v1/reviews/${review}/tries`, {
      try: 2,
      error: "2 of 3 reviewers of the review panel answered (reviewer-2: no answer)",
    });
    assert.equal(ok.status, 200);
    const ev = ledger.db
      .prepare("select subject, body from event where kind = 'review_try_failed'")
      .get() as { subject: string; body: string };
    assert.equal(ev.subject, "r-1");
    assert.deepEqual(JSON.parse(ev.body), {
      review,
      try: 2,
      error: "2 of 3 reviewers of the review panel answered (reviewer-2: no answer)",
    });
    // Only the supervisor posts one; a review that does not exist is refused.
    assert.equal(
      (await post(`/v1/reviews/${review}/tries`, { try: 1, error: "x" }, "prop-token")).status,
      401,
    );
    assert.notEqual((await post("/v1/reviews/999/tries", { try: 1, error: "x" })).status, 200);
  });
});
