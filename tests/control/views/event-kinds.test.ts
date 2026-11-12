import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { foldedKinds } from "../../../src/control/views/fold/index.ts";
import { EVENT_KINDS } from "../../../src/core/events/kinds.ts";
import { whyUnreadable } from "../../../src/core/events/schemas.ts";

/**
 * One walk over every kind of event (goal 254, item 2). A kind has a handler in the fold of
 * control's views and a sentence in History, or it is on one of the lists below, which say what
 * it has none of. So a new kind can't be left half done unseen: it gets both, or its author puts
 * it on a list, on purpose. A list also fails when it names a kind that has since got what the
 * list says it lacks, so each list is exact.
 *
 * The lists are today's. The last one is the kinds nothing in control reads: whether each is on
 * purpose has not been asked, kind by kind.
 */

/** A sentence in History, and no field of a view: the sentence reads the event itself. */
const SENTENCE_ONLY = [
  "acceptance_set",
  "claim_added",
  "command",
  "command_rejected",
  "context_compacted",
  "flaws_accepted",
  "goal_complete",
  "kit_set",
  "lane_limits_set",
  "legacy",
  "mcp_server_back",
  "mcp_server_failed",
  "mcp_servers",
  "mcp_servers_wait",
  "model_route_cleared",
  "model_route_set",
  "parent_screened",
  "port_queued",
  "queue_low",
  "research_stopped",
  "rig_settings_changed",
  "run_hours_added",
  "teachers_round_requested",
  "terminal_input",
  "trial_repeating",
  "workers_reset",
];

/** A handler, and no sentence: a view shows it in a place of its own, not as a line of History. */
const HANDLER_ONLY = [
  "advisor_answer",
  "agent_message",
  "agent_message_read",
  "agent_message_unkept",
  "attempt_lifecycle",
  "champion_published",
  "crash_infra",
  "directives_superseded",
  "experiment_assigned",
  "experiment_finished",
  "goal_checks",
  "job_lease_expired",
  "job_queued",
  "job_unblocked",
  "journal_note",
  "research_digest",
  "research_final",
  "source_note",
  "trial_started",
  "verdict_guards",
];

/** Neither, because another reader of control takes it: the reader is named beside each. */
const READ_ELSEWHERE = [
  "agent_prompt", // a run's prompts (control/prompts.ts)
  "finding_added", // the knowledge base (core/kb/records.ts)
  "kb_item", // the knowledge base (control/events/apply.ts)
  "model_call", // model use (core/usage.ts)
  "research_doc", // the knowledge base (core/kb/records.ts)
  "retention_removed", // what a policy removed on the rig (control/events/apply.ts)
  "source_fetched", // the knowledge base (core/kb/records.ts)
];

/** Neither: the timeline keeps the event as it came, and nothing in control reads it. */
const TIMELINE_ONLY = [
  "build_recorded",
  "champion_ref_failed",
  "contract_stored",
  "dev_run",
  "direction_status",
  "epoch_ended",
  "export_written",
  "fetch_refused",
  "fork_round",
  "harness_gap",
  "import_verified",
  "lane_best",
  "promotion_blocked",
  "research_files_saved",
  "rig_disk",
  "rig_drain",
  "run_end_exported",
  "submission_refused",
  "trial_stop_asked",
  "trial_stopped",
  "wipe_requested",
];

/**
 * Read by a handler or a sentence with no schema (core/events/schemas.ts), so what reads the
 * body takes it unchecked. `goal_checks` has a parser of its own.
 */
const READ_UNCHECKED = [
  "acceptance_set",
  "goal_checks",
  "goal_complete",
  "job_leased",
  "kit_set",
  "lane_limits_set",
  "research_paper_requested",
  "run_hours_added",
  "teachers_round_requested",
  "workers_reset",
];

const WORDS = join(import.meta.dirname, "..", "..", "..", "src", "control", "ui", "words");

/**
 * The kinds History has a sentence for: each `case` of the switch on an event's kind, in the
 * modules of control/ui/words/. They are read from the text, since a sentence is a branch of a
 * function and not an entry of a table.
 */
function saidKinds(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(WORDS)) {
    const text = readFileSync(join(WORDS, file), "utf8");
    const at = text.indexOf("switch (e.kind)");
    if (at < 0) continue;
    for (const m of text.slice(at).matchAll(/\bcase "([^"]+)":/g)) out.push(m[1] as string);
  }
  return out;
}

/** Whether a kind's body has a schema: a schema refuses a body that is a number. */
const hasSchema = (kind: string): boolean =>
  whyUnreadable({ kind, actor: "", body: 0 }) !== undefined;

const sorted = (kinds: Iterable<string>): string[] => [...kinds].sort();

describe("every kind of event, walked", () => {
  const all = new Set<string>(EVENT_KINDS);
  const folded = new Set(foldedKinds());
  const said = new Set(saidKinds());

  test("a handler and a sentence are for a kind that exists, and each kind is listed once", () => {
    assert.deepEqual(
      sorted(folded).filter((k) => !all.has(k)),
      [],
      "a handler of the fold for a kind core/events/kinds.ts does not list",
    );
    assert.deepEqual(
      sorted(said).filter((k) => !all.has(k)),
      [],
      "a sentence for a kind core/events/kinds.ts does not list",
    );
    assert.ok(said.size > 50, "the sentences were found in control/ui/words/");
    const listed = [...SENTENCE_ONLY, ...HANDLER_ONLY, ...READ_ELSEWHERE, ...TIMELINE_ONLY];
    assert.deepEqual(
      listed.filter((k, i) => listed.indexOf(k) !== i),
      [],
      "a kind on two lists",
    );
    assert.deepEqual(
      [...listed, ...READ_UNCHECKED].filter((k) => !all.has(k)),
      [],
      "a list names a kind that does not exist",
    );
  });

  test("each kind has a handler and a sentence, or is on the list that says what it lacks", () => {
    const lacks = (k: string) =>
      `${folded.has(k) ? "" : "handler"} ${said.has(k) ? "" : "sentence"}`;
    const now = (want: string) => sorted(EVENT_KINDS).filter((k) => lacks(k).trim() === want);
    const words =
      "Give the kind its handler (control/views/fold/) and its sentence (control/ui/words/), or put it on the list in this test that says what it has none of, on purpose. A kind that got what a list says it lacks comes off that list.";
    assert.deepEqual(now("handler"), sorted(SENTENCE_ONLY), `Sentence, no handler. ${words}`);
    assert.deepEqual(now("sentence"), sorted(HANDLER_ONLY), `Handler, no sentence. ${words}`);
    assert.deepEqual(
      now("handler sentence"),
      sorted([...READ_ELSEWHERE, ...TIMELINE_ONLY]),
      `Neither a handler nor a sentence. ${words}`,
    );
  });

  test("a kind that a handler or a sentence reads has a schema, or is listed as read unchecked", () => {
    assert.deepEqual(
      sorted(EVENT_KINDS).filter((k) => (folded.has(k) || said.has(k)) && !hasSchema(k)),
      sorted(READ_UNCHECKED),
      "Give the kind's body a schema in core/events/schemas.ts, or list it here as read unchecked. A kind that got its schema comes off the list.",
    );
  });
});
