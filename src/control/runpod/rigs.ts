import { log, redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { LEAF_ENV, LEAF_PORT } from "../../core/link/leaf.ts";
import { POD_CONFIG_ENV, PodConfig } from "../../core/tunnel.ts";
import type { SecretBox } from "../secrets.ts";
import type { ControlStore, StoredRunpodRig } from "../store/index.ts";
import { rigView } from "../views/index.ts";
import {
  createPod,
  getPod,
  POD_LOG_MAX_TAIL,
  type PodLogLine,
  podLogs,
  readRunpod,
  terminatePod,
} from "./cloud.ts";
import { noFreeGpu, RUNPOD_STEP_WORDS, RunpodLifecycle } from "./lifecycle.ts";
import {
  idleSince,
  type RigState,
  type RunpodRigView,
  runpodRigView,
  spentBy,
} from "./rig-view.ts";
import type { ControlTunnels } from "./tunnel.ts";

/**
 * Rigs on RunPod, launched by the owner alone (REST, MCP or the command line; goal 022). A launch
 * mints the rig and its one-time code for pull mode (ControlTunnels.mint), starts a pod of the
 * one-container rig image with those values in its environment and the pull mode port exposed,
 * and names the pod (attach); control's loop then enrolls it and exchanges with it.
 *
 * Control follows each pod (`advance`, every 30 s): its status, its price and what it has cost
 * so far. It stops the pod when the owner asks, or when the owner set a spend limit or an idle
 * stop and the pod reached it; nothing else stops it: no limit is set for the owner. The idle
 * stop counts the time no run is at work on the rig (lastWork). The owner also starts, restarts
 * and terminates it (goal 023): runpod/lifecycle.ts, through which every stop, the limits'
 * included, sends the rig's results out first. Assigning or resuming a run on a stopped pod starts
 * it first (wake; issue.ts's issueWaking).
 */

/** The one-container image is CUDA 12.6; RunPod places the pod only on hosts whose driver runs it. */
const MIN_CUDA = "12.6";
/** The pod's volume, where the rig keeps its state (containers/rig/Containerfile). */
const VOLUME_PATH = "/workspace";
export const DEFAULT_CONTAINER_DISK_GB = 40;
export const DEFAULT_VOLUME_GB = 100;
/** A gap between two of control's looks at a pod that means control was not running. */
const AWAY_MS = 5 * 60_000;

/** The shortest idle stop: a rig needs a few minutes between enrollment and its first run. */
export const MIN_IDLE_STOP_MINUTES = 5;
/**
 * The idle stop a launch over REST, MCP or the command line gets when it names none, in minutes;
 * null: none. No cap comes by default: the pod never stops by itself unless the owner says so.
 */
export const DEFAULT_IDLE_STOP_MINUTES: number | null = null;
/**
 * The idle stop the dashboard's launch form fills in when it opens, in minutes (the owner,
 * 2026-10-20). The owner changes or clears it there; a cleared field launches with none.
 */
export const FORM_IDLE_STOP_MINUTES = 30;

/** What the owner asks for. Only the GPU type has no default. */
export interface LaunchRequest {
  /** A GPU type's id or name, from RunPod's list. */
  gpu: string;
  gpu_count?: number | undefined;
  /** SECURE, on demand: the owner's decision of 2026-10-20 ("Community and spot come later"). */
  cloud_type?: "SECURE" | "COMMUNITY" | undefined;
  /** A data center's id; not given: RunPod chooses. */
  datacenter?: string | undefined;
  /** Default: control's THERMITE_RUNPOD_RIG_IMAGE. */
  image?: string | undefined;
  container_disk_gb?: number | undefined;
  volume_gb?: number | undefined;
  /** The rig's name; not given: control makes one (rp- and 8 hexadecimal characters). */
  rig?: string | undefined;
  /** The enrollment code expires this long after the launch; not given: it does not. */
  enroll_within_minutes?: number | undefined;
  /** The rig's settings at enrollment, over the launch's own (its target and GPUs). */
  settings?: Partial<Record<(typeof POD_CONFIG_ENV)[number], string>> | undefined;
  spend_limit_usd?: number | undefined;
  /** Minutes with no run at work before control stops the pod; null: none; left out: the default. */
  idle_stop_minutes?: number | null | undefined;
}

/** A read of a rig's pod log, as REST and MCP answer it: its lines oldest first. */
export interface PodLogRead {
  rig: string;
  pod: string;
  lines: PodLogLine[];
  read_at: string;
}

/** The last read of a rig's pod log, for its page: the source it asked for, or why it failed. */
export interface KeptPodLog extends PodLogRead {
  source: "container" | "system" | null;
  error: string | null;
}

/**
 * A pod log read's query, as REST takes it: `tail` a whole number of lines, 1 or more (above
 * 2000: 2000), and `source` container or system (not given: both).
 */
export function podLogQuery(
  tail: string | undefined,
  source: string | undefined,
): { tail?: number; source?: "container" | "system" } | { error: string } {
  const out: { tail?: number; source?: "container" | "system" } = {};
  if (tail !== undefined && tail !== "") {
    if (!/^\d+$/.test(tail) || Number(tail) < 1)
      return { error: "tail is a whole number of lines, 1 or more" };
    out.tail = Math.min(POD_LOG_MAX_TAIL, Number(tail));
  }
  if (source !== undefined && source !== "") {
    if (source !== "container" && source !== "system")
      return { error: "source is container or system" };
    out.source = source;
  }
  return out;
}

/** A change to a rig's limits: a number sets one, null clears it, nothing keeps it. */
export interface LimitsChange {
  spend_limit_usd?: number | null | undefined;
  idle_stop_minutes?: number | null | undefined;
}

function checkLimits(l: LimitsChange): void {
  if (
    l.spend_limit_usd !== undefined &&
    l.spend_limit_usd !== null &&
    !(Number.isFinite(l.spend_limit_usd) && l.spend_limit_usd > 0)
  )
    throw new Error("a spend limit is a number of US dollars above 0");
  if (
    l.idle_stop_minutes !== undefined &&
    l.idle_stop_minutes !== null &&
    !(Number.isFinite(l.idle_stop_minutes) && l.idle_stop_minutes >= MIN_IDLE_STOP_MINUTES)
  )
    throw new Error(`an idle stop is ${MIN_IDLE_STOP_MINUTES} minutes or more`);
}

const wholeIn = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
const money = (usd: number) => `$${usd.toFixed(2)}`;

/**
 * Saves a rig's state on its GPU cloud. What its pod cost since control last counted it goes to
 * the runs the rig is running now, as its view says (goal 075): split evenly between them, or to
 * none when it runs none.
 */
export function saveRunpodRig(
  store: ControlStore,
  rig: string,
  state: unknown,
  active: boolean,
): void {
  const running = (rigView(store, rig)?.runs ?? [])
    .filter((r) => r.status === "running")
    .map((r) => ({ run: r.id, campaign: r.campaign || null }));
  store.runpod.saveRig(rig, state, active, running);
}

export class RunpodRigs {
  private readonly store: ControlStore;
  private readonly secrets: SecretBox;
  private readonly tunnels: ControlTunnels;
  private readonly fetchImpl: typeof fetch;
  private readonly image: string | undefined;
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  /** A pod log read's idle and total stops, in ms; not given: podLogs' own (tests shorten them). */
  private readonly logTimes: { idleMs?: number | undefined; totalMs?: number | undefined };
  private readonly life: RunpodLifecycle;
  private busy = false;
  /** One change to a rig's state at a time: control's loop and the owner's asks wait their turn. */
  private readonly locks = new Map<string, Promise<void>>();
  /** Pod log reads under way, and each rig's last read (kept in memory only). */
  private readonly logReads = new Map<string, Promise<PodLogRead>>();
  private readonly lastLogs = new Map<string, KeptPodLog>();

  constructor(
    store: ControlStore,
    secrets: SecretBox,
    tunnels: ControlTunnels,
    opts: {
      fetch?: typeof fetch | undefined;
      image?: string | undefined;
      now?: (() => number) | undefined;
      staleAfterMs?: number | undefined;
      /** Control's command-signing key: a stop or a terminate pauses runs and asks for exports. */
      privateKeyPem?: string | undefined;
      logTimes?: { idleMs?: number | undefined; totalMs?: number | undefined } | undefined;
    } = {},
  ) {
    this.store = store;
    this.secrets = secrets;
    this.tunnels = tunnels;
    this.fetchImpl = opts.fetch ?? fetch;
    this.image = opts.image;
    this.now = opts.now ?? Date.now;
    this.staleAfterMs = opts.staleAfterMs ?? 180_000;
    this.logTimes = opts.logTimes ?? {};
    this.life = new RunpodLifecycle({
      store,
      fetch: this.fetchImpl,
      now: this.now,
      privateKeyPem: opts.privateKeyPem,
      staleAfterMs: this.staleAfterMs,
    });
  }

  /** Runs `fn` once every earlier change to this rig has ended; its outcome is the caller's. */
  private async locked<T>(rig: string, fn: () => Promise<T>): Promise<T> {
    const before = this.locks.get(rig) ?? Promise.resolve();
    const run = before.then(fn);
    // The next change waits for this one to end, whether it worked or not.
    const ended = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(rig, ended);
    try {
      return await run;
    } finally {
      if (this.locks.get(rig) === ended) this.locks.delete(rig);
    }
  }

  /** The image a launch uses when none is given (control's THERMITE_RUNPOD_RIG_IMAGE). */
  defaultImage(): string | undefined {
    return this.image;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private key(cloud: string): string | undefined {
    const g = this.store.gpuClouds.get(cloud);
    return g ? this.secrets.open(g.key_sealed) : undefined;
  }

  /**
   * Launches a rig: a pod of the one-container rig image, in pull mode. Billed from now. Throws,
   * in words, when it can't; a launch that fails leaves no pod and no rig behind.
   */
  async launch(cloud: string, req: LaunchRequest, by: string): Promise<RunpodRigView> {
    const key = this.key(cloud);
    if (!key) throw new Error(`no GPU cloud "${cloud}"`);
    const gpuName = (req.gpu ?? "").trim();
    if (!gpuName) throw new Error("name a GPU type: its id or name in RunPod's list");
    const count = req.gpu_count ?? 1;
    if (!wholeIn(count, 1, 8)) throw new Error("a pod has 1 to 8 GPUs");
    const cloudType = req.cloud_type ?? "SECURE";
    if (cloudType !== "SECURE")
      throw new Error(
        "Community cloud comes in a later version: rigs launch on Secure cloud, on demand",
      );
    const disk = req.container_disk_gb ?? DEFAULT_CONTAINER_DISK_GB;
    if (!wholeIn(disk, 10, 2000)) throw new Error("the container's disk is 10 to 2000 GB");
    const volume = req.volume_gb ?? DEFAULT_VOLUME_GB;
    if (!wholeIn(volume, 10, 10_000)) throw new Error("the volume is 10 to 10000 GB");
    const ttl = req.enroll_within_minutes;
    if (ttl !== undefined && !(Number.isFinite(ttl) && ttl > 0))
      throw new Error("the time to enroll is a number of minutes above 0");
    checkLimits(req);
    const image = (req.image ?? this.image ?? "").trim();
    if (!image)
      throw new Error(
        "no image: give one, or set THERMITE_RUNPOD_RIG_IMAGE on control (the one-container rig image, at a registry RunPod can pull from)",
      );
    // The rig's settings: a GPU rig on all the pod's cards, unless the owner says otherwise.
    const settings = PodConfig.safeParse({
      env: {
        THERMITE_TARGET: "cuda-gpu",
        THERMITE_GPUS: Array.from({ length: count }, (_, i) => i).join(","),
        ...(req.settings ?? {}),
      },
    });
    if (!settings.success)
      throw new Error(
        `the rig's settings take only ${POD_CONFIG_ENV.join(", ")}, with values of letters, digits and . _ , : -`,
      );
    // A fresh read: prices and stock change.
    const facts = await readRunpod(key, this.fetchImpl);
    this.store.gpuClouds.setFacts(cloud, { facts });
    const gpu = facts.gpus.find((g) => g.id === gpuName || g.name === gpuName);
    if (!gpu) throw new Error(`RunPod lists no GPU type "${gpuName}"`);
    if (cloudType === "SECURE" ? !gpu.secure : !gpu.community)
      throw new Error(
        `${gpu.name} is not offered on ${cloudType === "SECURE" ? "Secure" : "Community"} cloud`,
      );
    if (
      req.datacenter &&
      facts.datacenters.length &&
      !facts.datacenters.some((d) => d.id === req.datacenter)
    )
      throw new Error(`RunPod lists no data center "${req.datacenter}"`);
    const listPrice = cloudType === "SECURE" ? gpu.price_secure : gpu.price_community;
    const minted = this.tunnels.mint({
      by,
      rig: req.rig,
      codeTtlMs: ttl === undefined ? undefined : ttl * 60_000,
      config: settings.data.env,
    });
    let pod: Awaited<ReturnType<typeof createPod>>;
    try {
      pod = await createPod(
        key,
        {
          name: `thermite-${minted.rig}`,
          image,
          gpu: gpu.id,
          gpuCount: count,
          cloud: cloudType,
          diskGb: disk,
          minCudaVersion: MIN_CUDA,
          datacenter: req.datacenter,
          volumeGb: volume,
          volumeMountPath: VOLUME_PATH,
          // With the leaf, its port as TCP: RunPod gives it a public address and port.
          ports: [`${minted.port}/http`, ...(minted.leaf ? [`${LEAF_PORT}/tcp`] : [])],
          env: { ...minted.env },
        },
        this.fetchImpl,
      );
    } catch (err) {
      // No pod: nothing can use the rig's code. RunPod's refusal may echo what it was sent: the
      // launch's secret values never go further than this.
      if (err instanceof Error)
        for (const secret of [
          minted.env.THERMITE_STATE_SNAPSHOT_KEY,
          minted.env.THERMITE_TUNNEL_ENROLL_CODE,
          minted.env.THERMITE_TUNNEL_PREFIX,
          minted.env[LEAF_ENV.key],
        ])
          if (secret) err.message = err.message.replaceAll(secret, "***");
      this.store.tunnels.drop(minted.rig, by);
      // RunPod's stock changes by the minute: say so, and what to do, in words.
      const busy = noFreeGpu(err);
      if (busy)
        throw new Error(
          `RunPod has no ${count} × ${gpu.name} free on ${cloudType === "SECURE" ? "Secure" : "Community"} cloud${req.datacenter ? ` in ${req.datacenter}` : ""} now: ${busy}. No pod was started and nothing is billed. Choose another GPU${req.datacenter ? " or any data center" : ""}, or try again in a few minutes.`,
        );
      throw err;
    }
    try {
      this.tunnels.attach(minted.rig, pod.id);
    } catch (err) {
      // RunPod's answer can't be used: the pod goes, so it costs nothing more.
      await terminatePod(key, pod.id, this.fetchImpl).catch((e) =>
        log(
          "control",
          "could not remove a pod after a failed launch",
          {
            pod: pod.id,
            error: redact(errorText(e)),
          },
          "warn",
        ),
      );
      this.store.tunnels.drop(minted.rig, by);
      throw err;
    }
    const now = this.iso();
    const idleStop =
      req.idle_stop_minutes === undefined ? DEFAULT_IDLE_STOP_MINUTES : req.idle_stop_minutes;
    const state: RigState = {
      image,
      gpu: gpu.id,
      gpu_name: gpu.name,
      gpu_count: count,
      cloud_type: cloudType,
      datacenter: pod.datacenter || req.datacenter || null,
      container_disk_gb: disk,
      volume_gb: volume,
      price_per_hr: pod.cost_per_hr || (listPrice === null ? null : listPrice * count),
      status: pod.status || "PROVISIONING",
      status_at: now,
      launched_at: now,
      spent_usd: 0,
      billed_since: now,
      running_since: now,
      spend_limit_usd: req.spend_limit_usd ?? null,
      idle_stop_minutes: idleStop,
      idle_from: idleStop === null ? null : now,
      busy_at: null,
      stopped_at: null,
      stopped_by: null,
      ended_at: null,
      error: null,
      notes: [],
    };
    this.store.runpod.addRig({ rig: minted.rig, cloud, pod: pod.id, state, by });
    this.store.rigHistory.add(
      minted.rig,
      "runpod_launched",
      true,
      `by ${by}: pod ${pod.id}, ${count} × ${gpu.name} on ${cloudType === "SECURE" ? "Secure" : "Community"} cloud${state.price_per_hr === null ? "" : `, ${money(state.price_per_hr)} an hour`}`,
    );
    this.store.auditLog.add(by, "runpod_rig_launched", {
      rig: minted.rig,
      cloud,
      pod: pod.id,
      gpu: gpu.name,
      gpu_count: count,
      cloud_type: cloudType,
      datacenter: state.datacenter,
      price_per_hr: state.price_per_hr,
      image,
      spend_limit_usd: state.spend_limit_usd,
      idle_stop_minutes: state.idle_stop_minutes,
    });
    return this.view(minted.rig) as RunpodRigView;
  }

  /** Sets or clears a rig's spend limit and idle stop. The owner's alone. */
  limits(rig: string, change: LimitsChange, by: string): RunpodRigView {
    const r = this.store.runpod.rig(rig);
    if (!r) throw new Error(`no rig ${rig} on a GPU cloud`);
    checkLimits(change);
    const s = r.state as RigState;
    if (change.spend_limit_usd !== undefined) s.spend_limit_usd = change.spend_limit_usd;
    if (change.idle_stop_minutes !== undefined) {
      // Idle time counts from when the stop is set, never from before.
      if (change.idle_stop_minutes !== null && s.idle_stop_minutes === null)
        s.idle_from = this.iso();
      s.idle_stop_minutes = change.idle_stop_minutes;
      if (s.idle_stop_minutes !== null && this.store.tunnels.get(rig)?.enrolled_at)
        this.noteWork(rig, s, this.now());
    }
    saveRunpodRig(this.store, rig, s, r.active);
    this.store.auditLog.add(by, "runpod_rig_limits", {
      rig,
      spend_limit_usd: s.spend_limit_usd,
      idle_stop_minutes: s.idle_stop_minutes,
    });
    return this.view(rig) as RunpodRigView;
  }

  /**
   * One step for every rig control follows. Control calls it at start and every 30 s: it follows
   * pods only while it runs, so a limit passed while it was away is acted on at once (goal 165).
   */
  async advance(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const r of this.store.runpod.rigs({ active: true }))
        await this.locked(r.rig, () => this.step(r.rig));
    } finally {
      this.busy = false;
    }
  }

  /**
   * When a run was last at work on the rig, as its signed reports say, in ms; null when none ever
   * was. A run is at work while it is running and something is under way for it: a lane's trial
   * in progress, or a judge job queued for it. A judge job that runs is work whatever its run.
   * While nothing is under way, a running run's newest event (capped at now) is its last work, so
   * the planner's gap between trials is not idle. A paused or finished run is never at work, and a
   * running run with nothing under way and no new event (blocked: waiting for the owner, say)
   * becomes idle from its last event. `now`: something is under way for a run at this moment.
   */
  private lastWork(rig: string, nowMs: number): { last: number | null; now: boolean } {
    const v = rigView(this.store, rig, { staleAfterMs: this.staleAfterMs, now: nowMs });
    if (!v) return { last: null, now: false };
    const running = v.runs.filter((x) => x.status === "running");
    const ids = new Set(running.map((x) => x.id));
    if (
      v.judge.now ||
      running.some((x) => Object.keys(x.at_work).length > 0) ||
      v.judge.queued.some((j) => j.run !== null && ids.has(j.run))
    )
      return { last: nowMs, now: true };
    let last: number | null = null;
    for (const x of running) {
      const at = Date.parse(x.timeline.at(-1)?.at ?? "");
      if (Number.isFinite(at)) last = Math.max(last ?? 0, Math.min(at, nowMs));
    }
    return { last, now: false };
  }

  /**
   * Notes on the rig's state whether a run is at work now, and when one last was: the idle stop
   * and the rig's page count idle time from these (idleSince).
   */
  private noteWork(rig: string, s: RigState, nowMs: number): void {
    const { last, now } = this.lastWork(rig, nowMs);
    s.at_work = now;
    if (last !== null && !(s.busy_at && Date.parse(s.busy_at) >= last))
      s.busy_at = new Date(last).toISOString();
  }

  private async step(rig: string): Promise<void> {
    const r = this.store.runpod.rig(rig);
    if (!r?.active) return;
    const s = r.state as RigState;
    const key = this.key(r.cloud);
    if (!key) {
      s.error = `the GPU cloud "${r.cloud}" was deleted, so control can't follow pod ${r.pod}: see RunPod's console`;
      saveRunpodRig(this.store, rig, s, r.active);
      return;
    }
    const nowMs = this.now();
    const now = this.iso();
    // When control last saw the pod: a long gap is time control was not running.
    const seenAt = s.status_at ? Date.parse(s.status_at) : null;
    // What it cost up to now, at the price it ran at.
    s.spent_usd = spentBy(s, nowMs);
    if (s.billed_since) s.billed_since = now;
    let active = true;
    try {
      const pod = await getPod(key, r.pod, this.fetchImpl);
      s.status_at = now;
      if (!pod) {
        s.status = "TERMINATED";
        s.ended_at = now;
        s.billed_since = null;
        s.running_since = null;
        s.op = null;
        s.notes.push("RunPod no longer has the pod.");
        this.store.rigHistory.add(rig, "runpod_gone", false, "it was removed outside Thermite");
        active = false;
      } else {
        s.status = pod.status;
        // Where control's bus reaches the pod's server: RunPod's address for it, while it runs.
        this.store.tunnels.setLeafAddress(rig, pod.tcp[LEAF_PORT] ?? null);
        if (pod.cost_per_hr > 0) s.price_per_hr = pod.cost_per_hr;
        if (pod.datacenter) s.datacenter = pod.datacenter;
        const running = pod.status !== "EXITED" && pod.status !== "TERMINATED";
        s.billed_since = running ? now : null;
        s.running_since = running ? (s.running_since ?? now) : null;
        s.error = null;
        if (s.op) active = await this.life.step(r, s, key, pod);
        else if (running) {
          // Started again (here, or in RunPod's console): no longer stopped.
          if (pod.status === "RUNNING") {
            s.stopped_at = null;
            s.stopped_by = null;
          }
          await this.limit(r, key, s, nowMs, seenAt);
        }
      }
    } catch (err) {
      s.error = redact(errorText(err));
      log("control", "runpod rig step failed", { rig, error: s.error }, "error");
    }
    // A refusal stays until a newer step in the rig's history (a full reset, say), not a read.
    if (s.refusal && this.store.rigHistory.list(rig).length > s.refusal.steps) s.refusal = null;
    saveRunpodRig(this.store, rig, s, active);
  }

  /** The owner's limits, if set: a pod that reached one is stopped, its results sent out first. */
  private async limit(
    r: StoredRunpodRig,
    key: string,
    s: RigState,
    nowMs: number,
    seenAt: number | null,
  ): Promise<void> {
    const enrolledAt = this.store.tunnels.get(r.rig)?.enrolled_at ?? null;
    if (s.idle_stop_minutes !== null && enrolledAt) this.noteWork(r.rig, s, nowMs);
    const spent = spentBy(s, nowMs);
    let why: "spend_limit" | "idle_stop" | undefined;
    if (s.spend_limit_usd !== null && spent >= s.spend_limit_usd) why = "spend_limit";
    else {
      // The rule the rig's page shows: no idle time while a run is at work.
      const since = idleSince(s, enrolledAt);
      if (
        s.idle_stop_minutes !== null &&
        since &&
        nowMs - Date.parse(since) >= s.idle_stop_minutes * 60_000
      )
        why = "idle_stop";
    }
    if (!why) return;
    if (seenAt !== null && nowMs - seenAt > AWAY_MS)
      s.notes.push(
        `Control was not running from ${new Date(seenAt).toISOString()}: the pod passed this limit meanwhile, and control stopped it as soon as it started again.`,
      );
    await this.life.beginStop(r, s, key, "control", why);
  }

  /** A rig control follows, its state and its key; throws, in words, when there is none. */
  private ready(rig: string): { r: StoredRunpodRig; s: RigState; key: string } {
    const r = this.store.runpod.rig(rig);
    if (!r) throw new Error(`no rig ${rig} on a GPU cloud`);
    const key = this.key(r.cloud);
    if (!key)
      throw new Error(
        `the GPU cloud "${r.cloud}" was deleted, so control can't reach pod ${r.pod}: see RunPod's console`,
      );
    return { r, s: r.state as RigState, key };
  }

  /**
   * Runs one of the owner's asks on a rig, under its lock: what was done is saved even when the
   * ask then fails (a refused start, say), and the error comes back in words.
   */
  private ask(
    rig: string,
    fn: (r: StoredRunpodRig, s: RigState, key: string) => Promise<void>,
  ): Promise<RunpodRigView> {
    return this.locked(rig, async () => {
      const { r, s, key } = this.ready(rig);
      const before = JSON.stringify(s);
      try {
        await fn(r, s, key);
      } finally {
        if (JSON.stringify(s) !== before)
          saveRunpodRig(this.store, rig, s, s.status !== "TERMINATED");
      }
      return this.view(rig) as RunpodRigView;
    });
  }

  /**
   * Stops a rig's pod: its running runs paused, and its results sent out first (an export), then
   * the pod stopped once they have left it, or after STOP_WAIT_MS; its volume keeps the rest.
   * Control's loop moves the stop on. The owner's alone.
   */
  stop(rig: string, by: string): Promise<RunpodRigView> {
    return this.ask(rig, (r, s, key) => this.life.beginStop(r, s, key, by, "owner"));
  }

  /** Starts a stopped pod now; refused, in words, when RunPod has no GPU free for it. */
  start(rig: string, by: string): Promise<RunpodRigView> {
    return this.ask(rig, (r, s, key) => this.life.start(r, s, key, by));
  }

  /**
   * Starts the rig's pod when it is stopped, before a run is assigned or resumed on it (issue.ts's
   * issueWaking): the command then waits until the pod runs and the rig fetches it. `why` says
   * what for, in the history and the audit log ("to assign run x"). Null when nothing was needed:
   * the rig is not one control follows on RunPod, or its pod runs or is starting. Throws, in
   * words, when a stop or a terminate is under way, or when the start is refused (the spend limit
   * reached, no GPU free at RunPod, a full reset under way).
   */
  wake(rig: string, by: string, why?: string): Promise<string | null> {
    if (!this.store.runpod.rig(rig)?.active) return Promise.resolve(null);
    return this.locked(rig, async () => {
      const r = this.store.runpod.rig(rig);
      if (!r?.active) return null;
      const s = r.state as RigState;
      if (s.op?.kind === "stop")
        throw new Error(
          `a stop of ${rig}'s pod is under way: wait until it has stopped, then start the run again (control then starts the pod first)`,
        );
      if (s.op?.kind === "terminate")
        throw new Error(`a terminate of ${rig}'s pod is under way: wait until it ends`);
      if (s.op || s.status !== "EXITED") return null;
      const key = this.key(r.cloud);
      if (!key)
        throw new Error(
          `the GPU cloud "${r.cloud}" was deleted, so control can't start pod ${r.pod}: see RunPod's console`,
        );
      const before = JSON.stringify(s);
      try {
        await this.life.start(r, s, key, by, why);
      } finally {
        if (JSON.stringify(s) !== before) saveRunpodRig(this.store, rig, s, r.active);
      }
      return `${rig}'s pod was stopped: control started it. The run starts once the pod runs.`;
    });
  }

  /** Stops the pod and starts it again (no export: its volume stays). */
  restart(rig: string, by: string): Promise<RunpodRigView> {
    return this.ask(rig, (r, s, key) => this.life.restart(r, s, key, by));
  }

  /**
   * Terminates a rig's pod once every result has left it. `confirm` must be "terminate <rig>".
   * Refused, and the pod left running with its runs paused, when a result can't leave.
   */
  terminate(rig: string, by: string, confirm: string): Promise<RunpodRigView> {
    if (confirm !== `terminate ${rig}`)
      return Promise.reject(new Error(`confirm with "terminate ${rig}"`));
    return this.ask(rig, async (r, s, key) => {
      await this.life.beginTerminate(r, s, key, by);
    });
  }

  /**
   * The rig's history: its launch, stops, starts, resets and the rest, oldest first, each RunPod
   * step also in words (null for another kind of step, such as a model download).
   */
  history(rig: string) {
    return this.store.rigHistory
      .list(rig)
      .map((e) => ({ ...e, words: RUNPOD_STEP_WORDS[e.step] ?? null }));
  }

  /**
   * Reads the rig's pod log from RunPod with the cloud's key (podLogs): its newest lines, from
   * the container and RunPod's host, each through redact(). The last read of each rig is kept in
   * memory, with why it failed if it did, for the rig's page; nothing is written to the store.
   * Reads asked for while the same one is under way share it.
   */
  logs(
    rig: string,
    o: { tail?: number | undefined; source?: "container" | "system" | undefined } = {},
  ): Promise<PodLogRead> {
    const r = this.store.runpod.rig(rig);
    if (!r) return Promise.reject(new Error(`no rig ${rig} on a GPU cloud`));
    const k = `${rig}\n${o.tail ?? ""}\n${o.source ?? ""}`;
    const going = this.logReads.get(k);
    if (going) return going;
    const read = (async (): Promise<PodLogRead> => {
      const key = this.key(r.cloud);
      const source = o.source ?? null;
      try {
        if (!key)
          throw new Error(
            `the GPU cloud "${r.cloud}" was deleted, so control can't read pod ${r.pod}'s log`,
          );
        const lines = await podLogs(key, r.pod, { ...o, ...this.logTimes }, this.fetchImpl);
        const out = { rig, pod: r.pod, lines, read_at: this.iso() };
        this.lastLogs.set(rig, { ...out, source, error: null });
        return out;
      } catch (err) {
        const error = redact(errorText(err));
        this.lastLogs.set(rig, { rig, pod: r.pod, lines: [], read_at: this.iso(), source, error });
        throw new Error(error);
      }
    })();
    this.logReads.set(k, read);
    const done = () => {
      if (this.logReads.get(k) === read) this.logReads.delete(k);
    };
    read.then(done, done);
    return read;
  }

  /** The last read of the rig's pod log since control started, or why it failed; none: not read. */
  lastLog(rig: string): KeptPodLog | undefined {
    return this.lastLogs.get(rig);
  }

  view(rig: string): RunpodRigView | undefined {
    const r = this.store.runpod.rig(rig);
    return r ? runpodRigView(r, this.store.tunnels.get(rig), this.now()) : undefined;
  }

  list(cloud?: string): RunpodRigView[] {
    return this.store.runpod
      .rigs({ cloud })
      .map((r) => runpodRigView(r, this.store.tunnels.get(r.rig), this.now()));
  }
}
