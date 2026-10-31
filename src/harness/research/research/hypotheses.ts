import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../../core/canonical.ts";
import {
  HYPOTHESES_RULE,
  hypothesisStatusWords,
  LIVE_HYPOTHESES,
  questionLabel,
} from "../../../core/research-check.ts";
import { type HypothesisRow, type Ledger, LedgerError } from "../../ledger/index.ts";
import { foldText } from "../checks.ts";
import { repeatsWords } from "../worker-words.ts";
import { clip, questionOf, type ResearchContext } from "./context.ts";

/**
 * A run's hypotheses (goals 078 and 117): its starting ones, a worker's proposals and revisions,
 * a change of status, and how a worker's brief lists them.
 */

/** The hypotheses a worker's brief lists: those that need a verdict, and the pool's newest. */
const BRIEF_REQUIRED = 30;
const BRIEF_POOL = 10;

/** A hypothesis's longest text: a longer one is cut to it. */
const HYPOTHESIS_MAX = 2000;

const ClaimIds = z.array(z.string().max(500)).max(50);

export const HypothesisInput = z.object({
  text: z.string(),
  question: z.number().int().nullable().optional(),
  supporting: ClaimIds.default([]),
});

export const HypothesisRevision = z.object({
  id: z.string().min(1).max(200),
  text: z.string().optional(),
  question: z.number().int().nullable().optional(),
  supporting: ClaimIds.optional(),
});

/**
 * A research run's starting hypotheses (goal 078): those of its campaign's brief, recorded as the
 * run's first hypotheses when the run is made, each whole, with no supporting claim yet and no
 * lane. Each is a hypothesis_added event by `by` (who assigned the run), so the campaign's folder
 * in the knowledge base holds them too. Returns their ids.
 */
