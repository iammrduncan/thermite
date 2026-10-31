import { asToken } from "../../../core/directions.ts";
import type { StoredEvent } from "../../views/index.ts";
import type { Sentence, SentenceContext } from "./context.ts";
import { clip } from "./shared.ts";

/** The plan's rules and directions, the lanes' restarts and the experiment queue, in words. */
export function planSentence(w: SentenceContext, e: StoredEvent): Sentence | null {
  const { b, who, title, s } = w;
  switch (e.kind) {
    case "directive": {
      const d = (b.body ?? {}) as {
        kind?: string;
        family?: string;
        match?: string;
        converted_from?: unknown;
      };
      // A rule converted from an old rule in words: its directive_converted event tells it.
      if (d.converted_from) return null;
      // A direction as :name: (goal 066); an old rule's words in quotes.
      const what = d.family ? asToken(d.family) : d.match ? `“${d.match}”` : undefined;
      return s(
        `${who(e.actor)} set a rule for the plan${d.kind ? `: ${d.kind}${what ? ` ${what}` : ""}` : ""}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "directives_left_out": {
      const rules = Array.isArray(b.rules)
        ? (b.rules as { kind?: string; family?: string; match?: string }[])
        : [];
      const named = rules
        .map((r) => `${r.kind ?? ""} ${r.family ? asToken(r.family) : (r.match ?? "")}`.trim())
        .join("; ");
      // A rule that freezes the queue's size or pins an experiment (goal 081): left out, with why.
      const refused =
        b.reason === "freezes_queue"
          ? "that would freeze the queue's size"
          : b.reason === "pins_experiment"
            ? "that would pin an experiment"
            : "";
      return s(
        b.reason === "unknown_direction"
          ? `${who(e.actor)} named ${rules.length === 1 ? "a direction" : "directions"} this research run doesn't have (${named}): left out. ${String(b.why ?? "")}`.trim()
          : refused
            ? `${who(e.actor)} gave ${rules.length === 1 ? "a rule" : `${rules.length} rules`} ${refused} (${named || "a note"}): left out. ${clip(String(b.why ?? ""), 300)}`.trim()
            : `${who(e.actor)} named ${rules.length === 1 ? "a rule" : `${rules.length} rules`} you removed (${named}): left out.`,
        refused ? "warn" : "",
        { run: String(e.subject) },
      );
    }
    // The planner's round left the queue below its target (goal 081): the teachers are asked.
    case "queue_low":
      return s(
        `After round ${String(b.round ?? "?")}, the queue had ${String(b.ready ?? "?")} of its target of ${String(b.target ?? "?")} experiments ready: the teachers were asked for ideas at once.`,
        "",
        { run: String(e.subject) },
      );
    case "family_added": {
      const name = asToken(String(b.family ?? ""));
      const what =
        typeof b.description === "string" && b.description ? `: ${clip(b.description, 200)}` : "";
      const rules = Array.isArray(b.for_rules) ? b.for_rules.map(String) : [];
      return s(
        rules.length
          ? `${who(e.actor)} designed the new direction ${name} for rule ${rules.join(", ")}${what}.`
          : `The run has a new direction, ${name}${typeof b.description === "string" && b.description ? ` (${clip(b.description, 200)})` : ""}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "directive_dropped":
      return s(`${who(e.actor)} removed rule ${String(b.id)}.`, "", { run: String(e.subject) });
    // The planner converted an old rule in words to a rule on a named direction (goal 066).
    case "directive_converted":
      return s(
        `${who(e.actor)} converted rule ${String(b.id)}, an old rule in words (“${clip(String(b.words ?? ""), 160)}”), to rule ${String(b.to)}: ${String(b.kind ?? "")} ${asToken(String(b.family ?? ""))}.`,
        "",
        { run: String(e.subject) },
      );
    case "workers_reset":
      return s(
        `${who(e.actor)} restarted the lanes: their trials ended, and every lane starts again from the champion.`,
        "warn",
        { run: String(e.subject) },
      );
    // The run's experiment queue (goal 064): what was added, moved, dropped and given out.
    case "experiment_added": {
      // An experiment whose trial was interrupted (or failed) goes back to the queue as a new one
      // by its author: not the author's act. The harness marks it (requeued_from: the
      // experiment, trial, lane and result); an older one says so only in its why.
      const again = /^tried again: its trial on \S+ (was interrupted|failed) \(/.exec(
        String(b.why ?? ""),
      );
      if (b.requeued_from || again) {
        const by = who(String(b.by ?? e.actor));
        const back = b.requeued_from as { result?: unknown } | undefined;
        const failed = again?.[1] === "failed" || back?.result === "error";
        return s(
          `${by === "You" ? "Your" : by.endsWith("s") ? `${by}'` : `${by}'s`} experiment "${clip(String(b.title ?? ""), 120)}" went back in the queue: its trial ${failed ? "failed" : "was interrupted"}.`,
          "",
          { run: String(e.subject) },
        );
      }
      return s(
        b.from_run
          ? `"${clip(String(b.title ?? ""), 120)}" was copied into the queue from run ${String(b.from_run)}.`
          : `${who(String(b.by ?? e.actor))} ${b.state === "proposed" ? "proposed" : "added"} "${clip(String(b.title ?? ""), 120)}"${b.state === "proposed" ? " as an idea for the queue" : " to the queue"}.`,
        "",
        { run: String(e.subject) },
      );
    }
    // Its trial never really tried it (goal 079): the same experiment, back at the top.
    case "experiment_returned":
      return s(
        `"${clip(title(e.subject, b.id), 120)}" went back to the top of the queue: its trial${b.lane ? ` on ${String(b.lane)}` : ""} ${b.result === "interrupted" ? "was interrupted" : "ended on the provider's error"} (${clip(String(b.cause ?? ""), 200)}).`,
        "",
        { run: String(e.subject) },
      );
    case "experiment_accepted":
    case "experiment_moved":
    case "experiment_edited":
    case "experiment_dropped": {
      const t = `"${clip(title(e.subject, b.id), 120)}"`;
      const by = who(String(b.by ?? e.actor));
      return s(
        e.kind === "experiment_accepted"
          ? `${by} queued the idea ${t}.`
          : e.kind === "experiment_moved"
            ? `${by} moved ${t} to ${typeof b.position === "number" ? `place ${b.position + 1}` : `the ${String(b.position)}`}.`
            : e.kind === "experiment_edited"
              ? `${by} edited ${t}.`
              : `${by} dropped ${t}${b.why ? `: ${clip(String(b.why), 200)}` : ""}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "planner_handout": {
      const as = Array.isArray(b.assignments)
        ? (b.assignments as { lane?: string; experiment?: string }[])
        : [];
      return s(
        `The planner gave out ${Number.isFinite(Number(b.round)) ? `round ${String(b.round)}` : "work"}: ${as.map((a) => `${a.lane} on "${clip(title(e.subject, a.experiment), 80)}"`).join("; ") || "nothing"}.`,
        "",
        { run: String(e.subject) },
      );
    }
    default:
      return null;
  }
}
