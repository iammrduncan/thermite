import type { z } from "zod";
import type { Prompt } from "../../../agents/prompt.ts";
import { renderMergedBy, renderTeacher } from "../../../agents/roles/index.ts";
import { StructuredDirective } from "../../../core/directives.ts";
import type { NoteInput } from "../../../core/journal.ts";
import { ideaWords, ruleRefusal } from "../../../core/queue-target.ts";
import { additionIn, type RunAdditions } from "../../../core/role-additions.ts";
import type { AdvisorAgent } from "../../../core/usage.ts";
import type {
  AdvisorCompaction,
  AdvisorKeeper,
  AdvisorResult,
  AdvisorTools,
  AdvisorUsage,
} from "../call.ts";
import { type AdvisorsConfig, packageFit } from "../config.ts";
import { runAdvisor } from "../run.ts";
import type { AdvisorInTerminal } from "../terminal/index.ts";
import type { AdvisorKb } from "../tools/index.ts";
import {
  checkPortfolio,
  DirectiveAnswer,
  DirectiveSet,
  MergedOpportunity,
  MergedResearchOpportunity,
  Opportunity,
  opportunityExperiment,
  type ProposedExperiment,
  type ProposedMove,
  ResearchDirectiveAnswer,
  ResearchOpportunity,
  ResearchTeacherAnswer,
  researchOpportunityExperiment,
  TeacherAnswer,
  TeacherReview,
} from "./answers.ts";

export interface TeacherRun {
  run: string;
  reviews: { teacher: string; review?: z.infer<typeof TeacherReview>; error?: string }[];
  /** Each teacher's answers to the owner's messages in the brief. */
  answers: { message: number; text: string; advisor: string }[];
  directives?: z.infer<typeof StructuredDirective>[];
  /** The round's portfolio (goal 081): the merged one, or every teacher's distinct opportunities. */
  portfolio: (Opportunity | ResearchOpportunity)[];
  /**
   * Experiments for the run's queue (the portfolio's, then any plain ones), and moves of queued
   * ones (the merged set's, or the first review's).
   */
  experiments: ProposedExperiment[];
  moves: z.infer<typeof ProposedMove>[];
  /** The field notes of each teacher that reviewed, and of the merged by model, by its name. */
  journal: { by: string; notes: NoteInput[] }[];
  dropped: string[];
  /** Teachers' opportunities the merged by model left out, kept by code (goal 081). */
  kept: string[];
  error?: string;
  tokens: { in: number; out: number };
  usd: number;
  /** The teachers' and the merged by model's compactions in this round (goal 070). */
  compactions?: AdvisorCompaction[] | undefined;
  /** Each call's model usage in this round, by whose it was (goal 075). */
  usage: ({ agent: AdvisorAgent } & AdvisorUsage)[];
  /** The prompts the round's calls sent (goal 166), for the harness to keep. */
  sent: Prompt[];
  /** The owner's messages the teachers' terminals took inside their turns (goal 169). */
  given: number[];
}

/** Experiments without repeats: the first of each idea's words. */
function distinct<T extends { title: string }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const w = ideaWords(x.title);
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
}

/**
 * The teachers' round for one run (goal 074): one or two independent reviews. Their main product
 * is a portfolio of opportunities for the queue (goal 081): two teachers' portfolios are merged by
 * the merged by model, and code adds back any opportunity it left out; without a merge, every
 * teacher's distinct opportunities are kept. Rules are second: two teachers' are merged into one
 * directive set by the merged by model; one teacher's, or two without a merged by model, give the
 * set of the first review that came back. Directives without a citation, and rules that freeze
 * the queue's size or pin an experiment, are dropped here, with why (the harness refuses them
 * too). Each advisor's brief is cut to fit its own window (packageFit).
 */
