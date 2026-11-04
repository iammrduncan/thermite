import { z } from "zod";
import { RunId, TRIAL_ID } from "../../ids.ts";
import { LIVE_KINDS } from "../../live.ts";
import {
  TERMINAL_KEYS,
  TERMINAL_KEYS_MAX,
  TERMINAL_TEXT_MAX,
  TERMINAL_WAITS,
} from "../../terminal-input.ts";

/**
 * A lane's trial on a follower (goal 205, step 2), as the rig's leader asks for it through the
 * follower's device route (device.ts). The leader keeps the trial's records; the follower makes
 * its workspace, runs its program and its commands, and serves the routes that need the
 * workspace's machine. Every other call of the trial waits on the follower until the leader's next
 * wait takes it, with the trial's token; the leader passes it to its own API and answers it. What
 * the program reports (its lines, counters, waits, usage) comes back with the waits too, in order.
 */

const TrialId = z.string().regex(TRIAL_ID);
const Commit = z.string().regex(/^[0-9a-f]{40}$/);
const MirrorName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
/** The longest a wait holds before it answers with nothing new. */
export const LANE_WAIT_MAX_MS = 25_000;
/** The most bytes of a forwarded call's body or answer, before base64. */
export const LANE_CALL_MAX_BYTES = 9 * 1024 * 1024;
const Body = z.string().max(Math.ceil(LANE_CALL_MAX_BYTES / 3) * 4 + 4);

/** A model route as the trial takes it, with its key now (the follower keeps it in memory). */
const Route = z.looseObject({ model: z.string(), baseUrl: z.string() });

/** The owner's messages waiting for the trial, as the leader's inbox gives them. */
const Waiting = z.array(z.object({ id: z.number().int(), text: z.string().max(100_000) })).max(200);

export const LaneAsk = z.discriminatedUnion("op", [
  /**
   * A trial starts: its spec as the scheduler built it, without its workspace, and the leader's
   * mirror whose parent commit it sent first. With no route, its program can't start.
   */
  z.object({
    op: z.literal("trial_start"),
    spec: z.looseObject({
      trialId: TrialId,
      token: z.string().regex(/^[0-9a-f]{64}$/),
      run: RunId,
      lane: z.string().regex(/^lane-\d+$/),
      parentCommit: Commit,
    }),
    repo: MirrorName,
    route: Route.optional(),
    /** Its program in its own terminal (the rig's setting when it starts), else headless. */
    terminal: z.boolean().optional(),
  }),
  /**
   * What the trial reported since event `seen`, and its calls waiting; the trial's end once it
   * ended. It holds up to `wait_ms` for something new. It carries the owner's messages waiting
   * for the trial now, whether the rig drains, and a route whose key was renewed.
   */
  z.object({
    op: z.literal("trial_wait"),
    trial: TrialId,
    seen: z.number().int().min(0),
    wait_ms: z.number().int().min(0).max(LANE_WAIT_MAX_MS),
    messages: Waiting,
    draining: z.boolean(),
    route: Route.optional(),
  }),
  /** The leader's answer to one of the trial's calls. */
  z.object({
    op: z.literal("trial_answer"),
    trial: TrialId,
    call: z.uuid(),
    status: z.number().int().min(100).max(599),
    type: z.string().max(200),
    body: Body,
  }),
  /** The trial is stopped: a reset, a drain's end or the leader's own stop. */
  z.object({ op: z.literal("trial_stop"), trial: TrialId }),
  /** Its terminal's screen now, for control's live view (step 2e). */
  z.object({ op: z.literal("trial_screen"), trial: TrialId }),
  /**
   * The owner's input into its terminal: typed now, or queued for its usage window's reset, whose
   * outcome comes back later as an `input_later` event with this `id`.
   */
  z.object({
    op: z.literal("trial_input"),
    trial: TrialId,
    id: z.uuid(),
    input: z.object({
      text: z.string().max(TERMINAL_TEXT_MAX).optional(),
      keys: z.array(z.enum(TERMINAL_KEYS)).max(TERMINAL_KEYS_MAX).optional(),
      follow_up: z.literal(true).optional(),
      wait: z.enum(TERMINAL_WAITS),
    }),
  }),
  /** Keys the owner pressed on Live, as they came; the answer holds each line they ended. */
  z.object({ op: z.literal("trial_keys"), trial: TrialId, data: z.string().max(64 * 1024) }),
]);
export type LaneAsk = z.infer<typeof LaneAsk>;

