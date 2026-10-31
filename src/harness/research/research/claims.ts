import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CLAIM_LIMITS } from "../../../agents/tools/index.ts";
import { canonicalJson } from "../../../core/canonical.ts";
import { LedgerError, type SourceRow } from "../../ledger/index.ts";
import { normalizeQuote, numbersIn, withoutNames } from "../checks.ts";
import { noQuestion } from "../worker-words.ts";
import { claimKey, clip, questionOf, type ResearchContext, sourceText } from "./context.ts";
import { archiveUrl } from "./sources.ts";

/** A worker's claims: each quote checked against the archived text of the source it cites. */

/** A label at a line's start that numbers a question or a claim: "Question 0:", "Claim c-005:". */
const LABEL = /^[*_]*(?:question|claim)\s*#?\s*[\w.-]*\d[\w-]*\s*[:.)\]]/i;

/**
 * The heading or label of a claim's text that a number comes from, if it comes from one: a
 * Markdown heading line ("# Claim c-verify-005") or a label at a line's start ("Question 0:").
 * Such a number counts like any other (the check is the same); the problem only says where it is.
 */
function headingWith(text: string, num: string): string | undefined {
  for (const line of text.split("\n")) {
    const t = line.trim();
    const head = /^#{1,6}\s/.test(t) ? t : LABEL.exec(t)?.[0];
    if (head && numbersIn(head).includes(num)) return head;
  }
  return undefined;
}

/** A URL loosely, to name what a source could be: no scheme, no "www.", no fragment or end slash. */
const looseUrl = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/#.*$/, "")
    .replace(/\/+$/, "");

/** A quote as a claim keeps it: its source's id, and what the worker cited when that was not it. */
interface ClaimQuote {
  source: string;
  quote: string;
  resolved_from?: string;
}

/** The most draft reasons a `claim_added` event carries (the claim's record keeps them all). */
const EVENT_PROBLEMS = 20;

