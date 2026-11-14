import pg from "pg";
import { errorText } from "./errors.ts";
import { log } from "./log.ts";

/**
 * Thermite's PostgreSQL connection (goal 268): what control's store on PostgreSQL runs its
 * statements through. A real server's connection is made here; the tests give one of a
 * PostgreSQL that runs inside their process.
 */

/** A row as PostgreSQL gives it. */
export type PgRow = Record<string, unknown>;

/**
 * One connection to a PostgreSQL database. Its statements run one after another, in the order
 * they are given.
 */
export interface PgConnection {
  /** Runs one statement, with its values for `$1`, `$2` and so on. */
  query(text: string, values?: readonly unknown[]): Promise<{ rows: PgRow[]; changed: number }>;
  /** Runs several statements with no values, as a schema's are. */
  exec(text: string): Promise<void>;
  /**
   * Keeps one session for every statement until `release`: a transaction's statements must all
   * run in the session that began it.
   */
  hold(): Promise<void>;
  release(): void;
  close(): Promise<void>;
}

/** The oldest PostgreSQL that Thermite's store runs on. */
export const POSTGRES_OLDEST = 16;

/**
 * A statement written with `?` for each value, as SQLite's are, with `$1`, `$2` and so on in
 * their place, as PostgreSQL takes them. A `?` inside a quoted string or name is left as it is.
 */
export function numbered(sql: string): string {
  let out = "";
  let n = 0;
  let quote = "";
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = "";
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === "?") {
      n += 1;
      out += `$${n}`;
    } else out += ch;
  }
  return out;
}

/**
 * The types whose values come as numbers, as SQLite's do: 64-bit whole numbers, and the exact
 * numbers a sum of them is. The store's are small.
 */
export const POSTGRES_NUMBER_TYPES: readonly number[] = [
  pg.types.builtins.INT8,
  pg.types.builtins.NUMERIC,
];

const types = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    POSTGRES_NUMBER_TYPES.includes(oid)
      ? (value: string) => Number(value)
      : pg.types.getTypeParser(oid, format as "text")) as typeof pg.types.getTypeParser,
};

/**
 * A connection to the PostgreSQL server at `url` (`postgres://user@host:port/database`), with the
 * user's password `o.password` when the address holds none, in the schema `o.schema` when given.
 * `o.idleMs` closes its session once it was idle that long, for the tests, which open many. It opens when its first statement runs. It keeps one session, so its statements run in order;
 * a session that the server ended is made again for the next statement.
 */
export function connectPostgres(
  url: string,
  o: { password?: string | undefined; schema?: string | undefined; idleMs?: number } = {},
): PgConnection {
  // The password goes into the address the driver reads: it takes an address's own fields over
  // any given beside it.
  const address = new URL(url);
  if (o.password !== undefined) address.password = o.password;
  const pool = new pg.Pool({
    connectionString: address.toString(),
    max: 1,
    // The one session stays open while its owner runs, unless `o.idleMs` closes an idle one.
    idleTimeoutMillis: o.idleMs ?? 0,
    types,
    // The schema its tables are in, when not the database's own.
    ...(o.schema ? { options: `-c search_path=${o.schema}` } : {}),
  });
  // A session that fails while it is idle is dropped by the pool, which makes a new one. Without
  // a listener, Node would stop the process on the pool's "error" event.
  pool.on("error", () => {});
  let held: pg.PoolClient | undefined;
  return {
    async query(text, values) {
      const r = await (held ?? pool).query(text, values ? [...values] : undefined);
      return { rows: r.rows as PgRow[], changed: r.rowCount ?? 0 };
    },
    async exec(text) {
      await (held ?? pool).query(text);
    },
    async hold() {
      held = await pool.connect();
    },
    release() {
      held?.release();
      held = undefined;
    },
    async close() {
      held?.release();
      held = undefined;
      await pool.end();
    },
  };
}

/** The server's major version, such as 17. */
export async function postgresVersion(conn: PgConnection): Promise<number> {
  const { rows } = await conn.query("select current_setting('server_version_num') as n");
  return Math.floor(Number(rows[0]?.n) / 10_000);
}

// ------------------------------------------------------------------ settings
//
// Control reads them at its start; the command line reads them where it backs control's store up
// and copies it.

/**
 * Where control's store is (goal 268): `sqlite`, the default and the store a release supports, a
 * file in control's state folder; or `postgres`, a PostgreSQL database, for trial until the move
 * (goal 270).
 */
export const STORE_SETTING = "THERMITE_CONTROL_STORE";
/**
 * The PostgreSQL database of control's store, without its password:
 * `postgres://user@host:5432/database`.
 */
const POSTGRES_URL_SETTING = "THERMITE_CONTROL_POSTGRES_URL";
/** The file that holds the password of the store's PostgreSQL user. */
export const POSTGRES_PASSWORD_FILE_SETTING = "THERMITE_CONTROL_POSTGRES_PASSWORD_FILE";

/** Where control's store is, as its settings say: SQLite, or a PostgreSQL database's address. */
export type StoreSetting = { kind: "sqlite" } | { kind: "postgres"; url: string };

/**
 * Where control's store is, from its settings. Throws in words that name the setting, so control
 * stops at its start, on a store it does not know and on a PostgreSQL address that is refused
 * (postgresAddress).
 */
export function storeSetting(env: Record<string, string | undefined>): StoreSetting {
  const kind = env[STORE_SETTING]?.trim() || "sqlite";
  if (kind === "sqlite") return { kind };
  if (kind !== "postgres") throw new Error(`${STORE_SETTING} is sqlite or postgres, not "${kind}"`);
  return { kind, url: postgresAddress(env) };
}

