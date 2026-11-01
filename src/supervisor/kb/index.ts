/**
 * The supervisor's part of the knowledge base on control (goal 175): the items' files, from the
 * rig's outbox onto the message bus, and out of the outbox once control holds them (files.ts); and
 * the agents' searches and reads, taken from the harness and asked of control (asks.ts).
 */
export { askControl, KB_ASKS_WAIT_S, type KbControl, relayKbAsks } from "./asks.ts";
export {
  KB_FILES_PER_ROUND,
  KB_FILES_PUT,
  type KbFilesPut,
  putKbFiles,
  removeHeldKbFiles,
} from "./files.ts";
