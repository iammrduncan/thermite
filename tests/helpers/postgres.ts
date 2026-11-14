import { PGlite } from "@electric-sql/pglite";
import {
  connectPostgres,
  type PgConnection,
  type PgRow,
  POSTGRES_NUMBER_TYPES,
} from "../../src/common/postgres.ts";
import { type ControlStore, openPostgresStore } from "../../src/control/store/index.ts";

/**
 * Control's store on PostgreSQL, for the tests (goal 268): what `--store postgres` opens every
 * store with (store-postgres.ts), and what a test of the store on PostgreSQL opens by itself.
 *
 * The PostgreSQL is PGlite, PostgreSQL itself inside the test's process, so the tests need no
 * server; with THERMITE_TEST_POSTGRES_URL set it is the server at that address, as CI and the
 * acceptance checks run them. Either way one database holds every store the file opens, each in a
 * schema of its own: a store in memory gets a new one, and a store at a path gets the schema of
 * that path, so a test that opens the same file again finds what it kept.
 */

const url = process.env.THERMITE_TEST_POSTGRES_URL;

/** The schemas of the stores at a path, by path. */
const schemas = new Map<string, string>();
let made = 0;
/** A name no other test process uses on a shared server. */
const prefix = `t${process.pid}_${Date.now().toString(36)}`;

function schemaOf(path: string): string {
  const held = path === ":memory:" ? undefined : schemas.get(path);
  if (held) return held;
  made += 1;
  const name = `${prefix}_${made}`;
  if (path !== ":memory:") schemas.set(path, name);
  return name;
}

// ------------------------------------------------------------------ PGlite, one for the process

let lite: Promise<PGlite> | undefined;
/** The schema the one session is in now. */
let inSchema = "";
/** The end of the line of statements and transactions on the one session. */
let line: Promise<unknown> = Promise.resolve();

/** A value as node-postgres sends it: a number as its digits, so PostgreSQL reads it by the column's type. */
const sent = (v: unknown): unknown =>
  typeof v === "number" || typeof v === "bigint" ? String(v) : v === undefined ? null : v;

/**
 * A connection to the process's one PGlite, in a schema of its own. PGlite has one session, so
 * the stores take turns on it: a statement runs whole, and a transaction holds the session until
 * it ends, as a transaction on a server holds its own.
 */
function liteConnection(schema: string): PgConnection {
  lite ??= PGlite.create({
    parsers: Object.fromEntries(POSTGRES_NUMBER_TYPES.map((oid) => [oid, Number])),
  });
  const db = lite;
  let ready: Promise<void> | undefined;
  /** Whether this connection holds the session: its statements then run at once, in its turn. */
  let holds = false;
  let release: () => void = () => {};
  const here = async (pg: PGlite) => {
    ready ??= pg.exec(`create schema if not exists "${schema}"`).then(() => {});
    await ready;
    if (inSchema !== schema) {
      await pg.exec(`set search_path to "${schema}"`);
      inSchema = schema;
    }
  };
  const turn = <R>(fn: (pg: PGlite) => Promise<R>): Promise<R> => {
    const run = async () => {
      const pg = await db;
      await here(pg);
      return fn(pg);
    };
    if (holds) return run();
    const mine = line.then(run, run);
    line = mine.catch(() => {});
    return mine;
  };
  return {
    query: (text, values) =>
      turn(async (pg) => {
        const r = await pg.query(text, (values ?? []).map(sent));
        return { rows: r.rows as PgRow[], changed: r.affectedRows ?? 0 };
      }),
    exec: (text) =>
      turn(async (pg) => {
        await pg.exec(text);
      }),
    hold: () =>
      new Promise<void>((held) => {
        const run = () =>
          new Promise<void>((done) => {
            holds = true;
            release = () => {
              holds = false;
              done();
            };
            held();
          });
        line = line.then(run, run);
      }),
    release: () => release(),
    // The process's one database stays: other stores are in it.
    close: async () => {},
  };
}

// ------------------------------------------------------------------ a server, for CI

/** A connection to the server at `url`, in a schema of its own. */
function serverConnection(to: string, schema: string): PgConnection {
  const conn = connectPostgres(to, { schema });
  let ready: Promise<void> | undefined;
  const made = () => {
    ready ??= connectPostgres(to)
      .exec(`create schema if not exists "${schema}"`)
      .then(() => {});
    return ready;
  };
  return {
    query: async (text, values) => {
      await made();
      return conn.query(text, values);
    },
    exec: async (text) => {
      await made();
      return conn.exec(text);
    },
    hold: async () => {
      await made();
      return conn.hold();
    },
    release: () => conn.release(),
    close: () => conn.close(),
  };
}

/** A connection to the tests' PostgreSQL, in the schema of the store at `path`. */
export function postgresConnection(path = ":memory:"): PgConnection {
  const schema = schemaOf(path);
  return url ? serverConnection(url, schema) : liteConnection(schema);
}

/** Control's store at `path` (in memory unless given) on the tests' PostgreSQL. */
export function postgresStore(path = ":memory:"): ControlStore {
  return openPostgresStore(postgresConnection(path), path);
}
