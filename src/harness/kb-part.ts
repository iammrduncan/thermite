import type { KbKind } from "../core/kb.ts";
import {
  indexEvent,
  KB_EVENT_KINDS,
  type KbIndexTarget,
  type KbStored,
  mergeItem,
  metaOf,
  sameItem,
} from "../core/kb-index.ts";
import type { Ledger } from "./ledger/index.ts";

/**
 * A rig's runs' part of their campaigns' collections (goal 065), for an export: the items this
 * ledger's events make, read the same way control reads them (core/kb-index.ts), so an export
 * holds what its runs put in Thermite's knowledge base. Each item keeps its origin: campaign,
 * rig, run, who wrote it and when.
 */

/** One item of the part, as an export's knowledge.jsonl holds it. */
export interface KbPartItem {
  campaign: string;
  rig: string;
  run: string;
  kind: KbKind;
  ref: string;
  title: string;
  body: string;
  by: string;
  url: string | null;
  sub: string | null;
  at: string;
  updated_at: string;
}

interface Held {
  run: string;
  kind: KbKind;
  ref: string;
  stored: KbStored;
  at: string;
  updated_at: string;
  /** The event that last changed it. */
  changed: number;
}

/** Event ids read per query while reading the ledger: at most this many events at once. */
const PAGE = 5000;

/**
 * The items that events after `since`, up to `through`, added or changed, each as it stands
 * after `through`, in the order they first appeared. The whole ledger is read (an item changed
 * now may have started long before), but only those items are returned.
 */
export function knowledgePart(
  ledger: Ledger,
  rig: string,
  since: number,
  through: number,
): KbPartItem[] {
  const items = new Map<string, Held>();
  const attempts = new Map<string, string>();
  const campaigns = new Map<string, string>();
  const key = (run: string, kind: string, ref: string) => JSON.stringify([run, kind, ref]);
  let current = 0;
  const target: KbIndexTarget = {
    // The run's campaign as its own ledger records it (the contract it was assigned).
    runCreated: (run, named) => {
      const campaign = ledger.runs.get(run)?.campaign || named;
      if (campaign) campaigns.set(run, campaign);
    },
    item: (run, kind, ref) => {
      const s = items.get(key(run, kind, ref))?.stored;
      return s && { body: s.body, meta: metaOf(s.meta) };
    },
    attempt: (ref) => {
      const run = attempts.get(ref);
      const s = run ? items.get(key(run, "attempt", ref))?.stored : undefined;
      return run && s ? { run, body: s.body, meta: metaOf(s.meta) } : undefined;
    },
    put: (run, kind, ref, f, at) => {
      if (!campaigns.has(run) || !ref) return;
      const k = key(run, kind, ref);
      const old = items.get(k);
      const next = mergeItem(ref, old?.stored, f);
      if (old && sameItem(old.stored, next)) return;
      items.set(k, {
        run,
        kind,
        ref,
        stored: next,
        at: old?.at ?? at,
        updated_at: at,
        changed: current,
      });
      if (kind === "attempt") attempts.set(ref, run);
    },
  };
  // A page of ids at a time, up to the last event that may change an item.
  const last = ledger.events.lastId(KB_EVENT_KINDS, { through });
  for (let after = 0; after < last; after += PAGE) {
    const page = { after, through: Math.min(after + PAGE, last) };
    for (const e of ledger.events.list(KB_EVENT_KINDS, page)) {
      current = e.id;
      if (!e.body || typeof e.body !== "object") continue;
      indexEvent(target, {
        at: e.at,
        actor: e.actor,
        kind: e.kind,
        subject: e.subject ?? "",
        body: e.body as Record<string, unknown>,
      });
    }
  }
  return [...items.values()]
    .filter((x) => x.changed > since)
    .map((x) => ({
      campaign: campaigns.get(x.run) as string,
      rig,
      run: x.run,
      kind: x.kind,
      ref: x.ref,
      title: x.stored.title,
      body: x.stored.body,
      by: x.stored.by,
      url: x.stored.url,
      sub: x.stored.sub,
      at: x.at,
      updated_at: x.updated_at,
    }));
}
