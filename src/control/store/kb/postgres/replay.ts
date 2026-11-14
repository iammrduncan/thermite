import type { KbIndexTarget } from "../../../../core/kb/index.ts";

/**
 * How the reading of an event (core/kb/records.ts) runs on a store whose answers come later
 * (goal 268). The reading is written for a target that answers at once, as the SQLite store's
 * does and as an export's does, and it is not changed. Here it runs against what the store was
 * found to hold so far:
 *
 * - when it asks for something not read yet, the run stops there. The writes it made before that
 *   point are kept in the store, each once; then what it asked for is read, and the reading runs
 *   again from its start;
 * - the reading works from the event and the answers alone, so each run asks the same things in
 *   the same order, and gets further than the one before, until one ends;
 * - an answer is read after every write before it is kept, so the reading sees its own writes,
 *   as it does on a store that answers at once.
 */

/** A target of the reading whose every call gives its answer later. */
export type KbIndexTargetLater = {
  [K in keyof KbIndexTarget]: KbIndexTarget[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : never;
};

type Name = keyof KbIndexTarget;
/** One call of the target: its name and what it was given. */
type Call = { name: Name; args: unknown[] };

/** Thrown inside the reading to stop a run at a question whose answer is not read yet. */
class NotReadYet {
  readonly asked: Call;
  constructor(asked: Call) {
    this.asked = asked;
  }
}

const sameCall = (a: Call, b: Call) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Runs `reading` to its end on `target`: every write it makes is made on the target once, in
 * its order, and every question it asks is answered from the target.
 */
export async function readLater(
  reading: (target: KbIndexTarget) => void,
  target: KbIndexTargetLater,
): Promise<void> {
  /** The questions asked so far, each with its answer, in the reading's order. */
  const answered: { asked: Call; answer: unknown }[] = [];
  /** How many of the reading's writes the target has. */
  let kept = 0;
  const call = (c: Call): Promise<unknown> =>
    (target[c.name] as (...args: unknown[]) => Promise<unknown>)(...c.args);
  for (;;) {
    let asks = 0;
    /** This run's writes, in order: the first `kept` of them are on the target already. */
    const writes: Call[] = [];
    const ask = (asked: Call): unknown => {
      const had = answered[asks];
      if (!had) throw new NotReadYet(asked);
      if (!sameCall(had.asked, asked))
        throw new Error("the reading of an event asked different things when it ran again");
      asks += 1;
      return had.answer;
    };
    const run: KbIndexTarget = {
      runCreated: (...args) => void writes.push({ name: "runCreated", args }),
      put: (...args) => void writes.push({ name: "put", args }),
      item: (...args) => ask({ name: "item", args }) as ReturnType<KbIndexTarget["item"]>,
      attempt: (...args) => ask({ name: "attempt", args }) as ReturnType<KbIndexTarget["attempt"]>,
    };
    let stopped: Call | undefined;
    try {
      reading(run);
    } catch (err) {
      if (!(err instanceof NotReadYet)) throw err;
      stopped = err.asked;
    }
    for (const w of writes.slice(kept)) await call(w);
    kept = Math.max(kept, writes.length);
    if (!stopped) return;
    answered.push({ asked: stopped, answer: await call(stopped) });
  }
}
