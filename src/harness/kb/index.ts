/**
 * The harness's part of the knowledge base on control (goal 175): a write of one item's version,
 * recorded signed in the run's ledger (write.ts), with its file kept in the outbox for the
 * supervisor to put on the message bus; the agents' tools, kb_search, kb_read and kb_write
 * (tools.ts); and the channel the supervisor holds open for their searches and reads (asks.ts).
 */
export { ASK_UNANSWERED_MS, ASK_UNTAKEN_MS, type KbAskOut, KbAsks, TAKE_MAX } from "./asks.ts";
export { type KbCaller, KbTools } from "./tools.ts";
export { type KbWrite, type KbWritten, writeKbItem } from "./write.ts";
