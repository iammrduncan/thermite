import { Refusal } from "../../common/errors.ts";

/**
 * One terminal's typing, in order (goal 169): what the loop types and the owner's inputs go in one
 * after another, never into each other. An input that must start by a time (goal 241) and still
 * waits for what went in before it then is refused in words and never typed. So the one who gave
 * it hears the truth: an advisor's input passes from the harness to the supervisor, and the harness
 * answers it as refused when the supervisor does not say in time what became of it.
 */
export class TypingQueue {
  private last: Promise<unknown> = Promise.resolve();

  /** `work` once what was queued before it has gone in. */
  type<R>(work: () => Promise<R>): Promise<R> {
    const next = this.last.then(work);
    this.last = next.catch(() => undefined);
    return next;
  }

  /**
   * `work` once what was queued before it has gone in, if that comes before `startBy` (in
   * milliseconds since the epoch). If not, it is refused with `why` at `startBy`, and the work
   * never runs. Work that has started goes on past `startBy`.
   */
  typeBy<R>(work: () => Promise<R>, startBy: number, why: string): Promise<R> {
    let state: "waiting" | "started" | "dropped" = "waiting";
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (state !== "waiting") return;
          state = "dropped";
          reject(new Refusal(why));
        },
        Math.max(0, startBy - Date.now()),
      );
      this.type(async () => {
        if (state === "dropped") return undefined;
        state = "started";
        clearTimeout(timer);
        return work();
      }).then(
        (v) => {
          if (state === "started") resolve(v as R);
        },
        (err: unknown) => {
          clearTimeout(timer);
          if (state !== "dropped") reject(err);
        },
      );
    });
  }
}
