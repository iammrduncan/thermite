import type { Bus } from "../common/bus/index.ts";
import {
  RIG_ASK_TIMEOUT_MS,
  RIG_ASKS,
  type RigAskAnswer,
  type RigAskBody,
  type RigAskKind,
  RigAskRefusal,
  rigAskSubject,
} from "../core/link/asks.ts";

/**
 * The supervisor's asks of control on the message bus (core/link/asks.ts): a request on the rig's
 * own subject, and control's one answer. Every call between a rig and control but the registration
 * of its keys and the large files goes on the bus.
 */

/** Where the supervisor asks: its rig, and the bus it signs in to with the rig's key. */
export interface ControlOnBus {
  rig: string;
  bus: Pick<Bus, "request">;
}

/** Control's refusal of an ask, in its words, with its code when it gave one. */
export class AskRefused extends Error {
  readonly code: string | undefined;

  constructor(kind: RigAskKind, refusal: RigAskRefusal) {
    super(`control refused the rig's ${kind}: ${refusal.refused}`);
    this.code = refusal.code;
  }
}

/**
 * Asks control on the bus and reads its answer. Throws AskRefused when control refuses, and an
 * error in words when no answer came (no one serves the subject, the timeout, the bus away) or the
 * answer is not one this build reads.
 */
export async function ask<K extends RigAskKind>(
  c: ControlOnBus,
  kind: K,
  body: RigAskBody<K>,
): Promise<RigAskAnswer<K>> {
  const data = await c.bus.request(
    rigAskSubject(c.rig, kind),
    JSON.stringify(body),
    RIG_ASK_TIMEOUT_MS,
  );
  const raw: unknown = JSON.parse(Buffer.from(data).toString("utf8"));
  const refusal = RigAskRefusal.safeParse(raw);
  if (refusal.success) throw new AskRefused(kind, refusal.data);
  return RIG_ASKS[kind].answer.parse(raw) as RigAskAnswer<K>;
}
