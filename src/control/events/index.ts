/**
 * Control's events on the message bus (goal 168, step 4): the `EVENTS` stream is control's one
 * copy of its rigs' events. The writer publishes each report's events there first, and waits for
 * the apply (writer.ts); the apply of the stream writes what control derives from the events and
 * hands them to control's views (apply.ts); a store from before holds its events in a table,
 * moved to the stream once, checked there and dropped (move.ts); the knowledge base reads the
 * stream again after an upgrade, and takes each writer's item after its checks (knowledge.ts).
 * Events become messages, in batches, in batch.ts.
 */

export { APPLY_PAGE, applyState, EventsApply, type EventsApplyOptions } from "./apply.ts";
export { BATCH_BYTES, notForBus } from "./batch.ts";
export { readKnowledgeAgain } from "./knowledge.ts";
export {
  EventsMove,
  type EventsMoveOptions,
  MOVE_CHECK_SAMPLE,
  type MoveStopped,
  movedEnd,
} from "./move.ts";
export {
  APPLY_WAIT_MS,
  EventsWriter,
  type EventsWriterOptions,
  WRITER_WAITING_MAX,
  type Written,
  writerOf,
  writerState,
} from "./writer.ts";
