/**
 * The harness's part of the knowledge base on control (goal 175): a write of one item's version,
 * recorded signed in the run's ledger (write.ts), with its file kept in the outbox for the
 * supervisor to put on the message bus.
 */
export { type KbWrite, type KbWritten, writeKbItem } from "./write.ts";
