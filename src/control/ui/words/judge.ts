import { HELD_OUT_OWNER_WORDS, type HeldOutKind } from "../../../core/held-out.ts";
import { BROKEN_VERDICTS, WON_VERDICTS } from "../../../core/verdicts.ts";
import { listText } from "../../../core/words.ts";
import type { StoredEvent } from "../../views/index.ts";
import type { Sentence, SentenceContext } from "./context.ts";
import { jobText, portWords } from "./jobs.ts";
import { clip } from "./shared.ts";
import { verdictText } from "./verdicts.ts";

/**
 * A change on its way through the judge, in words: submitted, judged, audited and promoted; and
 * the judge's own checks: the starting point, the champion's goals and the rig's noise.
 */
export function judgeSentence(w: SentenceContext, e: StoredEvent): Sentence | null {
  const { b, att, job, s, who } = w;
  switch (e.kind) {
    case "attempt_recorded": {
      const flaws = Array.isArray(b.known_flaws) ? b.known_flaws.length : 0;
      // Why the static checks refused it (goal 082): the first violation, and how many more.
      const refused = Array.isArray(b.violations) ? b.violations.map(String) : [];
      const total = typeof b.violations_total === "number" ? b.violations_total : refused.length;
      return s(
        // A known attempt is named by its hypothesis where the sentence is shown; else quote it.
        `${b.lane ? String(b.lane) : "Someone"} submitted ${e.subject}${b.hypothesis && !att(e.subject)?.hypothesis ? `: "${clip(String(b.hypothesis), 160)}"` : "."}${flaws ? ` It declares ${flaws} known flaw${flaws > 1 ? "s" : ""}.` : ""}${refused.length ? ` The static checks refused it: ${clip(refused[0] as string, 200)}${total > 1 ? `, and ${total - 1} more` : ""}.` : ""}`,
        refused.length ? "warn" : "",
        { attempt: String(e.subject), run: String(b.run ?? "") },
      );
    }
    // A confirmation's held-out check (goal 082): the owner's own view, with each failed case.
    case "held_out_checked": {
      const cells = (Array.isArray(b.cells) ? b.cells : []).map(
        (x) => (x ?? {}) as Record<string, unknown>,
      );
      const failed = cells.filter((c) => c.ok !== true);
      const total = typeof b.cells_total === "number" ? b.cells_total : cells.length;
      const said = (c: Record<string, unknown>) =>
        `${clip(String(c.cell ?? "?"), 80)} ${
          typeof c.kind === "string" && c.kind in HELD_OUT_OWNER_WORDS
            ? HELD_OUT_OWNER_WORDS[c.kind as HeldOutKind]
            : "failed"
        }`;
      // A goal run's champion, at its second validation (goal 086), or an attempt.
      const champion = typeof b.champion_seq === "number";
      const who = champion ? `Champion #${b.champion_seq}` : String(e.subject);
      const link = champion
        ? { run: String(b.run ?? e.subject) }
        : { attempt: String(e.subject), run: String(b.run ?? "") };
      if (b.pass === true)
        return s(
          `${who} passed its held-out check: ${total} case${total === 1 ? "" : "s"}.`,
          "ok",
          link,
        );
      const list = failed.slice(0, 3).map(said).join("; ");
      const more = failed.length > 3 ? `, and ${failed.length - 3} more` : "";
      return s(
        `${who} failed its held-out check: ${list}${more}.${champion ? " The run does not close." : ""}`,
        "bad",
        link,
      );
    }
    case "job_leased": {
      const j = job(e.subject);
      if (!j) return null;
      const a = j.attempt ? att(j.attempt) : undefined;
      return s(`The judge started ${jobText(j, a?.lane)}.`, "", {
        attempt: j.attempt ?? undefined,
        run: j.run ?? undefined,
      });
    }
    case "job_finished": {
      if (b.state === "done") return null;
      const j = job(e.subject);
      return s(
        `The judge's job ${j ? `(${jobText(j)})` : String(e.subject)} ${String(b.state)}${(b.result as { error?: string } | undefined)?.error ? `: ${clip(String((b.result as { error?: string }).error), 160)}` : ""}.`,
        "bad",
        { attempt: j?.attempt ?? undefined, run: j?.run ?? undefined },
      );
    }
    case "verdict": {
      const a = att(e.subject);
      const gained = a?.gained?.length ? ` Newly met: ${listText(a.gained)}.` : "";
      const v = String(b.verdict);
      return s(
        `${e.subject}${a?.lane ? ` (${a.lane})` : ""}: ${verdictText(v, b.delta as number | null)}.${v.startsWith("goal_") ? gained : ""}`,
        WON_VERDICTS.includes(v)
          ? "ok"
          : v === "regress" || BROKEN_VERDICTS.includes(v)
            ? "bad"
            : "",
        { attempt: String(e.subject), run: a?.run },
      );
    }
    case "champion_promoted":
      return s(
        b.setup === true
          ? `${String(b.attempt)} became champion #${String(b.seq)}, the run's new starting point: the judge could measure it. The gain counts from here.`
          : b.attempt
            ? `${String(b.attempt)} became champion #${String(b.seq)}: lanes now build on it.`
            : `Champion #${String(b.seq)} was set.`,
        "ok",
        { attempt: b.attempt ? String(b.attempt) : undefined, run: String(e.subject) },
      );
    // A hill climb's baseline (goal 115): where the run started, as the judge measured it.
    case "baseline":
      return s(
        `The judge measured the starting point, champion #${String(b.champion_seq ?? "?")}${b.attempt ? ` (setup change ${String(b.attempt)})` : ""}, on every case: ${clip(String(b.summary ?? ""), 300)}. Every change is held against these values.`,
        "ok",
        { run: String(e.subject), attempt: b.attempt ? String(b.attempt) : undefined },
      );
    case "baseline_failed":
      return s(
        `The judge could not measure the starting point, champion #${String(b.champion_seq ?? "?")}: ${clip(String(b.reasons ?? "").split("\n")[0] ?? "", 300)}. The run is in setup: the lanes work to make it build and run its cases.`,
        "bad",
        { run: String(e.subject) },
      );
    case "champion_reopened":
      return s(`Champion #${String(b.seq)} was withdrawn: its evidence was invalidated.`, "bad", {
        run: String(e.subject),
      });
    // The owner withdrew evidence (goal 174): what, why and how far it reached.
    case "invalidation": {
      const n = Array.isArray(b.attempts) ? b.attempts.length : 0;
      const job = b.kind === "job";
      const reached = job
        ? `${n === 1 ? "1 attempt loses its verdict" : `${n} attempts lose their verdicts`}, resting on them or built on what did: the judge measures ${n === 1 ? "it" : "them"} again unless the run is closed`
        : n > 1
          ? `It and the ${n - 1} attempt${n === 2 ? "" : "s"} built on it are withdrawn for good`
          : "It is withdrawn for good";
      return s(
        `${who(e.actor)} withdrew ${job ? `the measurements of judge job ${String(e.subject)}` : `attempt ${String(e.subject)}`}: ${clip(String(b.reason ?? ""), 300)}. ${reached}. Nothing is deleted.`,
        "bad",
        {
          run: typeof b.run === "string" ? b.run : undefined,
          attempt: job ? undefined : String(e.subject),
        },
      );
    }
    case "champion_moved_back":
      return s(
        `The run's champion moved back from #${String(b.from)} to #${String(b.to)}${b.attempt ? ` (${String(b.attempt)})` : ", the starting point"}: its evidence was withdrawn. New trials build on #${String(b.to)}.`,
        "warn",
        { run: String(e.subject), attempt: b.attempt ? String(b.attempt) : undefined },
      );
    case "job_cancelled": {
      const j = job(e.subject);
      return s(
        `The judge's job ${j ? `(${jobText(j)})` : String(e.subject)} was cancelled: ${clip(String(b.reason ?? ""), 200)}.`,
        "",
        {
          attempt: typeof b.attempt === "string" ? b.attempt : undefined,
          run: typeof b.run === "string" ? b.run : undefined,
        },
      );
    }
    case "promotion_pending":
      return s(
        `${e.subject} waits for your approval${b.reason ? ` (${String(b.reason)})` : ""}.`,
        "warn",
        { attempt: String(e.subject), run: String(b.run ?? "") },
      );
    case "audit_requested":
      return s(
        `${e.subject} is held for an audit: ${auditReason(String(b.reason ?? ""))}.`,
        "warn",
        {
          attempt: String(e.subject),
          run: String(b.run ?? ""),
        },
      );
    case "audit_decided":
      return s(
        `The auditor ${b.decision === "block" ? "blocked" : b.decision === "clear" ? "cleared" : "passed to you"} ${e.subject}${b.reasons ? `: ${clip(String(b.reasons), 200)}` : "."}`,
        b.decision === "block" ? "bad" : "ok",
        { attempt: String(e.subject), run: att(e.subject)?.run },
      );
    case "parent_screened":
    case "port_queued":
      return s(portWords(e.kind, String(e.subject), b), "", { attempt: String(e.subject) });
    case "promotion_declined":
      return s(
        `You declined ${e.subject}: it will not become the champion.${b.note ? ` (${String(b.note)})` : ""}`,
        "warn",
        { attempt: String(e.subject), run: att(e.subject)?.run },
      );
    case "audit_overridden":
      return s(`You overrode the audit of ${e.subject}.`, "", {
        attempt: String(e.subject),
        run: att(e.subject)?.run,
      });
    case "flaws_accepted":
      return s(
        b.by
          ? `${e.subject}'s declared flaws were accepted with its promotion: ${String(b.by)}.`
          : `You accepted ${e.subject}'s declared flaws.`,
        "",
        { attempt: String(e.subject), run: att(e.subject)?.run },
      );
    case "audit_skipped":
      return s(
        `${e.subject} had no audit: ${String(b.why ?? "this rig has no auditor")} (one was called for: ${auditReason(String(b.reason ?? ""))}).`,
        "",
        { attempt: String(e.subject), run: String(b.run ?? "") },
      );
    case "goal_report": {
      const gs = Array.isArray(b.goals) ? (b.goals as { status?: string }[]) : [];
      const met = gs.filter((g) => g.status === "met").length;
      // Its held-out check failed (goal 086): the judge's fixed words of the kinds.
      const unconfirmed = typeof b.not_confirmed === "string" ? clip(b.not_confirmed, 300) : "";
      return s(
        `The judge checked champion #${String(b.champion_seq ?? "?")}: ${met} of ${gs.length} goals met${b.complete ? ", every required goal" : ""}.${b.complete && b.confirming ? " It checks the champion a second time before the run closes; no new trial starts until then." : ""}${unconfirmed ? ` It was not confirmed on the held-out cases (${unconfirmed}): the lanes go on.` : ""}`,
        b.complete ? "ok" : unconfirmed ? "warn" : "",
        { run: String(e.subject) },
      );
    }
    case "goal_complete":
      return s("Every required goal is met: the campaign is complete.", "ok", {
        run: String(e.subject),
      });
    case "calibration":
      return s(
        `The judge measured the rig's noise: ±${(Number(b.sigma) * 100).toFixed(2)}% per block.`,
        "",
        { run: String(e.subject) },
      );
    default:
      return null;
  }
}

/** The audit trigger in words ("declared flaws" says little on its own). */
export function auditReason(reason: string): string {
  if (reason === "declared flaws") return "the agent that made the change wrote problems with it";
  if (reason === "the contract's adversarial checklist")
    return "the contract tells the judge to do an adversarial test of each change in a goal campaign";
  return reason;
}
