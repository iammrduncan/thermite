import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ownerAsks } from "../../../src/harness/service/champion.ts";
import type { HarnessService } from "../../../src/harness/service/index.ts";

/**
 * Goal 212: a confirmed win whose verdict names guards that ask waits for the owner, with them in
 * words, though the run promotes on its own; one whose verdict names none promotes as before.
 */

function service(verdict: Record<string, unknown> | undefined): HarnessService {
  return {
    promotionFor: () => "auto",
    askFor: () => ({}),
    ledger: {
      latestEventBody: (kind: string, subject: string) =>
        kind === "verdict" && subject === "a-1" ? verdict : undefined,
    },
  } as unknown as HarnessService;
}

const attempt = { id: "a-1", known_flaws: "[]" };

describe("a guard that asks, at promotion (goal 212)", () => {
  test("a win past a guard that asks waits for the owner, with the guard in words", () => {
    const asks = ["kl/n256: mean 0.2 is not at most 0", "kl/n512: mean 0.3 is not at most 0"];
    assert.equal(
      ownerAsks(service({ verdict: "win_confirmed", asks }), "r-1", attempt, 0.05),
      "a guard asks you before this change is kept: kl/n256: mean 0.2 is not at most 0; kl/n512: mean 0.3 is not at most 0",
    );
  });

  test("a win that keeps every guard that asks promotes on its own, as before", () => {
    assert.equal(ownerAsks(service({ verdict: "win_confirmed" }), "r-1", attempt, 0.05), undefined);
    assert.equal(ownerAsks(service(undefined), "r-1", attempt, 0.05), undefined);
  });
});
