import type { Sql } from "../../../../common/postgres.ts";
import { kbAddress } from "../../../../core/kb/index.ts";
import { itemOf } from "../items.ts";
import {
  KB_STORED_FILES,
  type KbStoredFigures,
  type KbTextState,
  type Row,
  TEXT_STATE_SQL,
  TYPE_SQL,
} from "../stored.ts";

export async function storedFigures(q: Sql): Promise<KbStoredFigures> {
  const rows = async (sql: string) => (await q.all(sql)) as Row[];
  const by = async (sql: string) =>
    new Map((await rows(sql)).map((r) => [String(r.c), Number(r.n ?? 0)]));
  const types = await rows(
    `select i.campaign as c, ${TYPE_SQL} as t, count(*) as n from kb_item i group by 1, 2`,
  );
  const versions = "kb_version v join kb_item i on i.id = v.item";
  const older = await by(
    `select i.campaign as c, count(*) as n from ${versions} where v.version < i.version group by 1`,
  );
  const text = await by(
    `select i.campaign as c, coalesce(sum(octet_length(v.body)), 0) as n from ${versions} group by 1`,
  );
  const fileBytes = await by(
    `select c, sum(bytes) as n from (select distinct i.campaign as c, f.sha256, f.bytes
       from ${versions} join kb_file f on f.sha256 = v.file_sha256) x group by c`,
  );
  const typeOf = (c: string, t: string) =>
    types.filter((r) => String(r.c) === c && r.t === t).reduce((n, r) => n + Number(r.n), 0);
  const collections = (await rows("select campaign as c from kb_collection order by campaign")).map(
    (r) => {
      const c = String(r.c);
      const file_bytes = fileBytes.get(c) ?? 0;
      return {
        campaign: c,
        records: typeOf(c, "record"),
        blurbs: typeOf(c, "blurb"),
        files: typeOf(c, "file"),
        file_bytes,
        older_versions: older.get(c) ?? 0,
        stored_bytes: (text.get(c) ?? 0) + file_bytes,
      };
    },
  );
  const one = async (sql: string) => Number(((await q.get(sql)) as Row).n ?? 0);
  const allFiles = await one(
    `select coalesce(sum(bytes), 0) as n from kb_file
     where sha256 in (select file_sha256 from kb_version where file_sha256 is not null)`,
  );
  const total = (t: string) => types.filter((r) => r.t === t).reduce((n, r) => n + Number(r.n), 0);
  const all = {
    items: await one("select count(*) as n from kb_item"),
    records: total("record"),
    blurbs: total("blurb"),
    files: total("file"),
    file_bytes: allFiles,
    older_versions: await one(`select count(*) as n from ${versions} where v.version < i.version`),
    stored_bytes:
      (await one("select coalesce(sum(octet_length(body)), 0) as n from kb_version")) + allFiles,
  };
  const largest = (
    (await q.all(
      `select i.*, (case when f.sha256 is not null then 1 else 0 end) as held,
           ${TEXT_STATE_SQL} as text_state from kb_item i
         left join kb_file f on f.sha256 = i.file_sha256
         left join kb_file_text t on t.sha256 = i.file_sha256
         where i.file_sha256 is not null order by i.file_bytes desc nulls last, i.id limit ?`,
      KB_STORED_FILES,
    )) as Row[]
  ).map((r) => ({
    address: kbAddress(itemOf(r)),
    name: String(r.file_name ?? ""),
    type: String(r.file_type ?? ""),
    bytes: Number(r.file_bytes ?? 0),
    searched: r.text_state === "searched",
    text_state: r.text_state as KbTextState,
    held: Number(r.held) === 1,
  }));
  const file_types = (
    await rows(
      `select i.file_type as ft, count(*) as n, coalesce(sum(i.file_bytes), 0) as b,
       sum(case when ${TEXT_STATE_SQL} = 'searched' then 1 else 0 end) as s,
       sum(case when ${TEXT_STATE_SQL} = 'waiting' then 1 else 0 end) as w
     from kb_item i left join kb_file_text t on t.sha256 = i.file_sha256
     where i.file_sha256 is not null group by i.file_type order by b desc, ft nulls first`,
    )
  ).map((r) => ({
    type: String(r.ft ?? ""),
    files: Number(r.n),
    bytes: Number(r.b),
    searched: Number(r.s ?? 0),
    waiting: Number(r.w ?? 0),
  }));
  const last = (await q.get(`select i.*, v.version as v_version, v.at as v_at from ${versions}
       where v.event is not null order by v.at desc, v.item desc, v.version desc limit 1`)) as
    | Row
    | undefined;
  const file = (await q.get(
    "select sha256, bytes, stored_at from kb_file order by stored_at desc, sha256 limit 1",
  )) as Row | undefined;
  return {
    collections,
    all,
    words: { items: await one("select count(distinct item) as n from kb_passage") },
    largest,
    file_types,
    last_item: last
      ? { address: kbAddress(itemOf(last)), version: Number(last.v_version), at: String(last.v_at) }
      : null,
    last_file: file
      ? { sha256: String(file.sha256), bytes: Number(file.bytes), at: String(file.stored_at) }
      : null,
  };
}
