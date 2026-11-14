import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { rowsBehind, tablesBehind } from "../../src/control/store/behind.ts";
import { type ControlStore, openControlStore } from "../../src/control/store/index.ts";
import { type StoreWaits, setStoreWaits } from "../../src/control/store/waits.ts";

/**
 * What the tests of control's transactions share (tests/control/together/): each place outside
 * the store that opens a transaction keeps its changes together or drops them together, and a
 * read a write relies on is one piece with the write.
 */

/** Every table of the store with its rows, as the database has them now. */
export type Rows = Record<string, unknown[]>;

/**
 * Every row of every table, read behind the interface: a dropped transaction leaves the whole
 * store as it was, not only the rows a test thought of.
 */
async function everyRow(store: ControlStore): Promise<Rows> {
  const out: Rows = {};
  const text = (row: unknown) =>
    JSON.stringify(row, (_, v) => (typeof v === "bigint" ? String(v) : v));
  // In an order of their own: a store gives a table's rows in no order that a write keeps.
  for (const name of await tablesBehind(store))
    out[name] = (await rowsBehind(store, `select * from "${name}"`))
      .map((row) => ({ row, as: text(row) }))
      .sort((a, b) => (a.as < b.as ? -1 : a.as > b.as ? 1 : 0))
      .map((r) => r.row);
  return out;
}

/** The tables whose rows differ between two readings of the store, by name. */
function changedTables(before: Rows, after: Rows): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => {
      try {
        assert.deepStrictEqual(after[name], before[name]);
        return false;
      } catch {
        return true;
      }
    })
    .sort();
}

/** The rows of one table now, behind the interface, for a table no call of the store gives. */
export function rowsOf(store: ControlStore, table: string): Promise<Record<string, unknown>[]> {
  return rowsBehind(store, `select * from "${table}"`);
}

/** The failure the tests put in a write's place: what a store that cannot write says. */
export const WRITE_FAILED = "disk I/O error";

type Calls = Record<string, (...args: never[]) => Promise<unknown>>;

/**
 * Puts a call that fails in the place of `name` on a part of the store's interface, as a store
 * that cannot write fails it. `when` says which calls fail (every one unless given); the others
 * go to the store. Gives the function that puts the store's own call back.
 */
export function failWrite<P extends object>(
  part: P,
  name: keyof P & string,
  when: (...args: unknown[]) => boolean = () => true,
): () => void {
  const calls = part as unknown as Calls;
  const own = calls[name];
  assert.equal(typeof own, "function", `the store's interface has ${name}`);
  calls[name] = async (...args: never[]) => {
    if (when(...(args as unknown[]))) throw new Error(WRITE_FAILED);
    return (own as (...a: never[]) => Promise<unknown>).apply(part, args);
  };
  return () => {
    calls[name] = own as Calls[string];
  };
}

/**
 * A transaction the code under test opened, as the helpers below follow it: the outermost one.
 * Work it started that goes on after it ended is no longer its own.
 */
interface Followed {
  open: boolean;
}

/** One transaction on the store as a test saw it: the outermost one, with its savepoints. */
export interface SeenTx {
  /** Every row as the transaction found the store, and as it left it. */
  before: Rows;
  after: Rows;
  /** The tables it left with other rows than it found: none when it was dropped. */
  changed: string[];
  /** Whether its function failed, so the store dropped it. */
  failed: boolean;
}

/** What `code` did: what it gave or how it failed, and each transaction it opened, in order. */
export interface Watched<T> {
  out: T | undefined;
  threw: Error | undefined;
  txs: SeenTx[];
}

/**
 * Runs `code` and reads the whole store as each of its transactions opens and as it ends, kept
 * or dropped. What a transaction changed is told apart from what the code, or another caller,
 * wrote before it or after it, outside it: a write made after a dropped transaction is kept, and
 * is not in `changed`. Never fails: what the code threw is in `threw`.
 *
 * Both readings are made with the store held, so no other caller's write is in them: each of the
 * code's transactions runs inside one of this helper's own, as a savepoint of it, and the store
 * is read before the code's transaction begins and after it was kept or dropped.
 */
export async function watched<T>(store: ControlStore, code: () => Promise<T>): Promise<Watched<T>> {
  const txs: SeenTx[] = [];
  const inside = new AsyncLocalStorage<Followed>();
  const ownTx = store.tx;
  (store as { tx: ControlStore["tx"] }).tx = <R>(fn: () => Promise<R>) => {
    // A transaction inside another is a savepoint of it: the outer one is the one read.
    if (inside.getStore()?.open) return ownTx(fn);
    const mine: Followed = { open: true };
    return ownTx(async () => {
      const before = await everyRow(store);
      let failed = false;
      try {
        return await ownTx(() => inside.run(mine, fn));
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        mine.open = false;
        const after = await everyRow(store);
        txs.push({ before, after, changed: changedTables(before, after), failed });
      }
    });
  };
  try {
    return { out: await code(), threw: undefined, txs };
  } catch (err) {
    return { out: undefined, threw: err instanceof Error ? err : new Error(String(err)), txs };
  } finally {
    (store as { tx: ControlStore["tx"] }).tx = ownTx;
  }
}

/**
 * Runs `code` with the store's write `part[name]` failing (failWrite), then puts the write back.
 * What watched() gives.
 */
