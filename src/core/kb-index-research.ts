import {
  clip,
  cutSaid,
  KB_BODY_MAX,
  type KbEvent,
  type KbIndexTarget,
  lines,
  n,
  setLine,
  str,
} from "./kb-fields.ts";
import { currentEvent } from "./names.ts";
import { hypothesisStatusWords, PAPER_ACCEPTED, questionLabel } from "./research-check.ts";

type Row = Record<string, unknown>;

/** A research paper's next experiment's kind (goal 119), in words: the run it is for. */
const NEXT_FOR_WORDS = new Map([
  ["hill_climb", "a hill climb, an improvement to measure against its champion"],
  ["goal", "a goal campaign, an outcome to prove"],
]);

/**
 * The research events' part of the reading (core/kb-index.ts hands each here): sources, claims,
 * hypotheses, findings, the paper and its next experiments, the reports, the answer cards and the
 * review panel's decisions. An event of another kind changes nothing.
 */
export function indexResearchEvent(t: KbIndexTarget, event: KbEvent, run: string): void {
  const e = currentEvent(event);
  const b = e.body;
  const ref = (x: unknown) => clip(str(x), 200);
  switch (e.kind) {
    // A source: its address, then the text that was read (the archived page as text, cut).
    case "source_fetched":
      t.put(
        run,
        "source",
        ref(b.source),
        {
          title: str(b.title) || str(b.url) || str(b.domain) || str(b.source),
          body: lines([str(b.url), str(b.domain), str(b.text) ? `\n${str(b.text)}` : ""]),
          by: e.actor,
          url: str(b.url) || null,
        },
        e.at,
      );
      return;
    case "claim_added":
      t.put(
        run,
        "claim",
        ref(b.claim),
        {
          title: str(b.text) || str(b.quote) || `claim ${str(b.claim)}`,
          body: lines([
            str(b.text),
            str(b.quote) ? `“${str(b.quote)}”` : "",
            b.verified === true ? "Verified against its source." : "A draft: not verified yet.",
            // Numbered from 1 for reading, with the index the records keep (goal 117).
            typeof b.question === "number" ? questionLabel(b.question) : "",
          ]),
          by: e.actor,
          sub: b.verified === true ? "verified" : "draft",
        },
        e.at,
      );
      return;
    // A hypothesis: the author's or a research worker's proposed explanation, with the question
    // it is about, its status (goal 117) and the verified claims for it. A revision or a merge
    // gives its new state; who first wrote it stays its writer.
    case "hypothesis_added":
    case "hypothesis_revised":
    case "hypothesis_merged": {
      const supporting = Array.isArray(b.supporting) ? b.supporting.map(String) : [];
      const status = e.kind === "hypothesis_merged" ? "merged" : str(b.status);
      t.put(
        run,
        "hypothesis",
        ref(b.hypothesis),
        {
          title: clip(str(b.text), 300) || `hypothesis ${str(b.hypothesis)}`,
          body: lines([
            str(b.text),
            typeof b.question === "number" ? questionLabel(b.question) : "",
            status ? `Status: ${hypothesisStatusWords(status, str(b.into) || null)}` : "",
            supporting.length
              ? `Supporting claims: ${supporting.join(", ")}`
              : "No verified claim supports it yet.",
            e.kind === "hypothesis_added" ? "" : `Changed by ${str(b.lane) || e.actor}.`,
          ]),
          ...(e.kind === "hypothesis_added" ? { by: str(b.lane) || e.actor } : {}),
        },
        e.at,
      );
      return;
    }
    // A hypothesis promoted, returned to the pool or retired (goal 117), by the owner or the
    // planner, with why: its item's status changes; one not in the reading yet is added.
    case "hypothesis_status": {
      const id = ref(b.hypothesis);
      const status = `Status: ${hypothesisStatusWords(str(b.status))}`;
      const why = `Status set by ${str(b.by) || e.actor}: ${str(b.reason)}`;
      const old = t.item(run, "hypothesis", id)?.body;
      t.put(
        run,
        "hypothesis",
        id,
        old === undefined
          ? {
              title: clip(str(b.text), 300) || `hypothesis ${str(b.hypothesis)}`,
              body: lines([
                str(b.text),
                typeof b.question === "number" ? questionLabel(b.question) : "",
                status,
                why,
              ]),
              by: e.actor,
            }
          : { body: setLine(setLine(old, "Status", status), "Status set by", why) },
        e.at,
      );
      return;
    }
    case "finding_added":
      t.put(
        run,
        "finding",
        ref(b.finding),
        {
          title: str(b.statement) || str(b.text) || `finding ${str(b.finding)}`,
          body: lines([
            str(b.statement),
            str(b.summary),
            str(b.why) ? `Why it matters: ${str(b.why)}` : "",
            `${str(b.claims)} supporting claims${b.supported === false ? " (not all verified)" : ""}`,
          ]),
          by: e.actor,
        },
        e.at,
      );
      return;
    // A research run's paper (goal 112): each next experiment its final writer gave, as an
    // experiment of the campaign's collection, which a goal or hill-climb run can take into its queue.
    // Its details say what it rests on, in words: a run that takes it cannot read this run.
    case PAPER_ACCEPTED: {
      // The paper itself, an item of its own (the owner, goal 162).
      if (str(b.paper))
        t.put(
          run,
          "report",
          "paper",
          {
            title: "Research paper",
            body: cutSaid(str(b.paper), KB_BODY_MAX, "paper"),
            by: `writer:${str(b.writer) || "final writer"}`,
          },
          e.at,
        );
      const xs = Array.isArray(b.experiments) ? b.experiments : [];
      for (const x of xs) {
        if (!x || typeof x !== "object" || !str((x as Row).id)) continue;
        const y = x as Row;
        const rests = Array.isArray(y.rests_on) ? y.rests_on.map(str).filter(Boolean) : [];
        // Its kind (goal 119): the run it is for, a hill climb or a goal campaign, and its measure.
        const kind = str(y.kind);
        const forWords = NEXT_FOR_WORDS.get(kind) ?? "";
        const details = lines([
          str(y.details),
          rests.length
            ? `It rests on, from the research paper of run ${run}:\n${rests.map((r) => `- ${r}`).join("\n")}`
            : "",
        ]);
        t.put(
          run,
          "experiment",
          ref(y.id),
          {
            title: str(y.title) || `experiment ${str(y.id)}`,
            body: lines([
              forWords ? `For: ${forWords}.` : "",
              str(y.measure)
                ? `${kind === "goal" ? "Reached when" : "Measure"}: ${str(y.measure)}`
                : "",
              details,
              str(y.why) ? `Why: ${str(y.why)}` : "",
            ]),
            by: `writer:${str(b.writer) || "final writer"}`,
            ...(forWords
              ? { sub: kind === "goal" ? "for a goal campaign" : "for a hill climb" }
              : {}),
            meta: {
              details,
              why: str(y.why),
              family: "",
              ...(forWords ? { next_for: kind, measure: str(y.measure) } : {}),
            },
          },
          e.at,
        );
      }
      return;
    }
    case "research_final":
    case "research_digest":
      if (str(b.report))
        t.put(
          run,
          "report",
          e.kind === "research_final" ? "final" : "digest",
          {
            title: e.kind === "research_final" ? "Final report" : "Latest digest",
            body: cutSaid(str(b.report), KB_BODY_MAX, "report"),
            by: "research",
          },
          e.at,
        );
      return;
    // Each answer card and the review panel's decisions are items of their own, as the paper is
    // (the owner, goal 162), so a later run reads them whole, not at the end of a cut report.
    case "card_written":
      if (typeof b.question === "number" && str(b.answer))
        t.put(
          run,
          "report",
          `card-q${b.question}`,
          {
            title: `Answer card: ${questionLabel(b.question)}, version ${str(b.version)}`,
            body: cutSaid(
              lines([
                str(b.answer),
                `Certainty: ${str(b.certainty)}`,
                `Claims cited: ${n(b.claims)}; gaps: ${n(b.gaps)}`,
              ]),
              KB_BODY_MAX,
              "answer card",
            ),
            by: str(b.by) || e.actor,
          },
          e.at,
        );
      return;
    case "item_decided": {
      const about =
        str(b.kind) === "question" && /^\d+$/.test(str(b.key))
          ? questionLabel(Number(b.key))
          : `${str(b.kind)} ${str(b.key)}`;
      const dissent = Array.isArray(b.dissent) ? b.dissent.length : 0;
      t.put(
        run,
        "report",
        `decision-${str(b.kind)}-${str(b.key)}`,
        {
          title: `The review panel on ${about}: ${str(b.decision)}`,
          body: lines([
            `Decision: ${str(b.decision)}${str(b.certainty) ? `, ${str(b.certainty)} certainty` : ""}`,
            b.card_version !== undefined && b.card_version !== null
              ? `On answer card version ${str(b.card_version)}`
              : "",
            dissent ? `Dissent: ${dissent} reviewer${dissent === 1 ? "" : "s"}` : "",
            `Review: ${str(b.review)}`,
          ]),
          by: "review_panel",
        },
        e.at,
      );
      return;
    }
  }
}
