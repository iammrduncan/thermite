import { randomBytes } from "node:crypto";
import { log, redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { SecretBox } from "../secrets.ts";
import type { ControlStore, StoredRunpodTest } from "../store/index.ts";
import {
  createPod,
  getPod,
  podAction,
  podPortUrl,
  type RunpodFacts,
  type RunpodGpu,
  readRunpod,
  terminatePod,
} from "./cloud.ts";
import { PROBE_CMD, PROBE_PORT, probeEnv } from "./probe.ts";

/**
 * Test pods on RunPod, started by the owner or an operator (dashboard, REST or MCP): one pod of
 * Thermite's harness image with the probe (runpod/probe.ts) in place of the broker. Control
 * follows it in steps (`advance`, every few seconds): it waits for the pod to run, reads the
 * probe's report through RunPod's HTTP proxy, optionally stops the pod and starts it again (does
 * it get its GPU back?), and then removes it. Control removes the pod at the end of every path,
 * on an error too; the owner's own limit, when set, ends it early. Nothing else ends it: no
 * limit is set for the owner.
 */

/** The harness images are CUDA 12.6; RunPod places the pod only on hosts whose driver runs it. */
const MIN_CUDA = "12.6";
export const DEFAULT_DISK_GB = 40;

export type TestPhase =
  | "starting"
  | "first_report"
  | "stopping"
  | "restarting"
  | "second_report"
  | "ending"
  | "done";

export const PHASE_WORDS: Record<TestPhase, string> = {
  starting: "starting the pod",
  first_report: "the pod runs: waiting for its report",
  stopping: "stopping the pod, to see that it gets its GPU back when started again",
  restarting: "starting the pod again",
  second_report: "waiting for its report after the restart",
  ending: "removing the pod",
  done: "done: the pod is removed",
};

/** What the owner or an operator asks for; everything has a default but the limit. */
export interface TestRequest {
  /** A GPU type's id or name; default: the cheapest in stock on the chosen cloud. */
  gpu?: string | undefined;
  cloud_type?: "SECURE" | "COMMUNITY" | undefined;
  /** Default: control's THERMITE_RUNPOD_TEST_IMAGE. */
  image?: string | undefined;
  disk_gb?: number | undefined;
  /** Stop the pod and start it again after the first report (default: yes). */
  restart?: boolean | undefined;
  /** Remove the pod after this many minutes, whatever it is doing. None unless given. */
  stop_after_minutes?: number | undefined;
}

export interface TestState {
  image: string;
  gpu: string;
  gpu_name: string;
  cloud_type: "SECURE" | "COMMUNITY";
  disk_gb: number;
  restart: boolean;
  stop_after_minutes: number | null;
  /** USD per hour, RunPod's price for the pod. */
  price_per_hr: number | null;
  /** The secret path the report is served under (RunPod's proxy is public). */
  token: string;
  pod_id: string;
  datacenter: string;
  phase: TestPhase;
  started_at: string;
  running_at?: string | undefined;
  first_report_at?: string | undefined;
  restart_at?: string | undefined;
  second_report_at?: string | undefined;
  ended_at?: string | undefined;
  /** Billed run time so far, and since when the current run is billed. */
  billed_ms: number;
  billed_since: string | null;
  report?: unknown;
  report_after_restart?: unknown;
  gpus_after_restart?: number | undefined;
  /** Why the test ended early, in words. */
  error?: string | undefined;
  notes: string[];
}

export interface TestView extends TestState {
  id: string;
  cloud: string;
  active: boolean;
  created_by: string;
  phase_words: string;
  cost_usd: number | null;
  findings: string[];
  outcome: "running" | "passed" | "failed" | "ended";
}

const NEEDED_CAPS = ["chown", "dac_override", "fowner", "kill", "setgid", "setuid"];

/** The cheapest GPU type on that cloud that RunPod has in stock (Secure stock only is listed). */
export function cheapestGpu(
  facts: RunpodFacts,
  cloud: "SECURE" | "COMMUNITY",
): RunpodGpu | undefined {
  const price = (g: RunpodGpu) => (cloud === "SECURE" ? g.price_secure : g.price_community);
  return facts.gpus
    .filter((g) => (cloud === "SECURE" ? g.secure : g.community) && price(g) !== null)
    .filter((g) => cloud === "COMMUNITY" || g.availability !== "NONE")
    .sort((a, b) => (price(a) ?? 1e9) - (price(b) ?? 1e9))[0];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const stepOf = (report: unknown, name: string) => obj(obj(obj(report).steps)[name]);

/** What the reports say, in words, for the owner. */
export function findings(s: TestState): string[] {
  const out: string[] = [];
  const r = s.report;
  if (!r) return out;
  const caps = stepOf(r, "capabilities");
  const eff = (obj(caps.value).effective as string[] | undefined) ?? [];
  const machine = obj(stepOf(r, "machine").value);
  out.push(
    machine.uid === 0
      ? "Runs as root."
      : `Does not run as root (uid ${String(machine.uid ?? "?")}): the broker can't work.`,
  );
  const missing = NEEDED_CAPS.filter((c) => !eff.includes(c));
  out.push(
    missing.length
      ? `Missing capabilities the broker needs: ${missing.join(", ")}.`
      : `Has every capability the broker needs (${NEEDED_CAPS.join(", ")}).`,
  );
  if (obj(caps.value).no_new_privs === true) out.push("no_new_privs is set.");
  const gpus = stepOf(r, "gpus");
  out.push(
    gpus.ok
      ? `GPU: ${String(obj(gpus.value).detail ?? obj(gpus.value).list ?? "")}.`
      : `nvidia-smi failed: ${String(gpus.error ?? "")}.`,
  );
  const chown = obj(stepOf(r, "device_chown").value);
  const chownBad = Object.entries(chown).filter(([, v]) => v !== "ok");
  out.push(
    Object.keys(chown).length === 0
      ? "No GPU device node was found to give to a group."
      : chownBad.length
        ? `The GPU device nodes keep the owner and mode they came with (${chownBad.map(([k, v]) => `${k} ${String(v)}`).join(", ")}): only the GPU fence can keep roles off them.`
        : "The GPU device nodes can be given to a group, mode 0660.",
  );
  const fence = obj(stepOf(r, "gpu_fence").value);
  if (fence.landlock_abi !== undefined)
    out.push(
      Number(fence.landlock_abi) > 0
        ? `Landlock ABI ${String(fence.landlock_abi)}: a fenced role's open of a card was ${String(fence.lane_opens_card)}.`
        : "No Landlock here: the GPU fence can't work, so a rig would not time or run development runs.",
    );
  const temp = obj(stepOf(r, "temp_modes").value);
  const tempBad = Object.entries(temp).filter(([, v]) => v !== "ok");
  out.push(
    tempBad.length
      ? `Setting /tmp and /dev/shm to 1770 failed: ${tempBad.map(([k, v]) => `${k} ${String(v)}`).join(", ")}.`
      : "/tmp and /dev/shm can be set to 1770.",
  );
  const vars = obj(stepOf(r, "runpod_variables").value);
  const names = (vars.in_environment as string[] | undefined) ?? [];
  out.push(
    names.length
      ? `RunPod sets ${names.length} variables: ${names.join(", ")}.`
      : vars.removed_by_entry_point === true
        ? "RunPod's variables reach no process: the image's entry point took them out."
        : "RunPod sets no RUNPOD_ variables in the container's environment.",
  );
  const role = stepOf(r, "role_reads_runpod_variables");
  const rv = obj(role.value);
  const pid1 = rv.pid1;
  const leaks = [
    ...(Array.isArray(pid1) && pid1.length ? [`PID 1's environment (${pid1.join(", ")})`] : []),
    ...(Array.isArray(rv.own) && rv.own.length ? ["its own environment"] : []),
    ...Object.entries(rv)
      .filter(([k, v]) => k.startsWith("/etc/") && typeof v === "string" && /^[1-9]/.test(v))
      .map(([k]) => k),
  ];
  out.push(
    !role.ok
      ? `The check as a role's user failed: ${String(role.error ?? "")}.`
      : leaks.length
        ? `A role's user can read RunPod's variables in: ${leaks.join("; ")}.`
        : "A role's user reads none of RunPod's variables.",
  );
  const net = obj(stepOf(r, "outbound_https").value);
  const failed = Object.entries(net).filter(([, v]) => obj(v).error !== undefined);
  out.push(
    failed.length
      ? `Outbound HTTPS failed for: ${failed.map(([u, v]) => `${u} (${String(obj(v).error)})`).join(", ")}.`
      : `Outbound HTTPS reached all ${Object.keys(net).length} addresses tried.`,
  );
  const st = stepOf(r, "isolation_selftest");
  const sv = obj(st.value);
  out.push(
    !st.ok
      ? `The isolation self-test could not run: ${String(st.error ?? "")}.`
      : sv.passed === true
        ? "The isolation self-test passed."
        : `The isolation self-test failed (exit ${String(sv.exit)}).`,
  );
  if (s.running_at)
    out.push(
      `The pod ran ${minutes(Date.parse(s.running_at) - Date.parse(s.started_at))} after it was asked for${s.first_report_at ? `, and reported ${minutes(Date.parse(s.first_report_at) - Date.parse(s.running_at))} later` : ""}.`,
    );
  if (s.restart && s.restart_at)
    out.push(
      s.second_report_at
        ? `After a stop and a start it ran again with ${s.gpus_after_restart ?? "?"} GPU(s) and reported again.`
        : s.phase === "done"
          ? "After a stop and a start it did not report again."
          : "",
    );
  return out.filter(Boolean);
}

const minutes = (ms: number) =>
  ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`;

export class RunpodTests {
  private readonly store: ControlStore;
  private readonly secrets: SecretBox;
  private readonly fetchImpl: typeof fetch;
  private readonly image: string | undefined;
  private readonly now: () => number;
  private readonly busy = new Map<string, Promise<void>>();

  constructor(
    store: ControlStore,
    secrets: SecretBox,
    opts: { fetch?: typeof fetch; image?: string | undefined; now?: () => number } = {},
  ) {
    this.store = store;
    this.secrets = secrets;
    this.fetchImpl = opts.fetch ?? fetch;
    this.image = opts.image;
    this.now = opts.now ?? Date.now;
  }

  /** The image a test uses when none is given (control's THERMITE_RUNPOD_TEST_IMAGE). */
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

  /** Starts a test pod (billed from now). Throws, in words, when it can't. */
  async start(cloud: string, req: TestRequest, by: string): Promise<TestView> {
    const key = this.key(cloud);
    if (!key) throw new Error(`no GPU cloud "${cloud}"`);
    const running = this.store.runpod.tests({ cloud, active: true })[0];
    if (running)
      throw new Error(
        `test ${running.id} is still running on "${cloud}": end it first, or wait for it`,
      );
    const image = (req.image ?? this.image ?? "").trim();
    if (!image)
      throw new Error(
        "no image: give one, or set THERMITE_RUNPOD_TEST_IMAGE on control (an image RunPod can pull)",
      );
    const cloudType = req.cloud_type ?? "SECURE";
    const disk = req.disk_gb ?? DEFAULT_DISK_GB;
    if (!Number.isInteger(disk) || disk < 10 || disk > 2000)
      throw new Error("the disk is 10 to 2000 GB");
    const limit = req.stop_after_minutes;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 5))
      throw new Error("a limit is 5 minutes or more");
    // A fresh read: prices and stock change.
    const facts = await readRunpod(key, this.fetchImpl);
    this.store.gpuClouds.setFacts(cloud, { facts });
    const gpu = req.gpu
      ? facts.gpus.find((g) => g.id === req.gpu || g.name === req.gpu)
      : cheapestGpu(facts, cloudType);
    if (!gpu)
      throw new Error(
        req.gpu
          ? `RunPod lists no GPU type "${req.gpu}"`
          : `RunPod has no GPU type in stock on ${cloudType === "SECURE" ? "Secure" : "Community"} cloud`,
      );
    const id = `t-${randomBytes(4).toString("hex")}`;
    const token = randomBytes(24).toString("hex");
    const pod = await createPod(
      key,
      {
        name: `thermite-test-${id}`,
        image,
        gpu: gpu.id,
        gpuCount: 1,
        cloud: cloudType,
        diskGb: disk,
        minCudaVersion: MIN_CUDA,
        ports: [`${PROBE_PORT}/http`],
        env: probeEnv(token),
        cmd: PROBE_CMD,
      },
      this.fetchImpl,
    );
    const now = this.iso();
    const state: TestState = {
      image,
      gpu: gpu.id,
      gpu_name: gpu.name,
      cloud_type: cloudType,
      disk_gb: disk,
      restart: req.restart ?? true,
      stop_after_minutes: limit ?? null,
      price_per_hr:
        pod.cost_per_hr || (cloudType === "SECURE" ? gpu.price_secure : gpu.price_community),
      token,
      pod_id: pod.id,
      datacenter: pod.datacenter,
      phase: "starting",
      started_at: now,
      billed_ms: 0,
      billed_since: now,
      notes: [],
    };
    this.store.runpod.addTest({ id, cloud, state, by });
    this.store.auditLog.add(by, "runpod_test_started", {
      id,
      cloud,
      pod: pod.id,
      gpu: gpu.name,
      cloud_type: cloudType,
      price_per_hr: state.price_per_hr,
      image,
      stop_after_minutes: limit ?? null,
    });
    return this.view(id) as TestView;
  }

  /** Ends a test now: its pod is removed. */
  async end(id: string, by: string): Promise<TestView> {
    const t = this.store.runpod.test(id);
    if (!t) throw new Error(`no test ${id}`);
    if (t.active) {
      const s = t.state as TestState;
      if (s.phase !== "ending" && s.phase !== "done") {
        s.notes.push(`Ended by ${by} while ${PHASE_WORDS[s.phase]}.`);
        s.phase = "ending";
        this.store.runpod.saveTest(id, s, true);
      }
      this.store.auditLog.add(by, "runpod_test_ended", { id, cloud: t.cloud });
      await this.stepOnce(id);
    }
    return this.view(id) as TestView;
  }

  /** One step for every running test. Control calls it every few seconds. */
  async advance(): Promise<void> {
    for (const t of this.store.runpod.tests({ active: true, limit: 100 }))
      await this.stepOnce(t.id);
  }

  private async stepOnce(id: string): Promise<void> {
    const running = this.busy.get(id);
    if (running) return running;
    const p = this.step(id).finally(() => this.busy.delete(id));
    this.busy.set(id, p);
    return p;
  }

  private async step(id: string): Promise<void> {
    const t = this.store.runpod.test(id);
    if (!t?.active) return;
    const s = t.state as TestState;
    const key = this.key(t.cloud);
    if (!key) {
      s.error = `the GPU cloud "${t.cloud}" was deleted, so control can't reach pod ${s.pod_id}: remove it in RunPod's console`;
      s.phase = "done";
      this.store.runpod.saveTest(id, s, false);
      return;
    }
    const now = this.iso();
    const billStop = () => {
      if (s.billed_since) s.billed_ms += Date.parse(now) - Date.parse(s.billed_since);
      s.billed_since = null;
    };
    try {
      if (
        s.stop_after_minutes !== null &&
        s.phase !== "ending" &&
        Date.parse(now) - Date.parse(s.started_at) >= s.stop_after_minutes * 60_000
      ) {
        s.notes.push(`Ended at the ${s.stop_after_minutes}-minute limit you set.`);
        s.phase = "ending";
      }
      switch (s.phase) {
        case "starting":
        case "restarting": {
          const pod = await getPod(key, s.pod_id, this.fetchImpl);
          if (!pod) throw new Error("RunPod no longer has the pod");
          if (pod.status === "RUNNING") {
            if (s.phase === "starting") {
              s.running_at = now;
              s.phase = "first_report";
            } else {
              s.gpus_after_restart = pod.gpus;
              s.phase = "second_report";
            }
          } else if (pod.status === "ERROR" || pod.status === "TERMINATED") {
            throw new Error(`the pod is ${pod.status.toLowerCase()}`);
          }
          break;
        }
        case "first_report":
        case "second_report": {
          const report = await this.readReport(s);
          const r = obj(report);
          if (s.phase === "first_report") {
            if (report) s.report = report;
            if (r.phase === "done") {
              s.first_report_at = now;
              if (s.restart) {
                await podAction(key, s.pod_id, "stop", this.fetchImpl);
                billStop();
                s.phase = "stopping";
              } else s.phase = "ending";
            }
          } else if (report) {
            // The container started again, so whatever answers now is the new probe.
            s.report_after_restart = report;
            if (r.phase === "done") {
              s.second_report_at = now;
              s.phase = "ending";
            }
          }
          break;
        }
        case "stopping": {
          const pod = await getPod(key, s.pod_id, this.fetchImpl);
          if (!pod) throw new Error("RunPod no longer has the pod");
          if (pod.status === "EXITED") {
            try {
              await podAction(key, s.pod_id, "start", this.fetchImpl);
              s.restart_at = now;
              s.billed_since = now;
              s.phase = "restarting";
            } catch (err) {
              s.notes.push(`RunPod would not start the pod again: ${errorText(err)}.`);
              s.phase = "ending";
            }
          }
          break;
        }
        case "ending": {
          await terminatePod(key, s.pod_id, this.fetchImpl);
          billStop();
          s.ended_at = now;
          s.phase = "done";
          this.store.auditLog.add("control", "runpod_test_done", {
            id,
            cloud: t.cloud,
            cost_usd: costOf(s),
            error: s.error ?? null,
          });
          break;
        }
        case "done":
          break;
      }
    } catch (err) {
      // Any failure ends the test, and the pod with it.
      const why = redact(errorText(err));
      log("control", "runpod test step failed", { id, phase: s.phase, error: why }, "error");
      if (s.phase === "ending") {
        s.error = `control could not remove pod ${s.pod_id}: ${why}. It tries again.`;
      } else {
        s.error ??= `${PHASE_WORDS[s.phase]}: ${why}`;
        s.phase = "ending";
      }
    }
    this.store.runpod.saveTest(id, s, s.phase !== "done");
  }

  private async readReport(s: TestState): Promise<unknown> {
    try {
      const r = await this.fetchImpl(`${podPortUrl(s.pod_id, PROBE_PORT)}/${s.token}/report.json`, {
        signal: AbortSignal.timeout(20_000),
        headers: { accept: "application/json" },
      });
      // Starting, the proxy answers 404 or 502: no report yet.
      if (!r.ok) return undefined;
      return await r.json();
    } catch {
      return undefined;
    }
  }

  /** A test as shown: its state (never the report's secret path), cost and findings. */
  view(id: string): TestView | undefined {
    const t = this.store.runpod.test(id);
    return t ? viewOf(t, this.now()) : undefined;
  }

  list(cloud?: string, limit = 20): TestView[] {
    return this.store.runpod.tests({ cloud, limit }).map((t) => viewOf(t, this.now()));
  }
}

function costOf(s: TestState, now?: number): number | null {
  if (s.price_per_hr === null) return null;
  const ms =
    s.billed_ms + (s.billed_since && now !== undefined ? now - Date.parse(s.billed_since) : 0);
  return Math.round(((s.price_per_hr * ms) / 3_600_000) * 100) / 100;
}

function viewOf(t: StoredRunpodTest, now: number): TestView {
  const s = t.state as TestState;
  const f = findings(s);
  const selftest = obj(stepOf(s.report, "isolation_selftest").value).passed === true;
  return {
    ...s,
    token: "",
    id: t.id,
    cloud: t.cloud,
    active: t.active,
    created_by: t.created_by,
    phase_words: PHASE_WORDS[s.phase],
    cost_usd: costOf(s, now),
    findings: f,
    outcome: t.active
      ? "running"
      : s.error || !s.report
        ? "ended"
        : s.restart && !s.second_report_at
          ? "failed"
          : selftest &&
              !f.some((x) =>
                /^(Missing|Setting|Does not|nvidia-smi failed|A role's user can|No Landlock)|was OPENED/.test(
                  x,
                ),
              )
            ? "passed"
            : "failed",
  };
}
