import type { z } from "zod";
import { PAPER, PAPER_CHECK, PAPERS_PENDING } from "../../../core/api/harness/advisors.ts";
import type { PaperExperiment } from "../../../core/api/harness/research.ts";
import type { AnswerOf } from "../../../core/api/route.ts";
import { NO_STE_CHECKER, steCheckerAt, steResultOf, steToolAnswer } from "../../ste-checker.ts";
import { writePaper } from "../final-writer.ts";
import type { AdviseContext } from "./context.ts";
import { clip, ifKnown } from "./shared.ts";

/** The final writer's part of a pass: the paper of each research run that ended. */
export async function writePapers(ctx: AdviseContext): Promise<void> {
  const {
    cfg,
    harness,
    next,
    s,
    now,
    retryMs,
    researchFor,
    configFor,
    additionsFor,
    keeperFor,
    overBudget,
    count,
    record,
    say,
    fail,
    usageOut,
    promptsOut,
  } = ctx;
  // The final writer (goal 112): its own model from control (goal 166), else the rig's first
  // teacher's, writes the research paper of each research run that ended (goal 117: its review's
  // pass accepted, or the progress rule). The supervisor runs the STE checker itself on the paper
  // it posts; the harness checks the rest and accepts or refuses it. A refused paper is written
  // again at the next round, with the problems in its package; a try that gave no paper, after
  // retryMs. No cap on tries.
  const writer = cfg.advisors.final_writer ?? cfg.advisors.teachers[0];
  if (writer && !overBudget()) {
    const ste = steCheckerAt(cfg.steChecker);
    let papers: AnswerOf<typeof PAPERS_PENDING>["papers"] = [];
    try {
      // A harness from before goal 112 has no papers to write: nothing to say.
      papers = (await ifKnown(harness.call(PAPERS_PENDING)))?.papers ?? [];
    } catch (err) {
      fail("the research papers to write", err);
    }
    for (const pkg of papers) {
      const run = pkg.run;
      const key = `paper:${run}:${pkg.review}`;
      const t = next.tried[key];
      if (t && now - Date.parse(t) < retryMs) continue;
      delete next.tried[key];
      next.tries[key] = (next.tries[key] ?? 0) + 1;
      const failed = (err: unknown) => {
        next.tried[key] = new Date().toISOString();
        fail(`the research paper of ${run}`, err, run);
      };
      // With the campaign's own context settings, when it sets any (goal 070).
      const own = await configFor(run);
      const runtime = own.final_writer ?? own.teachers[0] ?? writer;
      // The harness's checks of a draft; with its next experiments when the writer gives them, so
      // a missing kind or measure (goal 119) comes back within the call.
      const checkDraft = (markdown: string, experiments?: z.input<typeof PaperExperiment>[]) =>
        harness.call(PAPER_CHECK, {
          params: { run },
          body: { paper: markdown, ...(experiments ? { experiments } : {}) },
        });
      say(
        run,
        "status",
        `the final writer (${runtime.name}) writes the research paper${(next.tries[key] ?? 1) > 1 ? ` (try ${next.tries[key]})` : ""}${ste ? "" : `; ${NO_STE_CHECKER}, so its style is not checked`}`,
      );
      try {
        const r = await writePaper({
          runtime,
          pkg,
          keeper: keeperFor(run),
          research: researchFor(run),
          kb: await ctx.kbFor(run, "final-writer"),
          additions: await additionsFor(run),
          guide: ste?.guide,
          paper: {
            check: checkDraft,
            ste: async (text) =>
              ste ? steToolAnswer(await ste.check(text)) : { checked: false, why: NO_STE_CHECKER },
          },
          // In Pi, the writer revises within its call until the checks pass. A check that fails
          // to run takes the answer: the supervisor checks it again below, and the harness last.
          accept: async (o) => {
            try {
              const c = await checkDraft(o.paper, o.experiments);
              const errors = ste
                ? (await ste.check(o.paper)).findings.filter((f) => f.severity === "error")
                : [];
              const all = [
                ...c.problems.map((p) => `${p.line ? `line ${p.line}: ` : ""}${p.problem}`),
                ...errors.map((f) => `line ${f.line}: STE ${f.rule}: ${f.message}`),
              ];
              return all.length ? clip(all.slice(0, 40).join("; "), 6000) : undefined;
            } catch {
              return undefined;
            }
          },
        });
        count(r);
        await usageOut(run, `final paper ${pkg.review}`, "final_writer", r.usage);
        await promptsOut(run, `final paper ${pkg.review}`, r.sent);
        if (!r.output) {
          failed(r.error ?? "no paper");
          continue;
        }
        const paper = r.output.paper;
        const posted = await harness.call(PAPER, {
          params: { run },
          body: {
            writer: runtime.name,
            paper,
            experiments: r.output.experiments,
            ste: ste
              ? steResultOf(await ste.check(paper), paper)
              : { checked: false, why: NO_STE_CHECKER },
          },
        });
        if (posted.accepted) {
          s.papers = (s.papers ?? 0) + 1;
          say(
            run,
            "text",
            `the research paper is in: ${posted.cited ?? 0} claims cited, ${posted.experiments?.length ?? 0} next experiments kept in the knowledge base${ste ? ", STE checked" : ""}`,
          );
        } else {
          const ps = posted.problems ?? [];
          say(
            run,
            "status",
            `the harness refused the research paper (${ps.length} ${ps.length === 1 ? "problem" : "problems"}): ${clip(ps.map((p) => `${p.line ? `line ${p.line}: ` : ""}${p.problem}`).join("; "), 400)}. The final writer writes it again at the next round`,
          );
        }
        record(`paper-${run}`, {
          writer: runtime.name,
          posted,
          ...(r.compactions?.length ? { compactions: r.compactions } : {}),
        });
      } catch (err) {
        failed(err);
      }
    }
  }
}
