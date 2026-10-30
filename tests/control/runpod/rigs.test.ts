import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { makeCa } from "../../../src/control/bus/cert.ts";
import { podPortUrl } from "../../../src/control/runpod/cloud.ts";
import type { RunpodRigView } from "../../../src/control/runpod/rig-view.ts";
import { DEFAULT_IDLE_STOP_MINUTES, RunpodRigs } from "../../../src/control/runpod/rigs.ts";
import { ControlTunnels } from "../../../src/control/runpod/tunnel.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { LEAF_ENV, LEAF_PORT } from "../../../src/core/link/leaf.ts";
import { keySha256 } from "../../../src/core/tunnel.ts";
import { controlOnly, mcpClient } from "../../helpers/control-stack.ts";
import { applied, controlStore, ingestReport } from "../../helpers/control-store.ts";
import { FAKE_RUNPOD_KEY, fakeRunpod } from "../../helpers/fake-runpod.ts";
import {
  exportName,
  exportOnControl,
  harnessApplies,
  supervisorReports,
} from "../../helpers/rig-results.ts";

const KEY = FAKE_RUNPOD_KEY;
const IMAGE = "ghcr.io/example/thermite-rig:test-cuda";
const HOUR = 3_600_000;

function setup(o: { noCapacity?: boolean; image?: string | undefined; busCa?: string } = {}) {
  const store = controlStore();
  const secrets = SecretBox.ephemeral();
  store.gpuClouds.add({
    name: "runpod",
    kind: "runpod",
    key_sealed: secrets.seal(KEY),
    key_hint: "…cdef",
    by: "owner:ui",
  });
  const cloud = fakeRunpod(o);
  const control = generateSigningKeys();
  let clock = Date.now();
  const now = () => clock;
  const tunnels = new ControlTunnels(store, secrets, control.privateKeyPem, {
    now,
    busCa: o.busCa,
  });
  const rigs = new RunpodRigs(store, secrets, tunnels, {
    fetch: cloud.fetch,
    image: "image" in o ? o.image : IMAGE,
    now,
    privateKeyPem: control.privateKeyPem,
  });
  const created = () =>
    cloud.calls.filter((c) => c.method === "POST" && c.path === "/v2/pods").map((c) => c.body) as {
      image: string;
      gpu: { id: string; count: number; minCudaVersion: string };
      cloud: string;
      disk: number;
      dataCenterIds?: string[];
      mounts: { persistent: { size: number; path: string } };
      ports: string[];
      env: Record<string, string>;
      cmd?: unknown;
    }[];
  const advance = async (ms: number) => {
    clock += ms;
    await rigs.advance();
  };
  /** The rig's harness reports these events at control's clock now, as its signed reports would. */
  let seq = 0;
  const report = async (
    rig: string,
    ...events: [kind: string, subject: string, body?: object][]
  ) => {
    await ingestReport(store, {
      rig,
      ledger_id: "l1",
      cursor: seq,
      next: seq + events.length,
      summary: {},
      events: events.map(([kind, subject, body], i) => ({
        id: seq + i + 1,
        at: new Date(clock).toISOString(),
        actor: "t",
        kind,
        subject,
        body: body ?? {},
      })),
    });
    seq += events.length;
    await applied(store);
  };
  return { store, secrets, cloud, control, tunnels, rigs, created, advance, report };
}

const RUN = "c-1";
const runCreated = (): [string, string, object] => [
  "run_created",
  RUN,
  { campaign: "camp", mode: "hill_climb", seed: { repo: "p" } },
];

