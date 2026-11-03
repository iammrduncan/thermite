import { currentContract } from "./names.ts";

/**
 * A campaign's brief (goal 078): what its author tells the agents beyond the objective, kept in
 * its contract. The additional information (`additional_information`: Markdown, with no length
 * limit; `notes` in a contract written before v0.1.1, core/names.ts), the
 * starting links (`links` in a hill climb or goal, a research contract's `seeds`), the ideas to
 * try (hill climb and goal) and the hypotheses. The agents weigh it; it is never a rule: the
 * objective, the judge and the owner's messages decide.
 *
 * Where it goes, and whether whole or cut:
 * - the planner's context (campaign_brief): whole;
 * - the advisors' brief and packages (campaign_brief): whole, ahead of the evidence and the diff,
 *   so only the package's own cut at its end (to the advisor's window, and to advisorPrompt's
 *   most characters) can reach it, after those;
 * - each worker's trial brief, code and research: whole up to BRIEF_WHOLE_CHARS characters; a
 *   longer brief is cut there, with a line that says so and where the whole text is;
 * - the run's folder: BRIEF.md, whole, for every mode.
 * A research run also starts with the hypotheses as its own (startingHypotheses), and the
 * harness fetches and archives its starting links when it starts (the scheduler's seeds).
 */

export interface Brief {
  /** The additional information, in Markdown; "" when none. */
  additional_information: string;
  /** The starting links: a hill climb's or goal's `links`, a research contract's `seeds`. */
  links: string[];
  ideas: string[];
  hypotheses: string[];
}

/** The brief's file in a run's folder. */
export const BRIEF_FILE = "BRIEF.md";

/**
 * The most characters of the brief a worker's trial brief carries. A longer brief is cut there,
 * and the trial brief says where the whole text is (BRIEF.md): the cut is how much goes into one
 * prompt, never a limit on the text.
 */
export const BRIEF_WHOLE_CHARS = 32_000;

/** What every agent is told the brief is. */
export const BRIEF_IS =
  "From the campaign's author: starting points to weigh, not rules. The objective, the judge and the owner's messages decide.";

const fmt = (n: number) => n.toLocaleString("en-US");

const isResearch = (contract: unknown) =>
  (contract as { mode?: unknown } | null | undefined)?.mode === "research";

/** The brief in a contract (or in anything with its fields), or undefined when it has none. */
export function briefOf(contract: unknown): Brief | undefined {
  const c = (currentContract(contract) ?? {}) as {
    additional_information?: unknown;
    links?: unknown;
    seeds?: unknown;
    ideas?: unknown;
    hypotheses?: unknown;
  };
  const list = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
      : [];
  const b: Brief = {
    // Blank lines at either end go; the text's own indentation stays.
    additional_information:
      typeof c.additional_information === "string"
        ? c.additional_information.replace(/^(?:[ \t]*\n)+/, "").trimEnd()
        : "",
    links: list(isResearch(contract) ? c.seeds : c.links),
    ideas: list(c.ideas),
    hypotheses: list(c.hypotheses),
  };
  return b.additional_information || b.links.length || b.ideas.length || b.hypotheses.length
    ? b
    : undefined;
}

/** A numbered entry; its further lines indented under it. */
const entry = (n: number, s: string) => `${n}. ${s.replace(/\n/g, "\n   ")}`;

