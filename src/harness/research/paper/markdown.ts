/** The Markdown a research paper is read with (goal 112): its lines, headings and citations. */

/** A text on one line, cut to n characters with "…" when longer. */
export const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
export const FENCE = /^\s*(```|~~~)/;
export const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
export const TABLE_ROW = /^\s*\|/;
/** A citation: [c-…], or several in one pair of brackets, [c-…, c-…]. */
export const CITE = /\[\s*(c-[A-Za-z0-9_-]+(?:\s*[,;]\s*c-[A-Za-z0-9_-]+)*)\s*\]/g;

/** Words of a heading, folded for matching: "## Appendix A: Data" -> "appendix a data". */
export const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
