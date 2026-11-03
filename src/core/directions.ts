import { z } from "zod";

/**
 * A run's directions (goal 066): the approaches its experiments take. A rule for the
 * plan names one, wherever a rule is made or named: a message to the planner (the Planner tab's
 * Tell the planner, with its picker of the run's directions), the owner's commands over REST, MCP
 * and the command line, and the planner's and the advisors' answers.
 *
 * A direction is written in plain words (`shared memory tiling`) or as `:shared memory tiling:`;
 * the colons are optional around one direction, and mark each one in a longer text. Case, spaces
 * and dashes don't matter: `:Shared memory tiling:` and `shared-memory-tiling` are the same
 * direction, whose name is its words in lowercase joined by dashes (directionKey). A rule may name
 * a direction the run doesn't have yet: the planner designs it, in its own words, at its next
 * round. Rules in words that name no direction (`match`) are no longer made; an old one stays in
 * force, as legacy, until the planner's next round converts it to a rule on a named direction.
 */

/** A direction's name: 2 to 41 lowercase letters, digits and dashes, not starting with a dash. */
export const DIRECTION_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** A research run's directions are its task kinds, whether or not a task of each is queued. */
export const RESEARCH_TASK_KINDS = ["explore", "primary", "contradict", "consolidate"] as const;

