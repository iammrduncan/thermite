import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sqliteBehind } from "../../../src/control/store/behind.ts";
import { type ControlStore, openControlStore } from "../../../src/control/store/index.ts";
import { setStoreWaits } from "../../../src/control/store/waits.ts";

/**
 * The store's interface (goal 267): each call gives its answer later, SQLite stays behind it, and
 * a transaction's work stays whole while it waits between its calls.
 */

/** A promise and the function that keeps it, for a test that holds a transaction open. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open = () => {};
  const opened = new Promise<void>((done) => {
    open = done;
  });
  return { open, opened };
}

/** The setting `key` as the database has it now, read behind the interface: no turn is waited for. */
const kept = (store: ControlStore, key: string): string | undefined =>
  (
    sqliteBehind(store).db.prepare("select value from control_setting where key = ?").get(key) as
      | { value: string }
      | undefined
  )?.value;

describe("the store's interface", () => {
  test("every sub-store of the SQLite store is on the interface, and each of its calls waits", async () => {
    const store = openControlStore(":memory:");
    const sqlite = sqliteBehind(store);
    const parts = Object.entries(sqlite).filter(
      ([name]) => name !== "db" && name !== "path" && name !== "knowledge",
    );
    assert.ok(parts.length > 35, "the sub-stores were found");
    let calls = 0;
    for (const [name, part] of parts) {
      const face = (store as unknown as Record<string, Record<string, unknown>>)[name];
      assert.ok(face, `the interface has ${name}`);
      for (const method of Object.getOwnPropertyNames(Object.getPrototypeOf(part))) {
        if (method === "constructor") continue;
        assert.equal(typeof face[method], "function", `${name}.${method} is on the interface`);
        calls++;
      }
    }
    assert.ok(calls > 300, "the calls were found");
    // A call gives a promise, whatever it gives behind; one that fails gives a promise that fails.
    const listed: unknown = store.reportedRigs.list();
    assert.ok(listed instanceof Promise);
    assert.deepEqual(await listed, []);
    const set: unknown = store.ownSettings.set("a", "1", "test");
    assert.ok(set instanceof Promise);
    assert.equal(await set, undefined);
    await store.close();
    const after: unknown = store.reportedRigs.list();
    assert.ok(after instanceof Promise, "a failure is a promise that fails, not a throw");
    await assert.rejects(after);
  });

  test("the knowledge base is made at its first call, in that call's turn, not when it is asked for", async () => {
    const store = openControlStore(":memory:");
    const made = () =>
      (sqliteBehind(store) as unknown as { knowledge?: object }).knowledge !== undefined;
    const kb = store.kb();
    assert.equal(made(), false, "asking for it makes nothing: making it writes to the store");
    assert.equal(store.kb(), kb, "the same one each time");
    assert.deepEqual(await kb.files.orphans(new Date().toISOString(), 10), []);
    assert.equal(made(), true, "its first call made it");
    await store.close();
  });

  test("the types refuse a caller that does not wait, and give no way to the database", async () => {
    const store = openControlStore(":memory:");
    // @ts-expect-error A call gives a promise: its answer is not there until it is waited for.
    const rigs: unknown[] = store.reportedRigs.list();
    await rigs;
    // @ts-expect-error A promise is no setting: the value is read from what the wait gives.
    const value: string | undefined = store.ownSettings.get("a")?.value;
    assert.equal(value, undefined);
    // @ts-expect-error The interface has no database: all SQL is in the store's folder.
    assert.equal(store.db, undefined);
    // @ts-expect-error A transaction's function waits: one that gives no promise is refused.
    await store.tx(() => 1);
    await store.close();
  });
});

