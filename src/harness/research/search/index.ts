import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { log } from "../../../common/env.ts";
import { errorText } from "../../../common/errors.ts";
import {
  EVERY_ITEM,
  type FoundPassage,
  findWords,
  indexItem,
  type ScopeSql,
  type SearchMode,
  textStart,
  unindexItem,
} from "../../../common/search/index.ts";
import { openDatabase, transaction } from "../../../common/sqlite.ts";
import type { ResearchKind } from "../../../core/api/harness/research.ts";
import type { Ledger } from "../../ledger/index.ts";
import { SAVED_LANES_DIR } from "../folder.ts";
import { corpusPage } from "./corpus.ts";
import { entriesOf } from "./items.ts";
import { RUN_WORDS, SCHEMA, VERSION } from "./tables.ts";

/**
 * The index of each run's own research on the rig (goal 175): its sources' archived texts whole,
 * its claims, hypotheses, findings, notes, report sections and lanes' files, in a words index of
 * its own, `<state>/research-search/<run>.db`, built with Thermite's search engine
 * (common/search/), as control's knowledge base is: so the two rank the same text the same way.
 * search_research ranks the run's research by its words (BM25), with phrases and prefixes in the
 * exact mode, and says how many items hold each word and what is close to a word none holds;
 * search_corpus finds an exact phrase in the sources (corpus.ts). Both answer from the rig alone,
 * at once, with control away.
 *
 * The index is a copy, made from the ledger and the saved files: before each search it takes in
 * what was archived, written or changed since, and lets go of what is gone, so it is current
 * however a source or a file came. A lost index is made again.
 */

/** Where the index of each run is, under the harness's state. */
const SEARCH_DIR = "research-search";

/** What the index's context holds, for why. */
const CONTEXT_WORDS = "its context (kind, state, a source's address)";
/** A column filter that means something in this index, for the words of a refusal. */
const COLUMN_EXAMPLE = "title: word or context: verified";

/** One item a search found. */
export interface RunHit {
  kind: ResearchKind;
  id: string;
  at: string;
  title: string;
  state?: string;
  excerpt: string;
  why: string;
  /** Where in its text the best passage is, for a long one: a source's offsets, as read_source takes them. */
  passage: FoundPassage | null;
}

/** A search of a run's research: its hits, best first, and what the engine says beside them. */
export interface RunFound {
  matched: number;
  next_offset: number | null;
  words: { word: string; items: number }[];
  did_you_mean: { word: string; try: { word: string; items: number }[] }[];
  items: RunHit[];
  refused?: string;
}

export interface RunSearchOptions {
  kinds: readonly ResearchKind[];
  mode?: SearchMode | undefined;
  offset: number;
  limit: number;
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** An item's row as a hit. */
function hitOf(
  r: Record<string, unknown>,
  found: { excerpt: string; why: string; passage: FoundPassage | null },
): RunHit {
  return {
    kind: String(r.kind) as ResearchKind,
    id: String(r.ref),
    at: String(r.at),
    title: String(r.title),
    ...(r.state ? { state: String(r.state) } : {}),
    excerpt: found.excerpt.replace(/\s+/g, " ").trim(),
    why: found.why,
    passage: found.passage,
  };
}

/** The indexes of a rig's runs' own research. */
export class RunSearch {
  private readonly ledger: Ledger;
  private readonly dir: string;
  private readonly saved: string;
  /** Each run's index, opened at its first search. */
  private readonly open = new Map<string, DatabaseSync>();

  constructor(o: { ledger: Ledger; stateDir: string }) {
    this.ledger = o.ledger;
    this.dir = join(o.stateDir, SEARCH_DIR);
    this.saved = join(o.stateDir, SAVED_LANES_DIR);
  }

  /**
   * A run's index, made when it has none, one of another version, or one that can't be read: it
   * is a copy, made again from the ledger.
   */
  private db(run: string): DatabaseSync {
    const had = this.open.get(run);
    if (had) return had;
    const path = join(this.dir, `${run}.db`);
    let db: DatabaseSync | undefined;
    try {
      db = openDatabase(path);
      const version = db.prepare("pragma user_version").get() as { user_version: number };
      if (Number(version.user_version) !== VERSION) {
        const tables = db.prepare("select 1 from sqlite_master limit 1").get();
        if (tables) throw new Error(`an index of version ${version.user_version}`);
        db.exec(SCHEMA);
      }
    } catch (err) {
      db?.close();
      log("harness", "a run's research index made again", { run, why: errorText(err) });
      for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
      db = openDatabase(path);
      db.exec(SCHEMA);
    }
    this.open.set(run, db);
    return db;
  }

