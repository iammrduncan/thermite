import { ApiError } from "../common/api/call.ts";
import { controlClient } from "../common/api/control.ts";
import { harnessClient } from "../common/api/harness.ts";
import { errorText } from "../common/errors.ts";
import { KB_NOT_ASSIGNED, KB as KB_OF_CONTROL } from "../core/api/control/rigs.ts";
import { RUNS } from "../core/api/harness/advisors.ts";
import { KB } from "../core/api/harness/supervisor.ts";
import { knownKbKind, readKbSync } from "../core/kb.ts";

/**
 * Past research for each running run (goal 065). Control keeps Thermite's knowledge base: a
 * collection for each campaign, and which collections a campaign may read. The supervisor asks
 * control, with its rig's token, for the items of the collections a running run's campaign may
 * read, after the run's cursor, and hands them to its harness with the list of those collections.
 * The harness writes the items into the run's research folder under knowledge/, and removes the
 * folder of a collection no longer on the list (a revoked grant). The cursor of each run is kept
 * in the supervisor's state; pages are fetched while control says more wait. Control replays a
 * newly granted collection's items with new seqs, so a grant needs nothing special here. The harness never reaches control itself.
 *
 * A run control did not assign (a rig check's smoke run, say) has nothing there: control answers
 * 404 with the code `not_assigned`, which is no error, and the run is not asked about again for an
 * hour. Control also answers 404 for a run it assigned but has not heard of from the rig yet (its
 * first events are still on their way): that run is asked about again at the next sync.
 *
 * A newer control may send items of a kind this build does not know. They are left out, counted
 * by kind (the caller logs each kind once), and the sync goes on: a newer control never stops an
 * older rig's sync. The kinds are kept in the state; when an update of the rig teaches it one of
 * them, every run's cursor starts again from 0, so the items left out arrive then.
 *
 * Without control (no URL or token), nothing happens.
 */

export interface KbSyncConfig {
  rig: string;
  controlUrl?: string | undefined;
  controlToken?: string | undefined;
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
  /** The most JSON posted to the harness in one request, in characters (BATCH_CHARS by default). */
  batchBytes?: number | undefined;
  /** The clock (tests set it). */
  now?: (() => number) | undefined;
}

export interface KbSyncState {
  /** Per run, the last item's seq it was given (control's cursor). */
  cursors: Record<string, number>;
  /** Running runs control did not assign, and when to ask about each again (ISO time). */
  skipped?: Record<string, string> | undefined;
  /** Kinds of item this build left out because it does not know them (control is newer). */
  unknown_kinds?: string[] | undefined;
}

/** How long a run control did not assign is left alone. */
export const NOT_ASSIGNED_SKIP_MS = 3_600_000;

/**
 * The most JSON characters of items posted to the harness in one request: a quarter of the bytes
 * it takes (KB.maxBytes), so a batch fits even when each character is three bytes of UTF-8.
 */
const BATCH_CHARS = KB.maxBytes / 4;

export function emptyKbSyncState(): KbSyncState {
  return { cursors: {} };
}

export interface KbSyncResult {
  state: KbSyncState;
  /** Items handed to the harness in this call. */
  items: number;
  /** What went wrong, per run, in words (the other runs went on). */
  errors: string[];
  /** Items left out in this call, per kind this build does not know. */
  unknownKinds: Record<string, number>;
}

export async function syncKnowledgeOnce(
  cfg: KbSyncConfig,
  state: KbSyncState,
): Promise<KbSyncResult> {
  const out: KbSyncResult = {
    state: { cursors: { ...state.cursors } },
    items: 0,
    errors: [],
    unknownKinds: {},
  };
  if (!cfg.controlUrl || !cfg.controlToken) return out;
  // Kinds left out before that this build now knows (the rig was updated): every run starts
  // again from 0, so the items left out arrive. The harness overwrites the items it has.
  const leftOut = state.unknown_kinds ?? [];
  if (leftOut.some(knownKbKind)) out.state.cursors = {};
  const harness = harnessClient({
    url: cfg.harnessUrl,
    token: cfg.harnessToken,
    fetchImpl: cfg.fetchImpl,
  });
  const control = controlClient({
    url: cfg.controlUrl,
    token: cfg.controlToken,
    rig: cfg.rig,
    fetchImpl: cfg.fetchImpl,
  });
  const { runs } = await harness.call(RUNS);
  const running = runs.filter((r) => r.status === "running");
  // A skip ends after its hour, or when its run no longer runs.
  const now = (cfg.now ?? Date.now)();
  const skipped = Object.fromEntries(
    Object.entries(state.skipped ?? {}).filter(
      ([id, until]) => Date.parse(until) > now && running.some((r) => r.id === id),
    ),
  );
  const maxBytes = cfg.batchBytes ?? BATCH_CHARS;
  for (const run of running) {
    if (skipped[run.id]) continue;
    try {
      for (;;) {
        const after = out.state.cursors[run.id] ?? 0;
        let answer: unknown;
        try {
          answer = await control.call(KB_OF_CONTROL, { query: { run: run.id, after } });
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
          // Nothing for this run: control did not assign it (left alone for an hour), or has not
          // heard of it from the rig yet (asked again next time).
          if (err.code === KB_NOT_ASSIGNED)
            skipped[run.id] = new Date(now + NOT_ASSIGNED_SKIP_MS).toISOString();
          break;
        }
        const { page, unknownKinds } = readKbSync(answer);
        for (const [kind, n] of Object.entries(unknownKinds))
          out.unknownKinds[kind] = (out.unknownKinds[kind] ?? 0) + n;
        // Posted in batches the harness takes in one request each; the cursor moves only when
        // every item of the page reached the harness. Each post says which collections the run
        // may read now, so the harness removes one whose grant was revoked: a page with no items
        // is posted too, for that.
        let batch: unknown[] = [];
        let bytes = 0;
        const post = async (always = false) => {
          if (!batch.length && !always) return;
          await harness.call(KB, {
            body: { run: run.id, items: batch, collections: page.collections },
          });
          out.items += batch.length;
          batch = [];
          bytes = 0;
        };
        for (const item of page.items) {
          const size = JSON.stringify(item).length;
          if (batch.length && bytes + size > maxBytes) await post();
          batch.push(item);
          bytes += size;
        }
        await post(page.items.length === 0);
        out.state.cursors[run.id] = Math.max(after, page.next);
        if (!page.more) break;
        if (page.next <= after)
          throw new Error(`control said more items wait after ${after}, but gave none`);
      }
    } catch (err) {
      out.errors.push(`${run.id}: ${errorText(err)}`);
    }
  }
  if (Object.keys(skipped).length) out.state.skipped = skipped;
  const unknown = [
    ...new Set([...leftOut.filter((k) => !knownKbKind(k)), ...Object.keys(out.unknownKinds)]),
  ].sort();
  if (unknown.length) out.state.unknown_kinds = unknown;
  return out;
}