describe("a transaction on the store", () => {
  test("keeps all of its calls, or none of them", async () => {
    const store = openControlStore(":memory:");
    const out = await store.tx(async () => {
      await store.ownSettings.set("a", "1", "test");
      await store.ownSettings.set("b", "2", "test");
      return "done";
    });
    assert.equal(out, "done");
    assert.equal((await store.ownSettings.get("a"))?.value, "1");
    assert.equal((await store.ownSettings.get("b"))?.value, "2");
    await assert.rejects(
      store.tx(async () => {
        await store.ownSettings.set("a", "changed", "test");
        await store.ownSettings.set("c", "3", "test");
        throw new Error("the second write failed");
      }),
      /the second write failed/,
    );
    assert.equal((await store.ownSettings.get("a"))?.value, "1", "the first write was dropped");
    assert.equal(await store.ownSettings.get("c"), undefined);
    // The store goes on after a dropped transaction, and the next one is its own.
    await store.tx(async () => store.ownSettings.set("c", "3", "test"));
    assert.equal((await store.ownSettings.get("c"))?.value, "3");
    await store.close();
  });

  test("inside another is a savepoint: it is dropped alone, and kept with the outer one", async () => {
    const store = openControlStore(":memory:");
    await store.tx(async () => {
      await store.ownSettings.set("outer", "1", "test");
      await assert.rejects(
        store.tx(async () => {
          await store.ownSettings.set("inner", "1", "test");
          throw new Error("inner");
        }),
      );
      await store.tx(async () => store.ownSettings.set("kept", "1", "test"));
    });
    assert.equal((await store.ownSettings.get("outer"))?.value, "1");
    assert.equal(await store.ownSettings.get("inner"), undefined);
    assert.equal((await store.ownSettings.get("kept"))?.value, "1");
    await assert.rejects(
      store.tx(async () => {
        await store.tx(async () => store.ownSettings.set("gone", "1", "test"));
        throw new Error("outer");
      }),
    );
    assert.equal(await store.ownSettings.get("gone"), undefined, "dropped with the outer one");
    await store.close();
  });

  test("holds every other caller until it ends: their work is not kept or dropped with it", async () => {
    const store = openControlStore(":memory:");
    const hold = gate();
    const order: string[] = [];
    const first = store
      .tx(async () => {
        await store.ownSettings.set("mine", "1", "test");
        order.push("the transaction wrote");
        // A test alone waits for something else inside a transaction: to hold it open.
        await hold.opened;
        await store.ownSettings.set("mine", "2", "test");
        throw new Error("dropped");
      })
      .catch((err: Error) => order.push(`the transaction ended: ${err.message}`));
    // Another caller's write and read, asked while the transaction is open.
    const write = store.ownSettings.set("other", "1", "test").then(() => order.push("other wrote"));
    const read = store.ownSettings.get("mine").then((r) => order.push(`other read ${r?.value}`));
    // Another transaction, asked while the first is open.
    const second = store
      .tx(async () => {
        order.push("the second transaction began");
        await store.ownSettings.set("second", "1", "test");
      })
      .then(() => order.push("the second transaction ended"));
    for (let i = 0; i < 5; i++) await new Promise((turn) => setImmediate(turn));
    assert.deepEqual(order, ["the transaction wrote"], "nothing else ran while it was open");
    assert.equal(kept(store, "other"), undefined);
    hold.open();
    await Promise.all([first, write, read, second]);
    // The others ran once it ended, in the order they asked: the read saw none of its writes.
    assert.deepEqual([...order].sort(), [
      "other read undefined",
      "other wrote",
      "the second transaction began",
      "the second transaction ended",
      "the transaction ended: dropped",
      "the transaction wrote",
    ]);
    assert.equal(order.at(-1), "the second transaction ended");
    assert.equal(kept(store, "mine"), undefined, "the transaction's writes were dropped");
    assert.equal(kept(store, "other"), "1", "the other caller's write was not dropped with it");
    assert.equal(kept(store, "second"), "1");
    await store.close();
  });

  test("lets its own work through, side by side too, and a sub-store's own transaction inside it", async () => {
    const store = openControlStore(":memory:");
    await store.tx(async () => {
      await Promise.all([
        store.ownSettings.set("a", "1", "test"),
        store.ownSettings.set("b", "1", "test"),
        store.tx(async () => store.ownSettings.set("c", "1", "test")),
      ]);
      // The live lines' store runs a transaction of its own behind the interface: a savepoint of
      // this one.
      await store.liveLines.add(
        "rig-a",
        "log-1",
        [{ seq: 1, at: new Date().toISOString(), source: "harness", kind: "log", text: "x" }],
        true,
      );
      assert.equal((await store.ownSettings.get("c"))?.value, "1");
    });
    assert.equal(kept(store, "a"), "1");
    assert.equal(kept(store, "b"), "1");
    assert.equal(kept(store, "c"), "1");
    assert.equal((await store.liveLines.tail("rig-a", 10)).length, 1);
    await store.close();
  });

  test("work started inside it, and still going after it ended, is another caller's from then on", async () => {
    const store = openControlStore(":memory:");
    const hold = gate();
    const started: Promise<void>[] = [];
    await store.tx(async () => {
      await store.ownSettings.set("a", "1", "test");
      started.push(hold.opened.then(() => store.ownSettings.set("late", "1", "test")));
    });
    const next = store.tx(async () => {
      await store.ownSettings.set("b", "1", "test");
      hold.open();
      for (let i = 0; i < 3; i++) await store.ownSettings.get("b");
      assert.equal(kept(store, "late"), undefined, "it waits for the transaction that is open");
    });
    await Promise.all([next, ...started]);
    assert.equal(kept(store, "late"), "1");
    await store.close();
  });
});

