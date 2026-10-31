import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../../common/fs.ts";
import { KB_OUTBOX_FILES, type KbItemFile } from "../../core/kb.ts";

/**
 * An item's file for the knowledge base (goal 175), kept in the rig's outbox by its SHA-256
 * (KB_OUTBOX_FILES), once: a file there already is not written again. The supervisor puts it on
 * the message bus, and control keeps it once. An agent's item (write.ts), a source's archived text
 * and a lane's document (the research folder) keep their files here.
 */

/** A file's facts as an item names it: its SHA-256, its name, its media type and its size. */
export function kbFileFacts(bytes: Uint8Array, o: { name: string; type: string }): KbItemFile {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { sha256, name: o.name, type: o.type, bytes: bytes.length };
}

/** Keeps a file in the outbox under its SHA-256, unless it is there already. */
export function keepKbFile(outboxDir: string, bytes: Uint8Array, file: KbItemFile): void {
  const path = join(outboxDir, KB_OUTBOX_FILES, file.sha256);
  if (!existsSync(path)) writeAtomic(path, Buffer.from(bytes), 0o644);
}
