import type { Sql } from "../../../../common/postgres.ts";
import { KB_OUTCOMES, type KbListSort } from "../../../../core/kb/index.ts";
import { itemOf } from "../items.ts";
import {
  FILTERS,
  type KbFolderRow,
  type KbListAt,
  type KbListCounts,
  type KbListed,
  type KbListOptions,
  type KbTotals,
  type Sql as Part,
  type Row,
  TYPE_SQL,
} from "../list.ts";

/** The outcomes in their order (won first), and an item with none after them. */
const OUTCOME_RANK = `(case outcome ${KB_OUTCOMES.map((o, i) => `when '${o}' then ${i}`).join(" ")} else ${KB_OUTCOMES.length} end)`;
const SORTS: Record<KbListSort, string> = {
  name: "lower(title)",
  kind: "kind",
  outcome: OUTCOME_RANK,
  writer: "slot",
  modified: "updated_at",
  size: "coalesce(file_bytes, -1)",
};

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The SQL that keeps the items under a place, of kb_item as `alias` when given. */
function under(at: KbListAt, alias = ""): Part {
  const parts: string[] = [];
  const args: string[] = [];
  for (const [column, v] of [
    ["campaign", at.campaign],
    ["run", at.run],
    ["slot", at.slot],
  ] as const) {
    if (v === undefined) break;
    parts.push(`${alias ? `${alias}.` : ""}${column} = ?`);
    args.push(v);
  }
  return { sql: parts.length ? parts.join(" and ") : "1 = 1", args };
}

/** The filters as SQL, but the one named `but`, which its own counts leave out. */
function kept(o: KbListOptions, but?: keyof KbListCounts): Part {
  const given: Record<keyof KbListCounts, readonly string[] | undefined> = {
    kind: o.kinds,
    outcome: o.outcomes,
    type: o.types,
    slot: o.slots,
  };
  const parts: string[] = [];
  const args: string[] = [];
  for (const [name, values] of Object.entries(given) as [keyof KbListCounts, string[]][]) {
    if (name === but || !values?.length) continue;
    parts.push(` and ${FILTERS[name]} in (${marks(values.length)})`);
    args.push(...values);
  }
  return { sql: parts.join(""), args };
}

/** A page of the items under a place, with how many there are and their counts by filter. */
export async function listItems(q: Sql, at: KbListAt, o: KbListOptions): Promise<KbListed> {
  const w = under(at);
  const k = kept(o);
  const count = async (s: Part) =>
    Number(((await q.get(`select count(*) as n from kb_item where ${s.sql}`, ...s.args)) as Row).n);
  const total = await count(w);
  const matched = k.args.length
    ? await count({ sql: `${w.sql}${k.sql}`, args: [...w.args, ...k.args] })
    : total;
  const counts: KbListCounts = { kind: {}, outcome: {}, type: {}, slot: {} };
  for (const name of Object.keys(FILTERS) as (keyof KbListCounts)[]) {
    const others = kept(o, name);
    const rows = (await q.all(
      `select ${FILTERS[name]} as v, count(*) as n from kb_item
         where ${w.sql}${others.sql} and ${FILTERS[name]} is not null group by v order by n desc, v`,
      ...w.args,
      ...others.args,
    )) as Row[];
    for (const r of rows) counts[name][String(r.v)] = Number(r.n);
  }
  const sort = o.sort ?? "modified";
  const order = o.order ?? (sort === "modified" || sort === "size" ? "desc" : "asc");
  const items =
    o.limit > 0
      ? (
          (await q.all(
            `select * from kb_item where ${w.sql}${k.sql}
               order by ${SORTS[sort]} ${order}, updated_at desc, id desc limit ? offset ?`,
            ...w.args,
            ...k.args,
            o.limit,
            o.offset ?? 0,
          )) as Row[]
        ).map(itemOf)
      : [];
  return { total, matched, counts, items };
}

/** A place's totals (KbTotals), of every item under it. */
export async function placeTotals(q: Sql, at: KbListAt): Promise<KbTotals> {
  const w = under(at);
  const grouped = async (column: string) =>
    Object.fromEntries(
      (
        (await q.all(
          `select ${column} as v, count(*) as n from kb_item where ${w.sql} group by v order by n desc, v`,
          ...w.args,
        )) as Row[]
      ).map((r) => [String(r.v), Number(r.n)]),
    );
  const versions = `kb_version v join kb_item i on i.id = v.item where ${under(at, "i").sql}`;
  const one = async (sql: string) => Number(((await q.get(sql, ...w.args)) as Row).n);
  return {
    types: await grouped(TYPE_SQL),
    kinds: await grouped("kind"),
    slots: await grouped("slot"),
    older_versions: await one(`select count(*) as n from ${versions} and v.version < i.version`),
    stored_bytes:
      (await one(`select coalesce(sum(octet_length(v.body)), 0) as n from ${versions}`)) +
      (await one(
        `select coalesce(sum(f.bytes), 0) as n from kb_file f where f.sha256 in (
           select v.file_sha256 from ${versions} and v.file_sha256 is not null)`,
      )),
  };
}

/** The collections, runs or slots a place holds, in no order; none in a slot. */
export async function placeFolders(q: Sql, at: KbListAt): Promise<KbFolderRow[]> {
  const rows = async (sql: string, ...args: string[]) =>
    ((await q.all(sql, ...args)) as Row[]).map((r) => ({
      name: String(r.name),
      items: Number(r.n),
      updated_at: r.at ? String(r.at) : null,
      fresh: Number(r.fresh ?? 0) === 1,
    }));
  if (at.campaign === undefined)
    return await rows(
      `select c.campaign as name, count(i.id) as n, max(i.updated_at) as at from (
         select campaign from kb_collection union select campaign from kb_item
         union select campaign from kb_run) c
       left join kb_item i on i.campaign = c.campaign group by c.campaign`,
    );
  if (at.run === undefined)
    return await rows(
      `select r.run as name, count(i.id) as n, max(i.updated_at) as at, max(s.fresh) as fresh from (
         select run from kb_run where campaign = ? union select run from kb_item where campaign = ?) r
       left join kb_item i on i.campaign = ? and i.run = r.run
       left join kb_scope s on s.campaign = ? and s.run = r.run
       group by r.run`,
      at.campaign,
      at.campaign,
      at.campaign,
      at.campaign,
    );
  if (at.slot === undefined)
    return await rows(
      `select slot as name, count(*) as n, max(updated_at) as at from kb_item
       where campaign = ? and run = ? group by slot`,
      at.campaign,
      at.run,
    );
  return [];
}
