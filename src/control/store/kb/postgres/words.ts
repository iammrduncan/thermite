import { jsonPart, jsonText, type Sql } from "../../../../common/postgres.ts";
import { passageRows } from "../../../../common/search/index.ts";
import {
  KB_RECORDS,
  type KbOutcome,
  KbOutcome as KbOutcomeSchema,
  kbOutcomeOf,
  metaOf,
  resultAttempt,
} from "../../../../core/kb/index.ts";
import { contextOf, type WordsPlace } from "../words.ts";

/**
 * What the words index of control's knowledge base reads, on PostgreSQL (../../kb/words.ts): each
 * item's passages, its outcome and the context Thermite writes for it. The index over them is
 * goal 269's: until it is built, a search matches the words as they are (search.ts).
 */

/** Takes an item's passages out as they are: call it before its row changes. */
export async function unindexItem(q: Sql, id: number): Promise<void> {
  await q.run("delete from kb_passage where item = ?", id);
}

/** Puts an item's passages in, as its row is now (its text: `body`). */
export async function indexItem(q: Sql, id: number, body: string): Promise<void> {
  for (const r of passageRows(body))
    await q.run('insert into kb_passage (item, n, "start", len) values (?, ?, ?, ?)', id, ...r);
}

/** An attempt's outcome in its rig ledger's records; undefined when the knowledge base has none. */
async function attemptOutcome(
  q: Sql,
  p: Pick<WordsPlace, "rig" | "ledger">,
  ref: string,
): Promise<KbOutcome | null | undefined> {
  const r = (await q.get(
    "select outcome from kb_item where rig = ? and ledger = ? and slot = ? and kind = 'attempt' and ref = ?",
    p.rig,
    p.ledger,
    KB_RECORDS,
    ref,
  )) as { outcome: string | null } | undefined;
  if (!r) return undefined;
  return KbOutcomeSchema.safeParse(r.outcome).data ?? null;
}

/** A records item's outcome from its fields (core/kb/items.ts); none for an agent's item. */
export async function outcomeFor(q: Sql, p: WordsPlace, meta: string): Promise<KbOutcome | null> {
  if (p.slot !== KB_RECORDS) return null;
  const fields = metaOf(meta);
  // The rule asks for an attempt's outcome at once, and the store answers later: it is asked
  // which attempt it needs, that one is read, and the rule is asked again with it.
  let needs: string | undefined;
  const without = kbOutcomeOf(p.kind, fields, (ref) => {
    needs = ref;
    return undefined;
  });
  if (needs === undefined) return without;
  const outcome = await attemptOutcome(q, p, needs);
  return kbOutcomeOf(p.kind, fields, () => outcome);
}

/**
 * A campaign's title and target, from the newest version control keeps of its contract, or from the
 * newest run control assigned of it; empty when control has neither.
 */
export async function campaignAbout(q: Sql, campaign: string): Promise<string> {
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
  const kept = (await q.get(
    "select contract from campaign_version where campaign = ? order by version desc limit 1",
    campaign,
  )) as { contract: string } | undefined;
  if (kept) return fromContract(kept.contract);
  const r = (await q.get(
    `select ${jsonPart("signed", "envelope", "payload", "contract")} as contract from command
       where campaign = ? and kind = 'assign_campaign' order by issued_at desc, rowid desc limit 1`,
    campaign,
  )) as { contract: string | null } | undefined;
  return fromContract(r?.contract);
}

/**
 * The experiments of a rig ledger's records whose result names this attempt take its outcome: their
 * context changes, and their passages are written again. Their words and versions stay.
 */
export async function followAttempt(
  q: Sql,
  p: Pick<WordsPlace, "campaign" | "rig" | "ledger">,
  ref: string,
  outcome: KbOutcome | null,
): Promise<void> {
  const rows = (await q.all(
    `select id, campaign, run, slot, kind, sub, meta, body, outcome from kb_item
       where campaign = ? and kind = 'experiment' and rig = ? and ledger = ? and slot = ?
         and ${jsonText("meta", "result")} ilike ? escape ''`,
    p.campaign,
    p.rig,
    p.ledger,
    KB_RECORDS,
    `Result: attempt ${ref}%`,
  )) as unknown as {
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
      about: await campaignAbout(q, x.campaign),
    });
    await unindexItem(q, x.id);
    await q.run("update kb_item set outcome = ?, context = ? where id = ?", now, context, x.id);
    await indexItem(q, x.id, x.body);
  }
}
