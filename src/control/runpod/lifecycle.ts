import { log, redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { OpKind, OpPhase, RigOp, StopWhy } from "../../core/api/control/runpod.ts";
import { harnessConfirmed, issueCommand } from "../issue/index.ts";
import { exportLeft, resultsLeft } from "../results-left.ts";
import type { ControlStore, StoredRunpodRig } from "../store/index.ts";
import { rigView } from "../views/index.ts";
import { getPod, podAction, type RunpodPod, RunpodRefused, terminatePod } from "./cloud.ts";
import { type RigState, spentBy } from "./rig-view.ts";

/**
 * The lifecycle of a rig on RunPod (goal 023): stop, start, restart and terminate, mapped to
 * RunPod's API, with the rig's results first. RunpodRigs (runpod/rigs.ts) starts each one when
 * the owner asks, or when a limit the owner set is reached, and moves it on in control's loop;
 * lifecycle.ts's RunpodDriver offers them beside the compose and Kubernetes drivers, and its full
 * reset keeps the pod.
 *
 * - **Stop** pauses the rig's running runs, asks for an export, and stops the pod once that export
 *   and every result waiting with it have left the pod, or after STOP_WAIT_MS: a stopped pod keeps
 *   its volume, so what could not leave stays there. RunPod stops billing the GPU.
 * - **Start** asks RunPod to start the pod again, and says so in words when RunPod has no GPU free
 *   for it. Once the pod runs, the runs the last stop paused are resumed.
 * - **Restart** stops the pod and starts it again, with no export: its volume stays.
 * - **Terminate** pauses the runs, waits until no judge job and no command waits, asks for a full
 *   export, and removes the pod only when every result has left it (results-left.ts). When one
 *   can't leave, it refuses, and the pod keeps running with its runs paused.
 *
 * Each change is a step in the rig's history (rig_setup_event) and in control's audit log.
 */

export type { OpKind, OpPhase, RigOp, StopWhy };

/** A stop waits this long at most for the results to leave; the volume keeps the rest. */
export const STOP_WAIT_MS = 15 * 60_000;
/** How long each step of a terminate may wait before the terminate is refused. */
const TERMINATE_WAIT_MS: Partial<Record<OpPhase, number>> = {
  quiescing: 60 * 60_000,
  exporting: 30 * 60_000,
  leaving: 60 * 60_000,
};

/** The steps of a RunPod rig's history, in words (the rig's page and MCP's rig_setup). */
export const RUNPOD_STEP_WORDS: Record<string, string> = {
  runpod_launched: "Launched on RunPod",
  runpod_stopping: "Stopping the pod: its runs paused, and its results sent out first",
  runpod_stopped: "Pod stopped: its GPU is no longer billed, and its volume stays",
  runpod_restarting: "Restarting the pod: it stops, then starts again",
  runpod_starting: "Pod started at RunPod: waiting for it to run",
  runpod_start_refused: "RunPod did not start the pod",
  runpod_running: "The pod runs again",
  runpod_terminating: "Terminating the pod: its runs paused, and every result sent out first",
  runpod_terminated: "Pod terminated: RunPod removed it and its volume, and the rig is retired",
  runpod_terminate_refused: "Not terminated: the pod keeps running, with its runs paused",
  runpod_gone: "RunPod no longer has the pod",
  runpod_leaf_address: "Control's bus dials the pod's leaf node at the address RunPod gave it",
  reset_requested: "Full reset asked: runs paused and every result sent out before the wipe",
  reset_done: "Full reset done: the rig's state is wiped, and the pod and its GPU stay",
  reset_failed: "Full reset failed: nothing was wiped, and its runs stay paused",
  reset_cancelled: "Full reset cancelled: nothing was wiped, and its runs stay paused",
};

const OP_WORDS: Record<OpKind, string> = {
  stop: "a stop",
  start: "a start",
  restart: "a restart",
  terminate: "a terminate",
};

const money = (usd: number) => `$${usd.toFixed(2)}`;
const isStopped = (status: string) => status === "EXITED";

/** The harness of this rig has sent control a signed report: only then can it hold results. */
export function harnessReported(store: ControlStore, rig: string): boolean {
  const u = store.reportedRigs.list({ withRetired: true }).find((x) => x.id === rig);
  return Boolean(u && Date.parse(u.last_seen) > 0);
}

/**
 * Why a full reset of this RunPod rig can't start now, or undefined when it can (or when the rig
 * is not on RunPod). The reset needs the pod running, to send its results out and take the wipe.
 */
export function runpodResetRefusal(store: ControlStore, rig: string): string | undefined {
  const r = store.runpod.rig(rig);
  if (!r) return undefined;
  const s = r.state as RigState;
  if (!r.active) return `${rig}'s pod is gone: there is nothing to reset`;
  if (s.op) return `${OP_WORDS[s.op.kind]} of ${rig} is under way: wait until it ends`;
  if (isStopped(s.status))
    return `${rig}'s pod is stopped: start it first, so its results can leave it before the wipe`;
  return undefined;
}

/** When RunPod would not start a pod because it has no GPU free for it, in words; else undefined. */
export function noFreeGpu(err: unknown): string | undefined {
  if (!(err instanceof RunpodRefused)) return undefined;
  return /not enough (free )?gpus?|no (free |available )?gpus?|gpus? (is |are )?not available|insufficient|capacity|no (longer )?(any )?instances? (are )?available/i.test(
    err.message,
  )
    ? err.message
    : undefined;
}

export class RunpodLifecycle {
  private readonly store: ControlStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly privateKeyPem: string | undefined;
  private readonly staleAfterMs: number;

  constructor(o: {
    store: ControlStore;
    fetch: typeof fetch;
    now: () => number;
    /** Control's command-signing key: stops and terminates pause runs and ask for exports. */
    privateKeyPem: string | undefined;
    staleAfterMs: number;
  }) {
    this.store = o.store;
    this.fetchImpl = o.fetch;
    this.now = o.now;
    this.privateKeyPem = o.privateKeyPem;
    this.staleAfterMs = o.staleAfterMs;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private history(rig: string, step: string, ok: boolean, detail?: string): void {
    this.store.rigHistory.add(rig, step, ok, detail);
  }

  /** A signed command to the rig, as `by`. Throws, in words, when control can't sign here. */
  private issue(
    rig: string,
    kind: "pause_run" | "resume_run" | "export_now",
    payload: unknown,
    by: string,
    ttlMinutes = 30,
  ): string {
    if (!this.privateKeyPem)
      throw new Error("control has no command-signing key here, so it can't pause runs or export");
    return issueCommand(this.store, this.privateKeyPem, {
      rig,
      kind,
      payload,
      ttlMinutes,
      issuedBy: by,
    }).id;
  }

  /** The runs running on the rig now, as its signed reports say. */
  private runningRuns(rig: string): string[] {
    const v = rigView(this.store, rig, { staleAfterMs: this.staleAfterMs, now: this.now() });
    return (v?.runs ?? []).filter((x) => x.status === "running").map((x) => x.id);
  }

  /**
   * Why a new change can't start on this rig now, or undefined. A limit's stop goes ahead during
   * a full reset: the owner's limit comes first, and the reset waits for the pod or fails.
   */
  private busy(r: StoredRunpodRig, s: RigState, duringReset = false): string | undefined {
    if (!r.active) return `${r.rig}'s pod is gone: RunPod no longer has it`;
    if (s.op) return `${OP_WORDS[s.op.kind]} of ${r.rig} is under way: wait until it ends`;
    if (duringReset) return undefined;
    const reset = this.store.fullResets.open(r.rig);
    if (reset)
      return `a full reset of ${r.rig} is under way (${String(reset.state)}): cancel it, or wait until it ends`;
    return undefined;
  }

  /** A new change to the pod begins: the last refusal is no longer news. */
  private begin(s: RigState): void {
    s.refusal = null;
  }

  private newOp(kind: OpKind, by: string, why: StopWhy | null, phase: OpPhase): RigOp {
    const at = this.iso();
    return { kind, by, why, phase, at, phase_at: at, command: null, export: null, paused: [] };
  }

  private phase(op: RigOp, phase: OpPhase): void {
    op.phase = phase;
    op.phase_at = this.iso();
  }

  /** Pauses the rig's running runs, with the reason; the ids it paused. */
  private pauseRuns(rig: string, by: string, reason: string): string[] {
    const runs = this.runningRuns(rig);
    for (const run of runs) this.issue(rig, "pause_run", { run, reason }, by);
    return runs;
  }

  // ------------------------------------------------------------------ the owner's asks

  /**
   * Begins a stop: pauses the running runs and asks for an export, or, for a rig whose harness
   * never reported (it holds no result), stops the pod at once. Throws, in words, when it can't.
   */
  async beginStop(r: StoredRunpodRig, s: RigState, key: string, by: string, why: StopWhy) {
    const refused = this.busy(r, s, why !== "owner");
    if (refused) throw new Error(refused);
    if (isStopped(s.status)) throw new Error(`${r.rig}'s pod is stopped already`);
    this.begin(s);
    const words =
      why === "owner"
        ? `asked by ${by}`
        : why === "spend_limit"
          ? `it had cost ${money(spentBy(s, this.now()))}, which reached the spend limit you set (${money(s.spend_limit_usd ?? 0)})`
          : `no run was at work on it for ${s.idle_stop_minutes} minutes, the idle stop you set`;
    if (why === "owner") this.store.auditLog.add(by, "runpod_rig_stop", { rig: r.rig, pod: r.pod });
    if (!harnessReported(this.store, r.rig)) {
      this.history(
        r.rig,
        "runpod_stopping",
        true,
        `${words}; its harness never reported, so it holds no result`,
      );
      await this.stopPod(r, s, key, why, by, "it held no result");
      return;
    }
    const op = this.newOp("stop", by, why, "exporting");
    op.paused = this.pauseRuns(
      r.rig,
      by,
      why === "owner" ? "the owner stops the rig's pod" : `control stops the rig's pod: ${words}`,
    );
    op.command = this.issue(r.rig, "export_now", { full: false }, by);
    s.op = op;
    this.history(
      r.rig,
      "runpod_stopping",
      true,
      `${words}; ${op.paused.length ? `runs paused: ${op.paused.join(", ")}` : "no run was running"}; an export asked`,
    );
  }

  /**
   * Starts a stopped pod now. Refused, in words, when RunPod has no GPU free for it, and while the
   * pod has cost its spend limit. Once it runs, the runs the last stop paused are resumed. `note`
   * says what the start is for, when a run's assignment asked for it ("to assign run x").
   */
  async start(
    r: StoredRunpodRig,
    s: RigState,
    key: string,
    by: string,
    note?: string,
  ): Promise<void> {
    const refused = this.busy(r, s);
    if (refused) throw new Error(refused);
    if (!isStopped(s.status))
      throw new Error(`${r.rig}'s pod is not stopped: RunPod says it is ${s.status}`);
    const spent = spentBy(s, this.now());
    if (s.spend_limit_usd !== null && spent >= s.spend_limit_usd)
      throw new Error(
        `${r.rig} has cost ${money(spent)}, which is at its spend limit (${money(s.spend_limit_usd)}): raise or clear the limit first`,
      );
    this.begin(s);
    this.store.auditLog.add(by, "runpod_rig_start", {
      rig: r.rig,
      pod: r.pod,
      ...(note ? { note } : {}),
    });
    const op = this.newOp("start", by, null, "starting");
    if (note) op.note = note;
    await this.startPod(r, s, key, op);
  }

  /** Restarts the pod: a stop with no export (its volume stays), then a start. */
  async restart(r: StoredRunpodRig, s: RigState, key: string, by: string): Promise<void> {
    const refused = this.busy(r, s);
    if (refused) throw new Error(refused);
    if (isStopped(s.status))
      throw new Error(`${r.rig}'s pod is stopped: start it instead of restarting it`);
    this.begin(s);
    this.store.auditLog.add(by, "runpod_rig_restart", { rig: r.rig, pod: r.pod });
    await podAction(key, r.pod, "stop", this.fetchImpl);
    this.billStop(s);
    s.status = "EXITED";
    s.op = this.newOp("restart", by, null, "stopping");
    this.history(r.rig, "runpod_restarting", true, `asked by ${by}; RunPod stops the pod`);
  }

  /**
   * Begins a terminate. A running pod: its runs paused, then the wait for its judge jobs and
   * commands, then a full export. A stopped one is removed only when its results left it before it
   * stopped. Throws, in words, when it can't begin.
   */
  async beginTerminate(r: StoredRunpodRig, s: RigState, key: string, by: string) {
    const refused = this.busy(r, s);
    if (refused) throw new Error(refused);
    this.begin(s);
    this.store.auditLog.add(by, "runpod_rig_terminate", { rig: r.rig, pod: r.pod });
    if (!harnessReported(this.store, r.rig)) {
      this.history(
        r.rig,
        "runpod_terminating",
        true,
        `asked by ${by}; its harness never reported, so it holds no result`,
      );
      return this.terminate(r, s, key, by, "its harness never reported, so it held no result");
    }
    if (isStopped(s.status)) {
      const left =
        s.last_export && s.last_export_left
          ? resultsLeft(this.store, r.rig, { export: s.last_export })
          : undefined;
      if (!left?.left)
        throw new Error(
          `${r.rig}'s pod is stopped, and results may wait on its volume${left ? ` (${left.why})` : " (they did not all leave when it stopped)"}: start it, so they can leave, then terminate it`,
        );
      this.history(r.rig, "runpod_terminating", true, `asked by ${by}; ${left.why}`);
      return this.terminate(r, s, key, by, left.why);
    }
    const op = this.newOp("terminate", by, null, "quiescing");
    op.paused = this.pauseRuns(r.rig, by, "the owner terminates the rig's pod");
    s.op = op;
    s.paused_runs = [...new Set([...(s.paused_runs ?? []), ...op.paused])];
    this.history(
      r.rig,
      "runpod_terminating",
      true,
      `asked by ${by}; ${op.paused.length ? `runs paused: ${op.paused.join(", ")}` : "no run was running"}`,
    );
  }

  // ------------------------------------------------------------------ control's loop

  /**
   * Moves the change under way on one rig on, with its pod as RunPod has it now. False once the
   * pod is terminated: control no longer follows it.
   */
  async step(r: StoredRunpodRig, s: RigState, key: string, pod: RunpodPod): Promise<boolean> {
    const op = s.op;
    if (!op) return true;
    const nowMs = this.now();
    const waited = nowMs - Date.parse(op.phase_at);
    switch (op.phase) {
      case "stopping": {
        // A restart: RunPod stopped the pod; now it starts again.
        if (!isStopped(pod.status)) return true;
        await this.startPod(r, s, key, op);
        return true;
      }
      case "starting": {
        if (pod.status === "RUNNING") this.running(r, s, pod, op);
        else if (isStopped(pod.status) || pod.status === "ERROR") {
          s.op = null;
          this.history(
            r.rig,
            "runpod_start_refused",
            false,
            `RunPod says the pod is ${pod.status} after the start`,
          );
          this.store.auditLog.add("control", "runpod_rig_start_refused", {
            rig: r.rig,
            pod: r.pod,
            why: `the pod is ${pod.status}`,
          });
        }
        return true;
      }
      case "quiescing": {
        const v = rigView(this.store, r.rig, { staleAfterMs: this.staleAfterMs, now: nowMs });
        const busy = Number(v?.jobs.queued ?? 0) + Number(v?.jobs.leased ?? 0);
        const pending = this.store.commands.pending(r.rig).length;
        if (busy > 0 || pending > 0) {
          if (waited > (TERMINATE_WAIT_MS.quiescing ?? 0))
            this.refuseTerminate(
              r,
              s,
              `after ${Math.round(waited / 60_000)} minutes, ${busy} judge job(s) and ${pending} command(s) still wait on the rig`,
            );
          return true;
        }
        op.command = this.issue(r.rig, "export_now", { full: true }, op.by);
        this.phase(op, "exporting");
        return true;
      }
      case "exporting": {
        const c = op.command ? this.store.commands.get(op.command) : undefined;
        const done = c && c.status !== "pending" && harnessConfirmed(c.outcome);
        const name = done
          ? (c.outcome as { result?: { export?: string } } | null)?.result?.export
          : undefined;
        if (done && c.status === "delivered" && name) {
          op.export = name;
          this.phase(op, "leaving");
          return this.leave(r, s, key, op);
        }
        const failed =
          done || c?.status === "expired"
            ? `the export did not complete (${c?.status})`
            : !c
              ? "control lost the export's command"
              : undefined;
        if (op.kind === "stop") {
          if (failed || nowMs - Date.parse(op.at) > STOP_WAIT_MS)
            await this.stopPod(
              r,
              s,
              key,
              op.why ?? "owner",
              op.by,
              `${failed ?? "no export within 15 minutes"}: what it had not sent out stays on its volume`,
            );
        } else if (failed) this.refuseTerminate(r, s, failed);
        else if (waited > (TERMINATE_WAIT_MS.exporting ?? 0))
          this.refuseTerminate(r, s, `no export within ${Math.round(waited / 60_000)} minutes`);
        return true;
      }
      case "leaving":
        return this.leave(r, s, key, op);
    }
  }

  /** Waits until the op's export and every result with it have left the pod, then acts. */
  private async leave(r: StoredRunpodRig, s: RigState, key: string, op: RigOp): Promise<boolean> {
    const name = op.export as string;
    const all = resultsLeft(this.store, r.rig, { export: name });
    const never = exportLeft(this.store, r.rig, name).never;
    const nowMs = this.now();
    if (op.kind === "stop") {
      if (all.left) {
        await this.stopPod(r, s, key, op.why ?? "owner", op.by, all.why, name, true);
      } else if (never || nowMs - Date.parse(op.at) > STOP_WAIT_MS) {
        await this.stopPod(
          r,
          s,
          key,
          op.why ?? "owner",
          op.by,
          `${all.why}: what did not leave stays on its volume`,
          name,
          false,
        );
      }
      return true;
    }
    if (all.left) return this.terminate(r, s, key, op.by, all.why);
    if (never) this.refuseTerminate(r, s, all.why);
    else if (nowMs - Date.parse(op.phase_at) > (TERMINATE_WAIT_MS.leaving ?? 0))
      this.refuseTerminate(
        r,
        s,
        `${all.why}, still after ${Math.round((nowMs - Date.parse(op.phase_at)) / 60_000)} minutes`,
      );
    return true;
  }

  /** Stops the pod at RunPod: its GPU is no longer billed, its volume stays. */
  private async stopPod(
    r: StoredRunpodRig,
    s: RigState,
    key: string,
    why: StopWhy,
    by: string,
    results: string,
    exportName?: string,
    left?: boolean,
  ): Promise<void> {
    await podAction(key, r.pod, "stop", this.fetchImpl);
    const spent = this.billStop(s);
    s.status = "EXITED";
    s.stopped_at = this.iso();
    s.stopped_by = why;
    s.paused_runs = [...new Set([...(s.paused_runs ?? []), ...(s.op?.paused ?? [])])];
    s.last_export = exportName ?? null;
    s.last_export_left = left ?? false;
    s.op = null;
    if (why === "spend_limit")
      s.notes.push(
        `Stopped by control: it had cost ${money(spent)}, which reached the spend limit you set (${money(s.spend_limit_usd ?? 0)}). Its volume stays.`,
      );
    else if (why === "idle_stop")
      s.notes.push(
        `Stopped by control: no run was at work on it for ${s.idle_stop_minutes} minutes, the idle stop you set. Its volume stays.`,
      );
    this.history(r.rig, "runpod_stopped", true, results);
    this.store.auditLog.add(why === "owner" ? by : "control", "runpod_rig_stopped", {
      rig: r.rig,
      pod: r.pod,
      why,
      spend_usd: Math.round(spent * 100) / 100,
    });
  }

  /** Asks RunPod to start the pod; refused in words when it has no GPU free. */
  private async startPod(r: StoredRunpodRig, s: RigState, key: string, op: RigOp): Promise<void> {
    try {
      await podAction(key, r.pod, "start", this.fetchImpl);
    } catch (err) {
      const busy = noFreeGpu(err);
      const why = busy
        ? `RunPod has no free GPU for pod ${r.pod} now, so the pod stays stopped (${busy}). Its volume stays. Try again later, or terminate it and launch a new rig`
        : `RunPod would not start pod ${r.pod}: ${redact(errorText(err))}. It stays stopped, with its volume`;
      s.op = null;
      if (op.kind === "restart") {
        s.stopped_at = this.iso();
        s.stopped_by = "owner";
      }
      this.history(r.rig, "runpod_start_refused", false, why);
      this.store.auditLog.add("control", "runpod_rig_start_refused", {
        rig: r.rig,
        pod: r.pod,
        why,
      });
      if (op.kind === "start") throw new Error(why);
      return;
    }
    const now = this.iso();
    s.billed_since = now;
    s.stopped_at = null;
    s.stopped_by = null;
    this.phase(op, "starting");
    s.op = op;
    this.history(
      r.rig,
      "runpod_starting",
      true,
      `asked by ${op.by}${op.note ? ` ${op.note}` : ""}`,
    );
    // What RunPod says now: the pod may run at once.
    const pod = await getPod(key, r.pod, this.fetchImpl).catch((e) => {
      log(
        "control",
        "could not read a pod after its start",
        {
          pod: r.pod,
          error: redact(errorText(e)),
        },
        "warn",
      );
      return undefined;
    });
    if (pod) {
      s.status = pod.status;
      if (pod.status === "RUNNING") this.running(r, s, pod, op);
    }
  }

  /** The pod runs again: the start is done, and the runs the last stop paused are resumed. */
  private running(r: StoredRunpodRig, s: RigState, pod: RunpodPod, op: RigOp): void {
    s.op = null;
    s.running_since = this.iso();
    const said: string[] = [`with ${pod.gpus} GPU${pod.gpus === 1 ? "" : "s"}`];
    const resumed: string[] = [];
    const failed: string[] = [];
    for (const run of s.paused_runs ?? []) {
      try {
        // A day to deliver: the rig's harness starts again first.
        this.issue(r.rig, "resume_run", { run }, op.by, 24 * 60);
        resumed.push(run);
      } catch (err) {
        failed.push(`${run} (${errorText(err)})`);
      }
    }
    s.paused_runs = [];
    if (resumed.length) said.push(`runs resumed: ${resumed.join(", ")}`);
    if (failed.length) said.push(`not resumed: ${failed.join("; ")}`);
    const short = pod.gpus < s.gpu_count;
    if (short)
      said.push(
        `not the ${s.gpu_count} it was launched with: RunPod had no more free for it. Stop it and start it again later, or terminate it`,
      );
    this.history(r.rig, "runpod_running", !short && !failed.length, said.join("; "));
    this.store.auditLog.add("control", "runpod_rig_started", {
      rig: r.rig,
      pod: r.pod,
      gpus: pod.gpus,
      resumed,
    });
  }

  /** Removes the pod at RunPod for good, then retires the rig. */
  private async terminate(
    r: StoredRunpodRig,
    s: RigState,
    key: string,
    by: string,
    results: string,
  ): Promise<boolean> {
    await terminatePod(key, r.pod, this.fetchImpl);
    const spent = this.billStop(s);
    const now = this.iso();
    s.status = "TERMINATED";
    s.ended_at = now;
    s.running_since = null;
    s.op = null;
    s.notes.push(`Terminated by ${by}: ${results}.`);
    this.history(r.rig, "runpod_terminated", true, results);
    this.store.auditLog.add(by, "runpod_rig_terminated", {
      rig: r.rig,
      pod: r.pod,
      spend_usd: Math.round(spent * 100) / 100,
    });
    // Nothing reaches the pod any more: control stops connecting to it, and its records stay.
    if (!this.store.retired.get(r.rig)) this.store.retired.add(r.rig, by);
    return false;
  }

  /**
   * A terminate that can't go on: the pod keeps running, with its runs paused. The refusal stays
   * on the rig until the owner's next change to the pod, or a newer step in its history.
   */
  private refuseTerminate(r: StoredRunpodRig, s: RigState, why: string): void {
    s.op = null;
    const words = `${why}. The pod keeps running, with its runs paused: resume them, or fix what keeps the results on the pod and terminate it again`;
    this.history(r.rig, "runpod_terminate_refused", false, words);
    s.refusal = {
      words: `Not terminated: ${words}`,
      steps: this.store.rigHistory.list(r.rig).length,
    };
    this.store.auditLog.add("control", "runpod_rig_terminate_refused", {
      rig: r.rig,
      pod: r.pod,
      why,
    });
  }

  /** The pod stops costing now: what it cost so far is kept. No run works on a stopped pod. */
  private billStop(s: RigState): number {
    const spent = spentBy(s, this.now());
    s.spent_usd = spent;
    s.billed_since = null;
    s.running_since = null;
    s.at_work = false;
    return spent;
  }
}
