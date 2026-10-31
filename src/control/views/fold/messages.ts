import { frozen } from "../sharing.ts";
import type { Handler, Handlers } from "./index.ts";

/**
 * The owner's messages to the run's agents (goal 063), with who read them and the advisors'
 * answers, and the agents' notes (goal 065): field notes and research notes.
 */

/** How many of the owner's messages a run's view keeps. */
const KEPT_MESSAGES = 200;

/** A message read by an agent, unkept by the owner, or answered by an advisor. */
const messageUpdated: Handler = (f, e, b) => {
  const v = f.run(String(e.subject));
  const m = v.messages.find((x) => x.id === Number(b.message));
  if (!m) return;
  if (e.kind === "agent_message_unkept") m.unkept = true;
  else if (e.kind === "advisor_answer")
    m.answers.push({
      role: String(b.role ?? ""),
      text: String(b.text ?? ""),
      at: e.at,
      ...(typeof b.advisor === "string" && b.advisor ? { advisor: b.advisor } : {}),
    });
  else
    m.reads.push({
      by: String(b.by ?? ""),
      trial: typeof b.trial === "string" ? b.trial : null,
      at: e.at,
      // A read from before reads named their round has none.
      round: Number.isInteger(b.round) ? Number(b.round) : null,
    });
};

export const MESSAGES: Handlers = {
  journal_note(f, e, b) {
    const id = Number(b.id);
    const text = typeof b.text === "string" ? b.text : "";
    if (!Number.isFinite(id) || !text) return;
    const about =
      b.about && typeof b.about === "object" ? (b.about as Record<string, unknown>) : null;
    f.run(String(e.subject)).journal.push(
      frozen({
        id,
        by: String(b.by ?? e.actor),
        kind: typeof b.kind === "string" && b.kind ? b.kind : "note",
        text,
        // A note always says what it is about; one recorded before that rule is about its run.
        about:
          about && typeof about.type === "string" && about.id !== undefined && about.id !== null
            ? { type: about.type, id: String(about.id) }
            : { type: "run", id: String(e.subject) },
        lane: typeof b.lane === "string" ? b.lane : null,
        trial: typeof b.trial === "string" ? b.trial : null,
        at: e.at,
      }),
    );
  },
  // A research note (sources read, in any mode): in the journal's notes card, apart from the
  // field notes. Its id is negative so it never meets a field note's.
  research_note(f, e, b) {
    const note = Number(b.note);
    const text = typeof b.text === "string" ? b.text : "";
    if (!Number.isFinite(note) || !text) return;
    const sources = Array.isArray(b.sources) ? b.sources.map(String) : [];
    f.run(String(e.subject)).journal.push(
      frozen({
        id: -note,
        by: String(b.by ?? e.actor),
        kind: "note",
        text,
        about: sources[0] ? { type: "source", id: sources[0] } : null,
        lane: typeof b.by === "string" && /^lane-\d+$/.test(b.by) ? b.by : null,
        trial: typeof b.trial === "string" ? b.trial : null,
        at: e.at,
      }),
    );
  },
  agent_message(f, e, b) {
    const v = f.run(String(e.subject));
    if (typeof b.id !== "number" && !Number.isFinite(Number(b.id))) return;
    v.messages.push({
      id: Number(b.id),
      to: String(b.to ?? ""),
      text: String(b.text ?? ""),
      keep: b.keep === true,
      unkept: false,
      at: e.at,
      reads: [],
      answers: [],
      rules: [],
      left_out: [],
    });
    if (v.messages.length > KEPT_MESSAGES) v.messages.shift();
  },
  agent_message_read: messageUpdated,
  agent_message_unkept: messageUpdated,
  advisor_answer: messageUpdated,
};
