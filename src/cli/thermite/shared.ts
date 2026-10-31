import { readFileSync } from "node:fs";
import { errorText } from "../../common/errors.ts";
import { agentsContextRefusal } from "../../core/compaction.ts";

/** What several commands share: how a command stops on a mistake, and a campaign's own options. */

export function fail(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

/**
 * A campaign's own context settings from --context-window and --compact-at (goal 070), refused in
 * words when out of range; undefined when neither is given.
 */
export function contextFromFlags(values: {
  "context-window"?: string | undefined;
  "compact-at"?: string | undefined;
}): { context_window?: number; compact_at?: number } | undefined {
  const window = values["context-window"];
  const at = values["compact-at"];
  if (window === undefined && at === undefined) return undefined;
  const own = {
    ...(window !== undefined ? { context_window: Number(window) } : {}),
    ...(at !== undefined ? { compact_at: Number(at) } : {}),
  };
  const why = agentsContextRefusal(own);
  if (why) fail(`--context-window and --compact-at: ${why}`);
  return own;
}

/**
 * A campaign's brief from --info-file, --idea and --hypothesis (goal 078): the additional
 * information (the file's Markdown, the contract's notes), the ideas to try and the hypotheses,
 * one per option. Only what is given: each part replaces the contract's (or the copied
 * campaign's).
 */
export function briefFromFlags(values: {
  "info-file"?: string | undefined;
  link?: string[] | undefined;
  idea?: string[] | undefined;
  hypothesis?: string[] | undefined;
}): { notes?: string; ideas?: string[]; hypotheses?: string[] } {
  const file = values["info-file"];
  let notes: string | undefined;
  if (file !== undefined) {
    try {
      notes = readFileSync(file, "utf8");
    } catch (err) {
      fail(`--info-file: ${errorText(err)}`);
    }
  }
  return {
    ...(notes !== undefined ? { notes } : {}),
    ...(values.link ? { links: values.link } : {}),
    ...(values.idea ? { ideas: values.idea } : {}),
    ...(values.hypothesis ? { hypotheses: values.hypothesis } : {}),
  };
}
