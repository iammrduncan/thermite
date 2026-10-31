import { randomBytes } from "node:crypto";
import { redact } from "../common/log.ts";

/** How many notes control keeps at once; past it, the oldest is dropped. */
const NOTES_MAX = 500;
/** How long a note is kept: long enough to load its page again. */
const NOTE_MS = 15 * 60_000;
/** A note's ID, as a page's address names it. */
const NOTE_ID = /^note-[0-9a-f]{24}$/;

/**
 * Why a dashboard form failed, when the words come from another program's error (ssh, git,
 * kubectl, a GPU cloud, an MCP server): control keeps them for the page the form sends the owner
 * back to, and that page's address names them by an ID. The words never sit in a URL, the
 * browser's history or a proxy's log, and what could be a credential is taken out of them.
 */
export class PageNotes {
  private readonly notes = new Map<string, { text: string; until: number }>();

  /** Keeps `text` for a page, and gives the ID its address names it by. */
  put(text: string): string {
    const now = Date.now();
    for (const [id, n] of this.notes) if (n.until <= now) this.notes.delete(id);
    const id = `note-${randomBytes(12).toString("hex")}`;
    this.notes.set(id, { text: redact(text), until: now + NOTE_MS });
    if (this.notes.size > NOTES_MAX) {
      const oldest = this.notes.keys().next().value;
      if (oldest !== undefined) this.notes.delete(oldest);
    }
    return id;
  }

  /**
   * The words a page's query value stands for: a kept note's text, a note gone after its time
   * said so, and any other value as it is.
   */
  read(value: string | undefined): string | undefined {
    if (value === undefined || !NOTE_ID.test(value)) return value;
    const n = this.notes.get(value);
    return n && n.until > Date.now()
      ? n.text
      : "This message is no longer kept: do it again to see why.";
  }
}
