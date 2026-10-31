import type { Decision } from "../../store/index.ts";
import {
  type AttemptView,
  currentChampion,
  type RigView,
  type RunView,
} from "../../views/index.ts";
import { card, esc, icon } from "../components/index.ts";
import { attemptHref } from "../urls.ts";
import { clip } from "../words/index.ts";
import { cap, changeChips, changeFacts, changeHeadline } from "./change.ts";
import { decidedState } from "./decided.ts";
import type { Need, NeedsContext } from "./index.ts";
import { hasAdvisors } from "./outcome.ts";

/**
 * The changes that wait for the owner before they become the champion: a promotion the run asks
 * about, and an audit that a rig with no auditor holds or that the auditor blocked.
 */

const nextSeq = (r: RunView) => Math.max(1, ...r.champion.map((c) => c.seq)) + 1;

/** What a champion is, first in a decision's details. */
const CHAMPION_IS =
  "<dt>The champion</dt><dd>The champion is the version of the project that the agents start from. The judge compares each new change with it.</dd>";
const REJECT_DOES =
  "The change does not become the champion. The record shows that you rejected it. The agents continue from the current champion.";

/**
 * Why a change waits for you (goal 079: only where the run asks, or the auditor sent it). The
 * reason comes from the harness; one from before goal 079 may be missing.
 */
const waitWhy = (reason: string | null | undefined, max?: number) => {
  if (!reason) return "This run asks you to decide every change. This is its promotion rule.";
  const r = esc(max ? clip(reason, max) : reason);
  return /^the auditor/i.test(reason)
    ? `The auditor sent this change to you: ${r}.`
    : `It waits for you because ${r}.`;
};

/** Why a change waits for an audit, in plain words. */
const auditWhy = (reason: string, a: AttemptView | undefined) => {
  const n = a?.known_flaws.length ?? 0;
  if (reason === "declared flaws")
    return n
      ? `The agent that made the change wrote ${n} problem${n === 1 ? "" : "s"} with it.`
      : "The agent that made the change wrote problems with it.";
  if (reason === "the contract's adversarial checklist")
    return "The contract tells the judge to do an adversarial test of each change in a goal campaign.";
  return `${cap(reason)}.`;
};

const promoteDoes = (r: RunView, a: AttemptView | undefined, expected: number | null) => {
  const cur = currentChampion(r)?.seq ?? 1;
  const moved = expected !== null && expected !== cur;
  const flaws = a?.known_flaws.length
    ? " You also accept the problems that the agent wrote. The record shows your name."
    : "";
  return moved
    ? `The champion changed after the judge measured this change: it was champion #${expected}, and at this time it is champion #${cur}. Thus the judge first <b>tests the change again against champion #${cur}</b>. The change does not become the champion at this time.${flaws}`
    : `The change becomes <b>champion #${nextSeq(r)}</b>. The agents start their next work from it, and the judge compares new changes with it.${flaws}`;
};

/** A choice's label for decidedState: the promotion's own words, or "Reject it". */
const promoteOr = (promote: string) => (d: Decision) =>
  d.kind === "approve_promotion" ? promote : "Reject it";

/**
 * A change that waits for the owner's approval: the run asks about every change, or the auditor
 * sent it to the owner.
 */
export function promotionNeeds(c: NeedsContext, u: RigView, r: RunView): Need[] {
  const { ds, f, now, back } = c;
  const out: Need[] = [];
  const find = (id: string) => r.attempts.find((x) => x.id === id);
  for (const id of r.pending_promotions) {
    const a = find(id);
    const w = r.promotion_waits[id];
    out.push({
      kind: "promotion",
      rig: u.id,
      run: r.id,
      attempt: id,
      at: w?.at ?? a?.updated_at,
      ...card({
        tone: "warn",
        ic: icon.trophy,
        kind: "Your decision",
        question: "Make this change the new champion?",
        headline: changeHeadline(r, a, id),
        why: waitWhy(w?.reason, 160),
        chips: changeChips(r, a),
        key: `promote-${u.id}-${r.id}-${id}`,
        u,
        r,
        lane: a?.lane,
        since: w?.at ?? a?.updated_at,
        now,
        facts: `${CHAMPION_IS}${changeFacts(r, a, id)}<dt>Why this waits for you</dt><dd>${waitWhy(w?.reason)}</dd>`,
        choices: [
          {
            button: f.cmd({
              rig: u.id,
              kind: "approve_promotion",
              fields: { run: r.id, attempt: id },
              label: "Make it the champion",
              cls: "primary",
              back,
            }),
            label: "Make it the champion",
            does: promoteDoes(r, a, w?.expected_seq ?? null),
          },
          {
            button: f.cmd({
              rig: u.id,
              kind: "decline_promotion",
              fields: { run: r.id, attempt: id },
              label: "Reject it",
              back,
            }),
            label: "Reject it",
            does: REJECT_DOES,
          },
          { label: "Do nothing", does: "Nothing changes. The change stays in this list." },
        ],
        more: `<a href="${attemptHref(r, id)}">Everything about this change (${esc(id)}) →</a>`,
        decided: decidedState(
          ds,
          { rig: u.id, run: r.id, attempt: id },
          w?.at ?? a?.updated_at,
          promoteOr("Make it the champion"),
          now,
        ),
      }),
    });
  }
  return out;
}

