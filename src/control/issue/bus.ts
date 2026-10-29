import type { Bus } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { canonicalJson } from "../../core/canonical.ts";
import type { SignedCommand } from "../../core/commands.ts";
import {
  COMMAND_STREAM,
  COMMAND_STREAM_CONFIG,
  commandMessageId,
  commandSubject,
} from "../../core/link/commands.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * Control's commands on the message bus (goal 168, step 1). With the bus on, each command control
 * records for a rig is published to the rig's subject too, where its supervisor takes it at once.
 * The store stays the record, and a command's status there the truth: a command the bus did not
 * take stays pending in the store, where the supervisor's poll over HTTP finds it and control
 * publishes it again as it starts, and a command the owner cancels is taken off the bus.
 */

/** What control needs of the bus for its commands. */
export type CommandBus = Pick<Bus, "makeStream" | "publish" | "remove">;

/**
 * How many commands may wait their turn to be published, as when the bus is slow to answer. Past
 * it, a command stays off the bus, pending in the store, and its rig's poll over HTTP fetches it.
 */
export const COMMANDS_WAITING_MAX = 100;

/** A store's bus, and the turns its commands take on it, in the order they come. */
interface OnBus {
  bus: CommandBus;
  last: Promise<void>;
  waiting: number;
}

/** Each store whose commands go on a bus too: control's own, once main.ts gives it one. */
const buses = new WeakMap<ControlStore, OnBus>();

/**
 * From now on, the commands this store records also go on this bus. Makes the commands stream,
 * trying again until the bus has it: until then, publishes fail and commands go over HTTP. Then
 * publishes each pending command again, each rig's oldest first: the stream keeps one message for
 * each command id it knows, so a command it holds is not kept twice, and one it lost, as after a
 * restore of the bus or a stream made anew, reaches its rig without waiting for the poll over HTTP.
 * An expired one is marked expired, as the poll marks it, and not published.
 */
export async function sendCommandsOn(store: ControlStore, bus: CommandBus): Promise<void> {
  buses.set(store, { bus, last: Promise.resolve(), waiting: 0 });
  await bus.makeStream(COMMAND_STREAM_CONFIG);
  log("control", "commands go over the message bus too", { stream: COMMAND_STREAM });
  let again = 0;
  for (const rig of store.commands.rigsWithPending())
    for (const signed of store.commands.pending(rig)) {
      publishCommand(store, signed);
      again++;
    }
  if (again) log("control", "pending commands published on the bus again", { commands: again });
}

/**
 * Publishes a command control has just recorded to its rig's subject, when the store's commands go
 * on a bus. It returns at once: the publish waits its turn, so a rig's commands reach the bus in
 * the order they were issued. A publish that fails is logged, and the command stays pending.
 */
export function publishCommand(store: ControlStore, signed: SignedCommand): void {
  const on = buses.get(store);
  if (!on) return;
  const e = signed.envelope;
  const what = { id: e.id, rig: e.rig, kind: e.kind };
  if (on.waiting >= COMMANDS_WAITING_MAX) {
    log("control", "too many commands wait for the bus; this one goes over HTTP", what, "warn");
    return;
  }
  inTurn(on, async () => {
    try {
      const id = commandMessageId(signed);
      const ack = await on.bus.publish(commandSubject(e.rig), canonicalJson(signed), { id });
      log("control", "command on the bus", { ...what, seq: ack.seq }, "debug");
    } catch (err) {
      const why = { ...what, error: errorText(err) };
      log("control", "command not on the bus; its rig's poll fetches it", why, "warn");
    }
  });
}

/**
 * Takes a cancelled command off its rig's subject, after its publish if that still waits its
 * turn, so the rig's supervisor never delivers it. One its supervisor took already is not there.
 */
export function unpublishCommand(store: ControlStore, rig: string, id: string): void {
  const on = buses.get(store);
  if (!on) return;
  inTurn(on, async () => {
    try {
      const removed = await on.bus.remove(COMMAND_STREAM, commandSubject(rig), id);
      const said = removed ? "cancelled command taken off the bus" : "cancelled command not on it";
      log("control", said, { id, rig });
    } catch (err) {
      const error = errorText(err);
      log("control", "cancelled command left on the bus", { id, rig, error }, "error");
    }
  });
}

/** Runs `work` after the work asked for before it on this bus. */
function inTurn(on: OnBus, work: () => Promise<void>): void {
  on.waiting++;
  on.last = on.last.then(work).finally(() => {
    on.waiting--;
  });
}
