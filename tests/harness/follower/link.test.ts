import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { followersOf } from "../../../src/harness/controller/judges.ts";
import { FollowerLink } from "../../../src/harness/judge/link.ts";

/**
 * Goal 205, step 1c: the leader's asks of its followers wait in the harness until the supervisor
 * takes them, and the follower's answer comes back through it.
 */

const outbox = () => mkdtempSync(join(tmpdir(), "thermite-link-"));

describe("the leader's link to its followers (goal 205)", () => {
  test("an ask waits for the supervisor, which takes it and brings the answer", async () => {
    const link = new FollowerLink({ outboxDir: outbox() });
    const asked = link.to("spark-02").ask({ op: "info" });
    const [item] = await link.take(1000);
    assert.equal(item?.machine, "spark-02");
    assert.deepEqual(item?.kind === "ask" && item.ask, { op: "info" });
    // Taken once: the next take has nothing.
    assert.deepEqual(await link.take(0), []);
    assert.equal(link.answer(String(item?.id), { answer: { type: "cpu" } }), true);
    assert.deepEqual(await asked, { type: "cpu" });
    // No ask is open under that id any more.
    assert.equal(link.answer(String(item?.id), { answer: {} }), false);
  });

  test("a take waits for an ask that comes meanwhile", async () => {
    const link = new FollowerLink({ outboxDir: outbox() });
    const taking = link.take(5000);
    setTimeout(() => void link.to("spark-02").ask({ op: "throttle" }), 20);
    const got = await taking;
    assert.equal(got.length, 1);
  });

  test("a refusal fails the ask with the follower's words", async () => {
    const link = new FollowerLink({ outboxDir: outbox() });
    const asked = link.to("spark-02").ask({ op: "throttle" });
    const [item] = await link.take(0);
    link.answer(String(item?.id), { error: "this follower has no judge card 3" });
    await assert.rejects(asked, /follower spark-02: this follower has no judge card 3/);
  });

  test("an ask nobody answers in time fails, so the judge tries its job again", async () => {
    const link = new FollowerLink({ outboxDir: outbox(), answerMs: 10 });
    const asked = link.to("spark-02").ask({ op: "info" });
    await link.take(0);
    await new Promise((r) => setTimeout(r, 30));
    await link.take(0);
    await assert.rejects(asked, /follower spark-02 gave no answer to its info in time/);
  });

  test("a git bundle waits as a file in the outbox for the supervisor", async () => {
    const dir = outbox();
    const link = new FollowerLink({ outboxDir: dir });
    const sent = link.to("spark-02").sendGit("proj", "a".repeat(40), Buffer.from("bundle"));
    const [item] = await link.take(0);
    assert.equal(item?.kind, "git");
    const file = item?.kind === "git" ? join(dir, item.file) : "";
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file, "utf8"), "bundle");
    link.answer(String(item?.id), { answer: { ok: true } });
    await sent;
  });
});

describe("THERMITE_FOLLOWERS (goal 205)", () => {
  test("each follower and its judge GPUs; not set, none", () => {
    assert.deepEqual(followersOf({ THERMITE_FOLLOWERS: "spark-02=1, spark-04=2" }), [
      { machine: "spark-02", cards: 1 },
      { machine: "spark-04", cards: 2 },
    ]);
    assert.deepEqual(followersOf({}), []);
    assert.throws(
      () => followersOf({ THERMITE_FOLLOWERS: "Spark=1" }),
      /"Spark=1" is not <machine>=<judge GPUs, 1 to 8>/,
    );
    assert.throws(() => followersOf({ THERMITE_FOLLOWERS: "spark-02=9" }), /1 to 8/);
  });
});