/** Lowercase words joined by dashes: "Loop  order" is loop-order. */
function slug(words: string): string {
  return words
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

/**
 * The direction an experiment's words stand for: the words when they are a direction's name
 * already, else the words made into one ("Loop order" is loop-order, ":split k:" is split-k), cut
 * to a name's length. None for words that make no name.
 */
export function directionOf(direction: string): string | undefined {
  const id = slug(direction).slice(0, 41).replace(/-+$/, "");
  return DIRECTION_NAME.test(id) ? id : undefined;
}

/** How a direction may be written in a rule: letters, digits, spaces and dashes. */
const WRITTEN = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;

/**
 * A direction as a rule names it, `shared memory tiling` or `:shared memory tiling:`, as its name
 * (shared-memory-tiling). None for other text, or words too long for a name.
 */
export function directionName(text: string): string | undefined {
  const t = text.trim();
  const inner = /^:(.*):$/.exec(t)?.[1]?.trim() ?? t;
  if (!WRITTEN.test(inner)) return undefined;
  const id = slug(inner);
  return DIRECTION_NAME.test(id) ? id : undefined;
}

/** Why a written direction is not one, in plain words; "" when it is. */
export function notADirection(text: string): string {
  if (directionName(text)) return "";
  const t = text.trim().slice(0, 80);
  const inner = /^:(.*):$/.exec(text.trim())?.[1]?.trim() ?? text.trim();
  return WRITTEN.test(inner) && slug(inner).length > 41
    ? `"${t}" is too long for a direction's name: use at most 41 letters, digits, spaces and dashes`
    : `"${t}" is not a direction's name: write it in letters, digits, spaces and dashes, such as shared memory tiling or :shared memory tiling:`;
}

/**
 * A `:name:` in a longer text: it stands on its own (`10:30:45` names nothing), and starts and
 * ends with a letter or a digit. The Planner tab's script reads messages with the same pattern.
 */
export const DIRECTION_TOKEN_SOURCE =
  "(?<![A-Za-z0-9:]):([A-Za-z0-9](?:[A-Za-z0-9 -]{0,58}[A-Za-z0-9])?):(?![A-Za-z0-9])";
const TOKEN = new RegExp(DIRECTION_TOKEN_SOURCE, "g");

/** Every direction a text names as `:name:`, such as an owner's message, in order, once each. */
export function directionTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const name = directionName(m[1] as string);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * A text such as a message to the planner, in parts, to show each `:name:` as a direction: plain
 * text, a direction (`name`), or a `:name:` that makes no direction's name (`bad`, with why). The
 * parts' `text` joined is the whole text.
 */
export function directionParts(
  text: string,
): { text: string; name?: string | undefined; bad?: string | undefined }[] {
  const out: { text: string; name?: string | undefined; bad?: string | undefined }[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    const name = directionName(m[0]);
    out.push(name ? { text: m[0], name } : { text: m[0], bad: notADirection(m[0]) });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** A direction as a rule shows it. */
export const asToken = (name: string) => `:${name}:`;

/** A list of directions in words: the first `max`, then how many more. */
export function directionList(names: readonly string[], max = 30): string {
  const shown = names.slice(0, max).map(asToken).join(", ");
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

/**
 * Why a research run refuses a rule naming another direction than its task kinds: it has no
 * planner to design a new one.
 */
export function researchDirectionRefusal(unknown: readonly string[]): string {
  return `A research run's directions are its task kinds: ${directionList(RESEARCH_TASK_KINDS)}. Its planner designs no ${unknown.length === 1 ? "new direction" : "new directions"}, so a rule for ${directionList(unknown)} would do nothing. Name a task kind.`;
}

/**
 * A rule's direction in a command or an answer, kept as its name: plain words or `:name:`.
 * Anything else is refused in plain words.
 */
export const DirectionRef = z
  .string()
  .trim()
  .transform((s, ctx) => {
    const name = directionName(s);
    if (name) return name;
    ctx.issues.push({ code: "custom", input: s, message: notADirection(s) });
    return z.NEVER;
  });

/**
 * An old rule in words (`match`, from before rules named directions): kept in force until the
 * planner's next round with its model converts it to a rule on a named direction. Until then only
 * the planner's model reads it, and code never keeps it.
 */
export function isLegacyRule(body: unknown): boolean {
  const b = (body ?? {}) as { match?: unknown; direction?: unknown };
  return typeof b.match === "string" && !b.direction;
}

/** How many old rules in words one planner's round converts; the rest wait for the next round. */
export const CONVERT_PER_ROUND = 5;

/**
 * The old rules in words in force that the planner's next round converts (goal 066): the first
 * CONVERT_PER_ROUND by id, each with its kind, its words and why.
 */
export function rulesToConvert(
  rules: readonly { id: number; body: unknown }[],
): { rule: number; kind: string; words: string; rationale: string }[] {
  return rules
    .filter((r) => isLegacyRule(r.body))
    .slice(0, CONVERT_PER_ROUND)
    .map((r) => {
      const b = r.body as { kind?: unknown; match?: unknown; rationale?: unknown };
      return {
        rule: r.id,
        kind: String(b.kind ?? ""),
        words: String(b.match),
        rationale: String(b.rationale ?? ""),
      };
    });
}

/**
 * An old rule in words as a rule on a named direction: the same kind, why, citations and source
 * (the owner's message it came from), the direction in place of the words, and the rule and the
 * words it was converted from.
 */
export function convertedRule(
  id: number,
  body: Record<string, unknown>,
  direction: string,
): Record<string, unknown> {
  const { match, ...rest } = body;
  return { ...rest, direction, converted_from: { rule: id, words: String(match) } };
}

/**
 * The directions rules name that the run doesn't have yet, each with those rules: the planner
 * designs each one at its next round (goal 066). In order of the first rule naming each.
 */
export function directionsToDesign(
  rules: readonly { id: number; body: unknown }[],
  known: readonly string[],
): { name: string; rules: { id: number; kind: string; rationale: string }[] }[] {
  const out: { name: string; rules: { id: number; kind: string; rationale: string }[] }[] = [];
  for (const r of rules) {
    const b = (r.body ?? {}) as { kind?: unknown; direction?: unknown; rationale?: unknown };
    const f = b.direction;
    if (typeof f !== "string" || !f || known.includes(f)) continue;
    let d = out.find((x) => x.name === f);
    if (!d) {
      d = { name: f, rules: [] };
      out.push(d);
    }
    d.rules.push({ id: r.id, kind: String(b.kind ?? ""), rationale: String(b.rationale ?? "") });
  }
  return out;
}
