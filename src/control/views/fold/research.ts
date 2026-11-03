import { PAPER_ACCEPTED, PAPER_REFUSED, PAPER_REQUESTED } from "../../../core/research-check.ts";
import { researchEvent } from "../research.ts";
import { frozen } from "../sharing.ts";
import type { CardView } from "../types.ts";
import type { Handler, Handlers } from "./index.ts";

/**
 * A research run: its digests and final report, its answer cards (goal 117), its items (goals 116
 * and 117: hypotheses, each reviewer's answers per item, the review panel's decision on each item,
 * and the progress rule's state) and its paper (goal 112).
 */

/** The newest digest's or the final report's figures. */
const digest: Handler = (f, e, b) => {
  f.run(String(e.subject)).research = frozen({
    ...b,
    kind: e.kind === "research_final" ? "final" : "digest",
    at: e.at,
  });
};

/** One of a research run's items: views/research.ts folds it. */
const item: Handler = (f, e) => {
  researchEvent(f.run(String(e.subject)), e);
};

export const RESEARCH: Handlers = {
  research_digest: digest,
  research_final: digest,
  // A research run's answer cards (goal 117): the newest the harness kept for each question.
  card_written(f, e, b) {
    const v = f.run(String(e.subject));
    const q = Number(b.question);
    if (!Number.isInteger(q) || q < 0) return;
    const card: CardView = frozen({
      question: q,
      version: Number(b.version) || 0,
      certainty: String(b.certainty ?? ""),
      answer: typeof b.answer === "string" ? b.answer : "",
      claims: (Array.isArray(b.cited) ? b.cited : []).map(String),
      gaps: (Array.isArray(b.gap_list) ? b.gap_list : []).flatMap((g) => {
        const x = (g ?? {}) as Record<string, unknown>;
        return typeof x.text === "string" ? [{ kind: String(x.kind ?? ""), text: x.text }] : [];
      }),
      by: typeof b.by === "string" ? b.by : null,
      at: e.at,
    });
    v.cards = [...v.cards.filter((c) => c.question !== q), card].sort(
      (x, y) => x.question - y.question,
    );
    v.card_refusals = v.card_refusals.filter((r) => r.question !== q);
  },
  card_refused(f, e, b) {
    const v = f.run(String(e.subject));
    const q = Number(b.question);
    if (!Number.isInteger(q) || q < 0) return;
    v.card_refusals = [
      ...v.card_refusals.filter((r) => r.question !== q),
      frozen({
        question: q,
        at: e.at,
        by: typeof b.by === "string" ? b.by : null,
        problems: (Array.isArray(b.problems) ? b.problems : [])
          .filter((x): x is string => typeof x === "string")
          .slice(0, 5)
          .map((x) => x.slice(0, 300)),
      }),
    ].sort((x, y) => x.question - y.question);
  },
  hypothesis_added: item,
  hypothesis_revised: item,
  hypothesis_merged: item,
  hypothesis_status: item,
  review_items: item,
  review_try_failed: item,
  item_decided: item,
  research_progress: item,
  // A research run's paper (goal 112): asked for, refused with problems, then in.
  [PAPER_REQUESTED](f, e) {
    f.run(String(e.subject)).paper = {
      state: "writing",
      requested_at: e.at,
      refused: null,
      at: null,
      writer: null,
      ste_checked: null,
      experiments: 0,
      next_for: { hill_climb: 0, goal: 0 },
      text: null,
    };
  },
  [PAPER_REFUSED](f, e, b) {
    const p = f.run(String(e.subject)).paper;
    if (p && p.state === "writing")
      p.refused = {
        at: e.at,
        problems: (Array.isArray(b.problems) ? b.problems : [])
          .filter((x): x is string => typeof x === "string")
          .slice(0, 5)
          .map((x) => x.slice(0, 300)),
      };
  },
  [PAPER_ACCEPTED](f, e, b) {
    const v = f.run(String(e.subject));
    const ste = (b.ste ?? {}) as { checked?: unknown };
    v.paper = {
      state: "in",
      requested_at: v.paper?.requested_at ?? e.at,
      refused: null,
      at: e.at,
      writer: typeof b.writer === "string" ? b.writer : null,
      ste_checked: ste.checked === true,
      experiments: Array.isArray(b.experiments) ? b.experiments.length : 0,
      next_for: {
        hill_climb: (Array.isArray(b.experiments) ? b.experiments : []).filter(
          (x) => (x as { kind?: unknown })?.kind === "hill_climb",
        ).length,
        goal: (Array.isArray(b.experiments) ? b.experiments : []).filter(
          (x) => (x as { kind?: unknown })?.kind === "goal",
        ).length,
      },
      text: typeof b.paper === "string" ? b.paper : null,
    };
  },
};