describe("what is done once a transaction is kept", () => {
  test("is done at once outside a transaction, and when the outermost one is kept inside one", async () => {
    const store = openControlStore(":memory:");
    const done: string[] = [];
    store.onceKept(() => done.push("outside"));
    assert.deepEqual(done, ["outside"], "no transaction holds it: at once");
    await store.tx(async () => {
      await store.ownSettings.set("a", "1", "test");
      store.onceKept(() => done.push(`kept, with a = ${kept(store, "a")}`));
      await store.tx(async () => {
        store.onceKept(() => done.push("the savepoint's"));
      });
      assert.deepEqual(done, ["outside"], "not before the outermost one is kept");
    });
    assert.deepEqual(done, ["outside", "kept, with a = 1", "the savepoint's"]);
    await store.close();
  });

  test("is never done for a transaction that is dropped, or for a savepoint dropped inside a kept one", async () => {
    const store = openControlStore(":memory:");
    const done: string[] = [];
    await assert.rejects(
      store.tx(async () => {
        store.onceKept(() => done.push("dropped"));
        await store.tx(async () => {
          store.onceKept(() => done.push("kept inside the dropped one"));
        });
        throw new Error("dropped");
      }),
    );
    await store.tx(async () => {
      await assert.rejects(
        store.tx(async () => {
          store.onceKept(() => done.push("the dropped savepoint's"));
          throw new Error("the savepoint is dropped");
        }),
      );
      store.onceKept(() => done.push("the kept one's"));
    });
    assert.deepEqual(done, ["the kept one's"]);
    await store.close();
  });

  test("its own failure fails nothing: the transaction is kept, and the rest is done", async () => {
    const store = openControlStore(":memory:");
    const done: string[] = [];
    await store.tx(async () => {
      await store.ownSettings.set("a", "1", "test");
      store.onceKept(() => {
        throw new Error("the bus is away");
      });
      store.onceKept(() => done.push("the next one"));
    });
    assert.equal(kept(store, "a"), "1");
    assert.deepEqual(done, ["the next one"]);
    await store.close();
  });
});

describe("a store whose calls take a turn of the event loop", () => {
  test("answers a call only after everything else that was due", async () => {
    const turnsBefore = async (store: ControlStore): Promise<number> => {
      let turns = 0;
      let going = true;
      const count = () => {
        if (!going) return;
        turns++;
        setImmediate(count);
      };
      setImmediate(count);
      await store.ownSettings.get("a");
      going = false;
      return turns;
    };
    const was = setStoreWaits("none");
    try {
      const plain = openControlStore(":memory:");
      assert.equal(await turnsBefore(plain), 0, "SQLite's answer is there with no turn between");
      await plain.close();
      setStoreWaits("turn");
      const slow = openControlStore(":memory:");
      assert.ok((await turnsBefore(slow)) >= 1, "the call took a turn");
      // It is the same store: a transaction holds the others through its turns.
      const order: string[] = [];
      const tx = slow.tx(async () => {
        await slow.ownSettings.set("a", "1", "test");
        await slow.ownSettings.set("a", "2", "test");
        order.push("the transaction's writes");
      });
      const other = slow.ownSettings.get("a").then((r) => order.push(`read ${r?.value}`));
      await Promise.all([tx, other]);
      assert.deepEqual(order, ["the transaction's writes", "read 2"]);
      await slow.close();
    } finally {
      setStoreWaits(was);
    }
  });
});
