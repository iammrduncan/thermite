import assert from "node:assert/strict";
import { test } from "node:test";
import { type ConsoleTerminal, TrialConsole } from "../../../../src/agents/cli/index.ts";
import { TypingQueue } from "../../../../src/agents/cli/typing.ts";
import type { HarnessClient } from "../../../../src/common/api/harness.ts";
import { Refusal } from "../../../../src/common/errors.ts";
import {
  ADVISOR_INPUT_OUTCOMES,
  ADVISOR_INPUTS,
  ADVISOR_TERMINALS,
} from "../../../../src/core/api/harness/terminals.ts";
import { advisorCallId } from "../../../../src/core/terminal-input.ts";
import { AdvisorInputs } from "../../../../src/harness/service/advisor-inputs.ts";
import { AdvisorConsoles } from "../../../../src/supervisor/advisors/terminal/consoles.ts";
import { relayAdvisorTerminals } from "../../../../src/supervisor/advisors/terminal/relay.ts";

/**
 * The owner's input to an advisor's terminal, from the harness's queue (harness/service/
 * advisor-inputs.ts) through the supervisor's relay into the call's terminal (goal 241). The harness
 * answers an input as refused when the supervisor does not say in time what became of it; so the
 * supervisor types one only if it can start in time, and an input the harness answers as refused
 * never reaches the program. CI's run on v0.2.0's tag typed one input into the auditor twice: the
 * terminal was still typing the auditor's long first message, the harness answered the input as
 * refused after 30 seconds, the acceptance check sent it again, and both went in.
 */

/** The program's side of a terminal: its typing queue, held as by the loop's long first message. */
function heldTerminal() {
  const typing = new TypingQueue();
  const typed: string[] = [];
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  void typing.type(() => held);
  const term: ConsoleTerminal = {
    ownerInput: (i, startBy) => {
      const work = async () => {
        typed.push(String(i.text));
      };
      return startBy === undefined
        ? typing.type(work)
        : typing.typeBy(work, startBy, "still taking what went in before it");
    },
    limitShown: () => undefined,
    screen: async () => undefined,
    lastScreen: () => undefined,
  };
  return { term, typed, release };
}

/** The harness's queue and the supervisor's relay between them, in one process. */
function relayed(o: { unansweredMs: number; startWithinMs: number }) {
  const inputs = new AdvisorInputs({ untakenMs: 5_000, unansweredMs: o.unansweredMs });
  const harness = {
    call: async (route: unknown, input?: { query?: { wait?: number }; body?: unknown }) => {
      if (route === ADVISOR_INPUTS)
        return { inputs: await inputs.take((input?.query?.wait ?? 0) * 1000) };
      if (route === ADVISOR_INPUT_OUTCOMES) {
        const { outcomes } = ADVISOR_INPUT_OUTCOMES.body.parse(input?.body);
        return { taken: outcomes.filter((x) => inputs.outcome(x)).length };
      }
      if (route === ADVISOR_TERMINALS) return { ok: true };
      throw new Error("no such route");
    },
  } as unknown as HarnessClient;
  const consoles = new AdvisorConsoles();
  let stop = false;
  const relay = relayAdvisorTerminals({
    harness,
    consoles,
    stopping: () => stop,
    startWithinMs: o.startWithinMs,
    waitS: 1,
  });
  return {
    inputs,
    consoles,
    end: async () => {
      stop = true;
      await relay;
    },
  };
}

test("an input the terminal can't start in time is refused, and never typed after; sent again, it goes in once (goal 241)", async () => {
  const r = relayed({ unansweredMs: 1_000, startWithinMs: 300 });
  const t = heldTerminal();
  const call = advisorCallId("auditor", "js-1", 1);
  r.consoles.set({ id: call, run: "js-1", role: "auditor" }, new TrialConsole(t.term));
  const later = () => assert.fail("nothing waits for a reset");
  try {
    // While the terminal still types the call's first message, the input is refused.
    const first = await r.inputs
      .forward(call, { text: "OWNER-TYPED-AUDITOR", wait: "queue" }, later)
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    // The first message ends; the owner sends the input again, as the check does.
    t.release();
    assert.deepEqual(
      await r.inputs.forward(call, { text: "OWNER-TYPED-AUDITOR", wait: "queue" }, later),
      { outcome: "typed" },
    );
    await new Promise((res) => setTimeout(res, 200));
    // It went in once: the refused one never did. CI's run saw it twice.
    assert.deepEqual(t.typed, ["OWNER-TYPED-AUDITOR"]);
    // Refused by the supervisor in words, within the harness's wait: not the harness's
    // "did not say in time", after which the supervisor typed it all the same.
    assert.ok(first instanceof Refusal, String(first));
    assert.match(first.message, /still taking what went in before it/);
  } finally {
    t.release();
    await r.end();
  }
});

test("an input the terminal starts in time is answered typed, as soon as it is", async () => {
  const r = relayed({ unansweredMs: 5_000, startWithinMs: 3_000 });
  const t = heldTerminal();
  const call = advisorCallId("auditor", "js-1", 1);
  r.consoles.set({ id: call, run: "js-1", role: "auditor" }, new TrialConsole(t.term));
  const later = () => assert.fail("nothing waits for a reset");
  try {
    const typing = r.inputs.forward(call, { text: "ONE", wait: "queue" }, later);
    // The first message ends in time: the input goes in, and the harness hears so.
    setTimeout(() => t.release(), 200);
    assert.deepEqual(await typing, { outcome: "typed" });
    assert.deepEqual(t.typed, ["ONE"]);
  } finally {
    t.release();
    await r.end();
  }
});
