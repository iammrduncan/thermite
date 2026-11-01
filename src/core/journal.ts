import { z } from "zod";

/**
 * Field notes (goal 065): what the workers, the planner and the advisors write down as they work.
 * A note is short, has its kind, and says what it is about: a record of its run, or the run
 * itself when its writer names nothing more specific. It is the agents' own words: data for other
 * agents to weigh, never instructions. What was tried and its result are in the experiment log,
 * so a note does not repeat them.
 */

export const NOTE_KINDS = [
  "observation",
  "decision",
  "surprise",
  "question",
  "lesson",
  "other",
] as const;
export const NoteKind = z.enum(NOTE_KINDS);
export type NoteKind = z.infer<typeof NoteKind>;

/** What a note is about: the run itself (by its id), or a record of the run, by its id. */
export const ABOUT_TYPES = [
  "run",
  "experiment",
  "attempt",
  "source",
  "claim",
  "finding",
  "round",
  "trial",
  "message",
] as const;
export const AboutType = z.enum(ABOUT_TYPES);
export type AboutType = z.infer<typeof AboutType>;

/** The longest note, in characters. */
export const NOTE_MAX = 2000;

export const NoteAbout = z.strictObject({
  type: AboutType,
  id: z.string().trim().min(1).max(200),
});
export type NoteAbout = z.infer<typeof NoteAbout>;

/**
 * One note as a writer gives it: its kind, its text (trimmed, not empty) and what it is about.
 * A writer may leave `about` out: the note is then recorded as about its run.
 */
export const NoteInput = z.strictObject({
  kind: NoteKind,
  text: z.string().trim().min(1).max(NOTE_MAX),
  about: NoteAbout.optional(),
});
export type NoteInput = z.infer<typeof NoteInput>;

/**
 * A model's notes, read leniently, one by one: a note that does not fit is left out (a text too
 * long is shortened), never a reason to lose the plan, review, audit or verdict it came with. No
 * limit on how many: none is set by default.
 */
export const LenientNotes = z
  .unknown()
  .transform((xs): NoteInput[] =>
    (Array.isArray(xs) ? xs : []).flatMap((x) => {
      if (!x || typeof x !== "object") return [];
      const o = x as Record<string, unknown>;
      const text = typeof o.text === "string" ? o.text.trim().slice(0, NOTE_MAX).trim() : "";
      const a = o.about as { type?: unknown; id?: unknown } | undefined;
      const about = NoteAbout.safeParse(
        a && typeof a === "object"
          ? {
              type: typeof a.type === "string" ? a.type.trim().toLowerCase() : a.type,
              id: typeof a.id === "number" ? String(a.id) : a.id,
            }
          : undefined,
      );
      const n = NoteInput.safeParse({
        kind: typeof o.kind === "string" ? o.kind.trim().toLowerCase() : o.kind,
        text,
        ...(about.success ? { about: about.data } : {}),
      });
      return n.success ? [n.data] : [];
    }),
  )
  .catch([]);

/** A worker's instructions for its field notes, with how its harness writes one. */
export function notesInstruction(how: string): string {
  return `As you work, keep field notes ${how}: an observation, a key decision and why, a surprise, an open question or a lesson. Keep each short, give its kind, and say what it is about when it is about one thing (a note that names nothing is about the run). Never note what you tried and its result: the experiment log has that. Other agents and later campaigns read your notes.`;
}

/** What a field note is, the same words for every writer. */
export const NOTES_GUIDE = `Field notes: write down what you learn as you work, in short notes, each with its kind:
an observation, a key decision and why, a surprise, an open question, or a lesson. Name what a
note is about when it is about one thing (an experiment, an attempt, a source, a claim, a
finding, a round, a trial or a message, by its id); a note that names nothing is about the run.
Never write what was tried and its result:
the experiment log has that. Other agents read your notes as data, and so do later campaigns.`;
