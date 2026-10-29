import {
  BROKEN_VERDICTS,
  SCREENED_VERDICTS,
  UNCLEAR_VERDICTS,
  WON_VERDICTS,
} from "../../../core/verdicts.ts";
import type { AttemptView, RigView, RunView } from "../../views/index.ts";

/**
 * Whether the rig has an auditor to decide its audits. A supervisor that reports its roles says
 * so exactly; an older one only says whether any advisors run (null: none are configured).
 */
export const hasAdvisors = (u: RigView) => {
  const advisors = (u.supervisor as { advisors?: { roles?: { auditor?: boolean } } | null } | null)
    ?.advisors;
  return advisors?.roles ? advisors.roles.auditor === true : Boolean(advisors);
};

/**
 * An attempt's outcome as one word a person scans for, with its tone. With its rig: an audit the
 * rig's auditor will decide is "Auditing", not "Needs you" (goal 079).
 */
export function outcome(r: RunView, a: AttemptView, u?: RigView): { word: string; tone: string } {
  const champ = r.champion.find((c) => c.attempt === a.id && !c.reopened);
  if (champ) return { word: `Champion #${champ.seq}`, tone: "ok" };
  const judging = ["queued", "building", "screening", "confirming", "verifying"].includes(
    a.lifecycle,
  );
  // The owner withdrew its evidence (goal 174), and it is not being judged again.
  if (a.verdict === "invalidated" && !judging) return { word: "Withdrawn", tone: "warn" };
  const audit = r.audits.filter((x) => x.attempt === a.id).at(-1);
  if (audit?.decision === "block" || a.lifecycle === "audit_blocked")
    return { word: "Blocked", tone: "bad" };
  const auditing = a.lifecycle === "awaiting_audit" || (audit && audit.decision === null);
  // A change that waited when its run closed (goal 087): no one decides it now.
  if (r.status === "closed" && (auditing || a.lifecycle === "awaiting_approval"))
    return { word: "Run closed", tone: "" };
  if (
    auditing &&
    u &&
    hasAdvisors(u) &&
    !r.pending_promotions.includes(a.id) &&
    a.lifecycle !== "awaiting_approval"
  )
    return { word: "Auditing", tone: "info" };
  if (r.pending_promotions.includes(a.id) || a.lifecycle === "awaiting_approval" || auditing)
    return { word: "Needs you", tone: "warn" };
  if (a.lifecycle === "declined") return { word: "Declined", tone: "" };
  if (a.lifecycle === "promoted") return { word: "Promoted", tone: "ok" };
  if (judging) return { word: "Judging", tone: "info" };
  if (a.lifecycle === "duplicate") return { word: "Duplicate", tone: "" };
  // Its run closed before the judge got to it (goal 087).
  if (a.lifecycle === "not_judged") return { word: "Not judged", tone: "" };
  // Its job lost its lease too often and was set aside: an infrastructure failure, not a loss.
  if (a.lifecycle === "errored") return { word: "Errored", tone: "" };
  const v = a.verdict ?? "";
  if (WON_VERDICTS.includes(v)) return { word: "Won", tone: "ok" };
  if (SCREENED_VERDICTS.includes(v)) return { word: "Judging", tone: "info" };
  if (BROKEN_VERDICTS.includes(v)) return { word: "Broken", tone: "bad" };
  if (UNCLEAR_VERDICTS.includes(v)) return { word: "Unclear", tone: "" };
  if (!v) return { word: "Judging", tone: "info" };
  return { word: "Lost", tone: "" };
}