  /**
   * The run's index made current: what was archived, written or changed since it last looked is
   * indexed, and what is gone is let go. An item whose text can't be read now waits for the next.
   */
  private sync(run: string): void {
    const db = this.db(run);
    const want = new Map(
      entriesOf(this.ledger, this.saved, run).map((e) => [`${e.kind}:${e.ref}`, e]),
    );
    const have = db.prepare("select id, kind, ref, key from item").all() as {
      id: number;
      kind: string;
      ref: string;
      key: string;
    }[];
    const kept = new Set<string>();
    const gone: number[] = [];
    for (const h of have) {
      const k = `${h.kind}:${h.ref}`;
      if (want.get(k)?.key === h.key) kept.add(k);
      else gone.push(Number(h.id));
    }
    const added = [...want].filter(([k]) => !kept.has(k)).map(([, e]) => e);
    if (!gone.length && !added.length) return;
    let indexed = 0;
    transaction(db, () => {
      for (const id of gone) {
        unindexItem(db, RUN_WORDS, id);
        db.prepare("delete from item where id = ?").run(id);
      }
      const next = db.prepare("select coalesce(max(seq), 0) + 1 as n from item");
      const add = db.prepare(
        `insert into item (seq, kind, ref, key, at, title, state, context, body)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of added) {
        const body = e.text();
        if (body === undefined) continue;
        const seq = Number((next.get() as { n: number }).n);
        const id = Number(
          add.run(seq, e.kind, e.ref, e.key, e.at, e.title, e.state, e.context, body)
            .lastInsertRowid,
        );
        indexItem(db, RUN_WORDS, id, body);
        indexed++;
      }
    });
    if (indexed || gone.length)
      log("harness", "a run's research indexed", { run, items: indexed, let_go: gone.length });
  }

  /**
   * A run's research by its words, best first: BM25 over the index, with each hit's excerpt, why it
   * matched and where; a page of `limit` from `offset`. No words: the newest. `kinds` keeps those.
   */
  search(run: string, q: string, o: RunSearchOptions): RunFound {
    this.syncOrSay(run);
    const db = this.db(run);
    const scope: ScopeSql = {
      sql: `i.kind in (${marks(o.kinds.length)})`,
      args: [...o.kinds],
    };
    const r = findWords(db, RUN_WORDS, {
      queries: [q],
      mode: o.mode,
      scope,
      within: EVERY_ITEM,
      offset: o.offset,
      limit: o.limit,
      context: CONTEXT_WORDS,
      columnExample: COLUMN_EXAMPLE,
    });
    if (r) {
      const { found, ...rest } = r;
      return { ...rest, items: found.map((f) => hitOf(f.row, f)) };
    }
    const total = Number(
      (
        db.prepare(`select count(*) as n from item i where ${scope.sql}`).get(...scope.args) as {
          n: number;
        }
      ).n,
    );
    const rows = db
      .prepare(
        `select * from item i where ${scope.sql} order by i.at desc, i.seq desc limit ? offset ?`,
      )
      .all(...scope.args, o.limit, o.offset) as Record<string, unknown>[];
    return {
      matched: total,
      next_offset: o.offset + rows.length < total ? o.offset + rows.length : null,
      words: [],
      did_you_mean: [],
      items: rows.map((row) =>
        hitOf(row, { excerpt: textStart(String(row.body ?? "")), why: "", passage: null }),
      ),
    };
  }

  /** search_corpus: an exact phrase in the run's archived sources, a page at a time (corpus.ts). */
  corpus(run: string, text: string, skip: number) {
    this.syncOrSay(run);
    return corpusPage(this.db(run), this.ledger, run, text, skip);
  }

  /** The index made current; a failure is logged, and the search answers from what it holds. */
  private syncOrSay(run: string): void {
    try {
      this.sync(run);
    } catch (err) {
      log("harness", "a run's research not indexed", { run, error: errorText(err) }, "warn");
    }
  }
}
