import type { Bus, BusMessage, Handled } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { SignedCommand } from "../../core/commands.ts";
import {
  COMMAND_RENEW_BEFORE_MS,
  COMMAND_STREAM,
  commandConsumerName,
  readCommand,
} from "../../core/link/commands.ts";
import { AskRefused, ask } from "../ask.ts";
import { deliverCommand, type RelayConfig } from "./index.ts";

/**
 * A rig's commands from the message bus (goal 168, step 1), the only way they reach it. The
 * supervisor takes each from its rig's consumer as soon as control issues it, stages its content,
 * and delivers it to its harness (deliverCommand). Only once the harness has its outcome is the
 * message acked. A command whose sources still stage is asked to be signed again before it
 * expires, so a long download never expires its assignment.
 */

/**
 * How soon the bus hands again a command that waits: its sources still stage, the harness is
 * applying it, or control did not take its outcome. The commands after it go on meanwhile.
 */
export const COMMAND_AGAIN_MS = 5_000;

/**
 * One message from the rig's consumer. A command delivered already and a message that is not this
 * rig's command are acked and not delivered. A command control signed again while its sources
 * staged is delivered in that newer form. One past its expiry is asked of control again, which
 * holds the newest form (the supervisor may have restarted since): one control no longer holds
 * pending is acked and not delivered.
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
  let held = cfg.held?.get(e.id) ?? cmd;
  if (Date.parse(held.envelope.expires_at) < Date.now()) {
    const newer = await renewal(cfg, held);
    if (!newer || Date.parse(newer.envelope.expires_at) < Date.now()) {
      log("supervisor", "a command from the bus expired before delivery", what, "warn");
      cfg.held?.delete(e.id);
      return undefined;
    }
    held = newer;
  }
  cfg.held?.set(e.id, held);
  if (await deliverCommand(cfg, held)) return undefined;
  log("supervisor", "a command from the bus waits", what, "debug");
  // Sources that still stage, near the command's expiry: control signs it again with a later one.
  const due = Date.parse(held.envelope.expires_at) - Date.now() <= COMMAND_RENEW_BEFORE_MS;
  if (due && cfg.staging?.has(e.id)) {
    const newer = await renewal(cfg, held).catch((err: unknown) => {
      const why = { id: e.id, error: errorText(err).slice(0, 300) };
      log("supervisor", "a command whose sources stage was not signed again yet", why, "warn");
      return undefined;
    });
    if (newer) cfg.held?.set(e.id, newer);
  }
  return { againInMs: COMMAND_AGAIN_MS };
}

/**
 * Control's newest form of a pending command (core/link/asks.ts's `renew`): signed again with a
 * later expiry while its sources stage, at most for the longest hold; or as control holds it.
 * Undefined when control holds it pending no more. Throws when control gave no answer: the bus
 * hands the command again.
 */
async function renewal(cfg: RelayConfig, cmd: SignedCommand): Promise<SignedCommand | undefined> {
  const e = cmd.envelope;
  let answer: Awaited<ReturnType<typeof ask<"renew">>>;
  try {
    answer = await ask({ rig: cfg.rig, bus: cfg.bus }, "renew", { id: e.id });
  } catch (err) {
    if (!(err instanceof AskRefused)) throw err;
    log("supervisor", "control holds a command pending no more", { id: e.id, error: err.message });
    return undefined;
  }
  const newer = answer.command as unknown as SignedCommand;
  if (newer.envelope.id !== e.id)
    throw new Error(`control answered with another command: ${newer.envelope.id}`);
  if (newer.envelope.expires_at !== e.expires_at)
    log("supervisor", "a command was signed again with a later expiry", {
      id: e.id,
      expires_at: newer.envelope.expires_at,
    });
  return newer;
}

/**
 * Takes the rig's commands from its consumer on the commands stream, which control makes, until
 * the bus is closed. A stream or a consumer not made yet is waited for.
 */
export async function followCommands(bus: Pick<Bus, "follow">, cfg: RelayConfig): Promise<void> {
  await bus.follow(COMMAND_STREAM, commandConsumerName(cfg.rig), (m) => takeCommand(cfg, m));
}