describe("rigs on RunPod: the launch", () => {
  test("a pod of the rig image in pull mode: Secure by default, the volume, the port, the launch values and nothing else", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    const [body] = s.created();
    assert.ok(body);
    assert.equal(body.image, IMAGE);
    assert.deepEqual(body.gpu, { id: "NVIDIA RTX A4000", count: 1, minCudaVersion: "12.6" });
    assert.equal(body.cloud, "SECURE", "Secure cloud on demand unless the owner asks otherwise");
    assert.equal(body.disk, 40);
    assert.deepEqual(body.mounts, { persistent: { size: 100, path: "/workspace" } });
    assert.equal(body.dataCenterIds, undefined, "RunPod chooses when none is given");
    assert.deepEqual(body.ports, ["8790/http"]);
    assert.equal(body.cmd, undefined, "the image's own entry point runs");
    // Only pull mode's launch values: public material, the one-time code and the snapshot key.
    assert.deepEqual(Object.keys(body.env).sort(), [
      "THERMITE_RIG_ID",
      "THERMITE_STATE_SNAPSHOT_KEY",
      "THERMITE_TUNNEL_CONTROL_BOX",
      "THERMITE_TUNNEL_CONTROL_KEY_SHA256",
      "THERMITE_TUNNEL_ENROLL_CODE",
      "THERMITE_TUNNEL_PORT",
      "THERMITE_TUNNEL_PREFIX",
    ]);
    assert.equal(body.env.THERMITE_RIG_ID, v.rig);
    assert.match(v.rig, /^rp-[0-9a-f]{8}$/);
    assert.equal(body.env.THERMITE_TUNNEL_CONTROL_KEY_SHA256, keySha256(s.control.publicKeyPem));
    assert.equal(body.env.THERMITE_TUNNEL_PORT, "8790");
    assert.ok(!JSON.stringify(body).includes(KEY), "control's RunPod key never goes to the pod");
    // Control follows the pod in pull mode, with the rig's settings for a GPU rig.
    const t = s.store.tunnels.get(v.rig);
    assert.equal(t?.pod, "pod1");
    assert.equal(t?.url, podPortUrl("pod1", 8790));
    assert.deepEqual(t?.config.env, { THERMITE_TARGET: "cuda-gpu", THERMITE_GPUS: "0" });
    assert.equal(t?.code_expires_at, null, "the code expires only when the launch says so");
    // Its price from RunPod's list (the new pod shows none yet), nothing spent, no limits.
    assert.equal(v.pod, "pod1");
    assert.equal(v.price_per_hr, 0.25);
    assert.equal(v.spend_usd, 0);
    assert.equal(v.spend_limit_usd, null);
    assert.equal(v.idle_stop_minutes, DEFAULT_IDLE_STOP_MINUTES, "the default: none, until set");
    assert.equal(v.idle_stop_minutes, null);
    assert.equal(v.enrolled_at, null);
    const audit = s.store.auditLog.list(10).find((a) => a.action === "runpod_rig_launched");
    assert.equal(audit?.actor, "owner:api");
    assert.equal((audit?.body as { pod?: string } | undefined)?.pod, "pod1");
  });

  test("with control's authority for the bus: the leaf's port as TCP, its values, and the pod's address from RunPod while it runs", async () => {
    const s = setup({ busCa: makeCa(new Date(), 30).cert });
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    const [body] = s.created();
    assert.deepEqual(body?.ports, ["8790/http", `${LEAF_PORT}/tcp`]);
    assert.deepEqual(
      Object.keys(body?.env ?? {})
        .filter((k) => k.startsWith("THERMITE_LEAF_"))
        .sort(),
      Object.values(LEAF_ENV).sort(),
    );
    assert.equal(v.bus_leaf, null, "no address before RunPod gives one");
    const pod = s.cloud.pods.get("pod1");
    assert.ok(pod);
    pod.tcp = { [LEAF_PORT]: { ip: "203.0.113.5", public: 40123 } };
    await s.advance(30_000);
    assert.equal(s.rigs.view(v.rig)?.bus_leaf, "203.0.113.5:40123");
    // Stopped, the pod has no address; started again, RunPod may give another.
    pod.status = "EXITED";
    await s.advance(30_000);
    assert.equal(s.rigs.view(v.rig)?.bus_leaf, null);
    pod.status = "STARTING";
    pod.tcp = { [LEAF_PORT]: { ip: "198.51.100.7", public: 41000 } };
    await s.advance(30_000);
    assert.equal(s.rigs.view(v.rig)?.bus_leaf, "198.51.100.7:41000");
    const steps = s.store.rigHistory.list(v.rig).filter((e) => e.step === "runpod_leaf_address");
    assert.deepEqual(
      steps.map((e) => e.detail),
      ["203.0.113.5:40123", "198.51.100.7:41000"],
    );
  });

  test("GPUs, a data center, an expiry for the code and the owner's settings", async () => {
    const s = setup();
    const v = await s.rigs.launch(
      "runpod",
      {
        gpu: "NVIDIA RTX A4000",
        gpu_count: 2,
        datacenter: "EU-RO-1",
        container_disk_gb: 60,
        volume_gb: 300,
        rig: "big-rig",
        enroll_within_minutes: 30,
        settings: { THERMITE_JUDGE_GPUS: "1", THERMITE_TARGET_CLASS: "a4000" },
        spend_limit_usd: 20,
        idle_stop_minutes: 45,
      },
      "owner:mcp",
    );
    const [body] = s.created();
    assert.equal(body?.cloud, "SECURE");
    assert.equal(body?.gpu.count, 2);
    assert.deepEqual(body?.dataCenterIds, ["EU-RO-1"]);
    assert.equal(body?.disk, 60);
    assert.deepEqual(body?.mounts, { persistent: { size: 300, path: "/workspace" } });
    assert.equal(v.rig, "big-rig");
    assert.ok(body?.env.THERMITE_TUNNEL_ENROLL_UNTIL);
    assert.deepEqual(s.store.tunnels.get("big-rig")?.config.env, {
      THERMITE_TARGET: "cuda-gpu",
      THERMITE_GPUS: "0,1",
      THERMITE_JUDGE_GPUS: "1",
      THERMITE_TARGET_CLASS: "a4000",
    });
    assert.equal(v.price_per_hr, 0.5, "Secure cloud's price for two GPUs");
    assert.equal(v.spend_limit_usd, 20);
    assert.equal(v.idle_stop_minutes, 45);
  });

  test("refusals start nothing and leave no rig: each says why", async () => {
    const s = setup();
    const refused: [Parameters<RunpodRigs["launch"]>[1], RegExp][] = [
      [{ gpu: "" }, /name a GPU type/],
      [{ gpu: "B200" }, /RunPod lists no GPU type "B200"/],
      [{ gpu: "RTX A4000", cloud_type: "COMMUNITY" }, /Community cloud comes in a later version/],
      [{ gpu: "RTX A4000", datacenter: "US-XX-9" }, /no data center "US-XX-9"/],
      [{ gpu: "RTX A4000", gpu_count: 9 }, /1 to 8 GPUs/],
      [{ gpu: "RTX A4000", volume_gb: 5 }, /volume is 10 to 10000 GB/],
      [{ gpu: "RTX A4000", spend_limit_usd: 0 }, /spend limit is a number of US dollars above 0/],
      [{ gpu: "RTX A4000", idle_stop_minutes: 2 }, /idle stop is 5 minutes or more/],
      [
        { gpu: "RTX A4000", settings: { THERMITE_TARGET: "$(id)" } },
        /settings take only THERMITE_TARGET/,
      ],
      [
        { gpu: "RTX A4000", settings: { LD_PRELOAD: "x" } as Record<string, string> },
        /settings take only/,
      ],
      [{ gpu: "RTX A4000", rig: "Bad_Name" }, /a rig's name is/],
    ];
    for (const [req, why] of refused)
      await assert.rejects(s.rigs.launch("runpod", req, "owner:api"), why, JSON.stringify(req));
    await assert.rejects(s.rigs.launch("aws", { gpu: "RTX A4000" }, "o"), /no GPU cloud "aws"/);
    const noImage = setup({ image: undefined });
    await assert.rejects(
      noImage.rigs.launch("runpod", { gpu: "RTX A4000" }, "o"),
      /no image: give one, or set THERMITE_RUNPOD_RIG_IMAGE/,
    );
    for (const x of [s, noImage]) {
      assert.deepEqual(x.created(), [], "no pod was asked for");
      assert.deepEqual(x.store.tunnels.list(), []);
      assert.deepEqual(x.store.runpod.rigs(), []);
    }
  });

  test("a pod RunPod refuses leaves no rig, and its code can never enroll", async () => {
    const s = setup({ noCapacity: true });
    await assert.rejects(
      s.rigs.launch("runpod", { gpu: "RTX A4000", rig: "rig-x" }, "owner:api"),
      /^Error: RunPod has no 1 × .+ free on Secure cloud now: RunPod answered 400 .*no capacity for that GPU.*\. No pod was started and nothing is billed\. Choose another GPU, or try again in a few minutes\.$/,
    );
    assert.equal(s.store.tunnels.get("rig-x"), undefined);
    assert.deepEqual(s.store.runpod.rigs(), []);
    assert.ok(s.store.auditLog.list(10).some((a) => a.action === "tunnel_rig_dropped"));
    // The name is free again.
    const ok = setup();
    await ok.rigs.launch("runpod", { gpu: "RTX A4000", rig: "rig-x" }, "owner:api");
    assert.ok(ok.store.tunnels.get("rig-x")?.pod);
  });

  test("each pod gets its own snapshot key, which goes to RunPod's settings and nowhere else", async () => {
    const s = setup();
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let a: Awaited<ReturnType<typeof s.rigs.launch>>;
    let b: Awaited<ReturnType<typeof s.rigs.launch>>;
    try {
      a = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
      b = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
      await s.advance(60_000);
    } finally {
      process.stdout.write = write;
    }
    const keys = s.created().map((c) => c.env.THERMITE_STATE_SNAPSHOT_KEY as string);
    assert.equal(keys.length, 2);
    for (const k of keys) assert.equal(Buffer.from(k, "base64url").length, 32);
    assert.notEqual(keys[0], keys[1], "a new key for each launch");
    // Not in control's database (any table), its audit, the views or its log.
    const tables = s.store.db
      .prepare("select name from sqlite_master where type = 'table'")
      .all() as { name: string }[];
    const dump = tables
      .map((t) => JSON.stringify(s.store.db.prepare(`select * from "${t.name}"`).all()))
      .join("\n");
    const views = JSON.stringify([s.rigs.view(a.rig), s.rigs.view(b.rig), a, b]);
    for (const k of keys) {
      assert.ok(!dump.includes(k), "not in control's database");
      assert.ok(!views.includes(k), "not in what control shows");
      assert.ok(!out.join("").includes(k), "not in control's log");
    }
  });

  test("a refusal that echoes the launch's values is told without them", async () => {
    const s = setup();
    let sent: Record<string, string> = {};
    // RunPod refuses the pod, naming the values it was sent: by name, and one bare.
    const echo = async (init: RequestInit | undefined) => {
      sent = (JSON.parse(String(init?.body)) as { env: Record<string, string> }).env;
      return new Response(
        JSON.stringify({
          title: "Bad Request",
          detail: `value ${sent.THERMITE_STATE_SNAPSHOT_KEY} is not allowed`,
          errors: {
            THERMITE_STATE_SNAPSHOT_KEY: sent.THERMITE_STATE_SNAPSHOT_KEY,
            THERMITE_TUNNEL_ENROLL_CODE: sent.THERMITE_TUNNEL_ENROLL_CODE,
          },
        }),
        { status: 400, headers: { "content-type": "application/problem+json" } },
      );
    };
    const rigs = new RunpodRigs(s.store, s.secrets, s.tunnels, {
      fetch: async (input, init) =>
        String(input).endsWith("/v2/pods") && init?.method === "POST"
          ? echo(init)
          : s.cloud.fetch(input, init),
      image: IMAGE,
      privateKeyPem: s.control.privateKeyPem,
    });
    const err = await rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api").then(
      () => undefined,
      (e: Error) => e,
    );
    assert.ok(err, "the launch is refused");
    assert.match(err.message, /RunPod answered 400/);
    assert.match(err.message, /value \*\*\* is not allowed/);
    assert.match(err.message, /"THERMITE_STATE_SNAPSHOT_KEY":"\*\*\*"/);
    assert.match(err.message, /"THERMITE_TUNNEL_ENROLL_CODE":"\*\*\*"/);
    for (const name of ["THERMITE_STATE_SNAPSHOT_KEY", "THERMITE_TUNNEL_ENROLL_CODE"]) {
      const value = sent[name] as string;
      assert.ok(value.length > 40);
      assert.ok(!err.message.includes(value.slice(0, 12)), `no part of ${name}'s value`);
    }
  });
});

