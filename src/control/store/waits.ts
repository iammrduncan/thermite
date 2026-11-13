import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { errorText } from "../../common/errors.ts";
import { log } from "../../common/log.ts";
import { transactionWaiting } from "../../common/sqlite.ts";

/**
 * How control's store is called (goal 267): each call gives its answer later, and its caller
 * waits for it. The store behind is SQLite, whose calls answer at once (sqlite.ts); this puts the
 * waiting calls over it, so the callers are written for a store that answers over a connection.
 *
 * It also keeps a transaction whole. A transaction's work waits between its calls, and SQLite has
 * one connection: a call from elsewhere in that time would join the transaction, and be kept or
 * dropped with it. So while a transaction is open, only its own work calls the store, and every
 * other call waits until it ends.
 */

/**
 * A part of the store as its callers see it: each of its calls gives a promise of what the call
 * behind it gives. The parts a part holds are seen the same way.
 */
export type Waits<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : T[K] extends object
      ? Waits<T[K]>
      : T[K];
};

/** How a store's calls wait: not at all beyond the promise, or a turn of the event loop each. */
export type StoreWaits = "none" | "turn";

let waitsNow: StoreWaits = "none";

/**
 * How the stores opened from now on wait. "turn" makes every call take a turn of the event loop,
 * as a call to a store on a server does: the tests can run so (`--store-waits turn`), and a caller
 * that does not wait for an answer, or relies on nothing happening between two calls, shows there.
 * Gives how they waited before.
 */
export function setStoreWaits(waits: StoreWaits): StoreWaits {
  const was = waitsNow;
  waitsNow = waits;
  return was;
}

/** A turn of the event loop: everything else that is due runs first. */
const turn = (): Promise<void> => new Promise((done) => setImmediate(done));

/**
 * Whose turn it is to call a store. With no transaction open, every caller's. With one open, its
 * own work's alone: the work a transaction's function does, and waits for, is known by the
 * asynchronous context it runs in. A transaction inside another is a savepoint of it, and is the
 * one whose turn it is until it ends.
 */
export class Turns {
  /** The transactions open now, the outermost first. Each is known by an object of its own. */
  private readonly open: object[] = [];
  private readonly inside = new AsyncLocalStorage<object>();
  /** What each open transaction's work asked to be done once it is kept (onceKept). */
  private readonly after = new Map<object, (() => void)[]>();
  /** The callers that wait for the open transactions to change. */
  private waiting: (() => void)[] = [];
  private readonly waits: StoreWaits = waitsNow;

  /** Runs one call of the store behind, in its turn. */
  async call<R>(fn: () => R): Promise<R> {
    if (this.waits === "turn") await turn();
    // Asked again after each wait, and nothing waits between the last answer and the call.
    while (!this.mayCall()) await this.change();
    return fn();
  }

  /**
   * Runs `fn` in one transaction on `db`: all of its calls to the store are kept, or none. Its
   * own calls go on while it is open; every other caller waits until it ends. `fn` waits for the
   * store and for nothing else: what it waits for holds every other caller of the store.
   */
  async tx<T>(db: DatabaseSync, fn: () => Promise<T>): Promise<T> {
    if (this.waits === "turn") await turn();
    // Nothing waits between its turn and the transaction's start, so no other caller starts one.
    while (!this.mayCall()) await this.change();
    const mine = {};
    let kept = false;
    try {
      const out = await transactionWaiting(db, () => {
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
      // What it asked to be done once kept: handed to the transaction it is a savepoint of, done
      // now when it is the outermost, and forgotten when it was dropped.
      const outer = at > 0 ? this.open[at - 1] : undefined;
      if (kept && outer) this.after.get(outer)?.push(...after);
      else if (kept) for (const done of after) this.run(done);
      this.changed();
    }
  }

  /**
   * Does `fn` once what the caller wrote is kept: at once when no transaction holds the caller's
   * work; else when the outermost transaction that holds it is kept, and never when that one, or
   * a savepoint between, is dropped. For what leaves the store and can't be taken back, such as a
   * command sent to a rig.
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

  /** Whether the caller may call the store now: no transaction is open, or it is the innermost's work. */
  private mayCall(): boolean {
    const innermost = this.open.at(-1);
    return innermost === undefined || innermost === this.inside.getStore();
  }

  /** Answers when a transaction has ended: the callers that wait ask again, in their order. */
  private change(): Promise<void> {
    return new Promise((again) => this.waiting.push(again));
  }

  private changed(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const again of waiting) again();
  }
}

/**
 * `part` as its callers see it: one waiting call for each of its methods, each run in its turn.
 * The methods named in `asIs` stay as they are: they answer at once, and keep nothing in the
 * store.
 */
export function waiting<T extends object>(part: T, turns: Turns): Waits<T>;
export function waiting<T extends object, K extends keyof T>(
  part: T,
  turns: Turns,
  asIs: readonly K[],
): Waits<Omit<T, K>> & Pick<T, K>;
export function waiting<T extends object>(
  part: T,
  turns: Turns,
  asIs: readonly PropertyKey[] = [],
): unknown {
  return waitingCalls(Object.getPrototypeOf(part), () => part, turns, asIs);
}

/**
 * A part that is made at its first call, as its callers see it: `made` gives it, in the call's
 * turn, and `methods` is its class's prototype.
 */
export function waitingOnce<T extends object>(methods: T, made: () => T, turns: Turns): Waits<T> {
  return waitingCalls(methods, made, turns, []) as Waits<T>;
}

function waitingCalls(
  methods: object,
  part: () => object,
  turns: Turns,
  asIs: readonly PropertyKey[],
): unknown {
  const out: Record<string, unknown> = {};
  for (let at = methods; at !== Object.prototype; at = Object.getPrototypeOf(at))
    for (const name of Object.getOwnPropertyNames(at)) {
      if (name === "constructor" || name in out) continue;
      if (typeof Object.getOwnPropertyDescriptor(at, name)?.value !== "function") continue;
      const method = (on: object) => (on as Record<string, (...args: unknown[]) => unknown>)[name];
      out[name] = asIs.includes(name)
        ? (...args: unknown[]) => method(part())?.apply(part(), args)
        : (...args: unknown[]) => turns.call(() => method(part())?.apply(part(), args));
    }
  return out;
}