/** A claim as a worker sends it, within the limits add_claim's text gives (CLAIM_LIMITS). */
export const ClaimInput = z.object({
  text: z.string().min(CLAIM_LIMITS.text.min).max(CLAIM_LIMITS.text.max),
  quotes: z
    .array(
      z.object({
        source: z.string().min(1),
        quote: z.string().min(CLAIM_LIMITS.quote.min).max(CLAIM_LIMITS.quote.max),
      }),
    )
    .min(CLAIM_LIMITS.quotes.min)
    .max(CLAIM_LIMITS.quotes.max),
  question: z.number().int().min(0).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/**
 * The archived source a quote cites. A quote names it by the id fetch returned. A URL it was
 * archived from (as fetched, or as its redirects ended; compared as the archive stores URLs) or
 * its file name in the research folder (`sources/s-….txt`) names it too, when it names exactly
 * one: the quote is then checked against that source, and the claim records what was cited.
 * Anything else is a problem that says what the source could be. The check itself is the same.
 */
function resolveSource(
  ctx: ResearchContext,
  run: string,
  cited: string,
): { row: SourceRow; from?: string | undefined } | { problem: string } {
  const byId = (id: string) => ctx.ledger.sources.get(run, id);
  const said = clip(cited, 200);
  const s = cited.trim();
  const exact = byId(s);
  if (exact) return { row: exact, from: s === cited ? undefined : cited };
  const file = /^(?:.*\/)?(s-[0-9a-f]+)\.(?:txt|md)$/.exec(s)?.[1];
  if (file) {
    const row = byId(file);
    return row
      ? { row, from: cited }
      : {
          problem: `no archived source ${said}: the research folder has no sources/${file}.txt; cite the s-… id that fetch returned`,
        };
  }
  const url = /^https?:\/\//i.test(s) ? archiveUrl(s) : undefined;
  if (url) {
    const ids = ctx.ledger.sources.idsAt(run, url);
    if (ids.length === 1) return { row: byId(ids[0] as string) as SourceRow, from: cited };
    if (ids.length > 1)
      return {
        problem: `no archived source ${said}: that URL is archived as ${ids.length} sources (${ids.join(", ")}); cite the id of the one the quote is from`,
      };
  }
  // Not archived as written. A URL archived in another form (http for https, without its
  // scheme or "www.", with an end slash) is named, never taken.
  const loose = looseUrl(s);
  const near: { id: string; at: string }[] = [];
  for (const r of ctx.ledger.sources.list(run)) {
    const at = [r.url, r.final_url].find((u) => looseUrl(u) === loose);
    if (at !== undefined) near.push({ id: r.id, at });
    if (near.length === 3) break;
  }
  if (near.length)
    return {
      problem: `no archived source ${said}: that URL is not archived as written, but ${near.map((r) => `${r.id} is archived from ${clip(r.at, 200)}`).join(", and ")}; cite ${near.length === 1 ? "that id" : "the id of the page the quote is from"} if it is the same page`,
    };
  return {
    problem: url
      ? `no archived source ${said}: no source was archived from that URL; fetch it first, then cite the s-… id that fetch returns`
      : `no archived source ${said}: a quote's source is the s-… id that fetch returned`,
  };
}

/** A worker's claim, checked by code: verified, or kept as a draft with its problems. */
export function addClaim(ctx: ResearchContext, run: string, lane: string | null, input: unknown) {
  const c = ClaimInput.parse(input);
  // A claim counts toward its question's answer: with one question, that one. A run of another
  // mode has no questions.
  const research = ctx.ledger.runs.get(run)?.mode === "research";
  const n = research ? ctx.contract(run).questions.length : 0;
  if (c.question === undefined && n > 1) throw new LedgerError("invalid", noQuestion(n));
  const question = research ? questionOf(ctx, run, c.question ?? 0) : null;
  const key = claimKey(c.text);
  const same = ctx.ledger.claims.verifiedFirst(run).find((r) => claimKey(r.text) === key);
  if (same?.verified) {
    return {
      claim: same.id,
      verified: true,
      problems: [],
      note: "this claim is already recorded and verified",
    };
  }
  const problems: string[] = [];
  const quotes: ClaimQuote[] = [];
  const resolved: { cited: string; source: string }[] = [];
  for (const q of c.quotes) {
    const s = resolveSource(ctx, run, q.source);
    if ("problem" in s) {
      problems.push(s.problem);
      quotes.push({ source: q.source, quote: q.quote });
      continue;
    }
    const id = s.row.id;
    quotes.push({
      source: id,
      quote: q.quote,
      ...(s.from === undefined ? {} : { resolved_from: s.from }),
    });
    if (s.from !== undefined) resolved.push({ cited: s.from, source: id });
    if (!normalizeQuote(sourceText(s.row)).includes(normalizeQuote(q.quote))) {
      problems.push(`quote not found verbatim in ${id}: "${q.quote.slice(0, 80)}"`);
    }
  }
  // A claim may not state numbers its own quotes do not contain. One from a heading or a label
  // ("Question 0:", "# Claim …") counts the same; the problem says where it comes from.
  // Whole numbers, not parts of them: a claim's 5 is not in a quote's 2025. A name's digits
  // (sm_50) are not stated numbers; a heading or label in the claim's text still is.
  const plain = (n: string) => n.replace(/,/g, "");
  const quoted = new Set(c.quotes.flatMap((q) => numbersIn(normalizeQuote(q.quote))).map(plain));
  for (const num of numbersIn(withoutNames(c.text))) {
    if (quoted.has(plain(num))) continue;
    const head = headingWith(c.text, num);
    problems.push(
      head
        ? `the number ${num} is not in the claim's quotes: it comes from the heading "${clip(head, 80)}". Give a question's number in "question", not in the claim's text, and leave headings and labels out of the text`
        : `the number ${num} is not in the claim's quotes`,
    );
  }
  const verified = problems.length === 0;
  // Each URL or file name taken as a source's id, so the worker cites the id next time.
  const how = resolved.length ? { resolved } : {};
  // The same claim with the same quotes, refused before: answered again, not recorded again, so
  // a worker that resubmits it in a loop learns what to change and fills no records.
  if (!verified) {
    const same = canonicalJson(quotes);
    const before = ctx.ledger.claims
      .drafts(run)
      .find((r) => claimKey(r.text) === key && r.quotes === same);
    if (before)
      return {
        claim: before.id,
        verified: false,
        problems,
        ...how,
        note: "this same claim, with the same quotes, was refused before for the same reasons: read_source the passage and copy its words exactly into the quote, or record what you learned as a note (add_note) instead",
      };
  }
  const id = `c-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  ctx.ledger.tx(() => {
    ctx.ledger.claims.add({
      id,
      run,
      lane,
      question,
      text: c.text,
      quotes,
      verified,
      problems,
      confidence: c.confidence ?? null,
    });
    // The claim's words and its first quote, bounded: the record of what the source says. Its
    // quotes' sources, and why a draft is one, so the owner sees it as the worker did.
    ctx.ledger.appendEvent(lane ?? "research", "claim_added", run, {
      claim: id,
      verified,
      question: c.question ?? null,
      text: clip(c.text, 500),
      quote: clip(c.quotes[0]?.quote ?? "", 500),
      sources: quotes.map((q) => clip(q.source, 200)),
      problems: problems.slice(0, EVENT_PROBLEMS).map((p) => clip(p, 300)),
      ...(problems.length > EVENT_PROBLEMS
        ? { more_problems: problems.length - EVENT_PROBLEMS }
        : {}),
    });
  });
  ctx.changed(run);
  return { claim: id, verified, problems, ...how };
}
