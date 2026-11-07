import { FINAL_LIFECYCLES, WON_VERDICTS } from "../core/verdicts.ts";
import { type ExperimentTry, type Ledger, LedgerError } from "./ledger/index.ts";
import type { Experiment } from "./queue.ts";

/**
 * When a tried experiment gets another try (goals 214 and 221): the judge settled its change
 * without a win and it has tries left, or the owner sends it back. Each gives the try that ended,
 * as the queue keeps it (`experiment_try`); the queue (queue.ts) sends the experiment back.
 */

/** A try that ended, as the queue keeps it. */
type EndedTry = Omit<ExperimentTry, "n" | "at">;

/**
 * An attempt's lifecycles that end its experiment's tries (goal 214): a win, a win that waits for
 * the owner, or one the owner decided. Any other final lifecycle uses a try.
 */
const ENDS_TRIES: ReadonlySet<string> = new Set([
  "promoted",
  "awaiting_approval",
  "audit_blocked",
  "declined",
]);

/**
 * The run's experiments whose attempt the judge settled without a win, with tries left, each with
 * its try, the oldest last. An attempt still being judged, a win, a win that waits for the owner
 * and one the owner decided are left out.
 */
export function settledTries(ledger: Ledger, run: string): { x: Experiment; t: EndedTry }[] {
  const out: { x: Experiment; t: EndedTry }[] = [];
  for (const x of ledger.experiments.doneWithTriesLeft(run).reverse()) {
    const attempt = x.attempt as string;
    const lifecycle = String(ledger.attempts.get(attempt)?.lifecycle ?? "");
    if (!FINAL_LIFECYCLES.has(lifecycle) || ENDS_TRIES.has(lifecycle)) continue;
    const v = ledger.verdicts.current(attempt);
    if (v && WON_VERDICTS.includes(v.verdict)) continue;
    const reasons = v ? ledger.verdicts.get(v.id)?.reasons : undefined;
    out.push({
      x,
      t: {
        lane: x.lane,
        trial: x.trial ?? "",
        attempt,
        result: x.result ?? "submitted",
        verdict: v?.verdict ?? lifecycle,
        cause: reasons?.trim().slice(0, 2000) || x.cause || null,
      },
    });
  }
  return out;
}

/**
 * The try the owner's send-back keeps (goal 221), and the tries the experiment gets: one more when
 * its tries are used (`used`, the one that ended among them). Refused in words: an experiment that
 * is not done (up next, in progress, an idea or dropped), one whose change the judge has not
 * settled, and a research run's task, which gets one try.
 */
export function ownersTry(
  ledger: Ledger,
  x: Experiment,
  used: number,
): { t: EndedTry; tries: number } {
  if (x.state !== "done")
    throw new LedgerError(
      "invalid",
      `experiment ${x.id} is ${x.state}: only a tried experiment goes back to up next`,
    );
  if (ledger.runs.get(x.run)?.mode === "research")
    throw new LedgerError(
      "invalid",
      "a research run's task gets one try: add a new task for what it should find",
    );
  const attempt = x.attempt ?? null;
  const lifecycle = attempt ? String(ledger.attempts.get(attempt)?.lifecycle ?? "") : "";
  if (attempt && !FINAL_LIFECYCLES.has(lifecycle))
    throw new LedgerError(
      "conflict",
      `experiment ${x.id}'s change ${attempt} is still with the judge (${lifecycle || "not judged yet"}): send it back once it has its verdict`,
    );
  const v = attempt ? ledger.verdicts.current(attempt) : undefined;
  return {
    t: {
      lane: x.lane,
      trial: x.trial ?? "",
      attempt,
      result: x.result ?? "no_attempt",
      verdict: v?.verdict ?? (attempt ? lifecycle : null),
      cause: x.cause ?? null,
    },
    tries: Math.max(x.tries ?? 1, used + 1),
  };
}

/**
 * What the owner's send-back would do (goal 221), with nothing changed: the try it would be, and
 * where it goes; refused in words as the send-back is.
 */
export function retryPreview(ledger: Ledger, x: Experiment, used: number, position: string) {
  const { t, tries } = ownersTry(ledger, x, used);
  return {
    experiment: x.id,
    preview: true,
    try: used + 1,
    tries,
    position,
    words: `"${x.title.slice(0, 120)}" would go back to ${position === "top" ? "the top of up next" : position === "end" ? "the end of up next" : `place ${position} of up next`} for try ${used + 1} of ${tries}, with try ${used}${t.lane ? ` on ${t.lane}` : ""} (${t.result}${t.verdict ? `, ${t.verdict}` : ""}) kept. Its next try goes to a lane that has not tried it while one has not. Nothing changed.`,
  };
}