describe("rigs on RunPod: price, spend and the owner's limits", () => {
  test("the price per hour and the spend so far follow the pod; with no limit set, nothing stops it", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000", gpu_count: 2 }, "owner:api");
    await s.advance(HOUR);
    let now = s.rigs.view(v.rig) as RunpodRigView;
    assert.equal(now.status, "RUNNING");
    assert.equal(now.price_per_hr, 0.5, "RunPod's own price for the running pod");
    assert.equal(now.spend_usd, 0.5);
    // A hundred hours later it still runs: no default limit.
    for (let i = 0; i < 100; i++) await s.advance(HOUR);
    now = s.rigs.view(v.rig) as RunpodRigView;
    assert.equal(now.status, "RUNNING");
    assert.equal(now.spend_usd, 50.5);
    assert.deepEqual(s.cloud.stops(), [], "control never stopped it");
    // Stopped at RunPod (by hand): the spend stops growing.
    const pod = s.cloud.pods.get("pod1");
    if (pod) pod.status = "EXITED";
    await s.advance(HOUR);
    const spent = s.rigs.view(v.rig)?.spend_usd;
    await s.advance(5 * HOUR);
    assert.equal(s.rigs.view(v.rig)?.spend_usd, spent);
    assert.equal(s.rigs.view(v.rig)?.status, "EXITED");
    // Gone at RunPod: control stops following it.
    s.cloud.pods.delete("pod1");
    await s.advance(HOUR);
    const gone = s.rigs.view(v.rig) as RunpodRigView;
    assert.equal(gone.active, false);
    assert.ok(gone.ended_at);
    assert.match(gone.notes.join(" "), /RunPod no longer has the pod/);
  });

  test("a spend limit stops the pod once it is reached, and only then", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000", spend_limit_usd: 1 }, "owner:api");
    await s.advance(HOUR);
    await s.advance(HOUR);
    await s.advance(HOUR);
    assert.deepEqual(s.cloud.stops(), [], "$0.75 of $1.00");
    await s.advance(HOUR);
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }], "$1.00 reached");
    const stopped = s.rigs.view(v.rig) as RunpodRigView;
    assert.equal(stopped.stopped_by, "spend_limit");
    assert.equal(stopped.status, "EXITED");
    assert.equal(stopped.spend_usd, 1);
    assert.match(stopped.notes.join(" "), /reached the spend limit you set \(\$1\.00\)/);
    const audit = s.store.auditLog.list(10).find((a) => a.action === "runpod_rig_stopped");
    assert.deepEqual(audit?.body, { rig: v.rig, pod: "pod1", why: "spend_limit", spend_usd: 1 });
    // Stopped, it costs nothing more and is not stopped again.
    await s.advance(10 * HOUR);
    assert.equal(s.rigs.view(v.rig)?.spend_usd, 1);
    assert.equal(s.cloud.stops().length, 1);
  });

  test("a limit passed while control was away stops the pod at its first step, and says so (goal 165)", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000", spend_limit_usd: 1 }, "owner:api");
    await s.advance(60_000);
    assert.deepEqual(s.cloud.stops(), [], "a minute: $0.00 of $1.00");
    // Control stops for five hours, and starts again on the same store: its first step.
    const back = Date.now() + 5 * HOUR;
    const again = new RunpodRigs(s.store, s.secrets, s.tunnels, {
      fetch: s.cloud.fetch,
      image: IMAGE,
      now: () => back,
      privateKeyPem: generateSigningKeys().privateKeyPem,
    });
    await again.advance();
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }]);
    const stopped = again.view(v.rig) as RunpodRigView;
    assert.equal(stopped.stopped_by, "spend_limit");
    assert.match(
      stopped.notes.join(" "),
      /Control was not running from .*: the pod passed this limit meanwhile, and control stopped it as soon as it started again\./,
    );
  });

  test("an idle stop counts only after enrollment, and only while no run is at work", async () => {
    const s = setup();
    const v = await s.rigs.launch(
      "runpod",
      { gpu: "RTX A4000", idle_stop_minutes: 30 },
      "owner:api",
    );
    // Not enrolled yet: a slow image pull is not idleness.
    await s.advance(HOUR);
    assert.deepEqual(s.cloud.stops(), []);
    assert.equal(s.rigs.view(v.rig)?.idle_since, null);
    // Enrolled, with a lane's trial in progress: at work, however long the trial takes.
    assert.ok(s.store.tunnels.pin(v.rig, "sign", "box"));
    await s.report(v.rig, runCreated(), ["trial_started", RUN, { lane: "lane-1", trial: "t-1" }]);
    for (let i = 0; i < 4; i++) await s.advance(20 * 60_000);
    assert.deepEqual(s.cloud.stops(), [], "a trial is in progress");
    // The run finishes: 30 minutes later control stops the pod, its results sent out first.
    await s.report(
      v.rig,
      ["trial_finished", RUN, { lane: "lane-1", trial: "t-1", stopped: "done" }],
      ["run_status", RUN, { status: "closed", reason: "done" }],
    );
    await s.advance(20 * 60_000);
    assert.deepEqual(s.cloud.stops(), []);
    await s.advance(20 * 60_000);
    const asked = s.rigs.view(v.rig) as RunpodRigView;
    assert.deepEqual(
      [asked.op?.kind, asked.op?.why, asked.op?.phase],
      ["stop", "idle_stop", "exporting"],
    );
    assert.deepEqual(s.cloud.stops(), [], "not before the rig's results have left it");
    harnessApplies(s.store, v.rig, exportName(1));
    supervisorReports(s.store, v.rig);
    exportOnControl(s.store, v.rig, exportName(1));
    await s.advance(30_000);
    assert.deepEqual(s.cloud.stops(), [{ action: "stop" }]);
    const stopped = s.rigs.view(v.rig) as RunpodRigView;
    assert.equal(stopped.stopped_by, "idle_stop");
    assert.equal(stopped.op, null);
    assert.match(
      stopped.notes.join(" "),
      /no run was at work on it for 30 minutes, the idle stop you set/,
    );
  });

  test("a running run with nothing under way and no new event is idle: blocked, it is paused and the pod stops", async () => {
    const s = setup();
    const v = await s.rigs.launch(
      "runpod",
      { gpu: "RTX A4000", idle_stop_minutes: 30 },
      "owner:api",
    );
    assert.ok(s.store.tunnels.pin(v.rig, "sign", "box"));
    // The run runs, but no trial is in progress and no judge job waits: it waits for the owner.
    await s.report(v.rig, runCreated(), ["promotion_awaiting_approval", RUN, { attempt: "a-1" }]);
    await s.advance(20 * 60_000);
    assert.deepEqual(s.cloud.stops(), []);
    assert.equal(s.rigs.view(v.rig)?.op, null);
    await s.advance(15 * 60_000);
    const asked = s.rigs.view(v.rig) as RunpodRigView;
    assert.deepEqual([asked.op?.kind, asked.op?.why], ["stop", "idle_stop"]);
    // The stop pauses the blocked run; the next start resumes it.
    assert.deepEqual(asked.op?.paused, [RUN]);
  });

  test("a running run's new events count as work: the planner's gap between trials is not idle", async () => {
    const s = setup();
    const v = await s.rigs.launch(
      "runpod",
      { gpu: "RTX A4000", idle_stop_minutes: 30 },
      "owner:api",
    );
    assert.ok(s.store.tunnels.pin(v.rig, "sign", "box"));
    await s.report(v.rig, runCreated());
    await s.advance(20 * 60_000);
    // The planner planned a round, 20 minutes in: the idle time counts from here.
    await s.report(v.rig, ["epoch_planned", RUN, { n: 1, source: "planner", assignments: [] }]);
    await s.advance(20 * 60_000);
    assert.equal(s.rigs.view(v.rig)?.op, null, "20 minutes since its last event");
    await s.advance(15 * 60_000);
    assert.equal(s.rigs.view(v.rig)?.op?.why, "idle_stop", "35 minutes since its last event");
  });

  test("a paused run is idle, and its queued judge jobs are not work; a judge job that runs is", async () => {
    const s = setup();
    const v = await s.rigs.launch(
      "runpod",
      { gpu: "RTX A4000", idle_stop_minutes: 30 },
      "owner:api",
    );
    assert.ok(s.store.tunnels.pin(v.rig, "sign", "box"));
    // A job queued for the run, then the run paused: the job waits for the resume.
    await s.report(
      v.rig,
      runCreated(),
      ["job_queued", "j-1", { kind: "measure", attempt: null }],
      ["run_status", RUN, { status: "paused", reason: "the owner paused it" }],
    );
    // Another job runs on the judge: work, whatever its run.
    await s.report(
      v.rig,
      ["job_queued", "j-2", { kind: "rig_check", attempt: null }],
      ["job_leased", "j-2", {}],
    );
    for (let i = 0; i < 4; i++) await s.advance(20 * 60_000);
    assert.equal(s.rigs.view(v.rig)?.op, null, "the judge is at work");
    await s.report(v.rig, ["job_finished", "j-2", { state: "done" }]);
    await s.advance(20 * 60_000);
    assert.equal(s.rigs.view(v.rig)?.op, null);
    await s.advance(15 * 60_000);
    assert.equal(s.rigs.view(v.rig)?.op?.why, "idle_stop", "only a paused run and its queued job");
  });

  test("limits are set and cleared later; an idle stop set later counts from then", async () => {
    const s = setup();
    const v = await s.rigs.launch("runpod", { gpu: "RTX A4000" }, "owner:api");
    s.store.tunnels.pin(v.rig, "sign", "box");
    await s.advance(3 * HOUR);
    assert.deepEqual(s.cloud.stops(), [], "idle for hours, but no idle stop is set");
    const set = s.rigs.limits(v.rig, { idle_stop_minutes: 60, spend_limit_usd: 100 }, "owner:api");
    assert.equal(set.idle_stop_minutes, 60);
    await s.advance(30 * 60_000);
    assert.deepEqual(s.cloud.stops(), [], "the idle time counts from when it was set");
    const cleared = s.rigs.limits(v.rig, { idle_stop_minutes: null }, "owner:api");
    assert.equal(cleared.idle_stop_minutes, null);
    assert.equal(cleared.spend_limit_usd, 100, "left out: kept");
    await s.advance(2 * HOUR);
    assert.deepEqual(s.cloud.stops(), []);
    assert.throws(() => s.rigs.limits(v.rig, { spend_limit_usd: -1 }, "o"), /above 0/);
    assert.throws(() => s.rigs.limits("nope", {}, "o"), /no rig nope on a GPU cloud/);
    assert.ok(s.store.auditLog.list(20).some((a) => a.action === "runpod_rig_limits"));
  });
});

