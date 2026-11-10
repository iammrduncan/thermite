import assert from "node:assert/strict";
import { test } from "node:test";
import { TypingQueue } from "../../../src/agents/cli/typing.ts";

/**
 * One terminal's typing (goals 169 and 241): the loop's and the owner's inputs go in one after
 * another, and an input that must start by a time is either typed or refused, never both.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Work that holds the queue until `release` is called, as the loop's long first message does. */
function holding() {
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  return { work: () => held, release };
}

test("what is queued goes in in order, and one that fails does not hold up the next", async () => {
  const q = new TypingQueue();
  const went: string[] = [];
  const a = q.type(async () => {
    await sleep(20);
    went.push("a");
  });
  const b = q.type(async () => {
    went.push("b");
    throw new Error("b failed");
  });
  const c = q.type(async () => {
    went.push("c");
    return "c";
  });
  await a;
  await assert.rejects(b, /b failed/);
  assert.equal(await c, "c");
  assert.deepEqual(went, ["a", "b", "c"]);
});

test("an input still waiting at its time is refused then, and never typed, even after what held it ends (goal 241)", async () => {
  const q = new TypingQueue();
  const first = holding();
  const loop = q.type(first.work);
  const typed: string[] = [];
  const t0 = Date.now();
  const owner = q.typeBy(
    async () => {
      typed.push("OWNER");
    },
    Date.now() + 50,
    "still taking what went in before it, so nothing was typed",
  );
  await assert.rejects(owner, /still taking what went in before it, so nothing was typed/);
  // Refused at its time, while the loop still held the queue: not when the loop ended.
  assert.ok(Date.now() - t0 < 1000);
  first.release();
  await loop;
  // What comes after it still goes in, and the refused input never did.
  await q.type(async () => {
    typed.push("NEXT");
  });
  assert.deepEqual(typed, ["NEXT"]);
});

test("an input that starts before its time goes on past it, and is typed once", async () => {
  const q = new TypingQueue();
  const typed: string[] = [];
  const done = await q.typeBy(
    async () => {
      // Typing that takes longer than the time left: it started in time, so it is not refused.
      await sleep(80);
      typed.push("OWNER");
      return "typed";
    },
    Date.now() + 20,
    "never",
  );
  assert.equal(done, "typed");
  assert.deepEqual(typed, ["OWNER"]);
});

test("an input whose own typing fails is refused with that failure", async () => {
  const q = new TypingQueue();
  await assert.rejects(
    q.typeBy(
      async () => {
        throw new Error("the program ended");
      },
      Date.now() + 5000,
      "never",
    ),
    /the program ended/,
  );
});
