import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../../common/fs.ts";
import {
  KB_OUTBOX_FILES,
  type KbLinkRel,
  type KbWrittenKind,
  kbAddress,
  readKbItem,
  writerOfSlot,
  writtenRef,
} from "../../core/kb.ts";
import { type Ledger, LedgerError } from "../ledger/index.ts";

/**
 * A write to the knowledge base (goal 175): one version of one item in its writer's slot of a run,
 * recorded signed in the run's ledger as a `kb_item` event, with the writer as the event's actor.
 * The supervisor sends the event to control in a report, as every event; control stores the item
 * in that slot, after its own checks. A file is kept by its SHA-256 in the outbox
 * (KB_OUTBOX_FILES), once, for the supervisor to put on the message bus. The `kb_write` tool of the
 * agents calls it in a later step, with the writer it knows the agent by: never one an agent says.
 */

export interface KbWrite {
  run: string;
  /**
   * Who writes, and so the slot it writes in: `records` for Thermite's code, or an agent's slot,
   * its role with its lane for a worker (core/kb.ts). The harness gives it from what it knows of
   * the caller, never from the caller's words.
   */
  writer: string;
  kind: KbWrittenKind;
  title: string;
  /** A blurb's text; or a file. */
  text?: string | undefined;
  /** A file kept whole: its bytes, its name and its media type. */
  file?: { bytes: Uint8Array; name: string; type: string } | undefined;
  /** A new version of the writer's own item, by its number in the slot; none: a new item. */
  of?: number | undefined;
  /** Its links to other items, by their addresses. */
  links?: readonly { rel: KbLinkRel; to: string }[] | undefined;
}

export interface KbWritten {
  /** The kb_item event's id in the ledger. */
  event: number;
  /** The item's number in its slot, and this version's. */
  item: number;
  version: number;
  /** Where it is: `<campaign>/<run>/<slot>/<kind>:<id>`. */
  address: string;
}

/**
 * Records one item's version in the ledger, in its writer's slot of the run: a new item takes the
 * slot's next number; `of` adds the next version of the writer's own item, of the same kind, and
 * the older versions stay. A file is kept in the outbox first, by its SHA-256, unless it is there
 * already. Throws a LedgerError, in words, on a run the ledger lacks, an item the writer's slot
 * lacks, a kind that differs from the item's, or a body the knowledge base would refuse.
 */
export function writeKbItem(ledger: Ledger, outboxDir: string, w: KbWrite): KbWritten {
  const run = ledger.runs.get(w.run);
  if (!run) throw new LedgerError("not_found", `no run ${w.run}`);
  const file = w.file && {
    sha256: createHash("sha256").update(w.file.bytes).digest("hex"),
    name: w.file.name,
    type: w.file.type,
    bytes: w.file.bytes.length,
  };
  return ledger.tx(() => {
    // The slot's items so far, from its writer's kb_item events: each item's kind and newest
    // version, as control keeps them.
    const held = new Map<number, { kind: string; version: number }>();
    const own = { subject: w.run, actor: writerOfSlot(w.writer), body: { slot: w.writer } };
    for (const e of ledger.events.list("kb_item", own))
      held.set(e.body.item, { kind: e.body.kind, version: e.body.version });
    let item: number;
    let version: number;
    if (w.of === undefined) {
      item = Math.max(0, ...held.keys()) + 1;
      version = 1;
    } else {
      const had = held.get(w.of);
      if (!had)
        throw new LedgerError("not_found", `${w.writer} has no item ${w.of} in run ${w.run}`);
      if (had.kind !== w.kind)
        throw new LedgerError(
          "invalid",
          `item ${w.of} is a ${had.kind}: a new version keeps its kind, not ${w.kind}`,
        );
      item = w.of;
      version = had.version + 1;
    }
    const read = readKbItem({
      slot: w.writer,
      item,
      version,
      kind: w.kind,
      title: w.title,
      ...(w.text === undefined ? {} : { text: w.text }),
      ...(file ? { file } : {}),
      links: w.links ?? [],
    });
    if ("refused" in read) throw new LedgerError("invalid", read.refused);
    const { body } = read;
    if (w.file && file) {
      const path = join(outboxDir, KB_OUTBOX_FILES, file.sha256);
      if (!existsSync(path)) writeAtomic(path, Buffer.from(w.file.bytes), 0o644);
    }
    const event = ledger.appendEvent(writerOfSlot(body.slot), "kb_item", w.run, body);
    const address = kbAddress({
      campaign: run.campaign,
      run: w.run,
      slot: body.slot,
      kind: body.kind,
      ref: writtenRef(body.slot, item),
    });
    return { event, item, version, address };
  });
}
