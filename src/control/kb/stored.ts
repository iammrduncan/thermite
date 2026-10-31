import { errorText } from "../../common/errors.ts";
import { EVENT_STREAM } from "../../core/link/events.ts";
import { KB_FILES_STREAM } from "../../core/link/kb-files.ts";
import { BUS_STATE_TIMEOUT_MS, type BusView } from "../bus/index.ts";
import type { ControlStore, KbStoredFigures } from "../store/index.ts";

/**
 * What the knowledge base stores (goal 176, What's stored), the same read on REST
 * (`GET /v1/kb/stored`), MCP (`kb_stored`), the command line (`thermite kb stored`) and the
 * dashboard's What's stored page: the totals, each collection's figures with its runs, last write
 * and who reads it, the indexes, the largest files and the file types, what waits on the message
 * bus for control to store, and a page of the writes control refused.
 */

/** Refused writes a page holds. */
export const KB_REFUSED_PAGE = 50;

/** Search by meaning: none is installed (goal 175 has not decided it). */
const MEANING = { state: "not installed" } as const;

/** What waits on the bus for control to store, as control can know it, and the last stored. */
export interface KbWaiting {
  /** off: control runs without the bus; away: the server did not answer (error says why). */
  bus: "on" | "off" | "away";
  error: string | null;
  /** Events on the events stream after the place control applied through: kb_item events among them. */
  events: number | null;
  /** File chunks on the KB_FILES stream that control has not taken yet. */
  file_chunks: number | null;
  last_item: KbStoredFigures["last_item"];
  last_file: KbStoredFigures["last_file"];
}

/** What the bus holds for control to store; nothing is waited for longer than its state is. */
async function waiting(
  store: ControlStore,
  view: BusView | undefined,
  f: KbStoredFigures,
): Promise<KbWaiting> {
  const last = { last_item: f.last_item, last_file: f.last_file };
  if (!view) return { bus: "off", error: null, events: null, file_chunks: null, ...last };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(
      () => fail(new Error(`no answer within ${BUS_STATE_TIMEOUT_MS / 1000} seconds`)),
      BUS_STATE_TIMEOUT_MS,
    );
  });
  try {
    const [end, streams] = await Promise.race([
      Promise.all([view.bus.lastSeq(EVENT_STREAM), view.bus.streams([KB_FILES_STREAM])]),
      late,
    ]);
    const place = store.busPositions.of(EVENT_STREAM);
    return {
      bus: "on",
      error: null,
      events: Math.max(0, end - place),
      file_chunks: streams.find((s) => s.name === KB_FILES_STREAM)?.messages ?? 0,
      ...last,
    };
  } catch (err) {
    return { bus: "away", error: errorText(err), events: null, file_chunks: null, ...last };
  } finally {
    clearTimeout(timer);
  }
}

/** The read: everything on one page, with the refused writes from `offset`. */
export async function kbStored(
  store: ControlStore,
  view: BusView | undefined,
  o: { offset?: number | undefined } = {},
) {
  const kb = store.kb();
  const f = kb.stored();
  const archived = new Set(store.archive.list().map((a) => a.campaign));
  const by = new Map(kb.collections().map((c) => [c.campaign, c]));
  const offset = Math.max(0, Math.floor(o.offset ?? 0));
  const refused = store.auditLog.kbRefusedPage(offset, KB_REFUSED_PAGE);
  const collections = f.collections.map((c) => ({
    ...c,
    archived: archived.has(c.campaign),
    runs: by.get(c.campaign)?.runs ?? 0,
    updated_at: by.get(c.campaign)?.updated_at || null,
    read_by: by.get(c.campaign)?.read_by ?? [],
  }));
  const last = collections.reduce<string | null>(
    (a, c) => (c.updated_at && (!a || c.updated_at > a) ? c.updated_at : a),
    null,
  );
  return {
    totals: {
      ...f.all,
      collections: collections.length,
      runs: collections.reduce((n, c) => n + c.runs, 0),
      updated_at: last,
    },
    collections,
    indexes: { words: { state: "current" as const, items: f.words.items }, meaning: MEANING },
    largest_files: f.largest,
    file_types: f.file_types,
    waiting: await waiting(store, view, f),
    refused: {
      total: refused.total,
      offset,
      next_offset:
        offset + refused.rows.length < refused.total ? offset + refused.rows.length : null,
      rows: refused.rows,
    },
  };
}
export type KbStored = Awaited<ReturnType<typeof kbStored>>;
