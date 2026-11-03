import { log } from "../../common/env.ts";
import type { CardSubmission, PaperSubmission } from "../../core/api/harness/research.ts";
import { type BriefData, briefData } from "../../core/brief.ts";
import { LedgerError } from "../ledger/index.ts";
import {
  type CardResult,
  type Cards,
  type PaperPackage,
  type Papers,
  researchEnd,
} from "../research/index.ts";
import type { HarnessService } from "./index.ts";

/**
 * A research run's answer cards (goal 117) and final paper (goal 112), as the supervisor asks for
 * them and posts them: each checked by code, then kept or refused with its problems.
 */

/**
 * For each running research run whose evidence changed since a card, its request (goal 117). A
 * run that ended (its review's pass accepted, or the progress rule's stop) gets none: its cards,
 * and so the decisions on them, stay as they were when it ended, for its paper.
 */
export function cardPackages(svc: HarnessService): ReturnType<Cards["pending"]> {
  return svc.cards.pending().filter((p) => !researchEnd(svc.ledger, p.run));
}

/**
 * The synthesizer's cards for a research run, as the supervisor posts them (goal 117): each
 * checked by code, then kept as its question's next version or refused with its problems, which
 * go back with the question's next request. The run's research folder follows what was kept.
 * A run that ended takes no card.
 */
export function submitCards(
  svc: HarnessService,
  run: string,
  input: CardSubmission,
  by: string,
): { results: CardResult[] } {
  if (researchEnd(svc.ledger, run))
    throw new LedgerError(
      "conflict",
      `run ${run} has ended: its answer cards stay as they were, for its paper`,
    );
  const out = svc.cards.submit(run, input, by);
  const q = (i: number) => `question ${i + 1}`;
  const kept: string[] = [];
  const refused: string[] = [];
  for (const r of out.results)
    if (r.accepted) kept.push(`${q(r.question)} (version ${r.version})`);
    else refused.push(`${q(r.question)} (${r.problems[0] ?? "no problem said"})`);
  svc.live.append({
    source: "planner",
    kind: "status",
    text: [
      kept.length
        ? `the synthesizer ${input.synthesizer} wrote the answer ${kept.length === 1 ? "card" : "cards"} of ${kept.join(", ")}`
        : "",
      refused.length
        ? `the harness refused the ${refused.length === 1 ? "card" : "cards"} of ${refused.join("; ")}: the old ${refused.length === 1 ? "card stands" : "cards stand"}, and the problems go back with the next request`
        : "",
    ]
      .filter(Boolean)
      .join(". ")
      .slice(0, 600),
    run,
  });
  if (kept.length)
    try {
      svc.researchChanged?.(run);
    } catch (err) {
      log("harness", "research folder not updated", { run, error: String(err) });
    }
  return out;
}

/** The research runs waiting for their paper, each as the final writer's package (goal 112). */
export function paperPackages(
  svc: HarnessService,
): (PaperPackage & { campaign_brief?: BriefData })[] {
  return svc.papers.pending().map((pkg) => {
    const brief = briefData(svc.contractFor(pkg.run));
    return { ...pkg, ...(brief ? { campaign_brief: brief } : {}) };
  });
}

/**
 * A research run's paper, as the supervisor posts it (goal 112): checked by code, then accepted
 * or refused with its problems. Accepted, it is the run's paper.md and leads its final report,
 * which the scheduler writes once the run's running trials have ended; then the run closes.
 */
export function submitPaper(
  svc: HarnessService,
  run: string,
  input: PaperSubmission,
  by: string,
): ReturnType<Papers["submit"]> {
  const out = svc.papers.submit(run, input, by);
  if (!out.accepted) {
    svc.live.append({
      source: "planner",
      kind: "status",
      text: `the final writer's paper was refused: ${out.problems.length} ${out.problems.length === 1 ? "problem" : "problems"}, the first: ${out.problems[0]?.problem ?? ""}`.slice(
        0,
        600,
      ),
      run,
    });
    return out;
  }
  svc.journal.writeAll(
    run,
    [
      {
        kind: "decision",
        text: `The research paper by the final writer ${input.writer} passed the harness's checks${input.ste.checked ? " and the rig's STE checker" : "; the rig has no STE checker, so its style was not checked"}. It leads the final report. The run ends once its running trials end.`,
      },
    ],
    { by: "harness", actor: by, source: "supervisor" },
  );
  svc.live.append({
    source: "planner",
    kind: "status",
    text: `the research paper is in: ${out.cited} claims cited, ${out.experiments.length} next ${out.experiments.length === 1 ? "experiment" : "experiments"}${input.ste.checked ? ", STE checked" : ", STE not checked (no checker)"}`,
    run,
  });
  try {
    svc.researchChanged?.(run);
  } catch (err) {
    log("harness", "research folder not updated", { run, error: String(err) });
  }
  return out;
}
