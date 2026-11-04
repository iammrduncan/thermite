import { z } from "zod";
import { RunId } from "../../ids.ts";
import type { Route } from "../route.ts";

/**
 * A rig's runners, as its core asks them for runs (goal 206). The core decides and records; a
 * runner process serves its machine's target resources, each a runner by its place (`card`):
 * builds a commit with its kit, runs an arm on a cell with its check, answers for its device, and
 * keeps a baseline's folder. src/harness/runner/ answers these routes; the core's judge asks them
 * through its RemoteRunner (harness/judge/remote-runner.ts) and its supervisor. Both take the
 * supervisor's token.
 *
 * A folder in an ask is one the runner named in an earlier answer: a job's or a baseline's folder
 * under its scratch, or a build under its store. It refuses any other.
 */

/** The most bytes one ask carries: a kept baseline's files are the largest. */
const RUN_MAX_BYTES = 48 * 1024 * 1024;
/** The most bytes of one git bundle the core sends a runner. */
const RUN_GIT_MAX_BYTES = 512 * 1024 * 1024;

/** A runner of the process, by its place among them: its users are run-i, builder-i… */
const Card = z.number().int().min(0).max(7);
/** A repository's name in the harness's mirrors: `kit-` and the kit's name for a kit. */
export const MirrorName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const Commit = z.string().regex(/^[0-9a-f]{40}$/);
const Job = z.number().int().positive();
const Folder = z.string().min(1).max(4096);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** What a job's runs need (judge/runner.ts's MeasureSpec), with the kit by its commit. */
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

/** A model file a run names: where it lands in the inbox and its SHA-256. */
const ModelFile = z.object({ path: z.string().min(1).max(1000), sha256: Sha256 });
/** A model file as a runner's supervisor fetches it: its name and source too. */
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

/** One ask of a runner process, by its `op`. */
export const RunAsk = z.discriminatedUnion("op", [
  /** Its kind of target, its runners and whether its roles are separated. */
  z.object({ op: z.literal("info") }),
  /** Whether it has a commit, and the commits it was sent (to send only what it lacks). */
  z.object({ op: z.literal("git_has"), repo: MirrorName, commit: Commit }),
  /** A commit built with the kit as the runner's builder, or found built. */
  z.object({
    op: z.literal("build"),
    card: Card,
    repo: MirrorName,
    commit: Commit,
    kit_repo: MirrorName,
    kit_commit: Commit,
    actor: z.string().max(80),
  }),
  /** One run of an arm on a cell, the throttling around it and any implausible value. */
  z.object({
    op: z.literal("measure"),
    card: Card,
    spec: Spec,
    arm: Arm,
    cell: z.string().max(200),
  }),
  /** The runner's identity, readiness, environment, state after a block, or a recovery. */
  z.object({
    op: z.literal("driver"),
    card: Card,
    ask: z.enum(["identify", "ready", "env", "after_block", "recover"]),
  }),
  /** The runner process's CPU throttling so far. */
  z.object({ op: z.literal("throttle") }),
  /** A baseline job's folder for the runner's checker to write. */
  z.object({ op: z.literal("baseline_work"), card: Card, job: Job }),
  /** That folder sealed and kept by run and job, with its files for the core to keep. */
  z.object({ op: z.literal("baseline_keep"), card: Card, written: Folder, run: RunId, job: Job }),
  /** A run's kept baseline that the runner lacks, from the core's copy. */
  z.object({
    op: z.literal("baseline_put"),
    run: RunId,
    job: Job,
    files: z.array(BaselineFile).max(10_000),
  }),
  /** A folder of the runner's removed. */
  z.object({ op: z.literal("remove"), dir: Folder }),
  /** Which of these model files, by SHA-256, the runner lacks. */
  z.object({ op: z.literal("models_have"), sha256s: z.array(Sha256).max(200) }),
  /** Model files its supervisor put in its inbox, each taken in by its SHA-256. */
  z.object({ op: z.literal("models_take"), models: z.array(ModelFile).max(200) }),
]);
export type RunAsk = z.infer<typeof RunAsk>;

export const RUN = {
  method: "POST",
  path: "/v1/run",
  what: "run",
  body: RunAsk,
  answer: z.looseObject({}),
  maxBytes: RUN_MAX_BYTES,
} as const satisfies Route;

/**
 * A git bundle of commits the runner lacks, for the named mirror: the request's bytes. The commit
 * named must be in it.
 */
export const RUN_GIT = {
  method: "POST",
  path: "/v1/run/git/:repo/:commit",
  what: "git bundle",
  answer: z.looseObject({ ok: z.boolean() }),
  maxBytes: RUN_GIT_MAX_BYTES,
} as const satisfies Route;

/**
 * The core's asks of its runners, as its supervisor takes them to carry on the bus: an ask of a
 * runner process, a git bundle for one of its mirrors, which waits in the harness's outbox (`file`,
 * below it) for the supervisor to read and remove, or model files it lacks.
 */
export const QueuedRun = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), runner: z.string(), kind: z.literal("ask"), ask: RunAsk }),
  z.object({
    id: z.string(),
    runner: z.string(),
    kind: z.literal("git"),
    repo: MirrorName,
    commit: Commit,
    /** The bundle's file in the outbox: only `.runs/<id>.bundle`, never a path out of it. */
    file: z.string().regex(/^\.runs\/[0-9a-f-]{36}\.bundle$/),
  }),
  z.object({
    id: z.string(),
    runner: z.string(),
    kind: z.literal("models"),
    models: z.array(ModelFetch).max(200),
  }),
]);
export type QueuedRun = z.infer<typeof QueuedRun>;

/** The asks waiting, taken by the supervisor; it waits up to `wait` milliseconds for one. */
export const RUN_ASKS = {
  method: "GET",
  path: "/v1/run-asks",
  what: "runners' asks",
  answer: z.looseObject({ asks: z.array(QueuedRun) }),
} as const satisfies Route;

/** A runner's answer to an ask the supervisor took, or why none came. */
export const RUN_ANSWER = {
  method: "POST",
  path: "/v1/run-asks/:id",
  what: "runner's answer",
  body: z.object({ answer: z.unknown().optional(), error: z.string().max(4000).optional() }),
  answer: z.looseObject({ ok: z.boolean() }),
  maxBytes: RUN_MAX_BYTES + 1024 * 1024,
} as const satisfies Route;
