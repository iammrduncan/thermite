import type { RunOverviewAnswer, Tone } from "../../../core/api/control/dashboard.ts";
import type { ControlStore } from "../../store/index.ts";
import { modeName } from "../../ui/components/index.ts";
import {
  baselineWords,
  confirmingWords,
  heldWords,
  type Need,
  passedOverWords,
  waitWords,
} from "../../ui/operator/index.ts";
import { runHref } from "../../ui/urls.ts";
import { clip, runStatusText, signed } from "../../ui/words/index.ts";
import { currentChampion, type RigView, type RunView } from "../../views/index.ts";
import { eventRows, needRow, runRow } from "./home.ts";

/**
 * A run's Overview for the dashboard's app (goal 243): its state in a sentence or two, its result
 * so far, what each of its agents does now and what happened. It says what the run's page at /ui
 * says, from the same word helpers; page code until they leave it (goals 244 and 247).
 */

/** How sure an answer is, as one of the app's colours. */
const certaintyTone = (certainty: string): Tone =>
  certainty === "high" || certainty === "moderate"
    ? "good"
    : certainty === "low" || certainty === "insufficient"
      ? "needs"
      : "none";

/** The words of each of the run's questions, from its newest digest, by index. */
function questionWords(r: RunView): string[] {
  const d = (r.research ?? {}) as { questions?: unknown };
  return (Array.isArray(d.questions) ? d.questions : []).map((q) =>
    String((q as { question?: unknown } | null)?.question ?? "").trim(),
  );
}

export async function runOverviewAnswer(
  store: ControlStore,
  u: RigView,
  r: RunView,
  feed: Need[],
  now: number,
): Promise<RunOverviewAnswer> {
  const row = await runRow(store, u, r, now, feed.length);
  const running = r.status === "running";
  const champ = currentChampion(r);
  const atWork = row.now.filter((l) => l.busy && l.who !== "judge" && l.who !== "writer").length;
  const met = r.goals.filter((g) => g.status === "met").length;
  const verified = Number((r.research as Record<string, unknown> | null)?.verified ?? 0);
  // The run in one or two sentences: where it stands, and who is at work.
  const said = [
    r.mode === "goal"
      ? r.goals.length
        ? `${met} of ${r.goals.length} goals met by champion #${champ?.seq ?? 1}.`
        : "The judge has not checked the goals yet."
      : r.mode === "hill_climb"
        ? `Champion #${champ?.seq ?? 1} is ${signed((champ?.cumulative ?? 1) - 1)} against where the run started.`
        : `${Number.isFinite(verified) ? verified : 0} verified claims so far.`,
    running
      ? atWork
        ? `${atWork} lane${atWork === 1 ? " is" : "s are"} at work.`
        : "No lane is at work."
      : `It is ${runStatusText(r)}.`,
    running ? confirmingWords(r) : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Why nothing is at work, in the pages' own words for each cause; the first that applies.
  const held =
    running && !atWork
      ? [
          r.agents_stopped ? `Its agents are stopped: ${r.agents_stopped.words}` : "",
          waitWords(r, now),
          heldWords(r),
          baselineWords(r),
          passedOverWords(u, r.id, now),
        ].find(Boolean) || null
      : null;
  const primary = r.baseline?.primary ?? null;
  const words = questionWords(r);
  const questions = words.map((question, index) => {
    const card = r.cards.filter((c) => c.question === index).at(-1);
    return {
      index,
      question,
      state: card
        ? { word: `certainty ${card.certainty}`, tone: certaintyTone(card.certainty) }
        : { word: "no answer yet", tone: "none" as const },
      answer: card ? clip(card.answer, 600) : "",
    };
  });
  const promotion =
    r.promotion === "owner_approval"
      ? "Ask me"
      : r.promotion === "auto"
        ? "Automatic"
        : "The rig's default";
  return {
    at: new Date(now).toISOString(),
    row,
    said,
    held,
    needs: feed.map((n, i) => needRow([u], n, i)),
    metric: primary
      ? {
          name: primary.metric,
          unit: r.baseline?.units[primary.metric] ?? null,
          better: primary.direction === "max" ? "higher is better" : "lower is better",
        }
      : null,
    questions,
    facts: [
      { label: "Mode", value: modeName(r.mode) },
      { label: "Rig", value: u.id },
      { label: "Promotion", value: promotion },
      { label: "Trials", value: String(r.agents.trials) },
      { label: "Rounds", value: String(r.agents.epochs) },
      { label: "Attempts", value: String(r.attempts.length) },
    ],
    recent: eventRows(
      r.timeline.slice(-80).map((e) => ({ u, e })),
      10,
    ),
    page: runHref(r),
  };
}
