import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RunpodRigs } from "../../../src/control/runpod/rigs.ts";
import { ControlTunnels } from "../../../src/control/runpod/tunnel.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { TEST_BUS_CA } from "../../helpers/bus-ca.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { applied, controlStore, ingestReport } from "../../helpers/control-store.ts";
import { FAKE_RUNPOD_KEY, fakeRunpod } from "../../helpers/fake-runpod.ts";
import {
  exportName,
  exportOnControl,
  harnessApplies,
  supervisorReports,
} from "../../helpers/rig-results.ts";
import { stack } from "./stack.ts";

/** The Rigs list: a row for each rig in each state it can be in, its filter chips and its columns. */

/**
 * Control with a rig in each state the Rigs list shows: live, behind control, refused (older and
 * newer), stale, offline, and three RunPod rigs (the fake RunPod): at work, stopped by its idle
 * stop, and launched but not reported yet.
 */
async function rigsStack() {
  const MIN = 60_000;
  const CONTROL = { version: "0.1.0", commit: null, protocol: 1, oldest_protocol: 1 };
  const OLD = { version: "0.0.9", commit: null, protocol: 1, oldest_protocol: 1 };
  const store = controlStore();
  const secrets = SecretBox.ephemeral();
  const keys = generateSigningKeys();
  store.gpuClouds.add({
    name: "runpod",
    kind: "runpod",
    key_sealed: secrets.seal(FAKE_RUNPOD_KEY),
    key_hint: "…cdef",
    by: "owner:ui",
  });
  const cloud = fakeRunpod();
  let clock = Date.now();
  const now = () => clock;
  const tunnels = new ControlTunnels(store, secrets, keys.privateKeyPem, {
    now,
    busCa: TEST_BUS_CA,
  });
  const pods = new RunpodRigs(store, secrets, tunnels, {
    fetch: cloud.fetch,
    image: "ghcr.io/example/thermite-rig:test-cuda",
    now,
    privateKeyPem: keys.privateKeyPem,
  });
  const { control } = controlOnly({
    store,
    keys,
    tokens: { rigs: {} },
    options: {
      staleAfterMs: 3 * MIN,
      offlineAfterMs: 15 * MIN,
      build: CONTROL,
      secrets,
      tunnels,
      runpodRigs: pods,
      cloudFetch: cloud.fetch,
    },
  });
  const { page: get } = await signIn(control);
  const cursors = new Map<string, number>();
  const report = async (
    rig: string,
    events: { kind: string; subject: string; body: object }[] = [],
  ) => {
    const from = cursors.get(rig) ?? 0;
    await ingestReport(store, {
      rig,
      ledger_id: `ledger-${rig}`,
      cursor: from,
      next: from + events.length,
      summary: {},
      events: events.map((e, i) => ({
        id: from + i + 1,
        at: new Date(Date.now() - 4 * MIN + i).toISOString(),
        actor: "t",
        ...e,
      })),
    });
    cursors.set(rig, from + events.length);
    await applied(store);
  };
  /** A running run with one attempt, 4 minutes ago. */
  const running = (rig: string, run: string, mode = "hill_climb") =>
    report(rig, [
      {
        kind: "run_created",
        subject: run,
        body: { campaign: "q4-gemv", mode, seed: { repo: "p" } },
      },
      { kind: "run_status", subject: run, body: { status: "running" } },
      { kind: "attempt_recorded", subject: `a-${run}`, body: { run, lifecycle: "measured" } },
    ]);
  const lastSeen = (rig: string, ms: number) =>
    store.db
      .prepare("update rig set last_seen = ? where id = ?")
      .run(new Date(Date.now() - ms).toISOString(), rig);
  const builds = (rig: string, b: typeof OLD) => {
    store.builds.setRig(rig, "harness", b);
    store.builds.setRig(rig, "supervisor", b);
  };
  store.machines.add({
    name: "gpu-host-1",
    address: "gpu-host-1.example.com",
    port: 22,
    user: "thermite",
    key_sealed: secrets.seal("not a real key"),
    public_key: "ssh-ed25519 AAAA",
    key_fingerprint: "SHA256:x",
    seen_host_keys: [],
    by: "owner:ui",
  });
  for (const rig of ["gpu-1", "gpu-2", "cpu-1", "cpu-2"]) {
    store.machines.addRig({
      rig,
      machine: "gpu-host-1",
      gpus: [],
      images: {
        harness: "registry.example.com/thermite-harness:0.0.9",
        supervisor: "registry.example.com/thermite-supervisor:0.0.9",
      },
      root: false,
      created_by: "owner:ui",
    });
    store.machines.setRigStatus(rig, "running");
  }
  // Live, as control.
  await running("gpu-1", "q4-gemv-3");
  builds("gpu-1", CONTROL);
  // Live, behind control.
  await running("gpu-2", "dec-2", "goal");
  builds("gpu-2", OLD);
  // Refused for an older version, two days after the last report control took.
  await running("cpu-1", "rl-2", "research");
  store.refusals.set(
    "cpu-1",
    "Control cannot work with this rig: its harness speaks protocol 0, older than the oldest control works with (1). Update the rig's images.",
  );
  lastSeen("cpu-1", 2 * 24 * 60 * MIN);
  // Stale: no report for 6 minutes.
  await running("cpu-2", "rl-3", "research");
  builds("cpu-2", CONTROL);
  lastSeen("cpu-2", 6 * MIN);
  // Offline, on a cluster: no report for 3 h 12 min.
  store.clusters.add({
    name: "cluster-1",
    kubeconfig_sealed: secrets.seal("apiVersion: v1\nkind: Config\n"),
    context: "c",
    placement: "created",
    namespace_pattern: "thermite-{rig}",
    slots: [],
    by: "owner:ui",
  });
  store.clusters.addRig({
    rig: "wc-1",
    cluster: "cluster-1",
    namespace: "thermite-wc-1",
    placement: "created",
    spec: {
      gpus: 0,
      gpuMode: "device-plugin",
      storageGi: 10,
      images: {
        harness: "registry.example.com/thermite-harness:0.1.0",
        supervisor: "registry.example.com/thermite-supervisor:0.1.0",
      },
    },
    created_by: "owner:ui",
  });
  store.clusters.setRigStatus("wc-1", "running");
  await running("wc-1", "q4-gemv-2");
  builds("wc-1", CONTROL);
  lastSeen("wc-1", (3 * 60 + 12) * MIN);
  // Refused because it is newer than control: control needs the update.
  await report("new-1");
  store.refusals.set(
    "new-1",
    "Control cannot work with this rig: it speaks protocol 9, newer than control's (1). Update control.",
  );
  // RunPod: one at work, one its idle stop stopped, one not reported yet.
  const live = await pods.launch("runpod", { gpu: "RTX A4000", datacenter: "EU-RO-1" }, "owner:ui");
  const idle = await pods.launch("runpod", { gpu: "RTX A4000", idle_stop_minutes: 30 }, "owner:ui");
  clock += 30_000;
  await pods.advance();
  for (const v of [live, idle]) assert.ok(store.tunnels.pin(v.rig, "sign", "box"));
  await running(live.rig, "q4-gemv-4");
  await report(live.rig, [
    { kind: "trial_started", subject: "q4-gemv-4", body: { lane: "lane-1", trial: "t-1" } },
  ]);
  builds(live.rig, CONTROL);
  await report(idle.rig);
  builds(idle.rig, CONTROL);
  clock += 40 * MIN;
  await pods.advance();
  harnessApplies(store, idle.rig, exportName(1));
  supervisorReports(store, idle.rig);
  exportOnControl(store, idle.rig, exportName(1));
  clock += 30_000;
  await pods.advance();
  assert.equal(pods.view(idle.rig)?.stopped_by, "idle_stop");
  assert.equal(pods.view(live.rig)?.status, "RUNNING");
  const fresh = await pods.launch("runpod", { gpu: "RTX A4000" }, "owner:ui");
  return { store, get, live: live.rig, idle: idle.rig, fresh: fresh.rig };
}

