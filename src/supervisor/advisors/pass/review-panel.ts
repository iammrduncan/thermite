import { errorText } from "../../../common/errors.ts";
import { REVIEW, REVIEW_KINDS, REVIEWS_PENDING } from "../../../core/api/harness/advisors.ts";
import type { NoteInput } from "../../../core/journal.ts";
import type { AdvisorCompaction, AdvisorResult } from "../call.ts";
import {
  isResearchPackage,
  type ResearchReviewAnswers,
  type ReviewOutput,
  reviewOne,
} from "../review-panel.ts";
import type { AdviseContext } from "./context.ts";
import { clip } from "./shared.ts";
import { MAX_TRIES } from "./state.ts";

/** The review panel's part of a pass: each open review, by every reviewer of the panel. */
export async function answerReviews(ctx: AdviseContext): Promise<void> {
  const {
    cfg,
    harness,
    next,
    s,
    now,
    retryMs,
    mark,
    kbFor,
    researchFor,
    configFor,
    additionsFor,
    keeperFor,
    mcpFor,
    overBudget,
    count,
    record,
    say,
    tryFailed,
    fail,
    usageOut,
    promptsOut,
    receipts,
    notesOut,
  } = ctx;
  // The review panel: every reviewer reviews blind; the harness needs at least two. It reviews
  // goals and, asked for by kind, research runs' questions (goal 112).
  if (cfg.advisors.review_panel.length && !overBudget()) {
    const kinds = REVIEW_KINDS.join(",");
    const { reviews } = await harness.call(REVIEWS_PENDING, { query: { kinds } });
    const told = new Set<number>();
    for (const pkg of reviews) {
      const key = `review:${pkg.id}`;
      // A review is tried again past MAX_TRIES: a try from then on posts it (below), so a run is
      // never left waiting on a review that no one posts.
      const t = next.tried[key];
      if (t && now - Date.parse(t) < retryMs) continue;
      mark(key);
      const last = (next.tries[key] ?? 0) >= MAX_TRIES;
      const owner = (pkg.owner_messages ?? []).filter((m) => !told.has(m.id));
      try {
        const results: {
          reviewer: string;
          pass: boolean;
          reasons: string;
          research?: ResearchReviewAnswers;
        }[] = [];
        const answers: { message: number; text: string; advisor: string }[] = [];
        const journal: { by: string; notes: NoteInput[] }[] = [];
        const mcp = await mcpFor(pkg.run);
        const additions = await additionsFor(pkg.run);
        // A research run's review (goal 112): its reviewers may read the run's own research.
        const research = isResearchPackage(pkg);
        // With the campaign's own context settings, when it sets any (goal 070).
        const panel = (await configFor(pkg.run)).review_panel;
        const compactions: AdvisorCompaction[] = [];
        // Each reviewer that gave no answer, and why.
        const unanswered: { reviewer: string; why: string }[] = [];
        // The reviewers review at once, in parallel (goal 117), each blind to the others. Each
        // one's call is then recorded in the panel's order: its usage, its line in Live and its
        // answer. A reviewer whose call throws gave no answer, with the error as why.
        // Thermite's knowledge base for the reviewers (goal 175), in the review panel's slot.
        const kb = pkg.run ? await kbFor(pkg.run, "review-panel") : undefined;
        const calls = await Promise.all(
          panel.map((runtime) =>
            reviewOne({
              runtime,
              pkg: { ...pkg, owner_messages: owner },
              ...(kb ? { kb } : {}),
              ...(mcp ? { mcp } : {}),
              ...(research && pkg.run ? { research: researchFor(pkg.run) } : {}),
              keeper: keeperFor(pkg.run),
              additions,
            }).then(
              (r) => ({ runtime, r }),
              (err: unknown) => ({
                runtime,
                r: {
                  output: undefined,
                  error: errorText(err),
                  tokensIn: 0,
                  tokensOut: 0,
                  usd: 0,
                } as AdvisorResult<ReviewOutput>,
              }),
            ),
          ),
        );
        for (const { runtime, r } of calls) {
          count(r);
          await usageOut(pkg.run, `review ${pkg.id}`, "review_panel", r.usage);
          await promptsOut(pkg.run, `review ${pkg.id}`, r.sent);
          compactions.push(...(r.compactions ?? []));
          if (!r.output) {
            unanswered.push({ reviewer: runtime.name, why: clip(r.error ?? "no answer", 300) });
            continue;
          }
          results.push({
            reviewer: runtime.name,
            pass: r.output.pass,
            reasons: r.output.reasons,
            ...(r.output.research ? { research: r.output.research } : {}),
          });
          for (const a of r.output.answers) answers.push({ ...a, advisor: runtime.name });
          if (r.output.journal.length) journal.push({ by: runtime.name, notes: r.output.journal });
          const rq = r.output.research?.questions ?? [];
          const answered = r.output.research
            ? ` Questions: ${rq.filter((q) => q.verdict === "answered").length} answered, ${rq.filter((q) => q.verdict === "insufficient").length} insufficient, ${rq.filter((q) => q.verdict === "open").length} open; ${r.output.research.hypotheses.length} hypotheses judged.`
            : "";
          say(
            pkg.run,
            "text",
            `review ${pkg.id}${research ? " of the research questions" : pkg.goal ? ` of goal ${pkg.goal}` : ""}, ${runtime.name}: ${r.output.pass ? "pass" : "fail"}.${answered} ${clip(r.output.reasons, 300)}`,
          );
        }
        // Every reviewer must answer: a crashed dissenter must not lose its veto. The owner's
        // messages count as read only with the posted review, so a retry gives them again. From
        // the MAX_TRIES-th try, the review is posted with each reviewer that gave no answer
        // failing it, with why: the run goes on, and is reviewed again on new evidence.
        if (results.length < cfg.advisors.review_panel.length) {
          const why = `${results.length} of ${cfg.advisors.review_panel.length} reviewers of the review panel answered${unanswered.length ? ` (${unanswered.map((u) => `${u.reviewer}: ${u.why}`).join("; ")})` : ""}`;
          if (!last) {
            fail(`review ${pkg.id}`, why, pkg.run);
            await tryFailed(pkg.id, next.tries[key] ?? 0, why);
            continue;
          }
          for (const u of unanswered)
            results.push({
              reviewer: u.reviewer,
              pass: false,
              reasons: `This reviewer gave no answer in ${next.tries[key]} tries, so the review is not passed: ${u.why}`,
            });
          say(
            pkg.run,
            "status",
            `review ${pkg.id}: ${why} in try ${next.tries[key]}: posted as not passed`,
          );
        }
        const posted = await harness.call(REVIEW, { params: { id: pkg.id }, body: { results } });
        s.reviews++;
        if (pkg.run) {
          const ids = owner.map((m) => m.id);
          await receipts(pkg.run, "review_panel", ids, answers);
          for (const m of owner) told.add(m.id);
        }
        say(
          pkg.run,
          "status",
          `review ${pkg.id}: ${posted?.result !== "review_passed" ? "the review panel did not pass it" : posted.accepted ? "the review panel passed it, and it was accepted (the run does not ask the owner)" : "the review panel passed it; it waits for the owner's acceptance"}`,
        );
        // Each reviewer's field notes, once the review is posted.
        const noted: unknown[] = [];
        if (pkg.run)
          for (const j of journal)
            noted.push(await notesOut(pkg.run, "review_panel", j.by, j.notes));
        record(`review-${pkg.id}`, {
          results,
          posted,
          noted,
          ...(compactions.length ? { compactions } : {}),
        });
      } catch (err) {
        fail(`review ${pkg.id}`, err, pkg.run);
        await tryFailed(pkg.id, next.tries[key] ?? 0, err);
      }
    }
  }
}
