import { AsyncLocalStorage } from "node:async_hooks";
import { errorText } from "../../../common/errors.ts";
import { log } from "../../../common/log.ts";
import type { Sql } from "../../../common/postgres.ts";

/**
 * The order of the PostgreSQL store's calls (goal 268). The store has one connection and one
 * process that writes, as the SQLite store has, so its calls keep the SQLite store's order:
 *
 * - one call at a time, each whole: a call's statements never mix with another call's;
 * - while a transaction is open, only its own work calls the store, and every other caller
 *   waits until it ends.
 *
 * A call's statements wait for the server, so the order is kept here: each caller waits its
 * turn. The work a transaction's function does, and waits for, is known by the asynchronous
 * context it runs in, and takes its turns among the transaction's own calls.
 */
export class Order {
  /** The transactions open now, the outermost first. Each is known by an object of its own. */
  private readonly open: object[] = [];
  private readonly inside = new AsyncLocalStorage<object>();
  /** What each open transaction's work asked to be done once it is kept (onceKept). */
  private readonly after = new Map<object, (() => void)[]>();
  /** Where the callers outside every transaction take their turns. */
  private readonly outside = {};
  /** The end of each line of callers: the last one's turn, by where they wait. */
  private readonly last = new Map<object, Promise<void>>();
  /** The store's start (start), which every call waits for; none until it is given. */
  private started: Promise<void> = Promise.resolve();

  /**
   * Runs `fn` as the store's start, before every call: each call then waits for it, and fails
   * with its error when it failed, so no call reaches a store that is not at this code's version.
   */
  start(fn: () => Promise<void>): void {
    this.started = this.turn(fn);
    // Each call reports the failure to its own caller: here it is not one more, unhandled.
    this.started.catch(() => {});
  }

  /** Where the caller takes its turn: among the innermost open transaction's work, or outside. */
  private where(): object {
    const mine = this.inside.getStore();
    return mine !== undefined && this.open.includes(mine) ? mine : this.outside;
  }

  /** Runs `fn` when every caller before it, in the same line, has ended. */
  private async turn<R>(fn: () => Promise<R>): Promise<R> {
    const line = this.where();
    const before = this.last.get(line) ?? Promise.resolve();
    let end: () => void = () => {};
    const mine = before.then(
      () =>
        new Promise<void>((done) => {
          end = done;
        }),
    );
    this.last.set(line, mine);
    await before;
    try {
      return await fn();
    } finally {
      end();
      if (this.last.get(line) === mine) this.last.delete(line);
    }
  }

  /** Answers when the store's start has ended, and fails as it failed. */
  ready(): Promise<void> {
    return this.started;
  }

  /** Runs one call of the store behind, in its turn, whole. */
  call<R>(fn: () => Promise<R> | R): Promise<R> {
    return this.turn(async () => {
      await this.started;
      return fn();
    });
  }

  /**
   * Runs `fn` in one transaction: all of its calls to the store are kept, or none. Its own calls
   * go on while it is open; every other caller waits until it ends.
   */
  tx<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
    return this.turn(async () => {
      await this.started;
      const mine = {};
      let kept = false;
      try {
        const out = await sql.tx(() => {
          this.open.push(mine);
          this.after.set(mine, []);
          return this.inside.run(mine, fn);
        });
        kept = true;
        return out;
      } finally {
        // Kept or dropped by now. A transaction that could not start is not among the open ones.
        const at = this.open.lastIndexOf(mine);
        const after = this.after.get(mine) ?? [];
        this.after.delete(mine);
        if (at >= 0) this.open.splice(at, 1);
        // What it asked to be done once kept: handed to the transaction it is a savepoint of,
        // done now when it is the outermost, and forgotten when it was dropped.
        const outer = at > 0 ? this.open[at - 1] : undefined;
        if (kept && outer) this.after.get(outer)?.push(...after);
        else if (kept) for (const done of after) this.run(done);
      }
    });
  }

  /**
   * Does `fn` once what the caller wrote is kept: at once when no transaction holds the caller's
   * work; else when the outermost transaction that holds it is kept, and never when that one, or
   * a savepoint between, is dropped.
   */
  onceKept(fn: () => void): void {
    const mine = this.inside.getStore();
    const list = mine === undefined ? undefined : this.after.get(mine);
    if (list) list.push(fn);
    else this.run(fn);
  }

  /** Runs what was asked for once kept. Its failure is its own: the transaction is kept. */
  private run(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const what = { error: errorText(err) };
      log("control", "work asked for once a transaction was kept failed", what, "error");
    }
  }
}

/**
 * `part` as its callers see it: each of its calls taken in its turn. The methods named in `asIs`
 * stay as they are: they answer at once, and keep nothing in the store.
 */
export function inOrder<T extends object>(
  part: () => T,
  methods: object,
  order: Order,
  asIs: readonly string[] = [],
): T {
  const out: Record<string, unknown> = {};
  for (let at = methods; at !== Object.prototype; at = Object.getPrototypeOf(at))
    for (const name of Object.getOwnPropertyNames(at)) {
      if (name === "constructor" || name in out) continue;
      if (typeof Object.getOwnPropertyDescriptor(at, name)?.value !== "function") continue;
      const method = (on: object) => (on as Record<string, (...args: unknown[]) => unknown>)[name];
      out[name] = asIs.includes(name)
        ? (...args: unknown[]) => method(part())?.apply(part(), args)
        : (...args: unknown[]) => order.call(() => method(part())?.apply(part(), args));
    }
  return out as T;
}