export function startingHypotheses(
  ledger: Ledger,
  run: string,
  texts: string[],
  by: string,
): string[] {
  return ledger.tx(() =>
    texts.map((text) => {
      const id = `h-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      ledger.hypotheses.add({
        id,
        run,
        lane: null,
        question: null,
        text,
        supporting: [],
        status: "author",
      });
      ledger.appendEvent(by, "hypothesis_added", run, {
        hypothesis: id,
        lane: null,
        text,
        supporting: [],
        from: "brief",
        question: null,
        status: "author",
      });
      return id;
    }),
  );
}

/** The statuses a hypothesis may be given by command (goal 117): promoted, back to the pool, retired. */
export const HYPOTHESIS_STATUS_CHANGES = ["promoted", "pool", "retired"] as const;
export type HypothesisStatusChange = (typeof HYPOTHESIS_STATUS_CHANGES)[number];

/** A change of a hypothesis's status, as the owner's command and the planner give it. */
export const HypothesisStatusInput = z.strictObject({
  id: z.string().trim().min(1).max(64),
  status: z.enum(HYPOTHESIS_STATUS_CHANGES),
  reason: z.string().trim().min(1).max(2000),
});
export type HypothesisStatusInput = z.infer<typeof HypothesisStatusInput>;

/** The event of a hypothesis whose status was changed by command or by the planner. */
export const HYPOTHESIS_STATUS = "hypothesis_status";

/**
 * Changes a hypothesis's status (goal 117): the owner's `hypothesis_status` command and the
 * planner's promotions and retirements both come here. A pool hypothesis may be promoted (it then
 * needs a verdict from the review panel, as the author's do) or retired; a promoted one may go
 * back to the pool or be retired; a retired one may go back to the pool or be promoted, unless
 * its words now repeat a live hypothesis of the run. Refused in words: an unknown hypothesis, one
 * of the author's (the campaign's brief sets those), and a merged one. The same status again
 * changes nothing and records nothing. Each change is the event `hypothesis_status`, with who
 * changed it and why. Who may do what beyond this (the planner's bounds) is the caller's.
 */
export function setHypothesisStatus(
  ledger: Ledger,
  run: string,
  input: unknown,
  by: string,
): {
  hypothesis: string;
  status: HypothesisStatusChange;
  from: string;
  changed: boolean;
  note?: string;
} {
  const p = HypothesisStatusInput.safeParse(input);
  if (!p.success)
    throw new LedgerError(
      "invalid",
      `a status change is {"id", "status": "promoted", "pool" or "retired", "reason"}: ${p.error.issues[0]?.path.join(".") || "it"} ${p.error.issues[0]?.message ?? "is not valid"}`,
    );
  const { id, status, reason } = p.data;
  const h = ledger.hypotheses.get(run, id);
  if (!h) throw new LedgerError("not_found", `no hypothesis ${id} in run ${run}`);
  const from = h.status;
  if (from === "author")
    throw new LedgerError(
      "invalid",
      `hypothesis ${id} is one of the author's: it needs a verdict already, and only the campaign's brief changes it`,
    );
  if (from === "merged")
    throw new LedgerError(
      "invalid",
      `hypothesis ${id} was merged into ${String(h.merged_into)}: change ${String(h.merged_into)} instead`,
    );
  if (from === status)
    return {
      hypothesis: id,
      status,
      from,
      changed: false,
      note: `hypothesis ${id} is ${hypothesisStatusWords(status)} already: nothing changed`,
    };
  // A retired hypothesis comes back only when no live one repeats it meanwhile.
  if (from === "retired") {
    const key = foldText(h.text);
    const twin = ledger.hypotheses
      .withStatus(run, LIVE_HYPOTHESES)
      .find((t) => t.id !== id && foldText(t.text) === key);
    if (twin)
      throw new LedgerError(
        "invalid",
        `hypothesis ${id}'s words repeat ${twin.id} (${hypothesisStatusWords(twin.status)}): change ${twin.id} instead`,
      );
  }
  ledger.tx(() => {
    ledger.hypotheses.setStatus(id, status);
    ledger.appendEvent(by, HYPOTHESIS_STATUS, run, {
      hypothesis: id,
      status,
      from,
      by,
      reason,
      question: h.question,
      text: h.text,
    });
  });
  return { hypothesis: id, status, from, changed: true };
}

/** The run's live hypothesis (the author's, the pool's or promoted) whose words these repeat. */
function twinOf(
  ctx: ResearchContext,
  run: string,
  text: string,
  except?: string | undefined,
): HypothesisRow | undefined {
  const key = foldText(text);
  return ctx.ledger.hypotheses
    .withStatus(run, LIVE_HYPOTHESES)
    .find((h) => h.id !== except && foldText(h.text) === key);
}

/** The verified claims of the run among these ids, and the rest. */
function verifiedAmong(
  ctx: ResearchContext,
  run: string,
  ids: string[],
): { ok: string[]; ignored: string[] } {
  const known = new Set(ctx.ledger.claims.verified(run).map((r) => r.id));
  const unique = [...new Set(ids)];
  return { ok: unique.filter((c) => known.has(c)), ignored: unique.filter((c) => !known.has(c)) };
}

/**
 * A worker's hypothesis for the run's pool (goal 117): its text, the question it is about (an
 * index of the contract's questions, or none: the whole run) and the verified claims behind it
 * (others are ignored, and said). Refused in words: an empty text, a question the run does not
 * have, and words that repeat a live hypothesis of the run once folded (the author's, the
 * pool's or a promoted one), naming it, so the worker revises it instead. Only the author's and
 * promoted hypotheses need a verdict from the review panel; the report lists the pool's.
 */
export function proposeHypothesis(
  ctx: ResearchContext,
  run: string,
  lane: string | null,
  input: unknown,
) {
  const p = HypothesisInput.safeParse(input);
  if (!p.success)
    throw new LedgerError(
      "invalid",
      `a hypothesis is {"text", "question"?: the index of a campaign question, from 0, "supporting"?: verified claim ids}: ${p.error.issues[0]?.path.join(".") || "it"} ${p.error.issues[0]?.message ?? "is not valid"}`,
    );
  const text = p.data.text.trim().slice(0, HYPOTHESIS_MAX);
  if (!text) throw new LedgerError("invalid", "a hypothesis needs its text");
  const question = questionOf(ctx, run, p.data.question);
  const twin = twinOf(ctx, run, text);
  if (twin) throw new LedgerError("invalid", repeatsWords(twin));
  const { ok, ignored } = verifiedAmong(ctx, run, p.data.supporting);
  const id = `h-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  ctx.ledger.tx(() => {
    ctx.ledger.hypotheses.add({
      id,
      run,
      lane,
      question,
      text,
      supporting: ok,
      status: "pool",
    });
    // So the campaign's collection in the knowledge base holds the run's hypotheses too.
    ctx.ledger.appendEvent(lane ?? "research", "hypothesis_added", run, {
      hypothesis: id,
      lane: lane ?? null,
      text,
      supporting: ok,
      question,
      status: "pool",
    });
  });
  ctx.changed(run);
  return {
    hypothesis: id,
    status: "pool",
    question,
    supporting: ok,
    ignored,
    note: "in the run's pool: only the author's hypotheses and promoted ones need a verdict from the review panel; change this one with revise_hypothesis",
  };
}

/**
 * A worker changes a pool hypothesis (goal 117): its text, its question (null: the whole run)
 * or its supporting claims (verified claims of the run; the list replaces the old one). The
 * author's hypotheses change only with the brief, and a merged or retired one not at all: each
 * is refused in words. A revision whose words repeat another live hypothesis merges this one
 * into it: status `merged`, `merged_into` the other, and the work goes on there.
 */
export function reviseHypothesis(
  ctx: ResearchContext,
  run: string,
  lane: string | null,
  input: unknown,
) {
  const p = HypothesisRevision.safeParse(input);
  if (!p.success)
    throw new LedgerError(
      "invalid",
      `a revision is {"id", "text"?, "question"?: the index of a campaign question from 0, or null, "supporting"?: verified claim ids}: ${p.error.issues[0]?.path.join(".") || "it"} ${p.error.issues[0]?.message ?? "is not valid"}`,
    );
  const r = p.data;
  const h = ctx.ledger.hypotheses.get(run, r.id.trim());
  if (!h) throw new LedgerError("not_found", `no hypothesis ${r.id} in this run`);
  const id = h.id;
  const status = h.status;
  if (status === "author")
    throw new LedgerError(
      "invalid",
      `hypothesis ${id} is one of the author's: only the campaign's brief changes it. Record claims for or against it, or propose a hypothesis of your own`,
    );
  if (status === "merged")
    throw new LedgerError(
      "invalid",
      `hypothesis ${id} was merged into ${String(h.merged_into)}: revise ${String(h.merged_into)} instead`,
    );
  if (status === "retired") throw new LedgerError("invalid", `hypothesis ${id} is retired`);
  if (r.text === undefined && r.question === undefined && r.supporting === undefined)
    throw new LedgerError(
      "invalid",
      "a revision needs what changes: text, question or supporting (or more than one)",
    );
  const text = r.text === undefined ? h.text : r.text.trim().slice(0, HYPOTHESIS_MAX);
  if (!text) throw new LedgerError("invalid", "a hypothesis needs its text");
  const question = r.question === undefined ? h.question : questionOf(ctx, run, r.question);
  let supporting = JSON.parse(h.supporting) as string[];
  let ignored: string[] = [];
  if (r.supporting !== undefined) {
    const v = verifiedAmong(ctx, run, r.supporting);
    if (r.supporting.length && !v.ok.length)
      throw new LedgerError(
        "invalid",
        `none of ${v.ignored.join(", ")} is a verified claim of this run: the supporting claims stay as they were`,
      );
    supporting = v.ok;
    ignored = v.ignored;
  }
  const twin = r.text === undefined ? undefined : twinOf(ctx, run, text, id);
  const by = lane ?? "research";
  if (twin) {
    const into = twin.id;
    ctx.ledger.tx(() => {
      ctx.ledger.hypotheses.merge(id, { text, question, supporting }, into);
      ctx.ledger.appendEvent(by, "hypothesis_merged", run, {
        hypothesis: id,
        into,
        lane: lane ?? null,
        text,
        question,
        supporting,
      });
    });
    ctx.changed(run);
    return {
      hypothesis: id,
      status: "merged",
      merged_into: into,
      note: `its new words repeat ${into}, so it is merged into ${into}: work on ${into} from now on`,
    };
  }
  const same =
    text === h.text && question === h.question && canonicalJson(supporting) === h.supporting;
  if (same)
    return { hypothesis: id, status, question, supporting, ignored, note: "nothing changed" };
  ctx.ledger.tx(() => {
    ctx.ledger.hypotheses.revise(id, { text, question, supporting });
    ctx.ledger.appendEvent(by, "hypothesis_revised", run, {
      hypothesis: id,
      lane: lane ?? null,
      text,
      question,
      supporting,
      status,
    });
  });
  ctx.changed(run);
  return { hypothesis: id, status, text, question, supporting, ignored };
}

/**
 * The hypotheses as a research worker's brief shows them (goal 117): what needs a verdict and
 * what does not, those that need one (the author's first, then promoted ones) each with its
 * question, and the newest of the pool; the folder lists them all.
 */
export function hypothesesBrief(ctx: ResearchContext, run: string): string {
  const rows = ctx.ledger.hypotheses.list(run);
  const where = (h: HypothesisRow) =>
    h.question === null ? "the whole run" : questionLabel(h.question);
  const line = (h: HypothesisRow, n: number) =>
    `- ${h.id} (${hypothesisStatusWords(h.status)}; ${where(h)}): ${clip(h.text.replace(/\s+/g, " ").trim(), n)}`;
  const required = [
    ...rows.filter((h) => h.status === "author"),
    ...rows.filter((h) => h.status === "promoted"),
  ];
  const pool = rows.filter((h) => h.status === "pool");
  return [
    "# Hypotheses",
    HYPOTHESES_RULE,
    ...(required.length
      ? [
          "They need a verdict:",
          ...required.slice(0, BRIEF_REQUIRED).map((h) => line(h, 400)),
          ...(required.length > BRIEF_REQUIRED
            ? [`… and ${required.length - BRIEF_REQUIRED} more in INDEX.md`]
            : []),
        ]
      : ["None needs a verdict: the brief has no hypotheses, and none was promoted."]),
    ...(pool.length
      ? [
          `The pool has ${pool.length}${pool.length > BRIEF_POOL ? `; the newest ${BRIEF_POOL}` : ""}:`,
          ...pool.slice(-BRIEF_POOL).map((h) => line(h, 200)),
        ]
      : ["The pool is empty."]),
    "Every hypothesis, with its status and question: INDEX.md and hypotheses/ in the research folder.",
  ].join("\n");
}
