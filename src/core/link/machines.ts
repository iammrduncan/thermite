import { z } from "zod";
import { Commit, DeviceAsk, MirrorName, ModelFetch } from "../api/harness/device.ts";
import { RIG_ID } from "../ids.ts";

/**
 * A rig's leader and its followers on the message bus (goal 205). The leader's supervisor carries
 * its harness's asks of a follower's judge GPUs (core/api/harness/device.ts) as requests on the
 * follower's own subject, and the follower's supervisor answers each from its harness. No stream
 * keeps them. A message holds at most MACHINE_PART_CHARS characters: a git bundle goes in parts,
 * and an answer longer than that comes in parts the leader asks for one by one.
 */

/** The most characters of one part: base64 of 3 MiB, well under the server's largest message. */
export const MACHINE_PART_CHARS = 4 * 1024 * 1024;

/** How long the leader waits for a follower's answer: a build or a run of the longest kits. */
export const MACHINE_ASK_TIMEOUT_MS = 3 * 3_600_000;

/** How long the leader waits for a follower to take one part of a bundle, or give one back. */
export const MACHINE_PART_TIMEOUT_MS = 120_000;

/** The subject a follower answers its leader's asks on: `thermite.rig.<rig>.machine.<m>.device`. */
export function machineSubject(rig: string, machine: string): string {
  if (!RIG_ID.test(rig) || !RIG_ID.test(machine))
    throw new Error(`not a rig's or a machine's name for a subject: ${rig}, ${machine}`);
  return `thermite.rig.${rig}.machine.${machine}.device`;
}

/** Every machine's subject of a rig, as its leader may ask them: `*` for the machine. */
export function machinesSubject(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a subject: ${rig}`);
  return `thermite.rig.${rig}.machine.*.device`;
}

const Part = z.number().int().min(0);

/** What the leader's supervisor sends a follower's. */
export const MachineRequest = z.discriminatedUnion("kind", [
  /** An ask of the follower's device. */
  z.object({ kind: z.literal("ask"), ask: DeviceAsk }),
  /** One part of a git bundle, in base64; the last part's answer is the follower's. */
  z.object({
    kind: z.literal("git"),
    id: z.string().max(64),
    repo: MirrorName,
    commit: Commit,
    part: Part,
    parts: Part.min(1),
    data: z.string().max(MACHINE_PART_CHARS),
  }),
  /** The next part of an answer that came in parts. */
  z.object({ kind: z.literal("more"), id: z.string().max(64), part: Part.min(1) }),
  /** Model files to fetch from their sources and give the follower's harness. */
  z.object({ kind: z.literal("models"), models: z.array(ModelFetch).max(200) }),
]);
export type MachineRequest = z.infer<typeof MachineRequest>;

/**
 * What a follower's supervisor answers: its harness's answer, why there is none, a part of a
 * bundle taken, or one part of a long answer (`more` on the first, with how many parts there are;
 * `data` on each). The parts joined are the answer's JSON.
 */
export const MachineReply = z.object({
  answer: z.unknown().optional(),
  error: z.string().optional(),
  took: z.boolean().optional(),
  more: z.object({ id: z.string(), parts: Part.min(2) }).optional(),
  data: z.string().optional(),
});
export type MachineReply = z.infer<typeof MachineReply>;