export async function teacherRound(input: {
  config: AdvisorsConfig;
  run: string;
  brief: unknown;
  tools: AdvisorTools;
  /** The merged by model's knowledge base tools, in its own slot (goal 175). */
  mergedKb?: AdvisorKb | undefined;
  /** Why the round runs now, when not on the clock: said on the brief's first line. */
  why?: string | undefined;
  /** Where each call's conversation is kept before a compaction (goal 070). */
  keeper?: AdvisorKeeper | undefined;
  /**
   * A research run (goal 117): the teachers get the research prompt and give research tasks
   * (ResearchOpportunity), each for one question's evidence gap; the merged by model merges
   * those. A hill climb's and a goal campaign's teachers give opportunities, as before.
   */
  research?: boolean | undefined;
  /** The owner's additions to the run's roles (goal 166): each teacher's and the merged by's. */
  additions?: RunAdditions;
  /**
   * On a rig whose agents run in their own terminal (goal 169): each teacher's call runs in its
   * program's; the merged by model, which takes no message, stays headless.
   */
  terminal?: AdvisorInTerminal | undefined;
}): Promise<TeacherRun> {
  const research = input.research === true;
  type Item = Opportunity | ResearchOpportunity;
  const item: z.ZodType<Item> = research ? ResearchOpportunity : Opportunity;
  const mergedItem: z.ZodType<Item & { from: string[] }> = research
    ? MergedResearchOpportunity
    : MergedOpportunity;
  const toExperiment = (o: Item): ProposedExperiment =>
    research
      ? researchOpportunityExperiment(o as ResearchOpportunity)
      : opportunityExperiment(o as Opportunity);
  const run: TeacherRun = {
    run: input.run,
    reviews: [],
    answers: [],
    portfolio: [],
    experiments: [],
    moves: [],
    journal: [],
    dropped: [],
    kept: [],
    tokens: { in: 0, out: 0 },
    usd: 0,
    usage: [],
    sent: [],
    given: [],
  };
  const count = (r: AdvisorResult<unknown>, agent: AdvisorAgent) => {
    run.tokens.in += r.tokensIn;
    run.tokens.out += r.tokensOut;
    run.usd += r.usd;
    if (r.compactions?.length) run.compactions = [...(run.compactions ?? []), ...r.compactions];
    if (r.usage?.calls.length) run.usage.push({ agent, ...r.usage });
    run.sent.push(...(r.sent ?? []));
  };
  const brief = { research, run: input.run, why: input.why, brief: input.brief };
  const results = await Promise.all(
    input.config.teachers.map((t) =>
      runAdvisor({
        runtime: t,
        prompt: (f) =>
          renderTeacher(
            {
              ...brief,
              fit: packageFit(t),
              addition: additionIn(input.additions, research ? "research-teacher" : "teacher"),
            },
            f,
          ),
        schema: TeacherReview,
        answerSchema: research ? ResearchTeacherAnswer : TeacherAnswer,
        tools: input.tools,
        keeper: input.keeper,
        terminal: input.terminal,
      }),
    ),
  );
  results.forEach((r, i) => {
    count(r, "teachers");
    const teacher = input.config.teachers[i]?.name ?? `teacher-${i}`;
    run.reviews.push({
      teacher,
      ...(r.output ? { review: r.output } : { error: r.error ?? "no review" }),
    });
    for (const a of r.output?.answers ?? []) run.answers.push({ ...a, advisor: teacher });
    for (const id of r.given ?? []) if (!run.given.includes(id)) run.given.push(id);
    if (r.output?.journal.length) run.journal.push({ by: teacher, notes: r.output.journal });
  });
  const good = run.reviews.filter(
    (r): r is typeof r & { review: z.infer<typeof TeacherReview> } => r.review !== undefined,
  );
  if (!good.length) {
    run.error = "no teacher produced a review";
    return run;
  }
  // Each teacher's portfolio, opportunity by opportunity: one that does not fit is left out with
  // why, and the rest stand. Each gets an id, for the merged by model's `from`.
  const portfolios = good.map((g) => {
    const p = checkPortfolio(g.review.portfolio, g.teacher, item);
    run.dropped.push(...p.left);
    return p.kept.map((o, k) => ({ id: `${g.teacher}#${k + 1}`, ...o }));
  });
  const labeled = portfolios.flat();
  // Each directive on its own: one that is not valid (a direction in words, say) is dropped, with
  // why, and the rest of the set stands.
  const valid = (xs: unknown[]) =>
    xs.flatMap((x) => {
      const d = StructuredDirective.safeParse(x);
      if (d.success) return [d.data];
      const r = (x ?? {}) as { kind?: unknown; family?: unknown; match?: unknown };
      run.dropped.push(
        `${String(r.kind ?? "?")} ${String(r.family ?? r.match ?? "")}: ${d.error.issues[0]?.message ?? "invalid"}`,
      );
      return [];
    });
  let directives: z.infer<typeof StructuredDirective>[];
  let plain: ProposedExperiment[];
  // Two teachers and a merged by model: their reviews merged. One teacher works with no merge.
  const mergedBy = input.config.teachers.length >= 2 ? input.config.merged_by : undefined;
  if (mergedBy) {
    // The reviews whole; the brief cut to what the merged by model's window leaves beside them.
    const reviews = good.map((g, i) => ({
      reviewer: g.teacher,
      summary: g.review.summary,
      portfolio: portfolios[i],
      recommendations: g.review.recommendations,
      experiments: g.review.experiments,
      moves: g.review.moves,
    }));
    const r = await runAdvisor({
      runtime: mergedBy,
      prompt: (f) =>
        renderMergedBy(
          {
            ...brief,
            fit: packageFit(mergedBy),
            reviews,
            addition: additionIn(input.additions, research ? "research-merged-by" : "merged-by"),
          },
          f,
        ),
      schema: DirectiveSet,
      answerSchema: research ? ResearchDirectiveAnswer : DirectiveAnswer,
      keeper: input.keeper,
      ...(input.mergedKb ? { tools: { kb: input.mergedKb } } : {}),
    });
    count(r, "merged_by");
    if (!r.output) {
      run.error = `the teachers' merged by model gave no directive set: ${r.error ?? ""}`;
      return run;
    }
    directives = valid(r.output.directives);
    // The merged portfolio, and every teacher's opportunity it holds in none, added back: the
    // merge drops no distinct idea (goal 081).
    const merged = checkPortfolio(r.output.portfolio, mergedBy.name, mergedItem);
    run.dropped.push(...merged.left);
    const held = new Set(merged.kept.flatMap((m) => m.from));
    const words = new Set(merged.kept.map((m) => ideaWords(m.title)));
    const missing = labeled.filter((o) => !held.has(o.id) && !words.has(ideaWords(o.title)));
    if (missing.length)
      run.kept.push(
        `the merged by model left out ${missing.map((o) => o.id).join(", ")}: kept, since distinct ideas are never dropped`,
      );
    run.portfolio = distinct([
      ...merged.kept.map(({ from: _from, ...o }) => o),
      ...missing.map(({ id: _id, ...o }) => o),
    ]);
    plain = r.output.experiments;
    run.moves = r.output.moves;
    if (r.output.journal.length) run.journal.push({ by: mergedBy.name, notes: r.output.journal });
  } else {
    // No merge: the first review's recommendations and moves are the set, and every teacher's
    // distinct opportunities and plain experiments go to the queue.
    const first = good[0] as (typeof good)[number];
    directives = valid(first.review.recommendations);
    run.portfolio = distinct(labeled.map(({ id: _id, ...o }) => o));
    plain = good.flatMap((g) => g.review.experiments);
    run.moves = first.review.moves;
  }
  run.experiments = distinct([...run.portfolio.map(toExperiment), ...plain]);
  run.directives = directives.filter((d) => {
    if (!d.citations.length) {
      run.dropped.push(`${d.kind} ${d.family ?? ""}: no citation`);
      return false;
    }
    // A rule that freezes the queue's size or pins an experiment (goal 081).
    const refused = ruleRefusal(d);
    if (refused) {
      run.dropped.push(`${d.kind}${d.family ? ` ${d.family}` : ""}: ${refused.why}`);
      return false;
    }
    return true;
  });
  const notes = run.directives.filter((d) => d.kind === "note");
  if (notes.length > 3) {
    run.dropped.push(`${notes.length - 3} extra notes`);
    const keep = new Set(notes.slice(0, 3));
    run.directives = run.directives.filter((d) => d.kind !== "note" || keep.has(d));
  }
  return run;
}
