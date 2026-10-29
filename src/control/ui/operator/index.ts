import type { ControlStore, Decision } from "../../store/index.ts";
import type { RigView } from "../../views/index.ts";
import { stuckNeeds } from "../stuck.ts";
import { controlDiskNeeds, diskNeeds, drainNeeds } from "./hold.ts";
import { auditNeeds, promotionNeeds } from "./promotion.ts";
import { proposalNeeds } from "./proposal.ts";
import { conclusionNeeds, reviewNeeds } from "./review.ts";
import { agentsNeeds, keyNeeds, resetNeeds, staleNeeds } from "./rig.ts";

export { attemptDetail } from "./attempt.ts";
export { baselineBlock } from "./baseline.ts";
export { runBrief } from "./brief.ts";
export { cap, changeChips, evidence } from "./change.ts";
export { decidedState } from "./decided.ts";
export { championHeldOutBlock } from "./held-out.ts";
export { outcome } from "./outcome.ts";
export { proposalCard } from "./proposal.ts";
export {
  attemptRows,
  baselineWords,
  confirmingWords,
  goalState,
  jobHtml,
  leftByClose,
  runFigure,
  runProgress,
  runRow,
  runStateHtml,
  waitingOn,
} from "./run.ts";
export { sentenceHtml, type TimelineRow, timeline } from "./timeline.ts";
export { withdrawBlock } from "./withdraw.ts";

/**
 * The operator's views: every decision with what is being decided, the evidence, and what each
 * choice does; what each run is doing now; and what happened, in words. Rig data is escaped
 * everywhere (esc), and buttons are the dashboard's signed-command forms (`Forms.cmd`).
 */

export interface Forms {
  /** A form that issues a signed command (see the dashboard's cmdForm). */
  cmd: (f: {
    rig: string;
    kind: string;
    fields?: Record<string, string>;
    label: string;
    cls?: string;
    back?: string;
  }) => string;
  /** The session's form token, for forms that are not commands. */
  csrf: string;
}

/** Something that waits for the owner. */
export interface Need {
  kind:
    | "promotion"
    | "audit"
    | "blocked"
    | "key"
    | "reset"
    | "agents"
    | "review"
    | "conclusion"
    | "stale"
    | "stuck"
    | "disk"
    | "drain"
    | "proposal";
  rig: string;
  run?: string | undefined;
  attempt?: string | undefined;
  at?: string | undefined;
  /** Its row in a list of decisions. */
  html: string;
  /**
   * The owner's choice is sent and the rig has not refused it: the lists leave the item out at
   * once, and only the change's own page still shows it. A refused choice, or a new wait, brings
   * it back.
   */
  decided?: boolean | undefined;
  /** The same decision as a box on its attempt's page: the buttons, each choice and why. */
  box: string;
}

/**
 * What each kind of need's card takes from needs(): the owner's decisions sent so far, the forms,
 * the time, and the page the forms come back to.
 */
export interface NeedsContext {
  ds: Decision[];
  f: Forms;
  now: number;
  back: string;
}

/**
 * Everything that waits for the owner on these rigs, with full context. Each kind of need has its
 * card in a module of operator/; they are gathered in this order, and then sorted by kind and age.
 */
export function needs(
  store: ControlStore,
  vs: RigView[],
  f: Forms,
  now: number,
  back: string,
): Need[] {
  const out: Need[] = [];
  const c: NeedsContext = { ds: store.commands.decisions(), f, now, back };
  for (const u of vs) {
    const key = store.reportedRigs.key(u.id);
    out.push(...keyNeeds(c, u, key));
    for (const r of u.runs) {
      // A closed run is finished, and nothing in it waits for the owner (goal 087; the owner,
      // 2026-10-22): its changes, audits, reviews and proposals leave Needs you, and the rig
      // refuses decisions on them.
      if (r.status === "closed") continue;
      out.push(...promotionNeeds(c, u, r));
      out.push(...auditNeeds(c, u, r));
      out.push(...reviewNeeds(c, u, r));
      // A trial quiet past the rig's setting, or one that repeats the same calls (goal 143).
      out.push(...stuckNeeds(store, u, r, f, now, back));
      out.push(...agentsNeeds(c, u, r));
      out.push(...conclusionNeeds(c, u, r));
    }
    out.push(...staleNeeds(c, u, key));
    // Its disk at its floor, or a drain past its deadline (goal 173).
    out.push(...diskNeeds(c, u));
    out.push(...drainNeeds(c, store, u));
  }
  out.push(...resetNeeds(c, store, vs));
  // Control's own disk at its floor (goal 173).
  out.push(...controlDiskNeeds(c, store));
  // The operator's changes to a campaign's settings that wait for the owner.
  out.push(...proposalNeeds(c, store));
  const order = [
    "key",
    "reset",
    "disk",
    "drain",
    "agents",
    "promotion",
    "audit",
    "blocked",
    "review",
    "conclusion",
    "proposal",
    "stale",
  ];
  return out.sort(
    (a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind) ||
      String(a.at ?? "").localeCompare(String(b.at ?? "")),
  );
}
