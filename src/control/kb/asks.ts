import type { Bus, BusRequest } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { KbLinkRel, kbAddress } from "../../core/kb.ts";
import {
  KB_IS_DATA,
  KB_READ_PAGE,
  KB_READ_SUBJECTS,
  KB_SEARCH_DEFAULT,
  KB_SEARCH_SUBJECTS,
  type KbAskAnswer,
  type KbAskKind,
  type KbHit,
  KbReadAsk,
  KbSearchAsk,
  kbAskOf,
} from "../../core/link/kb.ts";
import { answerStaysWithRig } from "../bus/index.ts";
import type { ControlStore, KbFind, KbFindAnswer } from "../store/index.ts";
import type { KbFound, KbItem } from "./index.ts";

/**
 * Control's answers to a rig's searches and reads of the knowledge base, for an agent of one of
 * its runs (goal 175): on the message bus, a request on the rig's own subject (core/link/kb.ts).
 * Control answers only for a run it assigned to
 * that rig, and reads only what the run may read: its own run alone when it started fresh, else its
 * campaign's whole collection, and the granted collections it includes (store/kb/scope.ts). What
 * the ask names beyond its run, its words and its kinds is never a scope.
 */

/**
 * An item as a hit: where it is, who wrote it and when, its outcome, and, for a search, its excerpt,
 * why and passage.
 */
export function hitOf(x: KbItem, found?: Pick<KbFound, "excerpt" | "why" | "passage">): KbHit {
  return {
    address: kbAddress(x),
    collection: x.campaign,
    run: x.run,
    slot: x.slot,
    kind: x.kind,
    title: x.title,
    outcome: x.outcome,
    excerpt: found?.excerpt ?? "",
    why: found?.why ?? "",
    passage: found?.passage ?? null,
    by: x.by,
    at: x.updated_at,
    version: x.version,
    file: x.file,
  };
}

/** A search's fields as the knowledge base takes them (store/kb/index.ts): the same for everyone. */
export function kbFindOf(s: Omit<KbSearchAsk, "run" | "q">): KbFind {
  return {
    mode: s.mode,
    like: s.like,
    seen: s.seen,
    kinds: s.kinds,
    outcomes: s.outcomes,
    runs: s.runs,
    slots: s.slots,
    collections: s.collections,
    offset: s.offset,
    limit: s.limit ?? KB_SEARCH_DEFAULT,
  };
}

/** What a search answers beside its hits: how many, the next page, its counts, words and their like. */
export function foundOf(r: KbFindAnswer) {
  return {
    matched: r.matched,
    next_offset: r.next_offset,
    counts: r.counts,
    words: r.words,
    did_you_mean: r.did_you_mean,
    ...(r.like ? { like: r.like } : {}),
  };
}

/** One page of a text from `offset`: KB_READ_PAGE characters, its length, and where to read on. */
export function textPage(text: string, offset = 0) {
  const end = offset + KB_READ_PAGE;
  return {
    text: text.slice(offset, end),
    offset,
    chars: text.length,
    next_offset: end < text.length ? end : null,
  };
}

/** Why an ask's body is refused, in words: each field and what is wrong with it. */
function refusal(err: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return `the ask is not one control takes: ${err.issues.map((i) => `${i.path.join(".") || "ask"}: ${i.message}`).join("; ")}`;
}

/**
 * Control's answer to one ask of a rig: a search's hits, an item read whole, or why not, in words.
 * `raw` is the ask's body as the rig sent it.
 */
