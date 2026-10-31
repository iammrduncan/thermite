import { z } from "zod";
import { KB_OWNER, KbAddress, KbItemBody, kbAddress } from "../../core/kb.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * The owner's note on an item (goal 176, item 6): a note in the `owner` slot of the item's run,
 * which follows the item, written as the owner; the same on the reader's Add a note, REST
 * (`POST /v1/kb/notes`), MCP (`kb_note`) and `thermite kb note`. The run's agents find it as they
 * find any item of what they read. A note is never changed or removed.
 */

/** How long a note may be: as a field note. */
export const KB_NOTE_MAX = 2_000;

export const kbNoteFields = {
  address: KbAddress.describe("The item the note is on, by its address: the note follows it"),
  text: z
    .string()
    .trim()
    .min(1)
    .max(KB_NOTE_MAX)
    .describe(`The note, 1 to ${KB_NOTE_MAX.toLocaleString("en-US")} characters`),
  title: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .optional()
    .describe("Its title; left out, the note's first line, cut to 120 characters"),
};
export const KbNoteQuery = z.strictObject(kbNoteFields);
export type KbNoteQuery = z.infer<typeof KbNoteQuery>;

/** What Add a note says before its button: what it does, in words. */
export const NOTE_WORDS = (run: string) =>
  `Saves your note in the owner slot of run ${run}, linked to this item. Its agents find it as they find any item they read. A note is kept as written: it is never changed or removed.`;

export type KbNoteOutcome =
  | { ok: true; address: string; follows: string; said: string }
  | { ok: false; error: string };

/** Writes the owner's note on the item at `address`; `by` is who wrote it, for the audit log. */
export function writeOwnerNote(store: ControlStore, n: KbNoteQuery, by: string): KbNoteOutcome {
  const kb = store.kb();
  const x = kb.at(n.address);
  if (!x) return { ok: false, error: `the knowledge base has no item ${n.address}` };
  const next = kb.nextItem(x, KB_OWNER);
  const first = n.text.split("\n")[0]?.trim() ?? "";
  const title = n.title ?? (first.length > 120 ? `${first.slice(0, 119)}…` : first);
  const body = KbItemBody.safeParse({
    slot: KB_OWNER,
    item: next,
    version: 1,
    kind: "note",
    title,
    text: n.text,
    links: [{ rel: "follows", to: n.address }],
  });
  if (!body.success)
    return { ok: false, error: body.error.issues.map((i) => i.message).join("; ") };
  const at = new Date().toISOString();
  const refused = store.tx(() =>
    kb.write({ rig: x.rig, ledger: x.ledger, run: x.run, at }, body.data),
  );
  if (refused) return { ok: false, error: refused };
  const address = kbAddress({ ...x, slot: KB_OWNER, kind: "note", ref: String(next) });
  store.auditLog.add(by, "kb_note", { address, follows: n.address });
  return {
    ok: true,
    address,
    follows: n.address,
    said: `Your note is kept: ${address}, in run ${x.run}'s owner slot, linked to ${n.address}.`,
  };
}
