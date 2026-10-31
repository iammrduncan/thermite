import { CARDS, CARDS_PENDING } from "../../../core/api/harness/advisors.ts";
import type { AnswerOf } from "../../../core/api/route.ts";
import { synthesizeCards } from "../synthesizer.ts";
import type { AdviseContext } from "./context.ts";
import { clip, ifKnown } from "./shared.ts";

/** The synthesizer's part of a pass: the answer cards of each research run's changed questions. */
export async function writeCards(ctx: AdviseContext): Promise<void> {
  const {
    cfg,
    harness,
    s,
    researchFor,
    kbFor,
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
  // The synthesizer (goal 117): its own model from control (goal 166), else the rig's first
  // teacher's, rewrites the answer card of each question of a running research run whose evidence
  // changed since its card, from the card and the new verified claims, with the run's research
  // read only. The harness checks each card, and keeps it or refuses it with its problems, which
  // come back with the question's next request. A failed call, or a question that got no card, is
  // tried again at the next round. No cap on tries.
  const synthesizer = cfg.advisors.synthesizer ?? cfg.advisors.teachers[0];
  if (synthesizer && !overBudget()) {
    let requests: AnswerOf<typeof CARDS_PENDING>["runs"] = [];
    try {
      // A harness from before goal 117 has no cards to write: nothing to say.
      requests = (await ifKnown(harness.call(CARDS_PENDING)))?.runs ?? [];
    } catch (err) {
      fail("the answer cards to write", err);
    }
    for (const pkg of requests) {
      if (overBudget()) break;
      const run = pkg.run;
      const asked = pkg.questions ?? [];
      // With the campaign's own context settings, when it sets any (goal 070).
      const own = await configFor(run);
      const runtime = own.synthesizer ?? own.teachers[0] ?? synthesizer;
      const words = (xs: number[]) =>
        `${xs.length === 1 ? "question" : "questions"} ${xs.map((i) => i + 1).join(", ")}`;
      say(
        run,
        "status",
        `the synthesizer (${runtime.name}) writes the answer ${asked.length === 1 ? "card" : "cards"} of ${words(asked.map((q) => q.index))}: their evidence changed`,
      );
      try {
        // Each question's `through` stays with the supervisor: it posts it back with the card.
        const r = await synthesizeCards({
          runtime,
          pkg: { ...pkg, questions: asked.map(({ through: _, ...q }) => q) },
          research: researchFor(run),
          // Thermite's knowledge base, in the synthesizer's own slot (goal 175).
          kb: await kbFor(run, "synthesizer"),
          keeper: keeperFor(run),
          additions: await additionsFor(run),
        });
        count(r);
        const call = `cards ${new Date().toISOString()}`;
        await usageOut(run, call, "synthesizer", r.usage);
        await promptsOut(run, call, r.sent);
        if (!r.output) {
          fail(
            `the answer cards of ${run} (tried again at the next round)`,
            r.error ?? "no answer",
            run,
          );
          continue;
        }
        const through = new Map(asked.map((q) => [q.index, q.through ?? null]));
        const cards = r.output.cards.map((c) => ({
          question: c.question,
          answer: c.answer,
          certainty: c.certainty,
          claims: c.claims,
          borrowed: c.borrowed,
          gaps: c.gaps,
          through: through.get(c.question) ?? null,
        }));
        const none = asked.map((q) => q.index).filter((i) => !cards.some((c) => c.question === i));
        if (!cards.length) {
          fail(
            `the answer cards of ${run}`,
            "the synthesizer gave no card that could be read",
            run,
          );
          continue;
        }
        const posted = await harness.call(CARDS, {
          params: { run },
          body: { synthesizer: runtime.name, cards },
        });
        const kept = posted.results.filter((x) => x.accepted);
        s.cards = (s.cards ?? 0) + kept.length;
        const refused = posted.results.flatMap((x) => (x.accepted ? [] : [x]));
        say(
          run,
          refused.length || none.length ? "status" : "text",
          [
            kept.length
              ? `the harness kept the answer ${kept.length === 1 ? "card" : "cards"} of ${words(kept.map((x) => x.question))}`
              : "",
            refused.length
              ? `it refused ${refused.map((x) => `question ${x.question + 1}'s (${clip(x.problems.join("; "), 200)})`).join("; ")}: the synthesizer writes ${refused.length === 1 ? "it" : "them"} again at the next round`
              : "",
            none.length
              ? `the synthesizer gave no card for ${words(none)}: asked again at the next round`
              : "",
          ]
            .filter(Boolean)
            .join(". "),
        );
        record(`cards-${run}`, {
          synthesizer: runtime.name,
          posted,
          ...(none.length ? { no_card: none } : {}),
          ...(r.compactions?.length ? { compactions: r.compactions } : {}),
        });
      } catch (err) {
        fail(`the answer cards of ${run} (tried again at the next round)`, err, run);
      }
    }
  }
}