const Seq = z.number().int().min(1);
/**
 * What a trial on a follower reported, in order: each the same as a trial on the leader's own
 * machine gives its harness (agents/programs.ts's TrialLink), and its calls of the leader's API.
 */
export const LaneEvent = z.discriminatedUnion("kind", [
  z.object({
    seq: Seq,
    kind: z.literal("live"),
    entries: z.array(z.object({ kind: z.enum(LIVE_KINDS), text: z.string() })),
  }),
  z.object({
    seq: Seq,
    kind: z.literal("progress"),
    progress: z.object({
      turns: z.number(),
      tool_calls: z.number(),
      tokens_in: z.number(),
      tokens_out: z.number(),
    }),
  }),
  z.object({
    seq: Seq,
    kind: z.literal("wait"),
    wait: z.object({ until: z.string(), kind: z.string(), words: z.string() }),
  }),
  z.object({
    seq: Seq,
    kind: z.literal("given"),
    ids: z.array(z.number().int()),
    how: z.string().optional(),
  }),
  /** The program's own reports: its subscription's windows, a model call's usage, its prompt. */
  z.object({ seq: Seq, kind: z.literal("windows"), windows: z.unknown() }),
  z.object({ seq: Seq, kind: z.literal("model_usage"), usage: z.unknown() }),
  z.object({ seq: Seq, kind: z.literal("sent"), prompt: z.unknown() }),
  z.object({
    seq: Seq,
    kind: z.literal("compacted"),
    harness: z.string(),
    compaction: z.unknown(),
  }),
  /** Its program reaches its provider through the follower's model proxy, which counts. */
  z.object({ seq: Seq, kind: z.literal("through_proxy") }),
  z.object({ seq: Seq, kind: z.literal("proxy_saw"), tokens: z.unknown() }),
  /** Its program's own code hands its usage over, as `harness` runs it. */
  z.object({ seq: Seq, kind: z.literal("hand_over"), harness: z.string() }),
  /** What became of an owner's input that waited for the usage window's reset. */
  z.object({
    seq: Seq,
    kind: z.literal("input_later"),
    id: z.uuid(),
    outcome: z.enum(["typed_after_reset", "dropped"]),
    why: z.string().optional(),
  }),
  /** A call of the trial for the leader's API, which `trial_answer` answers. */
  z.object({
    seq: Seq,
    kind: z.literal("call"),
    id: z.uuid(),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
    path: z
      .string()
      .regex(/^\/v1\//)
      .max(2000),
    search: z.string().max(4000),
    type: z.string().max(200),
    auth: z.string().max(400),
    body: Body,
  }),
]);
export type LaneEvent = z.infer<typeof LaneEvent>;

/** A file of the trial's session log, which the leader keeps by run and trial. */
const SessionFile = z.object({ name: z.string().min(1).max(200), base64: z.string() });

/** A terminal's screen, as the terminal host gives it. */
const Screen = z.object({ cols: z.number(), rows: z.number(), data: z.string() });

/**
 * The answer to a wait: the events after `seen`, and the trial's end once it ended, with its
 * terminal's last screen when it had one.
 */
export const LaneWaitAnswer = z.object({
  events: z.array(LaneEvent),
  ended: z
    .object({
      result: z.looseObject({}),
      session: z.array(SessionFile),
      screen: Screen.optional(),
    })
    .optional(),
});
export type LaneWaitAnswer = z.infer<typeof LaneWaitAnswer>;
