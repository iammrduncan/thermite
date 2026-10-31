import type { PaperExperiment, PaperSubmission } from "../../../core/api/harness/research.ts";
import type { Ledger } from "../../ledger/index.ts";
import { paperBasis } from "./basis.ts";
import type { PaperBasis, PaperProblem } from "./check.ts";
import { type PapersContext, papersContext, type Row } from "./context.ts";
import { type PaperPackage, pendingPackages } from "./package.ts";
import { accepted, type PaperFigures, request, requested } from "./request.ts";
import { checkDraft, submit } from "./submit.ts";

/**
 * A research run's final paper (goal 112). Once a research run ends (goal 117: the review panel's
 * pass is accepted, or the progress rule stops it), the run does not close at once: the harness
 * asks the supervisor's final writer for the run's research paper, one whole paper in Simplified
 * Technical English. The writer works from the run's research (read only) and the review panel's
 * standing decisions, with the questions that stayed open.
 *
 * The paper is written from the answer cards (goal 117), as a normal research paper that a person
 * reads from start to end (owner, 2026-10-24): an abstract, an introduction, the method, the
 * results, a discussion, the limitations and the future work, with the parts the writer chooses.
 * Code checks the paper before it is accepted, here, in code the writer cannot change: every
 * question with a verified claim is answered somewhere (the paper cites its evidence), every cited
 * claim is a verified claim of the run, every number in a paragraph is in the claims that
 * paragraph cites (or is one of the corpus figures the harness gave the writer), a verdict the
 * paper gives a hypothesis is the one the review panel gave, a hypothesis the panel did not judge
 * is given no verdict, and the STE checker the supervisor ran on the text found no error, when the
 * rig has one. A paper that fails is refused with its problems.
 *
 * An accepted paper gets what the writer does not write: each citation becomes the numbers of its
 * claim's sources, such as [1], and code appends the References and two appendices, the review
 * panel's decisions (each question's certainty, each hypothesis's verdict, each dissent) and the
 * claims cited. It is kept whole in its event; it leads the run's final report and is `paper.md`
 * in the run's research folder. Its next experiments become experiments in the campaign's
 * knowledge-base collection, for a goal or hill-climb run to take into its queue.
 *
 * The parts are in paper/: the request and its frozen figures (request.ts), each item's standing
 * decision (items.ts), what a paper is checked against (basis.ts), the final writer's package
 * (package.ts), code's checks of the text (check.ts), of the next experiments (next.ts) and of the
 * STE checker's result (ste.ts), the submission (submit.ts), and what code appends to an accepted
 * paper (appended.ts); markdown.ts reads the Markdown, and context.ts holds what they share.
 */

export {
  checkPaper,
  citationsIn,
  type PaperBasis,
  type PaperProblem,
} from "./check.ts";
export {
  checkExperiments,
  isNextKind,
  NEXT_HEADINGS,
  NEXT_KIND_WORDS,
  NEXT_KINDS,
  type NextKind,
  nextSectionProblems,
} from "./next.ts";
export {
  PAPER_ANSWER_CHARS,
  PAPER_PACKAGE_MAX,
  PAPER_RULES,
  type PaperPackage,
  PROPOSED_MAX,
} from "./package.ts";
export type { PaperFigures } from "./request.ts";
export { steProblems } from "./ste.ts";

/**
 * A run's research papers: asked for once its review's pass is accepted, listed for the final
 * writer while it waits, checked, and accepted or refused. Every step is an event of the run.
 */
export class Papers {
  /** What the papers' parts share (paper/context.ts). */
  private readonly ctx: PapersContext;

  constructor(ledger: Ledger, contractFor: (run: string) => unknown) {
    this.ctx = papersContext(ledger, contractFor);
  }

  /** The run's accepted paper, as its event keeps it: the paper whole, with its references and appendices. */
  accepted(run: string): Row | undefined {
    return accepted(this.ctx, run);
  }

  /** The request for the paper of the run's end, when the harness made it. */
  requested(run: string): { review: number; figures: PaperFigures; at: string } | undefined {
    return requested(this.ctx, run);
  }

  /** Asks the final writer for the paper of a run that ended, once: paper/request.ts. */
  request(run: string, by: string): boolean {
    return request(this.ctx, run, by);
  }

  /** What a run's paper is checked against; it must wait for its paper: paper/basis.ts. */
  basis(run: string): PaperBasis {
    return paperBasis(this.ctx, run);
  }

  /** A draft checked, as the writer's check_paper tool asks: paper/submit.ts. */
  check(
    run: string,
    markdown: string,
    experiments?: PaperExperiment[],
  ): { ok: boolean; problems: PaperProblem[] } {
    return checkDraft(this.ctx, run, markdown, experiments);
  }

  /** The runs waiting for their paper, each as the final writer's package: paper/package.ts. */
  pending(): PaperPackage[] {
    return pendingPackages(this.ctx);
  }

  /** A paper the supervisor posts, checked by code, then accepted or refused: paper/submit.ts. */
  submit(run: string, input: PaperSubmission, by: string) {
    return submit(this.ctx, run, input, by);
  }
}
