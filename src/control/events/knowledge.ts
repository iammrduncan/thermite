import { BUS_READ_MAX, type Bus } from "../../common/bus.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { type KbItemBody, readKbItem, slotOfWriter } from "../../core/kb.ts";
import { EVENT_STREAM, type EventRead, kindSubjects } from "../../core/link/events.ts";
import type { ControlStore } from "../store/index.ts";
import { streamEvent } from "../views/index.ts";

/**
 * A writer's `kb_item` event (goal 175), as the apply of the events stream takes it: the item goes
 * into its writer's slot of the event's run, after control's checks, in the page's transaction.
 * The report it came in was signed by the rig's harness, and control checked that signature
 * before it published the event (control/ingest.ts): control alone writes the events stream.
 * Then: the event reads as an item; the run is the rig's, in this ledger, by control's run
 * registry; the slot is the event's writer's (slotOfWriter: records from Thermite's code, an
 * agent's own slot from that agent), never one the item names for another writer; and the item is
 * new in its slot or the next version of the writer's own (store/kb/). Which writer may write
 * which kind is the campaign's, in a later step: every slot may write every kind now. A refused
 * item is recorded in control's audit log (`kb_item_refused`) and its log, and the rest of the
 * page goes on. Its file meets it by its SHA-256 (control/kb/files.ts), whichever comes first.
 */
export function takeKbItem(
  store: ControlStore,
  src: { rig: string; ledger: string },
  e: { id: number; at: string; actor: string; subject: string | null; body: unknown },
): void {
  const run = e.subject ?? "";
  const read = readKbItem(e.body);
  const why =
    "refused" in read
      ? `not an item: ${read.refused}`
      : storeItem(store, { ...src, run }, e, read.body);
  if (!why) return;
  const slot = "body" in read ? read.body.slot : null;
  const what = { ...src, event: e.id, run, writer: e.actor, slot, why };
  log("control", "an item for the knowledge base refused", what, "warn");
  store.auditLog.add("control", "kb_item_refused", what);
}

/** An item stored after control's checks; else why not, in words. */
function storeItem(
  store: ControlStore,
  src: { rig: string; ledger: string; run: string },
  e: { id: number; at: string; actor: string },
  b: KbItemBody,
): string | undefined {
  if (!src.run || store.runRegistry.ledgerOf(src.run, src.rig) !== src.ledger)
    return `run ${src.run || "(none)"} is not this rig's: control's run registry has no such run of this ledger`;
  const own = slotOfWriter(e.actor);
  if (!own) return `${e.actor} has no slot in the knowledge base: it writes no item`;
  if (own !== b.slot)
    return `${e.actor} writes only in its own slot, ${own}: not in ${b.slot}, another writer's`;
  return store.kb().write({ ...src, event: e.id, at: e.at }, b);
}

/**
 * Once, after an upgrade of the knowledge base's reading (goal 162), the events it read before, of
 * the kinds the new reading reads anew (KnowledgeBase.kindsToReadAgain), read again from the
 * events stream, from each rig's current ledger: those the apply applied before control started
 * (at or before the store's place) and those indexed from control's events table before the apply
 * fed it (at or below the hand-over mark, kb_cursor.seq, against each message's Thermite-Seq), as
 * the apply's own indexing tells them apart. Every later event the apply indexes as it comes. A
 * run filed already stays in its folder. The apply runs it as control starts, before its first
 * page; nothing is read once the store is at the reading. An event the knowledge base can't index
 * is passed over, in control's log. Returns how many events it read again.
 */
export async function readKnowledgeAgain(
  store: ControlStore,
  bus: Pick<Bus, "read">,
): Promise<number> {
  const kb = store.kb();
  const kinds = kb.kindsToReadAgain();
  if (!kinds.length) return 0;
  const place = store.busPositions.of(EVENT_STREAM);
  const mark = kb.indexedFromTable();
  const subjects = kinds.flatMap(kindSubjects);
  const ledgers = new Map(
    store.reportedRigs.list({ withRetired: true }).map((r) => [r.id, r.ledger_id]),
  );
  const started = performance.now();
  let again = 0;
  for (let from = 1; ; ) {
    const page = await bus.read(EVENT_STREAM, { subjects, from, limit: BUS_READ_MAX });
    const due: EventRead[] = [];
    // Messages come in the stream's order, and their Thermite-Seq with it: the first one after
    // both bounds ends the read.
    let ended = false;
    for (const m of page.messages) {
      const e = streamEvent(m);
      if (!e) continue;
      const seq = e.read.seq;
      if (m.seq > place && (seq === undefined || seq > mark)) {
        ended = true;
        break;
      }
      if (ledgers.get(e.read.rig) === e.read.ledger) due.push(e.read);
    }
    store.tx(() => {
      for (const { rig, ledger, event } of due)
        try {
          // A savepoint: an event indexed in part is not kept.
          store.tx(() => kb.index({ rig, ledger }, event, { again: true }));
          again++;
        } catch (err) {
          const what = { rig, ledger, event: event.id, kind: event.kind, error: errorText(err) };
          log("control", "an event not read again into the knowledge base", what, "error");
        }
    });
    if (ended || page.done || page.next <= from) break;
    from = page.next;
  }
  kb.readAgainDone();
  const ms = Math.round(performance.now() - started);
  const level = again ? "info" : "debug";
  log("control", "the knowledge base read events again for its new reading", { again, ms }, level);
  return again;
}