/** A change held for an audit that only the owner can decide, or one the auditor blocked. */
export function auditNeeds(c: NeedsContext, u: RigView, r: RunView): Need[] {
  const { ds, f, now, back } = c;
  const out: Need[] = [];
  const find = (id: string) => r.attempts.find((x) => x.id === id);
  // An audit the rig's auditor will decide needs nothing from you (goal 079): only a block
  // does, or an audit held on a rig with no auditor that has not been let go yet.
  const advisors = hasAdvisors(u);
  for (const au of r.audits.filter(
    (x) => x.decision === "block" || (x.decision === null && !advisors),
  )) {
    const a = find(au.attempt);
    const blocked = au.decision === "block";
    out.push({
      kind: blocked ? "blocked" : "audit",
      rig: u.id,
      run: r.id,
      attempt: au.attempt,
      at: au.at,
      ...card({
        tone: blocked ? "bad" : "warn",
        ic: icon.shield,
        kind: blocked ? "Blocked" : "Your decision",
        question: blocked
          ? "Overrule the auditor and make this change the champion?"
          : "Make this change the new champion?",
        headline: changeHeadline(r, a, au.attempt),
        why: blocked
          ? `<span class="bad">The auditor stopped this change. Its cause: ${esc(clip(au.reasons ?? "the auditor gave none", 200))}</span>`
          : `${esc(cap(auditWhy(au.reason, a)))} ${advisors ? "The auditor of this rig will make the decision if you do not." : "This rig has no auditor, thus you must make the decision."}`,
        chips: changeChips(r, a),
        key: `audit-${u.id}-${r.id}-${au.attempt}`,
        u,
        r,
        lane: a?.lane,
        since: au.at,
        now,
        facts: `${CHAMPION_IS}${changeFacts(r, a, au.attempt)}<dt>Why this waits for you</dt><dd>${
          blocked
            ? `The auditor stopped this change. Its cause: <span class="quote inline">${esc(au.reasons ?? "the auditor gave none")}</span> <span class="muted">(The audit started because ${esc(auditWhy(au.reason, a))})</span>`
            : `A change must have an audit before it becomes the champion when ${esc(auditWhy(au.reason, a).replace(/^The /, "the ").replace(/\.$/, ""))}. ${
                advisors
                  ? "The auditor of this rig will make the decision. You can make it first."
                  : "<b>This rig has no auditor.</b> Thus, no one other than you will make the decision."
              }`
        }</dd>`,
        choices: [
          {
            button: f.cmd({
              rig: u.id,
              kind: "approve_promotion",
              fields: { run: r.id, attempt: au.attempt },
              label: blocked ? "Overrule the auditor" : "Make it the champion",
              cls: blocked ? "" : "primary",
              back,
            }),
            label: blocked ? "Overrule the auditor" : "Make it the champion",
            does: `${blocked ? "You overrule the auditor." : "You make the decision, not an auditor."} The record shows your name. ${promoteDoes(r, a, au.expected_seq)}`,
          },
          {
            button: f.cmd({
              rig: u.id,
              kind: "decline_promotion",
              fields: { run: r.id, attempt: au.attempt },
              label: "Reject it",
              back,
            }),
            label: "Reject it",
            does: REJECT_DOES,
          },
          {
            label: "Do nothing",
            does: blocked
              ? "The change stays stopped, in this list. It does not become the champion if you do not overrule the auditor."
              : advisors
                ? "The change waits for the decision of the auditor."
                : "The change stays in this list. No auditor will make the decision for you. The agents continue from the current champion.",
          },
        ],
        more: `<a href="${attemptHref(r, au.attempt)}">Everything about this change (${esc(au.attempt)}) →</a>`,
        decided: decidedState(
          ds,
          { rig: u.id, run: r.id, attempt: au.attempt },
          au.at,
          promoteOr(blocked ? "Overrule the auditor" : "Make it the champion"),
          now,
        ),
      }),
    });
  }
  return out;
}
