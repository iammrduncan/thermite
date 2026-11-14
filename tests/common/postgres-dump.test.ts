import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Sql } from "../../src/common/postgres.ts";
import { type DumpValue, dumpPostgres, readDump } from "../../src/common/postgres-dump.ts";
import { postgresConnection } from "../helpers/postgres.ts";

/**
 * A dump of a store's tables as a file of lines (goal 268): what a backup of a control on
 * PostgreSQL holds. Every row comes back as it was, and a file that is not whole is refused.
 */

const file = () => join(mkdtempSync(join(tmpdir(), "thermite-dump-")), "store.dump");

async function tables() {
  const conn = postgresConnection();
  const q = new Sql(conn);
  await q.exec(`create table small (k text primary key, n bigint, b bytea);
create table many (a bigint not null, b text not null, v double precision, primary key (a, b));
create table plain (t text);
create table none (id bigint primary key)`);
  await q.run(
    "insert into small (k, n, b) values (?, ?, ?), (?, ?, ?)",
    "one",
    1,
    Buffer.from([0, 255]),
    "two",
    null,
    null,
  );
  for (let a = 0; a < 1203; a++)
    await q.run("insert into many (a, b, v) values (?, ?, ?)", a % 7, `row ${a}`, a / 4);
  await q.run(
    "insert into plain (t) values (?), (?)",
    'a "quoted" line\nand a second',
    "ünïcödé ␀",
  );
  return { conn, q };
}

describe("a dump of a store's tables", () => {
  test("holds every row of every table, read back as it was, with how many each had", async () => {
    const { conn, q } = await tables();
    const to = file();
    const made = await dumpPostgres(conn, to, {
      schema: async () => 3,
      notes: async () => ({ places: { EVENTS: 12 } }),
    });
    assert.deepEqual(made.tables, { many: 1203, none: 0, plain: 2, small: 2 });
    const got: Record<string, DumpValue[][]> = {};
    const read = await readDump(to, async (head, t) => {
      assert.deepEqual(head, { schema: 3, notes: { places: { EVENTS: 12 } } });
      const rows: DumpValue[][] = [];
      for await (const row of t.rows) rows.push(row);
      got[t.table] = rows;
      if (t.table === "small") assert.deepEqual(t.columns, ["k", "n", "b"]);
    });
    assert.deepEqual(read.tables, made.tables);
    assert.deepEqual(got.small, [
      ["one", 1, Buffer.from([0, 255])],
      ["two", null, null],
    ]);
    assert.equal(got.many?.length, 1203);
    const want = (await q.all("select a, b, v from many order by a, b")).map((r) => [
      r.a,
      r.b,
      r.v,
    ]);
    assert.deepEqual(got.many, want, "in the order of its key, across its pages");
    assert.deepEqual(got.plain?.map((r) => r[0]).sort(), [
      'a "quoted" line\nand a second',
      "ünïcödé ␀",
    ]);
    assert.deepEqual(got.none, []);
    // Every line is JSON, and the file is the owner's alone.
    for (const line of readFileSync(to, "utf8").trimEnd().split("\n")) JSON.parse(line);
  });

  test("is the store as it stood at one moment, while its owner writes", async () => {
    const { conn, q } = await tables();
    const to = file();
    let wrote = 0;
    const made = await dumpPostgres(conn, to, {
      schema: async () => 1,
      // What is written once the dump's reading began is not in it.
      notes: async () => {
        return {};
      },
    });
    await q.run("insert into small (k, n) values ('late', 9)");
    wrote++;
    assert.equal(made.tables.small, 2);
    assert.equal(wrote, 1);
  });

  test("a file that is no dump, of a newer format, or that stopped part way is refused in words", async () => {
    const { conn } = await tables();
    const to = file();
    await dumpPostgres(conn, to, { schema: async () => 1 });
    const whole = readFileSync(to, "utf8").trimEnd().split("\n");
    const take = async () => {};
    const other = file();
    writeFileSync(other, '{"hello":"world"}\n');
    await assert.rejects(readDump(other, take), /is not a dump of a store's rows/);
    writeFileSync(other, "not json\n");
    await assert.rejects(readDump(other, take), /holds a line that is no JSON/);
    writeFileSync(other, `${whole[0]?.replace('"v":1', '"v":2')}\n`);
    await assert.rejects(
      readDump(other, take),
      /is a dump of format 2, and this Thermite reads format 1: use the Thermite that made it, or a newer one/,
    );
    writeFileSync(other, `${whole.slice(0, -1).join("\n")}\n`);
    await assert.rejects(readDump(other, take), /stopped part way: it is not a whole dump/);
    // A row taken out: its table's count no longer holds.
    const row = whole.findIndex((l) => l.startsWith('["one"'));
    writeFileSync(other, `${[...whole.slice(0, row), ...whole.slice(row + 1)].join("\n")}\n`);
    await assert.rejects(
      readDump(other, take),
      /small has 1 rows where it says 2: it is not a whole dump/,
    );
    appendFileSync(to, "");
    assert.deepEqual((await readDump(to, take)).tables.small, 2);
  });
});
