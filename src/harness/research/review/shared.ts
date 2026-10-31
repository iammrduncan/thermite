/** What the parts of a research run's reviews share (review.ts says what the reviews are). */

export type Row = Record<string, unknown>;

export const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const listOf = <T>(json: unknown): T[] => {
  try {
    const v = JSON.parse(String(json ?? "[]")) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

/** Question indexes in words for people: "question 2", "questions 2, 5". */
export const questionsWords = (xs: number[]) =>
  `${xs.length === 1 ? "question" : "questions"} ${xs.map((i) => i + 1).join(", ")}`;
