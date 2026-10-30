import type { HarnessClient } from "../../common/api/harness.ts";
import type { Bus } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { KB_ANSWERS, KB_ASKS } from "../../core/api/harness/supervisor.ts";
import {
  KB_ASK_TIMEOUT_MS,
  type KbAskAnswer,
  KbAskAnswer as KbAskAnswerSchema,
  type KbAskKind,
  type KbReadAsk,
  type KbSearchAsk,
  kbAskSubject,
} from "../../core/link/kb.ts";

/**
 * The supervisor's part in the agents' searches and reads of the knowledge base (goal 175): it
 * holds a call open to its harness for the asks that wait there (the harness never calls out),
 * asks control for each on the message bus, as a request on the rig's own subject, and hands each
 * answer back. The advisors, whose calls the supervisor runs, ask control the same way
 * (askControl). When control can't be reached, the answer says so in words, and the agent goes on.
 */

/** How long the supervisor holds its call for the harness's asks open, in seconds. */
export const KB_ASKS_WAIT_S = 25;
/** How long it waits after a failed call to its harness before it calls again. */
const AGAIN_MS = 5_000;

/** Where the supervisor asks control: its rig's subjects on the bus. */
export interface KbControl {
  rig: string;
  bus: Pick<Bus, "request">;
}

/** Control could not be reached: the words the agent gets. */
const away = (how: string, err: unknown): KbAskAnswer => ({
  refused: `control can't be reached ${how} now (${errorText(err).slice(0, 200)}): the knowledge base can't be searched or read. Go on without it, and try again later`,
});

/** One ask of control for one of the rig's runs: control's answer, or why none came, in words. */
export async function askControl(
  c: KbControl,
  kind: KbAskKind,
  ask: KbSearchAsk | KbReadAsk,
): Promise<KbAskAnswer> {
  try {
    const data = await c.bus.request(
      kbAskSubject(kind, c.rig),
      JSON.stringify(ask),
      KB_ASK_TIMEOUT_MS,
    );
    return KbAskAnswerSchema.parse(JSON.parse(Buffer.from(data).toString("utf8")));
  } catch (err) {
    log(
      "supervisor",
      "a knowledge base ask got no answer on the bus",
      { run: ask.run, kind, error: errorText(err) },
      "warn",
    );
    return away("on the message bus", err);
  }
}

/**
 * Takes the harness's asks as they come, asks control for each (those taken together at once),
 * and hands the answers back, until `stopping`. A failed call to the harness is logged once, and
 * made again after a pause; an ask whose answer never reaches the harness ends there in words.
 */
export async function relayKbAsks(o: {
  harness: HarnessClient;
  control: KbControl;
  stopping: () => boolean;
}): Promise<void> {
  let failing = false;
  while (!o.stopping()) {
    try {
      const { asks } = await o.harness.call(KB_ASKS, { query: { wait: KB_ASKS_WAIT_S } });
      failing = false;
      if (!asks.length) continue;
      const answers = await Promise.all(
        asks.map(async (a) => ({ id: a.id, answer: await askControl(o.control, a.kind, a.ask) })),
      );
      await o.harness.call(KB_ANSWERS, { body: { answers } });
    } catch (err) {
      if (!failing)
        log(
          "supervisor",
          "the knowledge base's asks could not be relayed",
          { error: errorText(err) },
          "error",
        );
      failing = true;
      const until = Date.now() + AGAIN_MS;
      while (!o.stopping() && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    }
  }
}