/** The brief as Markdown: BRIEF.md's body and a trial brief's section. */
export function briefMarkdown(b: Brief, research = false): string {
  return [
    b.additional_information ? `## Additional information\n\n${b.additional_information}` : "",
    b.links.length
      ? `## Starting links\n\n${research ? "The harness fetches and archives these when the run starts: read them under sources/.\n\n" : "Nothing fetched these yet: fetch one when you need it, and the harness archives it.\n\n"}${b.links.map((x) => `- ${x}`).join("\n")}`
      : "",
    b.ideas.length ? `## Ideas to try\n\n${b.ideas.map((x, i) => entry(i + 1, x)).join("\n")}` : "",
    b.hypotheses.length
      ? `## Hypotheses\n\n${research ? "The run started with these as its hypotheses (hypotheses/).\n\n" : ""}${b.hypotheses.map((x, i) => entry(i + 1, x)).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** BRIEF.md: the whole brief, for the run's folder; undefined when the contract has none. */
export function briefFile(contract: unknown): string | undefined {
  const b = briefOf(contract);
  if (!b) return undefined;
  return `# The campaign's brief\n\n${BRIEF_IS}\n\n${briefMarkdown(b, isResearch(contract))}\n`;
}

/**
 * The brief's section in a worker's trial brief (code or research): whole, or its first
 * BRIEF_WHOLE_CHARS characters with a line that says so and where the whole text is. `file`:
 * BRIEF.md as the worker reads it.
 */
export function briefSection(contract: unknown, file: string): string | undefined {
  const b = briefOf(contract);
  if (!b) return undefined;
  const research = isResearch(contract);
  const md = briefMarkdown(b, research);
  const head = `# The campaign's brief\n${BRIEF_IS} ${research ? "Look for sources for and against its hypotheses." : "Try its ideas when they fit, and test its hypotheses."}`;
  if (md.length <= BRIEF_WHOLE_CHARS) return `${head}\n\n${md}`;
  return `${head}\n[Cut to its first ${fmt(BRIEF_WHOLE_CHARS)} of ${fmt(md.length)} characters. The whole brief is in ${file}: read the rest there.]\n\n${md.slice(0, BRIEF_WHOLE_CHARS)}`;
}

/** The parts of a brief a copy or the command line may give, as the request names them. */
export const BRIEF_PARTS = ["additional_information", "links", "ideas", "hypotheses"] as const;

/** Parts of a brief to put in a contract: each one given replaces the contract's. */
export interface BriefChange {
  /** The additional information; "" or null: none. */
  additional_information?: string | null | undefined;
  /** The starting links: a research contract's seeds. []: none. */
  links?: string[] | undefined;
  /** []: none. */
  ideas?: string[] | undefined;
  /** []: none. */
  hypotheses?: string[] | undefined;
}

/**
 * A contract with the brief's parts given (a copy's, or the command line's over a contract file):
 * each replaces the contract's, entries trimmed and empty ones left out, and an empty part removes
 * it. The result is a new contract, under the new names (core/names.ts). The links are a research contract's seeds. Refused in words: ideas to try for a research
 * campaign. The contract check then refuses a link that is not an address.
 */
export function briefChange(
  contract: object,
  change: BriefChange,
): Record<string, unknown> | string {
  const out: Record<string, unknown> = { ...currentContract(contract as Record<string, unknown>) };
  const research = out.mode === "research";
  if (change.ideas !== undefined && research)
    return "Ideas to try are for hill-climb and goal campaigns. A research campaign has questions and hypotheses.";
  if (change.additional_information !== undefined) {
    delete out.additional_information;
    if (change.additional_information?.trim())
      out.additional_information = change.additional_information;
  }
  for (const k of ["links", "ideas", "hypotheses"] as const) {
    const given = change[k];
    if (given === undefined) continue;
    const key = k === "links" && research ? "seeds" : k;
    delete out[key];
    const list = given.map((x) => x.trim()).filter(Boolean);
    if (list.length) out[key] = list;
  }
  return out;
}

/** The brief as the planner and the advisors read it: whole. */
export interface BriefData {
  note: string;
  additional_information?: string;
  starting_links?: string[];
  ideas_to_try?: string[];
  hypotheses?: string[];
}

export function briefData(contract: unknown): BriefData | undefined {
  const b = briefOf(contract);
  if (!b) return undefined;
  return {
    note: BRIEF_IS,
    ...(b.additional_information ? { additional_information: b.additional_information } : {}),
    ...(b.links.length ? { starting_links: b.links } : {}),
    ...(b.ideas.length ? { ideas_to_try: b.ideas } : {}),
    ...(b.hypotheses.length ? { hypotheses: b.hypotheses } : {}),
  };
}
