import { Type } from "@earendil-works/pi-ai";
import { errorText } from "../../common/errors.ts";
import { ABOUT_TYPES, NOTE_KINDS, NOTE_MAX } from "../../core/journal.ts";

/**
 * Field notes as agents write them (goal 065): the note tool of a Pi worker (code and research
 * trials), and the `journal` list the planner's and the advisors' answers may carry. The harness
 * records each note with who wrote it, from how it arrived, never from the note.
 */

/** A worker's note, as the harness API takes it (`POST /v1/trial/note`). */
export interface NoteRequest {
  kind: string;
  text: string;
  about?: { type: string; id: string } | undefined;
}

const Note = Type.Object({
  kind: Type.String({ description: NOTE_KINDS.join(" | ") }),
  text: Type.String({ description: `The note, short (at most ${NOTE_MAX} characters)` }),
  about: Type.Optional(
    Type.Object(
      {
        type: Type.String({ description: ABOUT_TYPES.join(" | ") }),
        id: Type.String({ description: "Its id (a round or a message: its number)" }),
      },
      { description: "What the note is about, when it is about one thing. Left out: the run" },
    ),
  ),
});

/** The note tool, the same for code and research workers in Pi. */
export const NOTE_TOOL = {
  name: "note",
  description:
    "Write a field note: an observation, a key decision and why, a surprise, an open question or a lesson, in a few sentences. Not what you tried and its result: the experiment log has that. It does not end your trial.",
  parameters: Note,
};

/** The `journal` field of the planner's and the advisors' answers. */
export const JOURNAL_FIELD = Type.Optional(
  Type.Array(Note, {
    description:
      "Your field notes, if any: observations, key decisions and why, surprises, open questions, lessons. Short; never what was tried and its result",
  }),
);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

/**
 * The notes of one model reply, held to the contract's `notes_per_turn` when it sets one (goal
 * 147): past it, a note is not recorded and its answer says so; the trial goes on. The worker
 * resets the count when a reply's turn ends. Without a limit, every note is recorded.
 */
export class NoteLimit {
  private readonly limit: number | undefined;
  private count = 0;

  constructor(limit: number | undefined) {
    this.limit = limit;
  }

  /** A new reply: its notes count from 0. */
  reset(): void {
    this.count = 0;
  }

  async write(
    note: (req: NoteRequest) => Promise<{ note: number }>,
    p: Record<string, unknown>,
  ): Promise<ReturnType<typeof text>> {
    if (this.limit !== undefined && this.count >= this.limit)
      return text(
        `not recorded: this campaign keeps at most ${this.limit} note${this.limit === 1 ? "" : "s"} from one reply. Write the most important ones in your next reply. Your trial goes on.`,
      );
    this.count++;
    return writeNote(note, p);
  }
}

/** Runs the note tool: the note through the harness API, and the answer in words. */
export async function writeNote(
  note: (req: NoteRequest) => Promise<{ note: number }>,
  p: Record<string, unknown>,
): Promise<ReturnType<typeof text>> {
  const kind = typeof p.kind === "string" ? p.kind.trim().toLowerCase() : "";
  const body = typeof p.text === "string" ? p.text.trim() : "";
  if (!body) return text("a note needs its text: what you observed, decided or learned");
  const a = p.about as { type?: unknown; id?: unknown } | undefined;
  const about =
    a && typeof a.type === "string" && (typeof a.id === "string" || typeof a.id === "number")
      ? { type: a.type.trim().toLowerCase(), id: String(a.id).trim() }
      : undefined;
  try {
    const out = await note({ kind, text: body, ...(about ? { about } : {}) });
    return text(`noted (#${out.note}). Your trial goes on.`);
  } catch (err) {
    return text(`the note was not recorded: ${errorText(err)}`);
  }
}
