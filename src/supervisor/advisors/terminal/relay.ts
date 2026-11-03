import type { HarnessClient } from "../../../common/api/harness.ts";
import { log } from "../../../common/env.ts";
import { errorText } from "../../../common/errors.ts";
import {
  ADVISOR_INPUT_OUTCOMES,
  ADVISOR_INPUTS,
  ADVISOR_TERMINALS,
  type AdvisorOutcome,
} from "../../../core/api/harness/terminals.ts";
import type { AdvisorConsoles } from "./consoles.ts";

/**
 * The supervisor's side of its advisors' terminals with its harness (goal 169;
 * core/api/harness/terminals.ts). It says which calls run in their terminals when one starts or
 * ends, and again every SAY_AGAIN_MS, since a harness that restarted forgets them. It holds a call
 * open to the harness for the owner's inputs the harness checked and recorded (the harness never
 * calls out), types each into its call's terminal, and says what became of it: at once, and again
 * later for one queued for the reset of the program's usage window.
 */

/** How long the supervisor holds its call for the owner's inputs open, in seconds. */
export const INPUTS_WAIT_S = 25;
/** How often the calls in their terminals are said again, unchanged. */
const SAY_AGAIN_MS = 60_000;
/** How long it waits after a failed call to its harness before it calls again. */
const AGAIN_MS = 5_000;
/** The most characters of why an input was refused or dropped, as the harness takes it. */
const WHY_MAX = 1000;

/** Takes the owner's inputs for the advisors' terminals until `stopping`; says which calls run. */
export async function relayAdvisorTerminals(o: {
  harness: HarnessClient;
  consoles: AdvisorConsoles;
  stopping: () => boolean;
}): Promise<void> {
  let saying = Promise.resolve();
  let sayFailing = false;
  const say = () => {
    saying = saying.then(async () => {
      try {
        await o.harness.call(ADVISOR_TERMINALS, { body: { calls: o.consoles.calls() } });
        sayFailing = false;
      } catch (err) {
        if (!sayFailing)
          log(
            "supervisor",
            "the harness did not take which advisors run in their terminals: said again at the next change, or within a minute",
            { error: errorText(err) },
            "warn",
          );
        sayFailing = true;
      }
    });
  };
  o.consoles.onChange(say);
  say();
  const again = setInterval(say, SAY_AGAIN_MS);
  again.unref();
  const tell = async (outcomes: AdvisorOutcome[]) => {
    try {
      await o.harness.call(ADVISOR_INPUT_OUTCOMES, { body: { outcomes } });
    } catch (err) {
      log(
        "supervisor",
        "what became of the owner's input to an advisor's terminal did not reach the harness",
        { inputs: outcomes.map((x) => x.id), error: errorText(err) },
        "warn",
      );
    }
  };
  /** One input into its call's terminal: what became of it now; `later` hears of a queued one. */
  const typeIn = async (i: { id: string } & Parameters<AdvisorConsoles["input"]>[0]) => {
    try {
      const now = await o.consoles.input(i, (outcome, why) => {
        void tell([{ id: i.id, outcome, ...(why ? { why: why.slice(0, WHY_MAX) } : {}) }]);
      });
      return now.outcome === "queued"
        ? { id: i.id, outcome: "queued" as const, ...(now.until ? { until: now.until } : {}) }
        : { id: i.id, outcome: "typed" as const };
    } catch (err) {
      return { id: i.id, outcome: "refused" as const, why: errorText(err).slice(0, WHY_MAX) };
    }
  };
  let failing = false;
  try {
    while (!o.stopping()) {
      try {
        const { inputs } = await o.harness.call(ADVISOR_INPUTS, { query: { wait: INPUTS_WAIT_S } });
        failing = false;
        if (!inputs.length) continue;
        // One at a time, in order: two inputs to one terminal go in as they were given.
        const outcomes: AdvisorOutcome[] = [];
        for (const i of inputs) outcomes.push(await typeIn(i));
        await tell(outcomes);
      } catch (err) {
        if (!failing)
          log(
            "supervisor",
            "the owner's inputs to the advisors' terminals could not be taken from the harness",
            { error: errorText(err) },
            "error",
          );
        failing = true;
        const until = Date.now() + AGAIN_MS;
        while (!o.stopping() && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
      }
    }
  } finally {
    clearInterval(again);
  }
}
