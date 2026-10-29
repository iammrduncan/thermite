import type { Bus, BusMessage, Handled } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { SignedCommand } from "../../core/commands.ts";
import { COMMAND_STREAM, commandConsumerName, readCommand } from "../../core/link/commands.ts";
import { SUPERVISOR_NUMBERS, supervisorMs } from "../settings.ts";
import { deliverCommand, type RelayConfig } from "./index.ts";

/**
 * A rig's commands from the message bus (goal 168, step 1). The supervisor takes each from its
 * rig's consumer as soon as control issues it, and delivers it as it delivers one from control's
 * pending list (deliverCommand): staged, to the harness, and the outcome acked to control. Only
 * then is the message acked. The poll over HTTP stays, slower, for a command the bus never had.
 */

/**
 * How often the supervisor asks control for its pending commands over HTTP when they come over
 * the bus: for a command that reached control's store but not the bus. It stays under the ten
 * minutes before a command's expiry in which control renews one whose sources still stage.
 */
export const COMMAND_FALLBACK_SECONDS = 180;

/**
 * How often the supervisor asks control for its pending commands over HTTP, in milliseconds:
 * THERMITE_COMMAND_POLL_SECONDS (read, so that a bad value stops the supervisor all the same), or
 * with the message bus COMMAND_FALLBACK_SECONDS.
 */
export function commandPollMs(env: Record<string, string | undefined>, onBus: boolean): number {
  const set = supervisorMs(env, SUPERVISOR_NUMBERS.commandPollSeconds);
  return onBus ? COMMAND_FALLBACK_SECONDS * 1000 : set;
}

/**
 * How soon the bus hands again a command that waits: its sources still stage, the harness is
 * applying it, or control did not take its outcome. The commands after it go on meanwhile.
 */
export const COMMAND_AGAIN_MS = 5_000;

/**
 * One message from the rig's consumer. A command delivered already, one past its expiry (control
 * marks it expired) and a message that is not this rig's command are acked and not delivered. A
 * command the poll over HTTP brought too is delivered in the newer form control gave it there.
 */
export async function takeCommand(cfg: RelayConfig, m: BusMessage): Promise<Handled> {
  let cmd: SignedCommand;
  try {
    cmd = readCommand(m.data);
  } catch (err) {
    const why = { seq: m.seq, error: errorText(err).slice(0, 300) };
    log("supervisor", "a message on the commands subject is not a command", why, "warn");
    return undefined;
  }
  const e = cmd.envelope;
  const what = { id: e.id, kind: e.kind, seq: m.seq };
  if (e.rig !== cfg.rig) {
    log("supervisor", "a command on the bus for another rig", { ...what, rig: e.rig }, "warn");
    return undefined;
  }
  if (cfg.delivered?.has(e.id)) {
    log("supervisor", "a command from the bus delivered already", what, "debug");
    return undefined;
  }
  const held = cfg.held?.get(e.id) ?? cmd;
  if (Date.parse(held.envelope.expires_at) < Date.now()) {
    log("supervisor", "a command from the bus expired before delivery", what, "warn");
    return undefined;
  }
  cfg.held?.set(e.id, held);
  if (await deliverCommand(cfg, held)) return undefined;
  log("supervisor", "a command from the bus waits", what, "debug");
  return { againInMs: COMMAND_AGAIN_MS };
}

/**
 * Takes the rig's commands from its consumer on the commands stream, which control makes, until
 * the bus is closed. A stream or a consumer not made yet is waited for.
 */
export async function followCommands(bus: Pick<Bus, "follow">, cfg: RelayConfig): Promise<void> {
  await bus.follow(COMMAND_STREAM, commandConsumerName(cfg.rig), (m) => takeCommand(cfg, m));
}
