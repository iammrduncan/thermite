import type { Ledger } from "../../src/harness/ledger/index.ts";
import type { HarnessService } from "../../src/harness/service/index.ts";

/**
 * Goal 117's tests of answer cards at the scale of a long run: six questions, as the 35-hour run
 * had, a rubric for each, and hundreds of verified claims recorded straight into the ledger (the
 * claim check itself has its own tests), from sources on several domains.
 */

export const SIX_QUESTIONS = [
  "Which memory access patterns limit a tiled matrix multiply on older GPUs?",
  "How much does shared memory tiling help on cards without tensor cores?",
  "Which compiler flags change register pressure in such kernels?",
  "What do vendors document about occupancy limits per streaming multiprocessor?",
  "Which profiling counters show bank conflicts?",
  "What do published kernels report for half precision on these cards?",
];

export const SIX_RUBRICS = SIX_QUESTIONS.map(
  (q, i) => `An answer to question ${i + 1} names the evidence for each part of: ${q}`,
);

/** Domains the seeded sources come from. */
export const DOMAINS = ["docs.example.com", "papers.example.org", "forum.example.net"];

/** One archived source for each domain, recorded straight into the ledger; ids by domain. */
export function seedSources(ledger: Ledger, run: string, domains = DOMAINS): Map<string, string> {
  const out = new Map<string, string>();
  domains.forEach((domain, i) => {
    const id = `s-seed${String(i).padStart(6, "0")}`;
    ledger.db
      .prepare(
        `insert into source (id, run, url, final_url, domain, fetched_at, http_status, content_type, bytes, sha256,
           title, raw_path, text_path, fetched_by) values (?, ?, ?, ?, ?, ?, 200, 'text/html', 100, ?, ?, ?, ?, 'lane-1')`,
      )
      .run(
        id,
        run,
        `https://${domain}/page-${i}`,
        `https://${domain}/page-${i}`,
        domain,
        new Date().toISOString(),
        String(i).padStart(64, "0"),
        `Page ${i}`,
        `/nonexistent/raw-${i}`,
        `/nonexistent/text-${i}`,
      );
    out.set(domain, id);
  });
  return out;
}

/**
 * `n` claims of a question (null: none), recorded straight into the ledger: each states a number
 * its quote holds, from the given sources, one second apart from `from` (ms). Returns their ids,
 * the oldest first. Their ids are `c-<tag><k>`, so a test can name them.
 */
export function seedClaims(
  ledger: Ledger,
  run: string,
  o: {
    question: number | null;
    n: number;
    sources: string[];
    from: number;
    tag: string;
    verified?: boolean;
  },
): string[] {
  const ids: string[] = [];
  const add = ledger.db.prepare(
    "insert into claim (id, run, lane, question, text, quotes, verified, problems, confidence, created_at) values (?, ?, 'lane-1', ?, ?, ?, ?, '[]', null, ?)",
  );
  for (let k = 0; k < o.n; k++) {
    const id = `c-${o.tag}${String(k).padStart(6, "0")}`;
    const text = `The ${o.tag} page reports ${1000 + k} MB/s for its case.`;
    add.run(
      id,
      run,
      o.question,
      text,
      JSON.stringify(o.sources.map((source) => ({ source, quote: text }))),
      o.verified === false ? 0 : 1,
      new Date(o.from + k * 1000).toISOString(),
    );
    ids.push(id);
  }
  return ids;
}

/** The number the k-th seeded claim states. */
export const seededNumber = (k: number) => String(1000 + k);

/**
 * Brings every answer card of a run up to date with a card that says nothing yet (certainty none),
 * so no question waits for the synthesizer: for tests of other advisors, whose scripted models
 * answer only their own calls.
 */
export function cardsUpToDate(service: HarnessService, run: string): void {
  for (let i = 0; i < 100; i++) {
    const pkg = service.cardPackages().find((p) => p.run === run);
    if (!pkg) return;
    service.submitCards(
      run,
      {
        synthesizer: "test",
        cards: pkg.questions.map((q) => ({
          question: q.index,
          answer: "No card was written in this test.",
          certainty: "none",
          claims: [],
          borrowed: [],
          gaps: [],
          through: q.through,
        })),
      },
      "test",
    );
  }
  throw new Error(`the cards of ${run} did not come up to date`);
}
