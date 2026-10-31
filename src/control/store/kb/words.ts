import type { DatabaseSync } from "node:sqlite";
import {
  indexItem as indexWords,
  passageRows,
  unindexItem as unindexWords,
  type WordsTables,
  wordsSchema,
} from "../../../common/search/index.ts";
import {
  KB_RECORDS,
  type KbOutcome,
  KbOutcome as KbOutcomeSchema,
  kbOutcomeOf,
  resultAttempt,
} from "../../../core/kb.ts";
import { metaOf } from "../../../core/kb-index.ts";

/**
 * The words index of control's knowledge base (goal 175): the search engine's FTS5 over passages
 * of the items' newest versions (common/search/), on the knowledge base's own tables. Each passage
 * is indexed with its item's title and a context Thermite writes from its own records (the item's
 * kind and outcome, its slot, run and campaign, and the campaign's title and target), never from
 * an agent's words. items.ts calls unindexItem before an item's row changes and indexItem after.
 */

/** The knowledge base's words index: its items, passages, their text, the index and its words. */
export const KB_WORDS: WordsTables = {
  items: "kb_item",
  passages: "kb_passage",
  view: "kb_passage_text",
  words: "kb_words",
  terms: "kb_words_terms",
};

/** The words index as it is built (store migration 17): the passages, the view, the index and its words. */
export const WORDS_INDEX = wordsSchema(KB_WORDS);

/** Takes an item's passages out of the words index as they are: call it before its row changes. */
export function unindexItem(db: DatabaseSync, id: number): void {
  unindexWords(db, KB_WORDS, id);
}

/** Puts an item's passages into the words index, as its row is now (its text: `body`). */
export function indexItem(db: DatabaseSync, id: number, body: string): void {
  indexWords(db, KB_WORDS, id, body);
}

/** Where an item is, as its outcome and context read it. */
export interface WordsPlace {
  campaign: string;
  rig: string;
  ledger: string;
  run: string;
  slot: string;
  kind: string;
}

/** An attempt's outcome in its rig ledger's records; undefined when the knowledge base has none. */
function attemptOutcome(
  db: DatabaseSync,
  p: Pick<WordsPlace, "rig" | "ledger">,
  ref: string,
): KbOutcome | null | undefined {
  const r = db
    .prepare(
      "select outcome from kb_item where rig = ? and ledger = ? and slot = ? and kind = 'attempt' and ref = ?",
    )
    .get(p.rig, p.ledger, KB_RECORDS, ref) as { outcome: string | null } | undefined;
  if (!r) return undefined;
  return KbOutcomeSchema.safeParse(r.outcome).data ?? null;
}

/** A records item's outcome from its fields (core/kb.ts); none for an agent's item. */
export function outcomeFor(db: DatabaseSync, p: WordsPlace, meta: string): KbOutcome | null {
  if (p.slot !== KB_RECORDS) return null;
  return kbOutcomeOf(p.kind, metaOf(meta), (ref) => attemptOutcome(db, p, ref));
}

/**
 * A campaign's title and target, from the newest version control keeps of its contract, or from the
 * newest run control assigned of it; empty when control has neither.
 */
