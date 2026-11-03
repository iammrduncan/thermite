import type { Bus } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { canonicalJson } from "../../core/canonical.ts";
import type { SignedCommand } from "../../core/commands.ts";
import {
  COMMAND_QUEUE_MAX,
  COMMAND_STREAM,
  COMMAND_STREAM_CONFIG,
  commandMessageId,
  commandSubject,
} from "../../core/link/commands.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * Control's commands on the message bus (goal 168), the only way a command reaches its rig. Each
 * command control records for a rig is published to the rig's subject, where its supervisor takes
 * it at once. The store stays the record, and a command's status there the truth. A command the
 * bus did not take (the rig's queue is full, or the bus is away) stays pending in the store: control
 * holds it, shows it waiting on the rig's page and under Needs you, and publishes it again every
 * COMMANDS_AGAIN_MS, each rig's oldest first, until the bus takes it. On the same beat, a pending
 * command past its expiry is marked expired. As control starts, it
 * publishes every pending command again. A command the owner cancels is taken off the bus.
 */

/** What control needs of the bus for its commands. */
export type CommandBus = Pick<Bus, "makeStream" | "publish" | "remove">;

/**
 * How many commands may wait their turn to be published, as when the bus is slow to answer. Past
 * it, a command is held, and published again with the others held.
 */
export const COMMANDS_WAITING_MAX = 100;

/** How often control publishes again the commands the bus did not take. */
export const COMMANDS_AGAIN_MS = 10_000;

/** A command the bus did not take: since when, and why, in words. */
export interface HeldCommand {
  id: string;
  rig: string;
  kind: string;
  since: string;
  why: string;
}

/** A store's bus, the turns its commands take on it in the order they come, and those held. */
interface OnBus {
  bus: CommandBus;
  last: Promise<void>;
  waiting: number;
  /** The commands the bus did not take, by id, in the order they were held. */
  held: Map<string, HeldCommand>;
}

/** Each store whose commands go on a bus: control's own, once main.ts gives it one. */
const buses = new WeakMap<ControlStore, OnBus>();

/** Why the bus did not take a command, in words. */
function whyNot(err: unknown): string {
  const error = errorText(err);
  // The stream refuses a command past the rig's queue (discard_new_per_subject).
  if (/per subject/i.test(error))
    return `the rig's queue on the bus holds ${COMMAND_QUEUE_MAX} commands it has not taken`;
  return `the bus did not take it: ${error.slice(0, 300)}`;
}

/**
 * From now on, the commands this store records go on this bus. Makes the commands stream, trying
 * again until the bus has it: until then, commands are held. Then publishes each pending command
 * again, each rig's oldest first: the stream keeps one message for each command id it knows, so a
 * command it holds is not kept twice, and one it lost, as after a restore of the bus or a stream
 * made anew, reaches its rig. An expired one is marked expired, and not published. Then publishes
 * the commands held again every COMMANDS_AGAIN_MS, for as long as control runs.
 */
export async function sendCommandsOn(store: ControlStore, bus: CommandBus): Promise<void> {
  const on: OnBus = { bus, last: Promise.resolve(), waiting: 0, held: new Map() };
  buses.set(store, on);
  for (const rig of store.commands.rigsWithPending())
    for (const signed of store.commands.pending(rig))
      hold(on, signed, "the commands stream is being made");
  await bus.makeStream(COMMAND_STREAM_CONFIG);
  log("control", "commands go over the message bus", { stream: COMMAND_STREAM });
  const again = on.held.size;
  await publishHeld(store);
  if (again) log("control", "pending commands published on the bus again", { commands: again });
  setInterval(() => void publishHeld(store), COMMANDS_AGAIN_MS).unref();
}

/** Holds a command the bus did not take, or notes why again. */
function hold(on: OnBus, signed: SignedCommand, why: string): void {
  const e = signed.envelope;
  const was = on.held.get(e.id);
  on.held.set(e.id, {
    id: e.id,
    rig: e.rig,
    kind: e.kind,
    since: was?.since ?? new Date().toISOString(),
    why,
  });
}

/** Publishes one command in its turn; false when the bus did not take it, which holds it. */
function publishInTurn(on: OnBus, signed: SignedCommand): Promise<boolean> {
  const e = signed.envelope;
  const what = { id: e.id, rig: e.rig, kind: e.kind };
  return inTurn(on, async () => {
    try {
      const id = commandMessageId(signed);
      const ack = await on.bus.publish(commandSubject(e.rig), canonicalJson(signed), { id });
      on.held.delete(e.id);
      log("control", "command on the bus", { ...what, seq: ack.seq }, "debug");
      return true;
    } catch (err) {
      const why = whyNot(err);
      if (!on.held.has(e.id))
        log("control", "command held: the bus did not take it", { ...what, why }, "warn");
      hold(on, signed, why);
      return false;
    }
  });
}

/**
 * Publishes a command control has just recorded to its rig's subject. It returns at once: the
 * publish waits its turn, so a rig's commands reach the bus in the order they were issued. A
 * command the bus does not take is held, and published again later.
 */
export function publishCommand(store: ControlStore, signed: SignedCommand): void {
  const on = buses.get(store);
  if (!on) return;
  if (on.waiting >= COMMANDS_WAITING_MAX) {
    const e = signed.envelope;
    log(
      "control",
      "command held: too many wait their turn for the bus",
      { id: e.id, rig: e.rig },
      "warn",
    );
    hold(on, signed, `${COMMANDS_WAITING_MAX} commands wait their turn for the bus already`);
    return;
  }
  void publishInTurn(on, signed);
}

/**
 * Publishes the commands held again, each rig's oldest first; a rig's next waits until the bus
 * takes the one before it. Every rig's pending commands are looked at, so one past its expiry is
 * marked expired (the store marks it so here), held or not; a held command no longer pending
 * (cancelled, expired) is let go.
 */
export async function publishHeld(store: ControlStore): Promise<void> {
  const on = buses.get(store);
  if (!on) return;
  for (const rig of store.commands.rigsWithPending()) {
    const pending = store.commands.pending(rig);
    const ids = new Set(pending.map((c) => c.envelope.id));
    for (const h of on.held.values()) if (h.rig === rig && !ids.has(h.id)) on.held.delete(h.id);
    if (!on.held.size) continue;
    for (const signed of pending) {
      if (!on.held.has(signed.envelope.id)) continue;
      if (!(await publishInTurn(on, signed))) break;
    }
  }
}

/** The commands the bus did not take, oldest first: a rig's alone when given. */
export function heldCommands(store: ControlStore, rig?: string): HeldCommand[] {
  const held = [...(buses.get(store)?.held.values() ?? [])];
  return rig === undefined ? held : held.filter((h) => h.rig === rig);
}

/**
 * Takes a cancelled command off its rig's subject, after its publish if that still waits its
 * turn, so the rig's supervisor never delivers it. One its supervisor took already is not there.
 */
export function unpublishCommand(store: ControlStore, rig: string, id: string): void {
  const on = buses.get(store);
  if (!on) return;
  on.held.delete(id);
  void inTurn(on, async () => {
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
function inTurn<T>(on: OnBus, work: () => Promise<T>): Promise<T> {
  on.waiting++;
  const done = on.last.then(work).finally(() => {
    on.waiting--;
  });
  on.last = done.then(
    () => undefined,
    () => undefined,
  );
  return done;
}
