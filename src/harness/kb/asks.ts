import { randomUUID } from "node:crypto";
import {
  KB_ASK_TIMEOUT_MS,
  type KbAskAnswer,
  type KbAskKind,
  type KbReadAsk,
  type KbSearchAsk,
} from "../../core/link/kb.ts";

/**
 * The channel the rig's supervisor holds open to the harness for the agents' searches and reads of
 * the knowledge base (goal 175). The harness never calls out: an agent's kb_search or kb_read
 * waits here, the supervisor takes what waits with a call that it holds open until there is some
 * (take), asks control, and hands each answer back (answer). An ask the supervisor has not taken
 * in ASK_UNTAKEN_MS, or not answered in ASK_UNANSWERED_MS, is answered in words: the agent goes on
 * without it.
 */

/** One ask as the supervisor takes it: its id, and what to ask control. */
export type KbAskOut =
  | { id: string; kind: "search"; ask: KbSearchAsk }
  | { id: string; kind: "read"; ask: KbReadAsk };

/** How long an ask waits for the supervisor to take it: then the agent is told it is away. */
export const ASK_UNTAKEN_MS = 15_000;
/** How long a taken ask waits for its answer: control's own wait, and a margin for the relay. */
export const ASK_UNANSWERED_MS = KB_ASK_TIMEOUT_MS + 10_000;
/** The most asks one take hands over; the rest wait for the next. */
export const TAKE_MAX = 20;
/** The longest a take is held open, in milliseconds. */
export const TAKE_WAIT_MAX_MS = 30_000;
/** The most asks waiting at once: one more is answered at once that the knowledge base is busy. */
export const WAITING_MAX = 200;

interface Waiting {
  out: KbAskOut;
  taken: boolean;
  done: (a: KbAskAnswer) => void;
  timer: NodeJS.Timeout;
}

export class KbAsks {
  private readonly waiting = new Map<string, Waiting>();
  private readonly untakenMs: number;
  private readonly unansweredMs: number;
  /** Takes held open, each woken when an ask arrives. */
  private takers: (() => void)[] = [];

  /** The waits, ASK_UNTAKEN_MS and ASK_UNANSWERED_MS unless told (tests tell shorter ones). */
  constructor(o: { untakenMs?: number; unansweredMs?: number } = {}) {
    this.untakenMs = o.untakenMs ?? ASK_UNTAKEN_MS;
    this.unansweredMs = o.unansweredMs ?? ASK_UNANSWERED_MS;
  }

  /**
   * One ask of an agent: control's answer, a refusal in words, or why no answer came, in words.
   * Never throws.
   */
  ask(kind: KbAskKind, ask: KbSearchAsk | KbReadAsk): Promise<KbAskAnswer> {
    if (this.waiting.size >= WAITING_MAX)
      return Promise.resolve({
        refused: `the knowledge base has ${WAITING_MAX} searches waiting already: try again in a minute`,
      });
    const id = randomUUID();
    return new Promise<KbAskAnswer>((resolve) => {
      const done = (a: KbAskAnswer) => {
        const w = this.waiting.get(id);
        if (!w) return;
        clearTimeout(w.timer);
        this.waiting.delete(id);
        resolve(a);
      };
      const timer = setTimeout(
        () =>
          done({
            refused:
              "the rig's supervisor did not take this from the harness: it may be restarting. The knowledge base can't be reached now; go on without it, and try again later",
          }),
        this.untakenMs,
      );
      this.waiting.set(id, { out: { id, kind, ask } as KbAskOut, taken: false, done, timer });
      for (const wake of this.takers.splice(0)) wake();
    });
  }

  /**
   * The asks waiting to be taken, at most TAKE_MAX, each handed over once; with none, the call
   * waits up to `waitMs` (at most TAKE_WAIT_MAX_MS) for one to arrive.
   */
  async take(waitMs: number): Promise<KbAskOut[]> {
    const ready = () => [...this.waiting.values()].filter((w) => !w.taken);
    if (!ready().length && waitMs > 0)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(waitMs, TAKE_WAIT_MAX_MS));
        this.takers.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    const out = ready().slice(0, TAKE_MAX);
    for (const w of out) {
      w.taken = true;
      clearTimeout(w.timer);
      w.timer = setTimeout(
        () =>
          w.done({
            refused: `control did not answer in ${Math.round(this.unansweredMs / 1000)} seconds: the knowledge base can't be reached now. Go on without it, and try again later`,
          }),
        this.unansweredMs,
      );
    }
    return out.map((w) => w.out);
  }

  /** An answer from the supervisor, to an ask it took. False: none waits with this id (too late). */
  answer(id: string, a: KbAskAnswer): boolean {
    const w = this.waiting.get(id);
    if (!w) return false;
    w.done(a);
    return true;
  }
}
