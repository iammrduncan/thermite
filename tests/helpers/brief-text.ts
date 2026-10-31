import { type Section, sectionsText } from "../../src/agents/prompt.ts";

/** A trial's brief (its sections, or a text) as the text its prompt carries. */
export const briefText = (b: string | readonly Section[]): string =>
  typeof b === "string" ? b : sectionsText(b);
