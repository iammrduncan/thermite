import assert from "node:assert/strict";
import { PiConsole, PiView, ViewInputs } from "../../src/agents/pi-view/index.ts";
import { messageText, type Prompt } from "../../src/agents/prompt.ts";
import type { FakeModel } from "./fake-model.ts";

/**
 * The owner's words and an owner's message that wait together for a role's call in Pi in its Pi
 * view (goal 169): the call's first reply is held while the owner types into its view and writes
 * to its role, and the message waits, as the harness keeps it, until the call posts it as read.
 * Pi's agent puts one waiting turn into each model call unless it is told to take all of them; a
 * test checks that the one model call after the held reply holds both.
 */

/** How long a call's first reply is held: the owner types and writes within it. */
export const HOLD_MS = 1000;
export const TYPED = "TYPED-WORDS: keep the result the same";
export const MESSAGE = { id: 7, text: "MESSAGE-SEVEN: look at the inner loop first" };

/** A turn's text as the model call's request holds it, in its JSON. */
const inRequest = (text: string) => JSON.stringify(text).slice(1, -1);

export function ownerWaits(model: FakeModel) {
  const piConsole = new PiConsole();
  const view = new PiView({ out: () => undefined, cols: 100, rows: 30, heading: "a role in Pi" });
  const inputs = new ViewInputs({
    view,
    ask: (ms) => piConsole.next(ms),
    answer: async (id, outcome, why) => piConsole.done(id, outcome, why),
    servers: [],
    relist: async () => ({ tools: [], call: async () => ({ content: [] }) }),
  });
  let waiting: { id: number; text: string }[] = [];
  const reads: number[][] = [];
  const kept: Prompt[] = [];
  return {
    /** The call's Pi view's console. */
    inputs,
    /** The session's link: the owner's messages that wait, and their read receipts. */
    link: {
      messages: async () => waiting,
      read: async (ids: number[]) => {
        reads.push(ids);
        waiting = waiting.filter((m) => !ids.includes(m.id));
      },
    },
    /** Keeps each later turn of the call as it enters its conversation. */
    keep: (p: Prompt) => {
      kept.push(p);
    },
    /** Once the call's first reply is held: the owner types, then writes, before it ends. */
    async typeAndWrite(): Promise<void> {
      for (let i = 0; i < 500 && model.requests < 1; i++)
        await new Promise((r) => setTimeout(r, 10));
      await piConsole.ownerInput({ text: TYPED });
      waiting = [MESSAGE];
      assert.equal(model.requests, 1, "the owner typed and wrote while its first reply was held");
    },
    /**
     * The model call after the held reply (`next`, its request's messages as JSON) holds the
     * owner's words and the message, each as the turn the role puts it in (`turns`), numbered in
     * that order; and the message was posted as read, once.
     */
    heldBoth(next: string | undefined, turns: { typed: string; message: string }): void {
      assert.ok(
        next?.includes(inRequest(turns.typed)) && next.includes(inRequest(turns.message)),
        `the model call after the held reply holds the owner's words and the message: ${next?.slice(-800)}`,
      );
      assert.deepEqual(
        kept.map((p) => [p.turn, messageText(p)]),
        [
          [1, turns.typed],
          [2, turns.message],
        ],
        "each went in as a turn of its own, the message numbered after the owner's words",
      );
      assert.deepEqual(reads, [[MESSAGE.id]], "the message was posted as read, once");
    },
    async close(): Promise<void> {
      inputs.close();
      await piConsole.end();
      view.stop();
    },
  };
}