/**
 * The address of the store's PostgreSQL database, from control's settings. Throws in words that
 * name the setting when it is not set, when it is no such address, and when it holds a password:
 * the password is a secret, and goes in its file.
 */
export function postgresAddress(env: Record<string, string | undefined>): string {
  const raw = env[POSTGRES_URL_SETTING]?.trim();
  const example = "postgres://thermite@postgres:5432/thermite";
  if (!raw)
    throw new Error(
      `${POSTGRES_URL_SETTING} is not set: it takes the address of the store's PostgreSQL database, such as ${example}`,
    );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${POSTGRES_URL_SETTING} takes a database's address, such as ${example}`);
  }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !url.hostname)
    throw new Error(`${POSTGRES_URL_SETTING} takes a database's address, such as ${example}`);
  if (url.password)
    throw new Error(
      `${POSTGRES_URL_SETTING} holds a password: take it out of the address, and put it in a file that ${POSTGRES_PASSWORD_FILE_SETTING} names`,
    );
  return raw;
}

// ------------------------------------------------------------------ statements
//
// How a store on PostgreSQL runs its statements: each is written with `?` for its values, as the
// SQLite store's are, and gives its answer later.

/**
 * A row as a statement gives it: text, numbers, bytes and null, the kinds of value a row of the
 * SQLite store holds, so that the two stores read a row with the same code.
 */
export type Row = Record<string, null | number | bigint | string | NodeJS.ArrayBufferView>;

/** Each statement's PostgreSQL form, kept: the same statements run again and again. */
const forms = new Map<string, string>();
const form = (sql: string): string => {
  let text = forms.get(sql);
  if (text === undefined) {
    text = numbered(sql);
    forms.set(sql, text);
  }
  return text;
};

/**
 * A field of a column that holds JSON as text, as text: `jsonText("body", "a", "b")` is what
 * SQLite's `json_extract(body, '$.a.b')` gives, but for a true or a false, which come as words.
 */
export const jsonText = (column: string, ...path: string[]): string =>
  `(${column}::json #>> '{${path.join(",")}}')`;

/** A part of a column that holds JSON as text, as JSON text: SQLite's `column -> '$.a.b'`. */
export const jsonPart = (column: string, ...path: string[]): string =>
  `(${column}::json #> '{${path.join(",")}}')::text`;

/**
 * A text with each NUL character as the symbol for it, ␀. PostgreSQL's text holds no NUL, and a
 * value with one would be refused whole; the SQLite store reads such a text back only up to it.
 */
const withoutNul = (text: string): string => text.replaceAll("\u0000", "\u2400");

/** A statement's values as they are sent: a text without NUL, and nothing as null. */
const sent = (values: readonly unknown[]): unknown[] =>
  values.map((v) =>
    typeof v === "string" && v.includes("\u0000") ? withoutNul(v) : v === undefined ? null : v,
  );

export class Sql {
  private readonly conn: PgConnection;
  /** How deep the transactions are nested now. */
  private depth = 0;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  /** Every row a statement gives. */
  async all(sql: string, ...values: unknown[]): Promise<Row[]> {
    return (await this.conn.query(form(sql), sent(values))).rows as Row[];
  }

  /** The first row a statement gives, or none. */
  async get(sql: string, ...values: unknown[]): Promise<Row | undefined> {
    return (await this.conn.query(form(sql), sent(values))).rows[0] as Row | undefined;
  }

  /** Runs a statement that writes: how many rows it changed. */
  async run(sql: string, ...values: unknown[]): Promise<{ changes: number }> {
    return { changes: (await this.conn.query(form(sql), sent(values))).changed };
  }

  /**
   * Runs an insert into a table whose key `id` counts up by itself: the new row's key, which
   * SQLite gives as the last row's id.
   */
  async insert(sql: string, ...values: unknown[]): Promise<number> {
    const row = (await this.conn.query(`${form(sql)} returning id`, sent(values))).rows[0];
    return Number(row?.id);
  }

  /** Runs several statements with no values. */
  async exec(sql: string): Promise<void> {
    await this.conn.exec(sql);
  }

  /**
   * Runs `fn` in one transaction: all of it is kept, or none of it. A call inside another is a
   * savepoint of the outer one. Whoever calls this makes sure that nothing but `fn`'s own work
   * uses the connection until it ends (the store's order of calls does: order.ts).
   */
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const depth = this.depth;
    const savepoint = depth > 0 ? `sp${depth}` : undefined;
    if (!savepoint) await this.conn.hold();
    try {
      await this.conn.exec(savepoint ? `savepoint ${savepoint}` : "begin");
    } catch (err) {
      if (!savepoint) this.conn.release();
      throw err;
    }
    this.depth = depth + 1;
    try {
      const out = await fn();
      await this.conn.exec(savepoint ? `release savepoint ${savepoint}` : "commit");
      return out;
    } catch (err) {
      try {
        await this.conn.exec(
          savepoint
            ? `rollback to savepoint ${savepoint}; release savepoint ${savepoint}`
            : "rollback",
        );
      } catch (rollback) {
        // A failed commit may have ended the transaction already: the first error is the one to
        // report, and the rollback's is logged beside it, never in its place.
        log(
          "postgres",
          "rollback failed",
          { error: errorText(rollback), after: errorText(err) },
          "error",
        );
      }
      throw err;
    } finally {
      // Once, whatever failed: a failed commit must not leave every later transaction nested.
      this.depth = depth;
      if (!savepoint) this.conn.release();
    }
  }
}