export function answerKbAsk(
  store: ControlStore,
  rig: string,
  kind: KbAskKind,
  raw: unknown,
): KbAskAnswer {
  const ask = (kind === "search" ? KbSearchAsk : KbReadAsk).safeParse(raw);
  if (!ask.success) return { refused: refusal(ask.error) };
  const { run } = ask.data;
  // Only a run control assigned to this rig, of the campaign it assigned.
  const campaign = store.runRegistry.assignedCampaigns(rig).get(run);
  if (!campaign)
    return {
      refused: `control did not assign run ${run} to ${rig}: it reads no knowledge base for it`,
    };
  const kb = store.kb();
  const { scope, where } = kb.scopeWhere(campaign, run);
  const view = { collection: campaign, fresh: scope.fresh, granted: scope.granted };
  if ("q" in ask.data) {
    const s = ask.data;
    // The runs and collections it keeps only narrow what the run reads: `where` is its scope.
    const r = kb.find([s.q, ...(s.queries ?? [])], where, kbFindOf(s));
    if (r.refused) return { refused: r.refused };
    log("control", "knowledge base searched", {
      rig,
      run,
      words: s.q.length,
      queries: 1 + (s.queries?.length ?? 0),
      mode: s.mode ?? "words",
      matched: r.matched,
    });
    return { note: KB_IS_DATA, scope: view, ...foundOf(r), hits: r.hits.map((x) => hitOf(x, x)) };
  }
  const { address, version, offset } = ask.data;
  const x = kb.at(address, where);
  if (!x)
    return {
      refused: `no item ${address} in what run ${run} reads: ${scope.fresh ? `its own items of ${campaign}` : `the collection ${campaign}`}${scope.granted.length ? `, and ${scope.granted.join(", ")}` : ""}`,
    };
  const versions = kb.versions(x.id);
  const v = version === undefined ? versions.at(-1) : versions.find((o) => o.version === version);
  if (!v)
    return { refused: `${address} has versions 1 to ${versions.length}, not version ${version}` };
  log("control", "knowledge base item read", { rig, run, address, version: v.version, offset });
  const { excerpt: _e, why: _w, passage: _p, ...item } = hitOf(x);
  return {
    note: KB_IS_DATA,
    item: {
      ...item,
      title: v.title,
      version: v.version,
      at: v.at,
      ...textPage(v.body, offset),
      versions: versions.length,
      links: v.links.flatMap((l) => {
        const rel = KbLinkRel.safeParse(l.rel);
        return rel.success ? [{ rel: rel.data, to: l.to }] : [];
      }),
    },
  };
}

/**
 * How many asks of one rig control answers at once, at most: those it took and has not answered.
 * One past it is refused in words at once, never queued; the rig's supervisor hands at most 20 at
 * a time, so a rig at work stays well under it.
 */
export const KB_ASKS_IN_FLIGHT_MAX = 32;

/** The asks of each rig control is answering now, held to a limit (KB_ASKS_IN_FLIGHT_MAX). */
export class KbAskLimit {
  private readonly busy = new Map<string, number>();
  readonly max: number;

  constructor(max = KB_ASKS_IN_FLIGHT_MAX) {
    this.max = max;
  }

  /**
   * Answers one ask of a rig within the limit. The answer is worked out after a turn of the event
   * loop, so the asks that arrive together are in flight together and wait their turn; past the
   * limit, an ask is refused in words.
   */
  async run(rig: string, answer: () => KbAskAnswer): Promise<KbAskAnswer> {
    const n = this.busy.get(rig) ?? 0;
    if (n >= this.max) {
      log(
        "control",
        "a knowledge base ask refused: too many of its rig's in flight",
        { rig, in_flight: n },
        "warn",
      );
      return {
        refused: `control is answering ${n} searches and reads of ${rig} already, its most at once: try again in a moment`,
      };
    }
    this.busy.set(rig, n + 1);
    try {
      await new Promise((r) => setImmediate(r));
      return answer();
    } finally {
      const left = (this.busy.get(rig) ?? 1) - 1;
      if (left > 0) this.busy.set(rig, left);
      else this.busy.delete(rig);
    }
  }
}

/** Control's one limit for the bus's asks. */
export const kbAskLimit = new KbAskLimit();

/**
 * Serves every rig's searches and reads on the message bus until it closes. An ask is answered
 * only at its own rig's inbox (core/link/users.ts), where only that rig's user may read: an ask
 * whose answer would go anywhere else is answered nothing, with a line in control's log. Every
 * other answer is the ask's answer as JSON, a refusal in words included.
 */
export function serveKbAsks(
  bus: Pick<Bus, "serve">,
  store: ControlStore,
  limit: KbAskLimit = kbAskLimit,
): Promise<void> {
  const answer = async (r: BusRequest): Promise<string | undefined> => {
    const at = kbAskOf(r.subject);
    if (!at) {
      log(
        "control",
        "a knowledge base ask on a subject that is no rig's",
        { subject: r.subject },
        "warn",
      );
      return undefined;
    }
    if (!answerStaysWithRig(store, at.rig, r.reply)) {
      const what = { rig: at.rig, kind: at.kind, reply: r.reply ?? null };
      log(
        "control",
        "a knowledge base ask refused: its answer would leave its rig's inbox",
        what,
        "warn",
      );
      return undefined;
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(r.data).toString("utf8"));
    } catch (err) {
      return JSON.stringify({ refused: `the ask is not JSON: ${errorText(err)}` });
    }
    return JSON.stringify(await limit.run(at.rig, () => answerKbAsk(store, at.rig, at.kind, body)));
  };
  return Promise.all([
    bus.serve(KB_SEARCH_SUBJECTS, answer),
    bus.serve(KB_READ_SUBJECTS, answer),
  ]).then(() => undefined);
}