export function campaignAbout(db: DatabaseSync, campaign: string): string {
  const has = (sql: string) => db.prepare(sql).get() !== undefined;
  const fromContract = (json: string | null | undefined) => {
    try {
      const c = JSON.parse(json ?? "null") as {
        title?: unknown;
        target?: { type?: unknown; class?: unknown };
      } | null;
      return [c?.title, c?.target?.type, c?.target?.class]
        .filter((x): x is string => typeof x === "string")
        .join(" ");
    } catch {
      // A contract control could not read gives no words.
      return "";
    }
  };
  if (has("select 1 from sqlite_master where type = 'table' and name = 'campaign_version'")) {
    const r = db
      .prepare(
        "select contract from campaign_version where campaign = ? order by version desc limit 1",
      )
      .get(campaign) as { contract: string } | undefined;
    if (r) return fromContract(r.contract);
  }
  const cols = db.prepare("pragma table_info(command)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "campaign")) return "";
  const r = db
    .prepare(
      `select json_extract(signed, '$.envelope.payload.contract') as contract from command
       where campaign = ? and kind = 'assign_campaign' order by issued_at desc limit 1`,
    )
    .get(campaign) as { contract: string | null } | undefined;
  return fromContract(r?.contract);
}

/**
 * An item's context, as the words index holds it beside its title and text: its kind (and a note's
 * sub-kind), its outcome, its slot, run and campaign, and the campaign's title and target.
 */
export function contextOf(
  p: Pick<WordsPlace, "campaign" | "run" | "slot" | "kind">,
  o: { outcome: KbOutcome | null; sub: string | null; about: string },
): string {
  const sub = o.sub && o.sub !== p.kind ? o.sub : "";
  return [p.kind, sub, o.outcome ?? "", p.slot, p.run, p.campaign, o.about]
    .filter(Boolean)
    .join(" ");
}

/**
 * The experiments of a rig ledger's records whose result names this attempt take its outcome: their
 * context changes, and the index follows. Their words and versions stay.
 */
export function followAttempt(
  db: DatabaseSync,
  p: Pick<WordsPlace, "campaign" | "rig" | "ledger">,
  ref: string,
  outcome: KbOutcome | null,
): void {
  const rows = db
    .prepare(
      `select id, campaign, run, slot, kind, sub, meta, body, outcome from kb_item
       where campaign = ? and kind = 'experiment' and rig = ? and ledger = ? and slot = ?
         and json_extract(meta, '$.result') like ?`,
    )
    .all(p.campaign, p.rig, p.ledger, KB_RECORDS, `Result: attempt ${ref}%`) as {
    id: number;
    campaign: string;
    run: string;
    slot: string;
    kind: string;
    sub: string | null;
    meta: string;
    body: string;
    outcome: string | null;
  }[];
  const now = outcome ?? "open";
  for (const x of rows) {
    if (x.outcome === now || resultAttempt(metaOf(x.meta).result) !== ref) continue;
    const context = contextOf(x, {
      outcome: now,
      sub: x.sub,
      about: campaignAbout(db, x.campaign),
    });
    unindexItem(db, x.id);
    db.prepare("update kb_item set outcome = ?, context = ? where id = ?").run(now, context, x.id);
    indexItem(db, x.id, x.body);
  }
}

/**
 * Store migration 17 (goal 175): the outcome and the context of every item, its passages, and the
 * words index anew over them, in place of migration 14's index of whole items. It runs once: a store
 * with passages has it. The knowledge base also runs it as it opens, as it runs migration 14.
 */
export function knowledgeSearch(db: DatabaseSync): void {
  const has = (name: string) =>
    db.prepare("select 1 from sqlite_master where name = ?").get(name) !== undefined;
  if (has("kb_passage")) return;
  db.exec(`
drop trigger if exists kb_item_words_added;
drop trigger if exists kb_item_words_changed;
drop trigger if exists kb_item_words_removed;
drop table if exists kb_words;
alter table kb_item add column outcome text;
alter table kb_item add column context text not null default '';
create index kb_item_outcome on kb_item (campaign, outcome) where outcome is not null;
${WORDS_INDEX}`);
  type Row = WordsPlace & { id: number; sub: string | null; meta: string; body: string };
  const page = (kind: string | null, after: number) =>
    db
      .prepare(
        `select id, campaign, rig, ledger, run, slot, kind, sub, meta, body from kb_item
         where id > ? ${kind ? "and kind = ?" : ""} order by id limit 1000`,
      )
      .all(after, ...(kind ? [kind] : [])) as unknown as Row[];
  const each = (kind: string | null, fn: (x: Row) => void) => {
    for (let after = 0, rows = page(kind, 0); rows.length; rows = page(kind, after)) {
      for (const x of rows) fn(x);
      after = rows.at(-1)?.id ?? after;
    }
  };
  const setOutcome = db.prepare("update kb_item set outcome = ? where id = ?");
  // The attempts first: an experiment's outcome is its attempt's.
  each("attempt", (x) => setOutcome.run(outcomeFor(db, x, x.meta), x.id));
  const about = new Map<string, string>();
  const set = db.prepare("update kb_item set outcome = ?, context = ? where id = ?");
  const add = db.prepare("insert into kb_passage (item, n, start, len) values (?, ?, ?, ?)");
  each(null, (x) => {
    const outcome = outcomeFor(db, x, x.meta);
    if (!about.has(x.campaign)) about.set(x.campaign, campaignAbout(db, x.campaign));
    set.run(
      outcome,
      contextOf(x, { outcome, sub: x.sub, about: about.get(x.campaign) ?? "" }),
      x.id,
    );
    for (const r of passageRows(x.body)) add.run(x.id, ...r);
  });
  db.exec("insert into kb_words (kb_words) values ('rebuild')");
}