describe("rigs on RunPod over REST and MCP: the owner's alone", () => {
  const tokens = {
    admin: "owner-token-abcdef",
    operator: "operator-token-abcdef",
    agent: "agent-token-abcdef",
    read: "read-token-abcdef",
    rigs: {},
  };

  test("REST: the owner launches, lists, reads and sets limits; another token is refused", async () => {
    const s = setup();
    const { control: api } = controlOnly({
      store: s.store,
      keys: s.control,
      tokens,
      options: { secrets: s.secrets, tunnels: s.tunnels, runpodRigs: s.rigs },
    });
    const call = (path: string, token: string, body?: unknown) =>
      api.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    for (const t of [tokens.operator, tokens.agent, tokens.read]) {
      const r = await call("/v1/gpu-clouds/runpod/rigs", t, { gpu: "RTX A4000" });
      assert.equal(r.status, 401);
    }
    assert.deepEqual(s.created(), [], "no pod for anyone but the owner");
    const launched = await call("/v1/gpu-clouds/runpod/rigs", tokens.admin, {
      gpu: "RTX A4000",
      spend_limit_usd: 5,
    });
    assert.equal(launched.status, 201);
    const v = (await launched.json()) as RunpodRigView;
    assert.equal(v.created_by, "owner:api");
    const list = (await (await call("/v1/gpu-clouds/runpod/rigs", tokens.admin)).json()) as {
      rig: string;
    }[];
    assert.deepEqual(
      list.map((x) => x.rig),
      [v.rig],
    );
    const rigs = (await (await call("/v1/rigs", tokens.admin)).json()) as {
      runpod: RunpodRigView[];
    };
    assert.equal(rigs.runpod[0]?.price_per_hr, 0.25);
    const one = await call(`/v1/rigs/${v.rig}/runpod`, tokens.admin);
    assert.equal(((await one.json()) as RunpodRigView).spend_limit_usd, 5);
    assert.equal((await call("/v1/rigs/nope/runpod", tokens.admin)).status, 404);
    const limits = await call(`/v1/rigs/${v.rig}/runpod/limits`, tokens.admin, {
      spend_limit_usd: null,
      idle_stop_minutes: 30,
    });
    assert.equal(limits.status, 200);
    assert.equal(((await limits.json()) as RunpodRigView).spend_limit_usd, null);
    assert.equal(
      (await call(`/v1/rigs/${v.rig}/runpod/limits`, tokens.operator, { spend_limit_usd: 1 }))
        .status,
      401,
    );
    // A refusal comes back in words; an unknown field is refused.
    const bad = await call("/v1/gpu-clouds/runpod/rigs", tokens.admin, { gpu: "B200" });
    assert.equal(bad.status, 409);
    assert.match(((await bad.json()) as { error: string }).error, /no GPU type "B200"/);
    const extra = await call("/v1/gpu-clouds/runpod/rigs", tokens.admin, {
      gpu: "RTX A4000",
      cmd: ["sh"],
    });
    assert.equal(extra.status, 400);
    // An idle stop left out takes the default; null says "none" whatever the default.
    const none = await call("/v1/gpu-clouds/runpod/rigs", tokens.admin, {
      gpu: "RTX A4000",
      idle_stop_minutes: null,
    });
    assert.equal(none.status, 201);
    assert.equal(((await none.json()) as RunpodRigView).idle_stop_minutes, null);
    const left = await call("/v1/gpu-clouds/runpod/rigs", tokens.admin, { gpu: "RTX A4000" });
    assert.equal(
      ((await left.json()) as RunpodRigView).idle_stop_minutes,
      DEFAULT_IDLE_STOP_MINUTES,
    );
    const short = await call("/v1/gpu-clouds/runpod/rigs", tokens.admin, {
      gpu: "RTX A4000",
      idle_stop_minutes: 2,
    });
    assert.equal(short.status, 409);
  });

  test("MCP: only the owner may launch or set limits; the operator, readers and the owner see the rigs; agents nothing", async () => {
    const s = setup();
    const { control: api } = controlOnly({
      store: s.store,
      keys: s.control,
      tokens,
      options: { secrets: s.secrets, tunnels: s.tunnels, runpodRigs: s.rigs },
    });
    const names = async (token: string) =>
      (await (await mcpClient(api, token)).listTools()).tools.map((t) => t.name);
    const owner = await names(tokens.admin);
    assert.ok(owner.includes("runpod_launch") && owner.includes("runpod_rig_limits"));
    for (const t of [tokens.operator, tokens.read]) {
      const n = await names(t);
      assert.ok(n.includes("runpod_rigs"));
      assert.ok(!n.includes("runpod_launch") && !n.includes("runpod_rig_limits"));
    }
    const agent = await names(tokens.agent);
    assert.ok(!agent.some((n) => n.startsWith("runpod_")));
    const operator = await mcpClient(api, tokens.operator);
    const tried = await operator.callTool({
      name: "runpod_launch",
      arguments: { cloud: "runpod", gpu: "RTX A4000" },
    });
    assert.equal(tried.isError, true);
    assert.deepEqual(s.created(), []);
    const client = await mcpClient(api, tokens.admin);
    const r = await client.callTool({
      name: "runpod_launch",
      arguments: { cloud: "runpod", gpu: "RTX A4000", idle_stop_minutes: 20 },
    });
    const v = JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as RunpodRigView;
    assert.equal(v.created_by, "owner:mcp");
    assert.equal(v.idle_stop_minutes, 20);
    const off = await client.callTool({
      name: "runpod_launch",
      arguments: { cloud: "runpod", gpu: "RTX A4000", idle_stop_minutes: null },
    });
    assert.notEqual(off.isError, true);
    const o = JSON.parse((off.content as { text: string }[])[0]?.text ?? "{}") as RunpodRigView;
    assert.equal(o.idle_stop_minutes, null, "null: no idle stop, whatever the default");
    const listed = await operator.callTool({ name: "runpod_rigs", arguments: {} });
    assert.match((listed.content as { text: string }[])[0]?.text ?? "", new RegExp(v.rig));
  });
});
