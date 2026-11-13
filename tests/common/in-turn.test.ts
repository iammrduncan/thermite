import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  eachInTurn,
  everyInTurn,
  filterInTurn,
  findInTurn,
  flatMapInTurn,
  mapInTurn,
  someInTurn,
} from "../../src/common/in-turn.ts";

/** A function that waits a turn of the event loop before it answers, and notes when it ran. */
function waiting<T, U>(seen: string[], fn: (x: T, i: number) => U) {
  return async (x: T, i: number): Promise<U> => {
    seen.push(`start ${String(x)}`);
    await new Promise((turn) => setImmediate(turn));
    seen.push(`end ${String(x)}`);
    return fn(x, i);
  };
}

describe("an array's methods for a function that waits", () => {
  test("each item's call ends before the next item's starts, in the array's order", async () => {
    const seen: string[] = [];
    assert.deepEqual(
      await mapInTurn(
        [1, 2, 3],
        waiting(seen, (x, i) => x * 10 + i),
      ),
      [10, 21, 32],
    );
    assert.deepEqual(seen, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
    seen.length = 0;
    await eachInTurn(
      ["a", "b"],
      waiting(seen, () => undefined),
    );
    assert.deepEqual(seen, ["start a", "end a", "start b", "end b"]);
  });

  test("they answer as the array's own methods do", async () => {
    const items = [1, 2, 3, 4];
    const no: string[] = [];
    assert.deepEqual(
      await mapInTurn(items, (x) => x + 1),
      items.map((x) => x + 1),
      "a function that does not wait is taken too",
    );
    assert.deepEqual(
      await flatMapInTurn(
        items,
        waiting(no, (x) => (x % 2 ? [x, x] : [])),
      ),
      items.flatMap((x) => (x % 2 ? [x, x] : [])),
    );
    assert.deepEqual(
      await flatMapInTurn(items, async (x) => x),
      items.flatMap((x) => x),
      "a value that is no array is one item",
    );
    assert.deepEqual(
      await filterInTurn(
        items,
        waiting(no, (x) => x > 2),
      ),
      [3, 4],
    );
    assert.equal(
      await findInTurn(
        items,
        waiting(no, (x) => x > 2),
      ),
      3,
    );
    assert.equal(
      await findInTurn(
        items,
        waiting(no, (x) => x > 9),
      ),
      undefined,
    );
    assert.equal(
      await someInTurn(
        items,
        waiting(no, (x) => x === 2),
      ),
      true,
    );
    assert.equal(
      await someInTurn(
        items,
        waiting(no, (x) => x === 9),
      ),
      false,
    );
    assert.equal(
      await everyInTurn(
        items,
        waiting(no, (x) => x > 0),
      ),
      true,
    );
    assert.equal(
      await everyInTurn(
        items,
        waiting(no, (x) => x < 2),
      ),
      false,
    );
    assert.deepEqual(await mapInTurn([], async () => 1), []);
    assert.equal(await everyInTurn([], async () => false), true);
    assert.equal(await someInTurn([], async () => true), false);
  });

  test("find, some and every end at the item that settles them", async () => {
    const seen: string[] = [];
    await findInTurn(
      [1, 2, 3],
      waiting(seen, (x) => x === 2),
    );
    assert.deepEqual(seen, ["start 1", "end 1", "start 2", "end 2"]);
    seen.length = 0;
    await someInTurn(
      [1, 2, 3],
      waiting(seen, (x) => x === 1),
    );
    assert.deepEqual(seen, ["start 1", "end 1"]);
    seen.length = 0;
    await everyInTurn(
      [1, 2, 3],
      waiting(seen, (x) => x > 1),
    );
    assert.deepEqual(seen, ["start 1", "end 1"]);
  });

  test("a call that fails ends the whole, and no later item is called", async () => {
    const seen: number[] = [];
    await assert.rejects(
      mapInTurn([1, 2, 3], async (x) => {
        seen.push(x);
        if (x === 2) throw new Error("the second failed");
        return x;
      }),
      /the second failed/,
    );
    assert.deepEqual(seen, [1, 2]);
  });
});
