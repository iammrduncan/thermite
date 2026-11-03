import { LedgerPart, type Row } from "./part.ts";

/** A version of a question's answer card as its row holds it; its claims and gaps are JSON, as stored. */
export interface CardRow {
  run: string;
  question: number;
  version: number;
  answer: string;
  certainty: string;
  claims: string;
  gaps: string;
  by: string;
  created_at: string;
}

function toCard(r: Row): CardRow {
  return {
    run: String(r.run),
    question: Number(r.question),
    version: Number(r.version),
    answer: String(r.answer),
    certainty: String(r.certainty),
    claims: String(r.claims),
    gaps: String(r.gaps),
    by: String(r.by),
    created_at: String(r.created_at),
  };
}

/**
 * The `question_card` table: each research question's answer card, kept as versions (append-only:
 * the newest version is the card).
 */
export class LedgerCards extends LedgerPart {
  /** A question's card, written at `at` by `by` as its next version: that version. */
  add(c: {
    run: string;
    question: number;
    answer: string;
    certainty: string;
    claims: readonly string[];
    gaps: readonly { kind: string; text: string }[];
    by: string;
    at: string;
  }): number {
    return this.tx(() => {
      const v =
        Number(
          this.row<Row>(
            "select max(version) as v from question_card where run = ? and question = ?",
            c.run,
            c.question,
          )?.v ?? 0,
        ) + 1;
      this.execute(
        "insert into question_card (run, question, version, answer, certainty, claims, gaps, by, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        c.run,
        c.question,
        v,
        c.answer,
        c.certainty,
        JSON.stringify(c.claims),
        JSON.stringify(c.gaps),
        c.by,
        c.at,
      );
      return v;
    });
  }

  /** A question's card: its newest version, if it has one. */
  newest(run: string, question: number): CardRow | undefined {
    const r = this.row<Row>(
      "select * from question_card where run = ? and question = ? order by version desc limit 1",
      run,
      question,
    );
    return r ? toCard(r) : undefined;
  }

  /** The newest card of each question of the run that has one, by question. */
  newestOfEach(run: string): CardRow[] {
    return this.rows<Row>(
      `select c.* from question_card c where c.run = ? and c.version = (
           select max(d.version) from question_card d where d.run = c.run and d.question = c.question)
         order by c.question`,
      run,
    ).map(toCard);
  }

  /** The newest card version of each question of the run, by question index. */
  newestVersions(run: string): Map<number, number> {
    return new Map(
      this.rows<Row>(
        "select question, max(version) as v from question_card where run = ? group by question",
        run,
      ).map((r) => [Number(r.question), Number(r.v)]),
    );
  }

  /** Every version of a question's card, the first first. */
  history(run: string, question: number): CardRow[] {
    return this.rows<Row>(
      "select * from question_card where run = ? and question = ? order by version",
      run,
      question,
    ).map(toCard);
  }

  /** Every version of the run's cards, by question, the first first. */
  versions(run: string): CardRow[] {
    return this.rows<Row>(
      "select * from question_card where run = ? order by question, version",
      run,
    ).map(toCard);
  }
}
