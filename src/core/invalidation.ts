import { z } from "zod";
import { Sha256Schema } from "./contract.ts";
import { RunId } from "./ids.ts";
import { listText } from "./words.ts";

/**
 * The owner withdraws bad evidence (goal 174): the signed command `invalidate_evidence`, and what
 * it reaches. Nothing is deleted: every step is a new record. An attempt withdrawn is withdrawn
 * for good, with every attempt built on it; a judge's job whose measurements are withdrawn leaves
 * the attempts that rested on them, and those built on them, to be judged again. The harness works
 * out the reach (harness/service/invalidation.ts); a preview gives it with nothing changed, and the
 * confirmation names the preview's `sha`, so the owner confirms exactly what they saw.
 */

/** The most attempts and jobs a reach lists; the rest are counted. */
export const REACH_LISTED = 200;

export const InvalidateEvidence = z
  .strictObject({
    run: RunId,
    /** An attempt of the run: withdrawn for good, with every attempt built on it. */
    attempt: z.string().min(1).max(64).optional(),
    /** A judge's job of the run whose measurements are withdrawn: what rests on them is judged again. */
    job: z.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(2000),
    /** True: the harness says what it would reach, and changes nothing. */
    preview: z.boolean().optional(),
    /** The `sha` of the reach its preview gave: refused when it reaches anything else now. */
    reach: Sha256Schema.optional(),
  })
  .refine((p) => (p.attempt === undefined) !== (p.job === undefined), {
    message: "name one attempt or one job",
    path: ["attempt"],
  })
  .refine((p) => p.preview === true || p.reach !== undefined, {
    message: "send a preview first (preview: true), then the sha it gave as reach",
    path: ["reach"],
  });
export type InvalidateEvidence = z.infer<typeof InvalidateEvidence>;

/**
 * Who may withdraw evidence: the owner alone, from the dashboard, REST, the command line or the
 * owner's MCP token. Never an operator (an agent the owner gives a token), an agent or an advisor.
 */
export const withdrawsEvidence = (issuedBy: string): boolean =>
  issuedBy === "owner" || (issuedBy.startsWith("owner:") && issuedBy !== "owner:operator");

/** One attempt an invalidation reaches, and what becomes of it. */
export interface ReachedAttempt {
  attempt: string;
  /** The subject itself, an attempt whose verdict rests on the job, or one built on a reached one. */
  why: "subject" | "evidence" | "lineage";
  /** The reached attempt it was built on, for lineage; else null. */
  parent: string | null;
  lifecycle: string;
  /** Its current verdict, which an `invalidated` one supersedes; null when it has none yet. */
  verdict: { id: number; verdict: string } | null;
  /** Withdrawn for good, judged again, or left withdrawn (its run is closed, or it was never judged). */
  then: "withdrawn" | "judged_again" | "stays_withdrawn";
}

/** What an invalidation reaches: what the preview shows, and what the command then does. */
export interface InvalidationReach {
  run: string;
  subject: { kind: "attempt" | "job"; id: string };
  /** An attempt's withdrawal is for good; a job's leaves what rested on it to be judged again. */
  for_good: boolean;
  /** The attempts reached, in order: the first REACH_LISTED. */
  attempts: ReachedAttempt[];
  attempts_total: number;
  /** How many current verdicts an `invalidated` verdict supersedes. */
  superseded: number;
  /** The judge's open jobs for them that are cancelled, and the attempts queued to be judged again. */
  jobs: {
    cancelled: { id: number; kind: string; attempt: string }[];
    cancelled_total: number;
    queued: number;
  };
  /** The champions reopened, and whether each was published (its patch left the rig). */
  champions: { seq: number; attempt: string; published: boolean }[];
  /** Where the run's champion moves back to; null when it stays. */
  champion: {
    from: number;
    to: number;
    to_attempt: string | null;
    /** A goal run's champion has its goals checked again. */
    validate: boolean;
  } | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Up to five names, and how many more. */
function named(xs: string[], total = xs.length): string {
  const shown = xs.slice(0, 5);
  const more = total - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : listText(shown);
}

/**
 * What an invalidation reaches, in plain words, one sentence a line: the dashboard's confirmation,
 * the command line's preview and the harness's answer to every channel say it the same way.
 */
export function reachWords(r: InvalidationReach): string[] {
  const of = (why: ReachedAttempt["why"]) =>
    r.attempts.filter((a) => a.why === why).map((a) => a.attempt);
  const built = of("lineage");
  const builtTotal = r.attempts_total - r.attempts.length + built.length;
  const lines: string[] = [];
  if (r.for_good) {
    lines.push(
      builtTotal
        ? `Attempt ${r.subject.id} and the ${plural(builtTotal, "attempt")} built on it (${named(built, builtTotal)}) are withdrawn for good: none is judged again, and none can become the champion.`
        : `Attempt ${r.subject.id} is withdrawn for good: it is not judged again, and it can't become the champion.`,
    );
  } else {
    const rest = of("evidence");
    const again = r.attempts.filter((a) => a.then === "judged_again").length;
    lines.push(
      `The measurements of judge job ${r.subject.id} are withdrawn. ${plural(rest.length, "attempt")} rested on them (${named(rest)})${built.length ? `, and ${plural(builtTotal, "attempt was", "attempts were")} built on those (${named(built, builtTotal)})` : ""}.`,
    );
    lines.push(
      again
        ? `${plural(again, "attempt goes", "attempts go")} back to the judge, to be measured again.`
        : "None is measured again: the run is closed, or they can't be judged (never measured, or withdrawn for good before).",
    );
  }
  lines.push(
    r.superseded
      ? `${plural(r.superseded, "verdict is", "verdicts are")} superseded by an invalidated verdict. Nothing is deleted: the old ${r.superseded === 1 ? "verdict stays" : "verdicts stay"} in the record.`
      : "No verdict is superseded: none was given yet. Each attempt gets an invalidated verdict.",
  );
  if (r.champions.length) {
    const seqs = r.champions.map((c) => `#${c.seq} (${c.attempt})`);
    lines.push(
      `${r.champions.length === 1 ? "Champion" : "Champions"} ${listText(seqs)} ${r.champions.length === 1 ? "is" : "are"} reopened.`,
    );
  }
  if (r.champion)
    lines.push(
      `The run's champion moves back from #${r.champion.from} to #${r.champion.to}${r.champion.to_attempt ? ` (${r.champion.to_attempt})` : ", the starting point"}: new trials build on it.${r.champion.validate ? " The judge checks its goals again." : ""}`,
    );
  const published = r.champions.filter((c) => c.published).map((c) => `#${c.seq}`);
  if (published.length)
    lines.push(
      published.length === 1
        ? `Champion ${published[0]} was published already: its patch stays in the results repository and on control, and the next export records that it was withdrawn. Nothing there is deleted or rewritten.`
        : `Champions ${listText(published)} were published already: their patches stay in the results repository and on control, and the next export records that they were withdrawn. Nothing there is deleted or rewritten.`,
    );
  if (r.jobs.cancelled_total)
    lines.push(
      `${plural(r.jobs.cancelled_total, "judge job")} waiting for or measuring them ${r.jobs.cancelled_total === 1 ? "is" : "are"} cancelled.`,
    );
  return lines;
}
