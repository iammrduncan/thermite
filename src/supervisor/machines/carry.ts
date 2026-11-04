import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HarnessClient } from "../../common/api/harness.ts";
import type { Bus } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { DEVICE_ANSWER, DEVICE_ASKS, type QueuedAsk } from "../../core/api/harness/device.ts";
import {
  MACHINE_ASK_TIMEOUT_MS,
  MACHINE_PART_CHARS,
  MACHINE_PART_TIMEOUT_MS,
  type MachineReply,
  type MachineRequest,
  machineSubject,
} from "../../core/link/machines.ts";

/**
 * The leader's supervisor carries its harness's asks of its followers (goal 205): it takes them
 * from the harness (DEVICE_ASKS), sends each on the bus to the follower's supervisor
 * (core/link/machines.ts), and gives the harness the answer (DEVICE_ANSWER). A git bundle waits
 * in the outbox; it goes in parts and its file is removed after. Asks are carried side by side,
 * each as it comes.
 */

/** How long one take waits at the harness for an ask, in milliseconds. */
const TAKE_WAIT_MS = 20_000;

interface Carrier {
  rig: string;
  bus: Pick<Bus, "request">;
  harness: Pick<HarnessClient, "call">;
  outboxDir: string;
  stopping: () => boolean;
  /** Each round, for the health route's loop. */
  tick?: (() => void) | undefined;
}

/** Sends one request to a follower's supervisor and reads its reply. */
async function send(c: Carrier, machine: string, r: MachineRequest, timeoutMs: number) {
  const data = await c.bus.request(machineSubject(c.rig, machine), JSON.stringify(r), timeoutMs);
  return JSON.parse(Buffer.from(data).toString("utf8")) as MachineReply;
}

/** The follower's answer from its reply, its parts fetched one by one when it came in parts. */
async function answerOf(c: Carrier, machine: string, first: MachineReply): Promise<unknown> {
  let reply = first;
  if (first.more) {
    let text = first.data ?? "";
    for (let part = 1; part < first.more.parts; part++) {
      const r = await send(
        c,
        machine,
        { kind: "more", id: first.more.id, part },
        MACHINE_PART_TIMEOUT_MS,
      );
      text += r.data ?? "";
    }
    reply = JSON.parse(text) as MachineReply;
  }
  if (reply.error !== undefined) throw new Error(reply.error);
  return reply.answer;
}

/** An ask to the follower, in parts when it is too long for one message; its answer. */
async function sendAsk(c: Carrier, a: Extract<QueuedAsk, { kind: "ask" }>): Promise<unknown> {
  const whole: MachineRequest = { kind: "ask", ask: a.ask };
  const text = JSON.stringify(a.ask);
  if (text.length + 32 <= MACHINE_PART_CHARS)
    return answerOf(c, a.machine, await send(c, a.machine, whole, MACHINE_ASK_TIMEOUT_MS));
  const parts = Math.ceil(text.length / MACHINE_PART_CHARS);
  let last: MachineReply = {};
  for (let part = 0; part < parts; part++) {
    const data = text.slice(part * MACHINE_PART_CHARS, (part + 1) * MACHINE_PART_CHARS);
    last = await send(
      c,
      a.machine,
      { kind: "ask_part", id: a.id, part, parts, data },
      part === parts - 1 ? MACHINE_ASK_TIMEOUT_MS : MACHINE_PART_TIMEOUT_MS,
    );
    if (last.error !== undefined) throw new Error(last.error);
  }
  return answerOf(c, a.machine, last);
}

/** A git bundle from the outbox to the follower, in parts; its last part's answer. */
async function sendBundle(c: Carrier, a: Extract<QueuedAsk, { kind: "git" }>): Promise<unknown> {
  const data = readFileSync(join(c.outboxDir, a.file)).toString("base64");
  const parts = Math.max(1, Math.ceil(data.length / MACHINE_PART_CHARS));
  let last: MachineReply = {};
  for (let part = 0; part < parts; part++) {
    const chunk = data.slice(part * MACHINE_PART_CHARS, (part + 1) * MACHINE_PART_CHARS);
    const request = { kind: "git" as const, id: a.id, repo: a.repo, commit: a.commit, part, parts };
    last = await send(
      c,
      a.machine,
      { ...request, data: chunk },
      part === parts - 1 ? MACHINE_ASK_TIMEOUT_MS : MACHINE_PART_TIMEOUT_MS,
    );
    if (last.error !== undefined) throw new Error(last.error);
  }
  return answerOf(c, a.machine, last);
}

/** One ask carried, and its answer, or why there is none, given to the harness. */
async function carryOne(c: Carrier, a: QueuedAsk): Promise<void> {
  let body: { answer?: unknown; error?: string };
  try {
    body = {
      answer:
        a.kind === "ask"
          ? await sendAsk(c, a)
          : a.kind === "models"
            ? await answerOf(
                c,
                a.machine,
                await send(
                  c,
                  a.machine,
                  { kind: "models", models: a.models },
                  MACHINE_ASK_TIMEOUT_MS,
                ),
              )
            : await sendBundle(c, a),
    };
  } catch (err) {
    body = { error: errorText(err).slice(0, 4000) };
  } finally {
    if (a.kind === "git") rmSync(join(c.outboxDir, a.file), { force: true });
  }
  await c.harness.call(DEVICE_ANSWER, { params: { id: a.id }, body }).catch((err: unknown) =>
    log("supervisor", "a follower's answer did not reach the harness", {
      machine: a.machine,
      error: errorText(err),
    }),
  );
}

/** Takes the harness's asks of its followers and carries each, until the supervisor stops. */
export async function carryFollowerAsks(c: Carrier): Promise<void> {
  let failing = false;
  while (!c.stopping()) {
    c.tick?.();
    const began = Date.now();
    let asks: QueuedAsk[];
    try {
      asks = (
        await c.harness.call(DEVICE_ASKS, {
          query: { wait: TAKE_WAIT_MS },
          timeoutMs: TAKE_WAIT_MS + 30_000,
        })
      ).asks as QueuedAsk[];
      failing = false;
    } catch (err) {
      if (!failing)
        log(
          "supervisor",
          "the followers' asks are not reachable",
          { error: errorText(err) },
          "warn",
        );
      failing = true;
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const a of asks) void carryOne(c, a);
    // A take answered empty at once (a harness that doesn't wait) waits a second here instead.
    const quick = 1000 - (Date.now() - began);
    if (!asks.length && quick > 0) await new Promise((r) => setTimeout(r, quick));
  }
}