export async function withWriteFailing<T, P extends object>(
  store: ControlStore,
  part: P,
  name: keyof P & string,
  code: () => Promise<T>,
  when?: (...args: unknown[]) => boolean,
): Promise<Watched<T>> {
  const putBack = failWrite(part, name, when);
  try {
    return await watched(store, code);
  } finally {
    putBack();
  }
}

/** What each transaction did, without its rows: whether it was dropped, and the tables it changed. */
export const seen = (w: { txs: SeenTx[] }) =>
  w.txs.map((t) => ({ failed: t.failed, changed: t.changed }));

/** What one transaction that failed leaves: nothing. */
export const DROPPED = [{ failed: true, changed: [] }];

/** How the stores opened now wait, found by asking one: the setting itself is not read back. */
async function storeWaitsNow(): Promise<StoreWaits> {
  const store = openControlStore(":memory:");
  let turned = false;
  setImmediate(() => {
    turned = true;
  });
  await store.ownSettings.get("a");
  await store.close();
  return turned ? "turn" : "none";
}

/**
 * Runs `fn` on stores whose every call takes a turn of the event loop, as a store on a server:
 * the stores `fn` opens. Afterwards stores wait as they did before, which is "turn" too when the
 * whole suite runs so.
 */
export async function withTurns<T>(fn: () => Promise<T>): Promise<T> {
  const was = await storeWaitsNow();
  setStoreWaits("turn");
  try {
    return await fn();
  } finally {
    setStoreWaits(was);
  }
}

/** A promise and the function that keeps it. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open = () => {};
  const opened = new Promise<void>((done) => {
    open = done;
  });
  return { open, opened };
}

/** What happened, in order, while another caller changed what a transaction had read. */
export interface Held<T> {
  /** What the code gave. */
  out: T;
  /**
   * "read" when the transaction had made its read, "ended" when its work ended (its function
   * answered, and the store keeps or drops it next), "other" when the other caller's change was
   * done. A transaction that holds the other caller gives them in this order; "other" before
   * "ended" is a change made between the read and the write.
   */
  order: ("read" | "ended" | "other")[];
}

/** A turn of the event loop: everything else that is due runs first. */
const turn = (): Promise<void> => new Promise((done) => setImmediate(done));

/**
 * How many turns of the event loop a transaction is kept open after its read, so that another
 * caller the store did not hold has the time to make its change: more than the store calls any
 * of the tests' other callers makes.
 */
const TURNS_HELD_OPEN = 200;

/**
 * Runs `code`, which opens a transaction on `store` that reads with `part[read]` and writes by
 * what it read. Once the transaction has that read's answer, another caller starts `other`,
 * which changes what was read, and the transaction is kept open for many turns of the event
 * loop before it goes on to its write: a caller the store does not hold makes its change in that
 * time, between the read and the write. Gives what the code gave and the order of the read, the
 * end of the transaction's work and the other caller's change. A transaction holds the other
 * caller until it ends, so its write is decided by what it read and the other's change comes
 * after it.
 *
 * Fails when the read was not made inside a transaction: then nothing held the other caller.
 */
export async function withAnotherCaller<T, P extends object>(
  store: ControlStore,
  part: P,
  read: keyof P & string,
  code: () => Promise<T>,
  other: () => Promise<unknown>,
): Promise<Held<T>> {
  const order: Held<T>["order"] = [];
  const inside = new AsyncLocalStorage<Followed>();
  const seenRead = gate();
  let readIn: Followed | undefined;
  const calls = part as unknown as Calls;
  const ownRead = calls[read];
  assert.equal(typeof ownRead, "function", `the store's interface has ${read}`);
  const ownTx = store.tx;
  (store as { tx: ControlStore["tx"] }).tx = <R>(fn: () => Promise<R>) => {
    // A transaction inside another is a savepoint of it: the outer one is the one followed.
    if (inside.getStore()?.open) return ownTx(fn);
    const mine: Followed = { open: true };
    return ownTx(() =>
      inside.run(mine, async () => {
        try {
          return await fn();
        } finally {
          // Noted inside the transaction, before the store lets any other caller in.
          mine.open = false;
          if (readIn === mine) order.push("ended");
        }
      }),
    );
  };
  calls[read] = async (...args: never[]) => {
    const answer = await (ownRead as (...a: never[]) => Promise<unknown>).apply(part, args);
    const mine = inside.getStore();
    if (mine?.open && !readIn) {
      readIn = mine;
      order.push("read");
      seenRead.open();
      // A test alone waits for something else inside a transaction: to hold it open.
      for (let i = 0; i < TURNS_HELD_OPEN; i++) await turn();
    }
    return answer;
  };
  // Asked for here, outside the transaction, so it is another caller's work, not the
  // transaction's own: whose work a call is follows where it was asked for.
  const changed = seenRead.opened.then(async () => {
    if (!readIn) return;
    await other();
    order.push("other");
  });
  try {
    const out = await code();
    assert.ok(readIn, `${read} was called inside a transaction`);
    await changed;
    return { out, order };
  } finally {
    (store as { tx: ControlStore["tx"] }).tx = ownTx;
    calls[read] = ownRead as Calls[string];
    // A read that was never made leaves the other caller waiting: let it go, with nothing to do.
    seenRead.open();
    await changed.catch(() => {});
  }
}

/** The order a transaction that holds the other caller gives. */
export const HELD = ["read", "ended", "other"] as const;