/** The Rigs list's row for one rig. */
const rowOf = (html: string, rig: string) =>
  new RegExp(`<tr class="click"(?:(?!</tr>).)*?<b>${rig}</b>(?:(?!</tr>).)*</tr>`, "s").exec(
    html,
  )?.[0] ?? "";

describe("the Rigs list", () => {
  test("one row for each rig: its state, where it runs, its version, its run, its last report and a pod's price", async () => {
    const s = await rigsStack();
    const list = await s.get("/ui/rigs");
    assert.match(
      list,
      /<span class="summary">9 rigs · 3 need an update · 1 stale · 1 offline · 1 stopped · 4 runs at work<\/span>/,
    );
    assert.match(list, /<a class="btn" href="\/ui\/rigs\/add\/runpod">Launch on RunPod<\/a>/);
    assert.match(
      list,
      /<th>Rig<\/th><th>Where it runs<\/th><th><span class="lb">Version<i class="ii"[^>]*data-tip="[^"]+">i<\/i><\/span><\/th><th>Run at work<\/th><th class="num">Progress<\/th><th>Last report<\/th><th class="num">Per hour<\/th>/,
    );
    assert.match(list, /Stale: no report for 3 minutes\. Offline: none for 15 minutes\./);
    // Live, as control: the run at work and its progress.
    const live = rowOf(list, "gpu-1");
    assert.match(live, /data-href="\/ui\/rigs\/gpu-1"/);
    assert.match(live, /<span class="chip ok">Live<\/span>/);
    assert.match(live, /Machine <span class="muted">· gpu-host-1<\/span>/);
    assert.match(live, /<span class="muted">0\.1\.0<\/span>/);
    assert.match(
      live,
      /<a class="nowrap" href="\/ui\/campaigns\/q4-gemv\/runs\/q4-gemv-3">q4-gemv-3<\/a><span class="rsub">q4-gemv · last attempt 4 min ago<\/span>/,
    );
    assert.match(live, /<b class="fig">\+0\.0%<\/b>/);
    assert.doesNotMatch(live, /vchip/);
    // Behind control: needs update, which opens the rig's page at its version banner.
    const behind = rowOf(list, "gpu-2");
    assert.match(behind, /<span class="chip ok">Live<\/span>/);
    assert.match(
      behind,
      /<a class="chip warn vchip" href="\/ui\/rigs\/gpu-2#version" title="Open the rig's page to update it">needs update ›<\/a><span class="rsub">0\.0\.9 · behind<\/span>/,
    );
    assert.match(behind, /data-href="\/ui\/rigs\/gpu-2#version"/);
    assert.match(behind, /<span class="muted small">goals not checked yet<\/span>/);
    assert.match(
      await s.get("/ui/rigs/gpu-2"),
      /id="version" data-state="behind"/,
      "the link opens the rig's page in that state",
    );
    // Refused for an older version: needs update too; its run as of its last report.
    const refused = rowOf(list, "cpu-1");
    assert.match(refused, /<span class="chip bad">Refused<\/span>/);
    assert.match(
      refused,
      /<a class="chip bad vchip" href="\/ui\/rigs\/cpu-1#version"[^>]*>needs update ›<\/a><span class="rsub">no version · refused<\/span>/,
    );
    assert.match(
      refused,
      /<a class="nowrap muted" href="[^"]+">rl-2<\/a><span class="rsub">q4-gemv · as of 2 days ago<\/span>/,
    );
    assert.match(refused, /<span class="muted">0 verified claims<\/span>/);
    assert.match(
      refused,
      /<span class="bad">2 days ago<\/span><span class="rsub">refused since<\/span>/,
    );
    assert.match(await s.get("/ui/rigs/cpu-1"), /id="version" data-state="refused"/);
    // Refused for a newer version: control needs the update.
    assert.match(
      rowOf(list, "new-1"),
      /<a class="chip bad vchip" href="\/ui\/rigs\/new-1#version"[^>]*>update control ›<\/a><span class="rsub">no version · refused, newer<\/span>/,
    );
    // Stale and offline: toned, their runs as of their last report.
    const stale = rowOf(list, "cpu-2");
    assert.match(stale, /<span class="chip warn">Stale<\/span>/);
    assert.match(stale, /data-href="\/ui\/rigs\/cpu-2#reporting"/);
    assert.match(stale, /<span class="rsub">q4-gemv · as of its last report<\/span>/);
    assert.match(stale, /<span class="warn">6 min ago<\/span>/);
    assert.match(await s.get("/ui/rigs/cpu-2"), /id="reporting" data-state="stale"/);
    const offline = rowOf(list, "wc-1");
    assert.match(offline, /<span class="chip bad">Offline<\/span>/);
    assert.match(offline, /Cluster <span class="muted">· cluster-1<\/span>/);
    assert.match(offline, /<span class="bad">3 h 12 min ago<\/span>/);
    assert.match(await s.get("/ui/rigs/wc-1"), /id="reporting" data-state="offline"/);
    // RunPod at work: its price per hour and its spend so far.
    const pod = rowOf(list, s.live);
    assert.match(pod, /<span class="chip ok">Live<\/span>/);
    assert.match(pod, /RunPod <span class="muted">· EU-RO-1<\/span>/);
    assert.match(pod, /<b>\$0\.25\/h<\/b><span class="rsub">\$\d+\.\d\d so far<\/span>/);
    // RunPod stopped by its idle stop: not stale nor offline, and a new run wakes it.
    const stopped = rowOf(list, s.idle);
    assert.match(stopped, /<span class="chip ">Stopped<\/span>/);
    assert.match(stopped, /data-href="\/ui\/rigs\/[^"#]+#pod"/);
    assert.match(
      stopped,
      /<span class="muted">No run at work<\/span><span class="rsub">its idle stop stopped it [^<]+ ago · a new run wakes it<\/span>/,
    );
    assert.match(stopped, /<span class="rsub">then it stopped<\/span>/);
    assert.match(stopped, /storage only<span class="rsub">\$\d+\.\d\d so far<\/span>/);
    // The status bar calls it stopped, not stale, and Needs you has no card for it. The sidebar
    // lists no rigs (goal 077): the Rigs page does.
    assert.doesNotMatch(list, new RegExp(`<span class="name">${s.idle}</span>`));
    assert.match(list, /\d+ rigs(?: · \d+ stale)? · 1 stopped<\/span>/);
    assert.doesNotMatch(
      await s.get("/ui"),
      new RegExp(`${s.idle} (stopped reporting|has not reported yet)`),
    );
    assert.match(await s.get(`/ui/rigs/${s.idle}`), /<div class="block" id="pod">/);
    // A pod launched but not reported yet costs already: it is listed with its price.
    const fresh = rowOf(list, s.fresh);
    assert.match(fresh, /<span class="chip info">Getting ready<\/span>/);
    assert.match(fresh, /1× RTX A4000/);
    assert.match(fresh, /<span class="muted">not reported yet<\/span>/);
    assert.match(fresh, /<span class="muted">none yet<\/span>/);
    assert.match(fresh, /<b>\$0\.25\/h<\/b>/);
    // The update and its steps, and the checks, are on the rig's page only.
    assert.doesNotMatch(list, /Update to 0\.1\.0|\/update"|model route|judge smoke/);
    assert.match(list, /Checks, keys, history and the update are on each rig's page\./);
  });

  test("the filter chips count and narrow the rows; a row opens its rig", async () => {
    const s = await rigsStack();
    const list = await s.get("/ui/rigs");
    const counts = [
      ["all", "All", 9],
      ["live", "Live", 3],
      ["update", "Needs update", 3],
      ["refused", "Refused", 2],
      ["lost", "Stale, offline or broken", 2],
      ["runpod", "On RunPod", 3],
      ["stopped", "Stopped", 1],
    ] as const;
    for (const [f, word, n] of counts)
      assert.match(
        list,
        new RegExp(
          `<a class="fchip${f === "all" ? " on" : ""}" href="/ui/rigs${f === "all" ? "" : `\\?f=${f}`}">${word} <span class="n">${n}</span></a>`,
        ),
      );
    const rigs = (html: string) =>
      [...html.matchAll(/<a class="kname" href="[^"]+"><b>([^<]+)<\/b>/g)].map((m) => m[1]).sort();
    assert.deepEqual(rigs(await s.get("/ui/rigs?f=update")), ["cpu-1", "gpu-2", "new-1"]);
    assert.deepEqual(rigs(await s.get("/ui/rigs?f=lost")), ["cpu-2", "wc-1"]);
    assert.deepEqual(rigs(await s.get("/ui/rigs?f=stopped")), [s.idle]);
    assert.deepEqual(rigs(await s.get("/ui/rigs?f=runpod")), [s.fresh, s.idle, s.live].sort());
    assert.deepEqual(rigs(await s.get("/ui/rigs?f=live")), ["gpu-1", "gpu-2", s.live].sort());
    assert.match(
      await s.get("/ui/rigs?f=update"),
      /<a class="fchip on" href="\/ui\/rigs\?f=update"/,
    );
    assert.equal(rigs(await s.get("/ui/rigs?f=nonsense")).length, 9, "anything else is All");
    // A row opens its rig, from control's own script; its links go where they say.
    const js = await s.get("/ui/assets/app.js");
    assert.match(js, /closest\("tr\[data-href\]"\)/);
    assert.match(js, /closest\("a, button, input, select, \.ii"\)/);
  });

  test("with no rig on RunPod there is no Per hour column, and with no rig the list says so", async () => {
    const s = await stack();
    await s.relay();
    const list = await (await s.get("/ui/rigs")).text();
    assert.match(list, /<span class="summary">1 rig · 0 runs at work<\/span>/);
    assert.doesNotMatch(list, /Per hour|Launch on RunPod/);
    assert.match(list, /Set up by you/);
    const { control: empty } = controlOnly({ tokens: { rigs: {} } });
    assert.match(await (await signIn(empty)).page("/ui/rigs"), /No rig has reported yet\./);
  });
});
