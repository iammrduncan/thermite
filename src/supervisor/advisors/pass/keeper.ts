import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdvisorKeeper } from "../call.ts";
import { clip } from "./shared.ts";

/** A name safe for a file: other characters become dashes. */
const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "advisor";

/**
 * Where an advisor's conversation is kept before each compaction (goal 070): the supervisor's home,
 * beside its records of the advisors' rounds (advisors/), under compactions/<run>/. Never the run's
 * research folder, which the run's agents read: an advisor's conversation may hold an outside
 * knowledge base's results or a fetched page. Each compaction is a line in the run's live view.
 */
export function advisorKeeper(
  home: string,
  run: string | undefined,
  say?: ((text: string) => void) | undefined,
): AdvisorKeeper {
  const folder = `compactions/${fileSafe(run ?? "no-run")}`;
  const stem = (advisor: string, call: string) => `${fileSafe(call)}-${fileSafe(advisor)}`;
  const program = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" } as const;
  return {
    keep: (advisor, call, n, markdown) => {
      const dir = join(home, "advisors", folder);
      mkdirSync(dir, { recursive: true });
      const name = `${stem(advisor, call)}-${n}.md`;
      writeFileSync(join(dir, name), markdown);
      return `the supervisor's records, advisors/${folder}/${name}`;
    },
    // Where it will be kept, in the same words, for the summary of the advisor's own program.
    at: (advisor, call) => ({
      dir: `advisors/${folder}`,
      stem: stem(advisor, call),
      readable: false,
      place: "the supervisor's records",
    }),
    done: (c) => {
      const tokens =
        c.tokens_before !== null
          ? ` at about ${c.tokens_before.toLocaleString("en-US")} tokens${c.tokens_after !== null ? `, down to about ${c.tokens_after.toLocaleString("en-US")}` : ""}`
          : "";
      const by = c.harness ? ` by ${program[c.harness]}` : "";
      say?.(
        `advisor ${c.advisor}: its conversation was compacted${by} (compaction ${c.number})${tokens}. It goes on.${c.how === "trimmed" ? " The summary failed, so the bodies of older tool results were left out." : ""}${c.kept ? ` The conversation before it is kept in ${c.kept}.` : " The conversation before it was not kept."}${c.error ? ` (${clip(c.error, 300)})` : ""}`,
      );
      if (c.summary)
        say?.(
          `advisor ${c.advisor}: the summary after compaction ${c.number}:\n\n${clip(c.summary, 4000)}`,
        );
    },
  };
}
