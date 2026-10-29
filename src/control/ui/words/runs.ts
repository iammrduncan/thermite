import { listText } from "../../../core/words.ts";
import type { StoredEvent } from "../../views/index.ts";
import type { Sentence, SentenceContext } from "./context.ts";
import { clip } from "./shared.ts";

/** Why a planner's try gave no plan, as the harness records it (goal 079). */
const PLAN_CAUSE_WORDS: Record<string, string> = {
  timeout: "it ran out of time",
  text_only: "it answered in text without a plan",
  cut_off: "its reply was cut off at the output limit",
  provider_error: "the provider failed",
  cancelled: "it was cancelled",
  invalid: "the plan was refused",
};

/** A run, its rounds and its trials, in words. */
export function runSentence(w: SentenceContext, e: StoredEvent): Sentence | null {
  const { b, s } = w;
  switch (e.kind) {
    case "run_created": {
      const seed = (b.seed ?? {}) as {
        repo?: string;
        commit?: string;
        folder?: string;
        source_commit?: string;
      };
      // A project in a folder: the folder of the repository's commit, as its owner knows it.
      const from = seed.folder
        ? `the folder ${seed.folder} of ${seed.repo ?? "its repository"} at ${String(seed.source_commit ?? "").slice(0, 8)}`
        : `${seed.repo ?? "its project"} at ${String(seed.commit ?? "").slice(0, 8)}`;
      return s(`Run ${e.subject} started from ${from}.`, "", { run: String(e.subject) });
    }
    case "run_status":
      return s(
        b.status === "running"
          ? `Run ${e.subject} resumed.`
          : `Run ${e.subject} ${String(b.status)}${b.reason ? `: ${String(b.reason)}` : ""}.`,
        b.status === "running" ? "ok" : "warn",
        { run: String(e.subject) },
      );
    case "epoch_started": {
      const as = Array.isArray(b.assignments)
        ? (b.assignments as { lane?: string; family?: string }[])
        : [];
      const round = Number.isFinite(Number(b.n)) ? `round ${String(b.n)}` : "a round";
      // Why each try gave no plan: its real cause (goal 079), else ("try 2: …") its refusal.
      const causes = Array.isArray(b.causes)
        ? (b.causes as { try?: unknown; cause?: unknown; detail?: unknown }[]).map(
            (c) =>
              `try ${String(c.try)}: ${PLAN_CAUSE_WORDS[String(c.cause)] ?? String(c.cause)}${c.detail ? ` (${clip(String(c.detail), 160)})` : ""}`,
          )
        : [];
      const refused = causes.length
        ? causes
        : Array.isArray(b.refused)
          ? b.refused.map(String)
          : [];
      const because =
        refused.length === 1 ? String(refused[0]).replace(/^try \d+: /, "") : refused.join("; ");
      // A hill climb's setup round (goal 115): set from the judge's reasons, not a refused plan.
      if (b.plan === "setup")
        return s(
          `${round.charAt(0).toUpperCase()}${round.slice(1)} is a setup round: ${listText(as.map((a) => String(a.lane)))} work${as.length === 1 ? "s" : ""} to make the starting point build and run its cases.`,
          "warn",
          { run: String(e.subject) },
        );
      // A research run's code plan, with the planner off on purpose (goal 117): not a refused plan.
      if (b.plan === "research" || String(b.notes ?? "").startsWith("research plan"))
        return s(
          `The gap-driven plan set ${round} (the planner is off): ${as.map((a) => `${a.lane} on ${a.family}`).join("; ")}.`,
          "",
          { run: String(e.subject) },
        );
      return s(
        `The planner planned ${round}${
          b.source !== "fallback"
            ? ""
            : refused.length
              ? ` (by the fixed rules: the model gave no usable plan, because ${because})`
              : b.notes
                ? ` (by the fixed rules: ${String(b.notes)})`
                : Number(b.planner_tries) === 0
                  ? " (by the fixed rules: no model)"
                  : " (by the fixed rules)"
        }: ${as.map((a) => `${a.lane} on ${a.family}`).join("; ")}.`,
        "",
        { run: String(e.subject) },
      );
    }
    case "trial_finished": {
      const why =
        b.attempt !== null && b.attempt !== undefined
          ? `submitted ${String(b.attempt)}`
          : `without a submission (${String(b.stopped).replace(/_/g, " ")}${b.error ? `: ${clip(String(b.error), 140)}` : ""})`;
      const compactions = Number(b.compactions) || 0;
      return s(
        `${b.lane ? String(b.lane) : "A lane"}'s trial${b.family ? ` on ${String(b.family)}` : ""} ended ${why}.${compactions ? ` Its conversation was compacted ${compactions === 1 ? "once" : `${compactions} times`}.` : ""}`,
        b.attempt ? "" : b.stopped === "error" ? "bad" : "",
        { attempt: b.attempt ? String(b.attempt) : undefined, run: String(e.subject) },
      );
    }
    // A trial that repeats the same tool calls (goal 143): it asks the owner under Needs you.
    case "trial_repeating": {
      const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "");
      return s(
        `${b.lane ? `${String(b.lane)}'s` : "A"} trial repeats the same tool calls: ${n(b.count)} in a row, each with the same answer as before, ${n(b.different)} different. It goes on, and asks you under Needs you.`,
        "warn",
        { run: String(e.subject) },
      );
    }
    // A conversation compacted near the model's window (goal 070): the trial went on.
    case "context_compacted": {
      const by =
        b.harness === "opencode"
          ? "OpenCode"
          : b.harness === "codex"
            ? "Codex"
            : b.harness === "claude-code"
              ? "Claude Code"
              : "The harness";
      const whose = b.trial
        ? `${b.lane ? `${String(b.lane)}'s` : "a"} trial ${String(b.trial)}`
        : `the ${String(b.lane ?? "planner")}`;
      const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "");
      const tokens = num(b.tokens_before)
        ? ` at about ${num(b.tokens_before)} tokens${num(b.tokens_after) ? `, down to about ${num(b.tokens_after)}` : ""}`
        : "";
      return s(
        `${by} compacted the conversation of ${whose} (compaction ${String(b.number)})${tokens}, and it went on.${b.how === "trimmed" ? " The summary failed, so older tool results were left out." : ""}${b.snapshot ? ` The conversation before it is kept in the run's research folder, ${String(b.snapshot)}.` : ""}`,
        "",
        { run: String(e.subject) },
      );
    }
    // The owner's input into a trial's terminal (goal 169), word for word, and what became of it.
    case "terminal_input": {
      const what = Array.isArray(b.keys)
        ? `the keys ${b.keys.map(String).join(", ")}`
        : `“${clip(String(b.text ?? ""), 200)}”`;
      const where = `${b.lane ? `${String(b.lane)}'s` : "a"} terminal (trial ${String(b.trial)})`;
      const words: Record<string, [string, Sentence["tone"]]> = {
        typed: [`You typed ${what} into ${where}.`, ""],
        queued: [
          `You typed ${what} into ${where}: it waits for the usage window's reset${b.until ? ` (${String(b.until)})` : ""}.`,
          "warn",
        ],
        typed_after_reset: [
          `Your input ${what} went into ${where} after the usage window's reset.`,
          "",
        ],
        dropped: [`Your input ${what} for ${where} was dropped: ${String(b.why ?? "")}`, "warn"],
        refused: [`Not typed into ${where}: ${what}. ${String(b.why ?? "")}`, "bad"],
      };
      const [text, tone] = words[String(b.outcome)] ?? [`You typed ${what} into ${where}.`, ""];
      return s(text, tone, { run: String(e.subject) });
    }
    default:
      return null;
  }
}
