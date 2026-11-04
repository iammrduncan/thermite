import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HarnessClient } from "../../common/api/harness.ts";
import type { Bus } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { type QueuedRun, RUN_ANSWER, RUN_ASKS } from "../../core/api/harness/runs.ts";
import {
  RUNNER_ASK_TIMEOUT_MS,
  RUNNER_PART_CHARS,
  RUNNER_PART_TIMEOUT_MS,
  type RunnerReply,
  type RunnerRequest,
  runnerSubject,
} from "../../core/link/runners.ts";

/**
 * The core's supervisor carries its harness's asks of its runners (goal 206): it takes them
 * from the harness (RUN_ASKS), sends each on the bus to the runner's supervisor
 * (core/link/runners.ts), and gives the harness the answer (RUN_ANSWER). A git bundle waits
 * in the outbox; it goes in parts and its file is removed after. Asks are carried side by side,
 * each as it comes.
 */

/** How long one take waits at the harness for an ask, in milliseconds. */
const TAKE_WAIT_MS = 20_000;
/** How long the asks may fail before the supervisor warns: its harness may still be starting. */
const QUIET_FAILING_MS = 60_000;

interface Carrier {
  rig: string;
  bus: Pick<Bus, "request">;
  harness: Pick<HarnessClient, "call">;
  outboxDir: string;
  stopping: () => boolean;
  /** Each round, for the health route's loop. */
  tick?: (() => void) | undefined;
}

/** Sends one request to a runner's supervisor and reads its reply. */
async function send(c: Carrier, runner: string, r: RunnerRequest, timeoutMs: number) {
  const data = await c.bus.request(runnerSubject(c.rig, runner), JSON.stringify(r), timeoutMs);
  return JSON.parse(Buffer.from(data).toString("utf8")) as RunnerReply;
}

/** The runner's answer from its reply, its parts fetched one by one when it came in parts. */
async function answerOf(c: Carrier, runner: string, first: RunnerReply): Promise<unknown> {
  let reply = first;
  if (first.more) {
    let text = first.data ?? "";
    for (let part = 1; part < first.more.parts; part++) {
      const r = await send(
        c,
        runner,
        { kind: "more", id: first.more.id, part },
        RUNNER_PART_TIMEOUT_MS,
      );
      text += r.data ?? "";
    }
    reply = JSON.parse(text) as RunnerReply;
  }
  if (reply.error !== undefined) throw new Error(reply.error);
  return reply.answer;
}

/** An ask to the runner, in parts when it is too long for one message; its answer. */
async function sendAsk(c: Carrier, a: Extract<QueuedRun, { kind: "ask" }>): Promise<unknown> {
  const whole: RunnerRequest = { kind: "ask", ask: a.ask };
  const text = JSON.stringify(a.ask);
  if (text.length + 32 <= RUNNER_PART_CHARS)
    return answerOf(c, a.runner, await send(c, a.runner, whole, RUNNER_ASK_TIMEOUT_MS));
  const parts = Math.ceil(text.length / RUNNER_PART_CHARS);
  let last: RunnerReply = {};
  for (let part = 0; part < parts; part++) {
    const data = text.slice(part * RUNNER_PART_CHARS, (part + 1) * RUNNER_PART_CHARS);
    last = await send(
      c,
      a.runner,
      { kind: "ask_part", id: a.id, part, parts, data },
      part === parts - 1 ? RUNNER_ASK_TIMEOUT_MS : RUNNER_PART_TIMEOUT_MS,
    );
    if (last.error !== undefined) throw new Error(last.error);
  }
  return answerOf(c, a.runner, last);
}

/** A git bundle from the outbox to the runner, in parts; its last part's answer. */
async function sendBundle(c: Carrier, a: Extract<QueuedRun, { kind: "git" }>): Promise<unknown> {
  const data = readFileSync(join(c.outboxDir, a.file)).toString("base64");
  const parts = Math.max(1, Math.ceil(data.length / RUNNER_PART_CHARS));
  let last: RunnerReply = {};
  for (let part = 0; part < parts; part++) {
    const chunk = data.slice(part * RUNNER_PART_CHARS, (part + 1) * RUNNER_PART_CHARS);
    const request = { kind: "git" as const, id: a.id, repo: a.repo, commit: a.commit, part, parts };
    last = await send(
      c,
      a.runner,
      { ...request, data: chunk },
      part === parts - 1 ? RUNNER_ASK_TIMEOUT_MS : RUNNER_PART_TIMEOUT_MS,
    );
    if (last.error !== undefined) throw new Error(last.error);
  }
  return answerOf(c, a.runner, last);
}

/** One ask carried, and its answer, or why there is none, given to the harness. */
async function carryOne(c: Carrier, a: QueuedRun): Promise<void> {
  let body: { answer?: unknown; error?: string };
  try {
    body = {
      answer:
        a.kind === "ask"
          ? await sendAsk(c, a)
          : a.kind === "models"
            ? await answerOf(
                c,
                a.runner,
                await send(
                  c,
                  a.runner,
                  { kind: "models", models: a.models },
                  RUNNER_ASK_TIMEOUT_MS,
                ),
              )
            : await sendBundle(c, a),
    };
  } catch (err) {
    body = { error: errorText(err).slice(0, 4000) };
  } finally {
    if (a.kind === "git") rmSync(join(c.outboxDir, a.file), { force: true });
  }
  await c.harness.call(RUN_ANSWER, { params: { id: a.id }, body }).catch((err: unknown) =>
    log("supervisor", "a runner's answer did not reach the harness", {
      runner: a.runner,
      error: errorText(err),
    }),
  );
}

/** Takes the harness's asks of its runners and carries each, until the supervisor stops. */
export async function carryRunnerAsks(c: Carrier): Promise<void> {
  // Since when the harness's asks have failed, and whether that was said: a harness that starts
  // a few seconds after its supervisor is no reason to warn.
  let failingSince: number | undefined;
  let said = false;
  while (!c.stopping()) {
    c.tick?.();
    const began = Date.now();
    let asks: QueuedRun[];
    try {
      asks = (
        await c.harness.call(RUN_ASKS, {
          query: { wait: TAKE_WAIT_MS },
          timeoutMs: TAKE_WAIT_MS + 30_000,
        })
      ).asks as QueuedRun[];
      failingSince = undefined;
      said = false;
    } catch (err) {
      failingSince ??= Date.now();
      if (!said && Date.now() - failingSince >= QUIET_FAILING_MS) {
        log("supervisor", "the runners' asks are not reachable", { error: errorText(err) }, "warn");
        said = true;
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const a of asks) void carryOne(c, a);
    // A take answered empty at once (a harness that doesn't wait) waits a second here instead.
    const quick = 1000 - (Date.now() - began);
    if (!asks.length && quick > 0) await new Promise((r) => setTimeout(r, quick));
  }
}
