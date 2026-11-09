import { z } from "zod";
import { Commit, MirrorName, ModelFetch, ModelPoll, RunAsk } from "../api/harness/runs.ts";
import { RIG_ID } from "../ids.ts";

/**
 * A rig's core and its runners on the message bus (goal 206). The core's supervisor carries its
 * harness's asks of a runner process (core/api/harness/runs.ts) as requests on the runner's own
 * subject, and the runner's supervisor answers each from its harness. No stream keeps them. A
 * message holds at most RUNNER_PART_CHARS characters: a git bundle or a long ask goes in parts,
 * and an answer longer than that comes in parts the core asks for one by one.
 */

/** The most characters of one part: base64 of 3 MiB, well under the server's largest message. */
export const RUNNER_PART_CHARS = 4 * 1024 * 1024;

/** How long the core waits for a runner's answer: a build or a run of the longest kits. */
export const RUNNER_ASK_TIMEOUT_MS = 3 * 3_600_000;

/** How long the core waits for a runner to take one part of a message, or give one back. */
export const RUNNER_PART_TIMEOUT_MS = 120_000;

/** The subject a runner process answers its core's asks on: `thermite.rig.<rig>.runner.<r>.run`. */
export function runnerSubject(rig: string, runner: string): string {
  if (!RIG_ID.test(rig) || !RIG_ID.test(runner))
    throw new Error(`not a rig's or a runner's name for a subject: ${rig}, ${runner}`);
  return `thermite.rig.${rig}.runner.${runner}.run`;
}

/** Every runner's subject of a rig, as its core may ask them: `*` for the runner. */
export function runnersSubject(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a subject: ${rig}`);
  return `thermite.rig.${rig}.runner.*.run`;
}

const Part = z.number().int().min(0);
const Id = z.string().max(64);
const Data = z.string().max(RUNNER_PART_CHARS);

/** What the core's supervisor sends a runner's. */
export const RunnerRequest = z.discriminatedUnion("kind", [
  /** An ask of the runner process; `id`, the core's, by which its answer is kept (goal 227). */
  z.object({ kind: z.literal("ask"), ask: RunAsk, id: Id.optional() }),
  /**
   * One part of an ask too long for one message (a kept baseline's files), in order: the parts
   * joined are the ask's JSON, and the last part's answer is the runner's.
   */
  z.object({ kind: z.literal("ask_part"), id: Id, part: Part, parts: Part.min(2), data: Data }),
  /** One part of a git bundle, in base64; the last part's answer is the runner's. */
  z.object({
    kind: z.literal("git"),
    id: Id,
    repo: MirrorName,
    commit: Commit,
    part: Part,
    parts: Part.min(1),
    data: Data,
  }),
  /** The next part of an answer that came in parts. */
  z.object({ kind: z.literal("more"), id: Id, part: Part.min(1) }),
  /**
   * Where an ask stands, by its id (goal 227): still running, its answer kept (the reply it gave),
   * or unknown, which the core takes as a run its runner no longer holds.
   */
  z.object({ kind: z.literal("state"), id: Id }),
  /** Model files to fetch from their sources and give the runner process; `poll`: in turns. */
  z.object({
    kind: z.literal("models"),
    models: z.array(ModelFetch).max(200),
    poll: ModelPoll.optional(),
  }),
]);
export type RunnerRequest = z.infer<typeof RunnerRequest>;

/**
 * What a runner's supervisor answers: its harness's answer, why there is none, a part taken, or
 * one part of a long answer (`more` on the first, with how many parts there are; `data` on each).
 * The parts joined are the answer's JSON.
 */
export const RunnerReply = z.object({
  answer: z.unknown().optional(),
  error: z.string().optional(),
  took: z.boolean().optional(),
  more: z.object({ id: z.string(), parts: Part.min(2) }).optional(),
  data: z.string().optional(),
  /** An ask's state (goal 227): one its runner still runs, or one it does not know. */
  state: z.enum(["running", "unknown"]).optional(),
});
export type RunnerReply = z.infer<typeof RunnerReply>;
