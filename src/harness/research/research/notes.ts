import { LedgerError } from "../../ledger/index.ts";
import { foldText } from "../checks.ts";
import type { ResearchContext } from "./context.ts";

/** The run's newest notes a new note may not repeat (goal 117). */
export const NOTE_REPEATS = 200;

/**
 * A research note, with the sources it relies on. It is its own record (the research folder's
 * notes/ and the report read it) and one `research_note` event with its text, so the knowledge
 * base has it too. Field notes are another record (journal.ts).
 *
 * A note that repeats one of the run's last NOTE_REPEATS notes word for word, once folded
 * (foldText), is refused in words (goal 117): one trial once wrote the same two words thousands
 * of times.
 */
export function addNote(
  ctx: ResearchContext,
  run: string,
  lane: string | null,
  text: string,
  sources: string[] = [],
  trial?: string | undefined,
) {
  const body = text.trim().slice(0, 4000);
  if (!body) throw new LedgerError("invalid", "a note needs its text");
  const key = foldText(body);
  const same = ctx.ledger.claims
    .newestNotes(run, NOTE_REPEATS)
    .find((n) => foldText(n.text) === key);
  if (same)
    throw new LedgerError(
      "invalid",
      `this note repeats note ${same.id} (by ${same.lane ?? "research"}, ${same.created_at}) word for word: it is not recorded again. Record what is new, or go on with the work`,
    );
  const cited = sources.slice(0, 20);
  const first = cited.length ? ctx.ledger.sources.get(run, cited[0] as string) : undefined;
  const id = ctx.ledger.tx(() => {
    const id = ctx.ledger.claims.addNote({ run, lane, text: body, sources: cited });
    ctx.ledger.appendEvent(lane ?? "research", "research_note", run, {
      note: id,
      by: lane ?? "research",
      text: body,
      sources: cited,
      ...(first ? { url: first.url } : {}),
      ...(trial ? { trial } : {}),
    });
    return id;
  });
  ctx.changed(run);
  return { note: id };
}
