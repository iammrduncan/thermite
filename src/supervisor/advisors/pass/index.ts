import { answerAudits } from "./auditor.ts";
import { adviseContext } from "./context.ts";
import { writePapers } from "./final-writer.ts";
import { answerReviews } from "./review-panel.ts";
import type { AdviseConfig, AdviseState } from "./state.ts";
import { writeCards } from "./synthesizer.ts";
import { teachRuns } from "./teachers.ts";

export { kbSearchFor } from "./kb.ts";
export { advisorKeeper } from "./keeper.ts";
export { type AdviseConfig, type AdviseState, emptyAdviseState } from "./state.ts";
export { overSpendLimit, teachersCalled } from "./teachers.ts";

/**
 * The supervisor's advisor loop: the teachers review each running run on their cadence, and at
 * once when the owner has written to it; the auditor answers open audits, the review panel
 * answers open reviews, the synthesizer rewrites the answer cards of each research run whose
 * evidence changed (goal 117), and the final writer writes the paper of each research run that
 * ended (goals 112 and 117). Everything goes through the harness API
 * with the supervisor's token, which cannot write verdicts, champions or contracts. Each run is kept in the supervisor's
 * home, the figures go to control, and each step is a line in the live view.
 *
 * The owner's messages reach an advisor in its brief or package (owner_messages). When the
 * advisor has run with them, the supervisor tells the harness which it was given and what it
 * answered, and the harness records the reads and the answers.
 *
 * The teachers, the auditor and the review panel may search the run's past research (the
 * folders its campaign may read in Thermite's knowledge base), read only, through the harness's
 * copy of the run's knowledge/: the same items the workers search. A teacher that may fetch any
 * web page gets no past research at all.
 *
 * The teachers also read the run's code and evidence (goal 081, not in a research run) and its own
 * research (goal 098: its sources, claims, hypotheses, findings, notes and files), read only,
 * through the harness; a teacher that may fetch any web page reads neither.
 *
 * They get the MCP servers the run's kit gives the advisors (goal 068): the supervisor makes each
 * call with the sign-in control gave it, and tells the harness when a server fails or comes back,
 * for the run's history. Advisors that may fetch any web page get no MCP server either.
 *
 * Each part of a pass is a module in pass/, which takes what it needs from the context the pass
 * makes at its start (pass/context.ts). They run in this order: the teachers, the auditor, the
 * synthesizer, the review panel, then the final writer.
 */
export async function adviseOnce(cfg: AdviseConfig, state: AdviseState): Promise<AdviseState> {
  const ctx = adviseContext(cfg, state);
  const { next, now } = ctx;
  await teachRuns(ctx);
  await answerAudits(ctx);
  await writeCards(ctx);
  await answerReviews(ctx);
  await writePapers(ctx);

  // Old retry markers go after a week (an open audit's are renewed by each try or hand-off; a
  // closed audit's went above).
  for (const [k, t] of Object.entries(next.tried)) {
    if (now - Date.parse(t) > 7 * 24 * 3_600_000) {
      delete next.tried[k];
      delete next.tries[k];
      delete next.auditErrors?.[k];
    }
  }
  return next;
}
