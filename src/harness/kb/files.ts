import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../common/env.ts";
import { writeAtomic } from "../../common/fs.ts";
import { KB_OUTBOX_FILES, KbFileSha256, type KbItemFile } from "../../core/kb/index.ts";

/**
 * An item's file for the knowledge base (goal 175), kept in the rig's outbox by its SHA-256
 * (KB_OUTBOX_FILES), once: a file there already is not written again. The supervisor puts it on
 * the message bus, and control keeps it once; once control says it holds it, the supervisor names
 * it to the harness, which removes it (forgetHeldKbFiles). An agent's item (write.ts), a source's
 * archived text and a lane's document (the research folder) keep their files here.
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

/**
 * Removes from the outbox the files control holds, each by its SHA-256, as the supervisor named
 * them from control's answer (KB_FILES_HELD): the only way a file leaves the outbox. One gone
 * already counts as none, and a name that is not a SHA-256 is passed over. A file written again
 * later is kept again, and goes once control is asked again. Returns how many it removed.
 */
export function forgetHeldKbFiles(outboxDir: string, files: readonly string[]): number {
  let removed = 0;
  for (const sha256 of files) {
    if (!KbFileSha256.safeParse(sha256).success) continue;
    const path = join(outboxDir, KB_OUTBOX_FILES, sha256);
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed++;
  }
  if (removed)
    log("harness", "files for the knowledge base left the outbox: control holds them", {
      removed,
    });
  return removed;
}
