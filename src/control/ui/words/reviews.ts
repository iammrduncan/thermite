import { questionName, RESEARCH_REVIEW } from "../../../core/research-check.ts";
import type { StoredEvent } from "../../views/index.ts";
import type { Sentence, SentenceContext } from "./context.ts";
import { clip } from "./shared.ts";

/**
 * Reviews and a run's end, in words: the review panel's reviews and decisions, a research run's
 * paper, answer cards and hypotheses, its stop, a campaign proposed as not possible, and the
 * claims workers record.
 */
export function reviewSentence(w: SentenceContext, e: StoredEvent): Sentence | null {
  const { b, who, s } = w;
  switch (e.kind) {
    case "review_requested":
      return s(
        b.goal === RESEARCH_REVIEW
          ? `The review panel was asked whether the research questions are answered (review ${String(b.review)}).`
          : `The review panel was asked to judge the goal "${String(b.goal)}".`,
        "",
        { run: String(e.subject) },
      );
    case "review_panel": {
      // A research review (goals 112 and 117): its outcome, and its items decided and still open.
      const count = (x: unknown) =>
        typeof x === "number" ? x : Array.isArray(x) ? x.length : null;
      const decided = count(b.decided);
      const open = count(b.open);
      if (b.goal === RESEARCH_REVIEW)
        return s(
          `Review ${String(b.review)} is in: the review panel ${b.result === "review_passed" ? "passed it" : "did not pass it"}${decided !== null ? `, with ${decided} ${decided === 1 ? "item" : "items"} decided${open ? ` and ${open} still open` : ""}` : ""}.`,
          b.result === "review_passed" ? "ok" : "",
          { run: String(e.subject) },
        );
      return s(`The review panel ${String(b.result).replace(/_/g, " ")}.`, "", {
        run: String(e.subject),
      });
    }
    case "review_decided":
      // Hands-off (goal 079): the harness took the review panel's pass, not the owner.
      return s(
        String(e.actor).includes("hands-off")
          ? `The review panel's pass was taken hands-off: this run does not ask you about reviews.`
          : `You ${String(b.decision)} ${b.goal === RESEARCH_REVIEW ? "the review panel's answers to the research questions" : "a review"}.`,
        "",
        { run: String(e.subject) },
      );
    // A research run's paper (goal 112).
    case "research_paper_requested":
      return s("The final writer was asked to write the research paper.", "", {
        run: String(e.subject),
      });
    case "research_paper_refused": {
      const problems = Array.isArray(b.problems) ? b.problems.map(String) : [];
      return s(
        `The harness refused the final writer's paper: ${Number(b.count) || problems.length} ${Number(b.count) === 1 ? "problem" : "problems"}${problems[0] ? `, the first: ${clip(problems[0], 200)}` : ""}.`,
        "warn",
        { run: String(e.subject) },
      );
    }
    case "research_paper_accepted": {
      const ste = (b.ste ?? {}) as { checked?: unknown };
      const xs = (Array.isArray(b.experiments) ? b.experiments : []) as { kind?: unknown }[];
      const n = xs.length;
      // By the run each is for (goal 119), when the paper tagged them.
      const hill = xs.filter((x) => x?.kind === "hill_climb").length;
      const goal = xs.filter((x) => x?.kind === "goal").length;
      const split =
        hill + goal
          ? ` (${[hill ? `${hill} for a hill climb` : "", goal ? `${goal} for a goal campaign` : ""].filter(Boolean).join(", ")})`
          : "";
      return s(
        `The research paper passed the harness's checks${ste.checked === true ? " and the rig's STE checker" : " (no STE checker on the rig)"}. It cites ${Number(b.cited_claims) || 0} claims, and ${n} next ${n === 1 ? "experiment" : "experiments"}${split} went to the knowledge base.`,
        "ok",
        { run: String(e.subject) },
      );
    }
    // A research run's answer cards (goal 117).
    case "card_written":
      return s(
        `The synthesizer wrote the answer card of question ${Number(b.question) + 1} (version ${String(b.version)}): certainty ${String(b.certainty)}, ${Number(b.claims) || 0} ${Number(b.claims) === 1 ? "claim" : "claims"} cited, ${Number(b.gaps) || 0} open ${Number(b.gaps) === 1 ? "gap" : "gaps"}.`,
        "ok",
        { run: String(e.subject) },
      );
    case "card_refused": {
      const problems = Array.isArray(b.problems) ? b.problems.map(String) : [];
      return s(
        `The harness refused the synthesizer's answer card of question ${Number(b.question) + 1}: ${Number(b.count) || problems.length} ${Number(b.count) === 1 ? "problem" : "problems"}${problems[0] ? `, the first: ${clip(problems[0], 200)}` : ""}. The old card stands.`,
        "warn",
        { run: String(e.subject) },
      );
    }
    // A research run's hypotheses (goal 117): the author's, the pool's, merges and status changes.
    case "hypothesis_added": {
      const q = Number.isInteger(b.question) ? ` (${questionName(Number(b.question))})` : "";
      const text = `"${clip(String(b.text ?? ""), 160)}"`;
      return s(
        b.status === "author" || (!b.lane && !b.status)
          ? `The run starts with the author's hypothesis${q}: ${text}.`
          : `${String(b.lane || e.actor)} proposed a hypothesis for the pool${q}: ${text}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "hypothesis_revised":
      return s(
        `${String(b.lane || e.actor)} revised hypothesis ${String(b.hypothesis)} of the pool${Number.isInteger(b.question) ? ` (${questionName(Number(b.question))})` : ""}: "${clip(String(b.text ?? ""), 160)}".`,
        "",
        { run: String(e.subject) },
      );
    case "hypothesis_merged":
      return s(
        `Hypothesis ${String(b.hypothesis)} was merged into ${String(b.into)}: its new words repeat it.`,
        "",
        { run: String(e.subject) },
      );
    case "hypothesis_status": {
      const by = who(String(b.by || e.actor));
      const did =
        b.status === "promoted"
          ? "promoted"
          : b.status === "pool"
            ? "returned to the pool"
            : b.status === "retired"
              ? "retired"
              : `set to ${String(b.status)}`;
      return s(
        `${by} ${did} hypothesis ${String(b.hypothesis)}${b.status === "promoted" ? ": the review panel must give it a verdict" : ""}${b.reason ? `. Why: ${clip(String(b.reason), 200).replace(/[.\s]+$/, "")}` : ""}.`,
        "",
        { run: String(e.subject) },
      );
    }
    // The review panel's answers per reviewer and its decision per item (goal 117).
    case "review_items": {
      const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
      const qs = items.filter((x) => x?.kind === "question");
      const hs = items.filter((x) => x?.kind === "hypothesis");
      const bad = items.filter((x) => Array.isArray(x?.problems) && x.problems.length).length;
      return s(
        `${String(b.reviewer)} answered review ${String(b.review)}: ${qs.filter((x) => x.verdict === "answered").length} of ${qs.length} ${qs.length === 1 ? "question" : "questions"} answered${hs.length ? `, ${hs.filter((x) => x.verdict === "supported" || x.verdict === "refuted").length} of ${hs.length} ${hs.length === 1 ? "hypothesis" : "hypotheses"} decided` : ""}.${bad ? ` Code found problems in ${bad} ${bad === 1 ? "answer" : "answers"}.` : ""}`,
        bad ? "warn" : "",
        { run: String(e.subject) },
      );
    }
    case "item_decided": {
      const kind = b.kind === "hypothesis" ? "hypothesis" : "question";
      const dissent = Array.isArray(b.dissent) ? b.dissent.length : 0;
      return s(
        `In review ${String(b.review)}, the review panel decided ${itemName(kind, String(b.key))}: ${decisionWords(kind, String(b.decision ?? ""), typeof b.certainty === "string" ? b.certainty : null)}${dissent ? ` (${dissent} ${dissent === 1 ? "reviewer dissents" : "reviewers dissent"})` : ""}.`,
        decisionTone(kind, String(b.decision ?? "")) === "ok" ? "ok" : "",
        { run: String(e.subject) },
      );
    }
    // A review try the supervisor could not post (goal 116).
    case "review_try_failed":
      return s(
        `Review ${String(b.review)}, try ${String(b.try)}, could not be posted: ${clip(String(b.error ?? ""), 200)}. It is tried again at the review panel's next round.`,
        "warn",
        { run: String(e.subject) },
      );
    // The progress rule (goal 117): said only when it ends the run, not at every digest.
    case "research_progress":
      return null;
    case "research_stopped": {
      const o = (b.open ?? {}) as { questions?: unknown };
      const open = Array.isArray(o.questions) ? o.questions.length : 0;
      return s(
        `Research stopped adding: ${open ? `${open} ${open === 1 ? "question stays" : "questions stay"} open, every open one saturated` : "every open question saturated"}, and nothing improved for a quarter of the running time. The run writes its paper and closes.`,
        "warn",
        { run: String(e.subject) },
      );
    }
    case "conclusion_proposed":
      return s(
        "The harness proposes ending the campaign as not possible: it needs your decision.",
        "warn",
        { run: String(e.subject) },
      );
    case "conclusion_accepted":
      return s("You ended the campaign as not possible.", "", { run: String(e.subject) });
    case "conclusion_rejected":
      return s("You chose to keep going.", "", { run: String(e.subject) });
    // A claim a worker recorded, in any mode: verified, or a draft with the harness's reasons.
    case "claim_added": {
      const by = e.actor === "research" ? "A worker" : e.actor;
      const said = `"${clip(String(b.text ?? ""), 160)}"`;
      if (b.verified === true)
        return s(`${by} recorded a verified claim: ${said}.`, "ok", { run: String(e.subject) });
      const problems = Array.isArray(b.problems) ? b.problems.map(String) : [];
      const more = Math.max(0, problems.length - 3) + (Number(b.more_problems) || 0);
      const why = problems.length
        ? ` Why: ${problems
            .slice(0, 3)
            .map((p) => clip(p, 200))
            .join("; ")}${more ? `; and ${more} more` : ""}.`
        : "";
      return s(`${by}'s claim stays a draft: ${said}.${why}`, "warn", {
        run: String(e.subject),
      });
    }
    default:
      return null;
  }
}

/** An item of a research review, for people: "Question 2" or "hypothesis h-1". */
export const itemName = (kind: string, key: string) =>
  kind === "question" && /^\d+$/.test(key) ? questionName(Number(key)) : `hypothesis ${key}`;

/**
 * The review panel's decision on an item, in words (goal 117): "answered, certainty high", "the
 * best available, insufficient", "open", "supported", "refuted" or "undecided".
 */
export function decisionWords(kind: string, decision: string, certainty: string | null): string {
  if (kind === "question" && decision === "answered")
    return certainty ? `answered, certainty ${certainty}` : "answered";
  if (decision === "insufficient") return "the best available, insufficient";
  return decision.replace(/_/g, " ") || "no decision";
}

/** A decision's tone: an end (answered, insufficient) or a verdict is good; open or undecided is not yet. */
export function decisionTone(kind: string, decision: string): "ok" | "warn" | "" {
  if (kind === "question")
    return decision === "answered" ? "ok" : decision === "insufficient" ? "warn" : "";
  return decision === "supported" || decision === "refuted" ? "ok" : "";
}
