import { z } from "zod";
import { RunId } from "../../ids.ts";
import type { Route } from "../route.ts";
import { LaneAsk } from "./lanes.ts";

/**
 * A follower's judge GPUs, as the rig's leader asks for them (goal 205). The leader's judge decides
 * and records; a follower builds and measures on its judge GPUs for it, and runs the trials of
 * the lanes it holds (lanes.ts). src/harness/follower/
 * answers these routes on the follower; the leader's judge asks them through its RemoteDevice
 * (harness/judge/remote.ts), its supervisor and the bus. Both take the supervisor's token.
 *
 * A folder in an ask is one the follower named in an earlier answer: a run's or a baseline's
 * folder under its scratch, or a build under its store. It refuses any other.
 */

/** The most bytes one ask carries: a kept baseline's files are the largest. */
const DEVICE_MAX_BYTES = 48 * 1024 * 1024;
/** The most bytes of one git bundle the leader sends a follower. */
const DEVICE_GIT_MAX_BYTES = 512 * 1024 * 1024;

/** A judge GPU of the follower, by its place among them: its users are run-i, builder-i… */
const Card = z.number().int().min(0).max(7);
/** A repository's name in the harness's mirrors: `kit-` and the kit's name for a kit. */
export const MirrorName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const Commit = z.string().regex(/^[0-9a-f]{40}$/);
const Job = z.number().int().positive();
const Folder = z.string().min(1).max(4096);

/** What a job's runs need (judge/device.ts's MeasureSpec), with the kit by its commit. */
const Spec = z.object({
  job: Job,
  kit_repo: MirrorName,
  kit_commit: Commit,
  /** The folder a baseline job's checks write, or the run's kept baseline, by run and job. */
  baseline: z.union([z.object({ written: Folder }), z.object({ run: RunId, job: Job })]).optional(),
  /** The metrics the run decides by; none: all of the kit's. */
  uses: z.array(z.string().max(200)).max(200).optional(),
});

const Arm = z.object({
  name: z.enum(["champion", "candidate", "retained", "twin", "baseline"]),
  dir: Folder,
  manifest: z.looseObject({ key: z.string() }),
});

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** A model file a run names: where it lands in the inbox and its SHA-256. */
const ModelFile = z.object({
  path: z.string().min(1).max(1000),
  sha256: Sha256,
});
/** A model file as a follower's supervisor fetches it: its name and source too. */
export const ModelFetch = ModelFile.extend({
  name: z.string().min(1).max(500),
  url: z
    .string()
    .max(4000)
    .regex(/^https?:\/\//),
});
export type ModelFetch = z.infer<typeof ModelFetch>;

/** A kept baseline's file: its path in the folder and its bytes. */
const BaselineFile = z.object({ path: z.string().min(1).max(1024), base64: z.string() });

/** One ask of a follower's device, by its `op`. */
export const DeviceAsk = z.discriminatedUnion("op", [
  /** Its kind of target, its judge GPUs and whether its roles are separated. */
  z.object({ op: z.literal("info") }),
  /** Whether it has a commit, and the commits it was sent (to send only what it lacks). */
  z.object({ op: z.literal("git_has"), repo: MirrorName, commit: Commit }),
  /** A commit built with the kit as the card's builder, or found built. */
  z.object({
    op: z.literal("build"),
    card: Card,
    repo: MirrorName,
    commit: Commit,
    kit_repo: MirrorName,
    kit_commit: Commit,
    actor: z.string().max(80),
  }),
  /** One run of an arm on a case, the throttling around it and any implausible value. */
  z.object({
    op: z.literal("measure"),
    card: Card,
    spec: Spec,
    arm: Arm,
    cell: z.string().max(200),
  }),
  /** The card's identity, readiness, environment, state after a block, or a recovery. */
  z.object({
    op: z.literal("driver"),
    card: Card,
    ask: z.enum(["identify", "ready", "env", "after_block", "recover"]),
  }),
  /** The follower's CPU throttling so far. */
  z.object({ op: z.literal("throttle") }),
  /** A baseline job's folder for the card's checker to write. */
  z.object({ op: z.literal("baseline_work"), card: Card, job: Job }),
  /** That folder sealed and kept by run and job, with its files for the leader to keep. */
  z.object({ op: z.literal("baseline_keep"), written: Folder, run: RunId, job: Job }),
  /** A run's kept baseline that the follower lacks, from the leader's copy. */
  z.object({
    op: z.literal("baseline_put"),
    run: RunId,
    job: Job,
    files: z.array(BaselineFile).max(10_000),
  }),
  /** A folder taken back from the user it was handed to, or removed. */
  z.object({ op: z.literal("folder"), act: z.enum(["reclaim", "remove"]), dir: Folder }),
  /** Which of these model files, by SHA-256, the follower lacks. */
  z.object({ op: z.literal("models_have"), sha256s: z.array(Sha256).max(200) }),
  /** Model files its supervisor put in its inbox, each taken in by its SHA-256. */
  z.object({ op: z.literal("models_take"), models: z.array(ModelFile).max(200) }),
  /** A lane's trial on the follower (lanes.ts). */
  ...LaneAsk.options,
]);
export type DeviceAsk = z.infer<typeof DeviceAsk>;

export const DEVICE = {
  method: "POST",
  path: "/v1/device",
  what: "device",
  body: DeviceAsk,
  answer: z.looseObject({}),
  maxBytes: DEVICE_MAX_BYTES,
} as const satisfies Route;

/**
 * A git bundle of commits the follower lacks, for the named mirror: the request's bytes. The
 * commit named must be in it.
 */
export const DEVICE_GIT = {
  method: "POST",
  path: "/v1/device/git/:repo/:commit",
  what: "git bundle",
  answer: z.looseObject({ ok: z.boolean() }),
  maxBytes: DEVICE_GIT_MAX_BYTES,
} as const satisfies Route;

/**
 * The leader's asks of its followers, as its supervisor takes them to carry on the bus (goal 205):
 * an ask of a follower's device, or a git bundle for one of its mirrors, which waits in the
 * harness's outbox (`file`, below it) for the supervisor to read and remove.
 */
export const QueuedAsk = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), machine: z.string(), kind: z.literal("ask"), ask: DeviceAsk }),
  z.object({
    id: z.string(),
    machine: z.string(),
    kind: z.literal("git"),
    repo: MirrorName,
    commit: Commit,
    file: z.string(),
  }),
  /** Model files the follower lacks, which its supervisor fetches from their sources. */
  z.object({
    id: z.string(),
    machine: z.string(),
    kind: z.literal("models"),
    models: z.array(ModelFetch).max(200),
  }),
]);
export type QueuedAsk = z.infer<typeof QueuedAsk>;

/** The asks waiting, taken by the supervisor; it waits up to `wait` milliseconds for one. */
export const DEVICE_ASKS = {
  method: "GET",
  path: "/v1/device-asks",
  what: "followers' asks",
  answer: z.looseObject({ asks: z.array(QueuedAsk) }),
} as const satisfies Route;

/** A follower's answer to an ask the supervisor took, or why none came. */
export const DEVICE_ANSWER = {
  method: "POST",
  path: "/v1/device-asks/:id",
  what: "follower's answer",
  body: z.object({ answer: z.unknown().optional(), error: z.string().max(4000).optional() }),
  answer: z.looseObject({ ok: z.boolean() }),
  maxBytes: DEVICE_MAX_BYTES + 1024 * 1024,
} as const satisfies Route;
