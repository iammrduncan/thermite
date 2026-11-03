import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClusterKubectl } from "../../../src/control/clusters/kubectl.ts";
import type { MachineSsh, SshTarget } from "../../../src/control/machines/ssh.ts";
import { checkRigPlace, type PlaceParts } from "../../../src/control/rigs/place.ts";
import { RigUpdates } from "../../../src/control/rigs/update.ts";
import { checkQuietRigs } from "../../../src/control/rigs/watch.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { rigView } from "../../../src/control/views/index.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import type { BuildInfo } from "../../../src/core/version.ts";
import { controlOnly, RIG_TOKEN, signIn } from "../../helpers/control-stack.ts";
import { answerCommand, applied, controlStore, ingestReport } from "../../helpers/control-store.ts";

const CONTROL: BuildInfo = { version: "0.1.0", commit: null, protocol: 1, oldest_protocol: 1 };
const OLD = { version: "0.0.9", commit: null, protocol: 1, oldest_protocol: 1 };
const IMAGES = {
  harness: "registry.example.com/thermite-harness:0.1.0",
  harnessCuda: "registry.example.com/thermite-harness:0.1.0-cuda",
  supervisor: "registry.example.com/thermite-supervisor:0.1.0",
};
const MIN = 60_000;

/** A machine behind a fake SSH layer: it answers the check and the update, and records each call. */
function fakeMachine(check = "harness=active\nsupervisor=active\n") {
  const calls: { target: SshTarget; script: string }[] = [];
  const ssh: MachineSsh = {
    scanHostKeys: async () => [],
    publicKeyOf: async () => {
      throw new Error("not used");
    },
    sshScript: async (target, script) => {
      calls.push({ target, script });
      if (script.includes("echo updated")) return { code: 0, stdout: "updated\n", stderr: "" };
      if (script.includes("is-active")) return { code: 0, stdout: check, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { ssh, calls };
}

/** A cluster whose API refuses every call. */
const downCluster: ClusterKubectl = {
  contextsOf: async () => ({ contexts: ["c"], current: "c" }),
  kubectl: async () => ({
    code: 1,
    stdout: "",
    stderr: "Unable to connect to the server: dial tcp: connect: connection refused",
  }),
};

/** Control, signed in, with a machine and a cluster in Providers, and its updates' short waits. */
async function control(o: { ssh?: MachineSsh; kube?: ClusterKubectl } = {}) {
  const store = controlStore();
  const secrets = SecretBox.ephemeral();
  const keys = generateSigningKeys();
  // What control checks a rig's place with: the same store, secrets, machine and cluster.
  const places: PlaceParts = {
    store,
    secrets,
    machineSsh: o.ssh ?? fakeMachine().ssh,
    kube: o.kube ?? downCluster,
  };
  const updates = new RigUpdates({
    store,
    privateKeyPem: keys.privateKeyPem,
    control: CONTROL,
    staleAfterMs: 3 * MIN,
    waits: { pause: 2000, report: 4000, isolation: 4000 },
    pollMs: 10,
  });
  const { control: api } = controlOnly({
    store,
    keys,
    tokens: { rigs: { "cpu-9": RIG_TOKEN } },
    options: {
      staleAfterMs: 3 * MIN,
      offlineAfterMs: 15 * MIN,
      build: CONTROL,
      secrets,
      machineSsh: places.machineSsh,
      clusterKubectl: places.kube,
      publicUrl: "https://control.example.com",
      rigImages: IMAGES,
      rigUpdates: updates,
    },
  });
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
  store.clusters.add({
    name: "cluster-1",
    kubeconfig_sealed: secrets.seal("apiVersion: v1\nkind: Config\n"),
    context: "c",
    placement: "created",
    namespace_pattern: "thermite-{rig}",
    slots: [],
    by: "owner:ui",
  });
  const ui = await signIn(api);
  const { page } = ui;
  const csrf = ui.csrfOf(await page("/ui/settings"));
  const post = async (path: string, form: Record<string, string> = {}) =>
    decodeURIComponent(String((await ui.post(path, { csrf, ...form })).headers.get("location")));
  /** A form as the page's script sends it (goal 080): with fetch, asking for JSON. */
  const send = async (path: string, form: Record<string, string> = {}) => {
    const r = await ui.post(path, { csrf, ...form }, { accept: "application/json" });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  // Each rig's next report, with events numbered on from its last.
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
        at: new Date(Date.now() + i).toISOString(),
        actor: "t",
        ...e,
      })),
    });
    cursors.set(rig, from + events.length);
    await applied(store);
  };
  /** The rig's last report came `ms` ago. */
  const lastSeen = (rig: string, ms: number) =>
    store.db
      .prepare("update rig set last_seen = ? where id = ?")
      .run(new Date(Date.now() - ms).toISOString(), rig);
  const builds = (rig: string, b: typeof OLD | BuildInfo) => {
    store.builds.setRig(rig, "harness", b);
    store.builds.setRig(rig, "supervisor", b);
  };
  return { store, keys, api, page, post, send, report, lastSeen, builds, updates, places };
}

/** A rig control set up on gpu-host-1, which reports. */
async function machineRig(s: Awaited<ReturnType<typeof control>>, rig: string) {
  s.store.machines.addRig({
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
  s.store.machines.setRigStatus(rig, "running");
  await s.report(rig);
}

/** Waits until `ok` is true, for at most 5 s. */
async function until(ok: () => boolean) {
  const end = Date.now() + 5000;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("a rig's page: its version", () => {
  test("behind: a banner, the Version fact, a history line, and Update for a rig control set up", async () => {
    const s = await control();
    await machineRig(s, "gpu-1");
    s.builds("gpu-1", OLD);
    const page = await s.page("/ui/rigs/gpu-1");
    assert.match(page, /data-state="behind"/);
    assert.match(page, /gpu-1 runs Thermite 0\.0\.9\. Control runs 0\.1\.0\./);
    assert.match(page, /They work together, so nothing stops\./);
    assert.match(page, /action="\/ui\/rigs\/gpu-1\/update"/);
    assert.match(page, />Update to 0\.1\.0</);
    assert.match(
      page,
      /data-version="behind">0\.0\.9 <span class="muted">· control 0\.1\.0 · they work together/,
    );
    assert.match(page, /Control runs 0\.1\.0, and this rig runs 0\.0\.9: they work together\./);
    assert.match(page, /<span class="warn">0\.0\.9, behind control<\/span>/);
    assert.match(page, /gpu-host-1, a machine over SSH/);
    // A rig control did not set up gets the words to update it, not the button.
    await s.report("own-1");
    s.builds("own-1", OLD);
    const own = await s.page("/ui/rigs/own-1");
    assert.match(own, /data-state="behind"/);
    assert.doesNotMatch(own, /\/ui\/rigs\/own-1\/update/);
    assert.match(own, /Pull the 0\.1\.0 images where the rig runs, and start it again with them\./);
    // The same version as control: no banner, and the fact says so.
    s.builds("own-1", CONTROL);
    const same = await s.page("/ui/rigs/own-1");
    assert.doesNotMatch(same, /data-state=/);
    assert.match(same, /data-version="current">0\.1\.0 <span class="muted">· as control/);
  });

  test("a control restarted during an update ends it, and the runs it paused resume (goal 165)", async () => {
    // The machine never answers the update's script: control restarts while it waits there.
    const m = fakeMachine();
    const ssh: MachineSsh = {
      ...m.ssh,
      sshScript: (t, script, ...rest) =>
        script.includes("echo updated")
          ? new Promise(() => {})
          : m.ssh.sshScript(t, script, ...rest),
    };
    const s = await control({ ssh });
    await machineRig(s, "gpu-1");
    s.builds("gpu-1", OLD);
    await s.report("gpu-1", [
      {
        kind: "run_created",
        subject: "run-1",
        body: { campaign: "camp", mode: "hill_climb", seed: { repo: "p" } },
      },
    ]);
    await s.post("/ui/rigs/gpu-1/update");
    await until(() => s.store.commands.pending("gpu-1").length === 1);
    const pause = s.store.commands.pending("gpu-1")[0]?.envelope;
    answerCommand(s.store, "gpu-1", pause?.id ?? "", "delivered", { source: "harness" });
    await until(() => /Moving its containers/.test(s.updates.waiting("gpu-1") ?? ""));
    // Control starts again on the same store: the update it kept there ends.
    const after = new RigUpdates({
      store: s.store,
      privateKeyPem: s.keys.privateKeyPem,
      control: CONTROL,
      staleAfterMs: 3 * MIN,
    });
    after.endUnfinished();
    await until(() => after.waiting("gpu-1") === null);
    const resume = s.store.commands.pending("gpu-1").find((c) => c.envelope.kind === "resume_run");
    assert.deepEqual(resume?.envelope.payload, { run: "run-1" });
    assert.deepEqual(
      s.store.rigHistory
        .list("gpu-1")
        .filter((e) => ["update_resumed", "update_failed"].includes(e.step))
        .map((e) => [e.step, e.detail]),
      [
        ["update_resumed", "runs resumed: run-1"],
        [
          "update_failed",
          "control restarted while it was moving its containers onto control's images: update the rig again from its page",
        ],
      ],
    );
  });

  test("Update to control's version: pause, the images over SSH, a report, the isolation check, resume", async () => {
    const m = fakeMachine();
    const s = await control({ ssh: m.ssh });
    await machineRig(s, "gpu-1");
    s.builds("gpu-1", OLD);
    await s.report("gpu-1", [
      {
        kind: "run_created",
        subject: "run-1",
        body: { campaign: "camp", mode: "hill_climb", seed: { repo: "p" } },
      },
    ]);
    const asked = await s.post("/ui/rigs/gpu-1/update");
    assert.match(
      asked,
      /ok=The update of gpu-1 to 0\.1\.0 began\. Its steps show below as they happen\./,
    );
    // Another update waits for this one.
    assert.match(
      await s.page(await s.post("/ui/rigs/gpu-1/update")),
      /An update of gpu-1 is under way/,
    );
    // The page's script follows the steps (goal 080): the banners name the route, whose state
    // changes with each step, final once the update ended. Its refusal comes in words.
    const follow = async () =>
      JSON.parse(await s.page("/ui/rigs/gpu-1/update.json")) as { state: string; final: boolean };
    const first = await follow();
    assert.equal(first.final, false);
    assert.match(
      await s.page("/ui/rigs/gpu-1"),
      /<div data-part="banners" data-follow="\/ui\/rigs\/gpu-1\/update\.json" data-follow-state="[^"]+">/,
    );
    const again = await s.send("/ui/rigs/gpu-1/update");
    assert.equal(again.status, 400);
    assert.match(String(again.body.said), /^Not sent: An update of gpu-1 is under way/);
    // 1. The run pauses: the rig takes the command.
    await until(() => s.store.commands.pending("gpu-1").length === 1);
    const pause = s.store.commands.pending("gpu-1")[0]?.envelope;
    assert.equal(pause?.kind, "pause_run");
    assert.deepEqual(pause?.payload, { run: "run-1", reason: "control updates the rig to 0.1.0" });
    answerCommand(s.store, "gpu-1", pause?.id ?? "", "delivered", { source: "harness" });
    // 2. Control's images, over SSH: pulled first, the units written again, both services restarted.
    await until(() => m.calls.some((c) => c.script.includes("echo updated")));
    const script = m.calls.find((c) => c.script.includes("echo updated"))?.script ?? "";
    assert.match(script, /podman pull -q "\$image"/);
    assert.match(script, /Image=registry\.example\.com\/thermite-harness:0\.1\.0\n/);
    assert.match(script, /CONTROL_URL=https:\/\/control\.example\.com/);
    assert.match(
      script,
      /restart thermite-gpu-1-harness\.service thermite-gpu-1-supervisor\.service/,
    );
    assert.doesNotMatch(script, /cat > "[^"]*\/secrets\//, "its tokens stay as they are");
    await until(() => s.store.machines.rig("gpu-1")?.images.harness === IMAGES.harness);
    // 3. A report from 0.1.0.
    await new Promise((r) => setTimeout(r, 20));
    s.builds("gpu-1", CONTROL);
    await s.report("gpu-1");
    // 4. The isolation check, then the run resumes.
    await until(() =>
      s.store.commands.pending("gpu-1").some((c) => c.envelope.kind === "rig_check"),
    );
    await s.report("gpu-1", [
      { kind: "rig_check_started", subject: "isolation", body: { check: "isolation" } },
      {
        kind: "rig_check_finished",
        subject: "isolation",
        body: { check: "isolation", ok: true, summary: "every probe came out as it must" },
      },
    ]);
    await until(() => s.store.rigHistory.list("gpu-1").some((e) => e.step === "update_resumed"));
    const resume = s.store.commands.pending("gpu-1").find((c) => c.envelope.kind === "resume_run");
    assert.deepEqual(resume?.envelope.payload, { run: "run-1" });
    assert.deepEqual(
      s.store.rigHistory
        .list("gpu-1")
        .filter((e) => e.step.startsWith("update_"))
        .map((e) => [e.step, e.ok]),
      [
        ["update_started", true],
        ["update_paused", true],
        ["update_images", true],
        ["update_reported", true],
        ["update_isolation", true],
        ["update_resumed", true],
      ],
    );
    await until(() => s.updates.waiting("gpu-1") === null);
    const last = await follow();
    assert.equal(last.final, true);
    assert.notEqual(last.state, first.state);
    const page = await s.page("/ui/rigs/gpu-1");
    assert.doesNotMatch(page, /data-follow="\/ui\/rigs\/gpu-1\/update\.json"/);
    assert.match(page, /data-state="updated"/);
    assert.match(page, /Updated\. It runs Thermite 0\.1\.0, as control does\./);
    assert.match(page, /Its runs paused at a safe point <span class="muted">· runs paused: run-1/);
    assert.match(
      page,
      /The isolation check after the update <span class="muted">· passed: every probe/,
    );
    assert.ok(s.store.auditLog.list(50).some((a) => a.action === "rig_update"));
  });

  test("Stop and Start on Set up by control, from the page's script: the block follows the change", async () => {
    const s = await control();
    await machineRig(s, "gpu-1");
    let page = await s.page("/ui/rigs/gpu-1");
    assert.match(
      page,
      /<div class="block" data-part="placed"><div class="head"><h2>Set up by control/,
    );
    assert.match(page, /action="\/ui\/rigs\/gpu-1\/machine\/stop" data-act>/);
    assert.match(page, /action="\/ui\/rigs\/gpu-1\/machine\/remove"><input/);
    const stop = await s.send("/ui/rigs/gpu-1/machine/stop");
    assert.equal(stop.status, 200);
    assert.deepEqual(
      [stop.body.final, stop.body.said, stop.body.tone, stop.body.follow],
      [true, "Stopped.", "ok", "/ui/rigs/gpu-1/place.json"],
    );
    assert.match(String(stop.body.state), /^stopped:\d+$/);
    // A change under way: the block names the route, which is final once the change ended.
    s.store.machines.setRigStatus("gpu-1", "starting");
    page = await s.page("/ui/rigs/gpu-1");
    assert.match(
      page,
      /data-part="placed" data-follow="\/ui\/rigs\/gpu-1\/place\.json" data-follow-state="starting:\d+"/,
    );
    assert.equal(JSON.parse(await s.page("/ui/rigs/gpu-1/place.json")).final, false);
    s.store.machines.setRigStatus("gpu-1", "running");
    assert.equal(JSON.parse(await s.page("/ui/rigs/gpu-1/place.json")).final, true);
    const bad = await s.send("/ui/rigs/no-such-rig/machine/stop");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.said, "Not sent: Control didn't set this rig up.");
  });

  test("Update from the page's script: the answer names the route that follows its steps", async () => {
    const s = await control();
    await machineRig(s, "gpu-1");
    s.builds("gpu-1", OLD);
    // The button is sent by the page's script.
    assert.match(
      await s.page("/ui/rigs/gpu-1"),
      /<form class="inline" method="post" action="\/ui\/rigs\/gpu-1\/update" data-act>/,
    );
    const r = await s.send("/ui/rigs/gpu-1/update");
    assert.equal(r.status, 200);
    assert.equal(r.body.follow, "/ui/rigs/gpu-1/update.json");
    assert.equal(r.body.final, false);
    assert.equal(
      r.body.said,
      "The update of gpu-1 to 0.1.0 began. Its steps show below as they happen.",
    );
    assert.match(await s.page("/ui/rigs/gpu-1"), /<button disabled>Updating…<\/button>/);
    // A rig control did not set up: refused in words.
    await s.report("own-1");
    s.builds("own-1", OLD);
    const own = await s.send("/ui/rigs/own-1/update");
    assert.equal(own.status, 400);
    assert.match(String(own.body.said), /^Not sent: Control didn't set own-1 up on a machine/);
    await until(() => s.updates.waiting("gpu-1") === null);
  });

  test("an isolation check the rig refuses after the update is said so, and the update ends", async () => {
    const s = await control();
    await machineRig(s, "gpu-1");
    s.builds("gpu-1", OLD);
    await s.post("/ui/rigs/gpu-1/update");
    await until(() => s.store.machines.rig("gpu-1")?.images.harness === IMAGES.harness);
    await new Promise((r) => setTimeout(r, 20));
    s.builds("gpu-1", CONTROL);
    await s.report("gpu-1");
    await until(() =>
      s.store.commands.pending("gpu-1").some((c) => c.envelope.kind === "rig_check"),
    );
    const check = s.store.commands.pending("gpu-1").find((c) => c.envelope.kind === "rig_check");
    answerCommand(s.store, "gpu-1", check?.envelope.id ?? "", "failed", {
      source: "harness",
      error: "not now: 1 open trial(s) and 0 judge job(s)",
    });
    await until(() => s.store.rigHistory.list("gpu-1").some((e) => e.step === "update_isolation"));
    const step = s.store.rigHistory.list("gpu-1").find((e) => e.step === "update_isolation");
    assert.equal(step?.ok, false);
    assert.equal(step?.detail, "not run: not now: 1 open trial(s) and 0 judge job(s)");
    await until(() => s.updates.waiting("gpu-1") === null);
  });

  test("an update whose images can't apply stops there, resumes the runs and says why", async () => {
    const m = fakeMachine();
    m.ssh.sshScript = async (target, script) => {
      m.calls.push({ target, script });
      return { code: 1, stdout: "", stderr: "Error: initializing source: manifest unknown" };
    };
    const s = await control({ ssh: m.ssh });
    await machineRig(s, "gpu-1");
    s.builds("gpu-1", OLD);
    await s.post("/ui/rigs/gpu-1/update");
    await until(() => s.store.rigHistory.list("gpu-1").some((e) => e.step === "update_failed"));
    const failed = s.store.rigHistory.list("gpu-1").find((e) => e.step === "update_images");
    assert.equal(failed?.ok, false);
    assert.match(failed?.detail ?? "", /manifest unknown\. The rig keeps the images it had/);
    assert.equal(s.store.machines.rig("gpu-1")?.status, "failed");
    const page = await s.page("/ui/rigs/gpu-1");
    assert.match(page, /data-state="behind"/);
    assert.match(page, /The update stopped/);
  });

  test("refused: what control knows, its calls counted, no checks, and Retire with typed words", async () => {
    const s = await control();
    await s.report("cpu-9");
    // A rig newer than control's protocol calls: refused, and the call is counted.
    const call = await s.api.request("/v1/rigs/cpu-9/git/kits/k.git/info/refs", {
      headers: {
        authorization: `Bearer ${RIG_TOKEN}`,
        "x-thermite-version": "9.0.0",
        "x-thermite-protocol": "9",
        "x-thermite-oldest-protocol": "9",
      },
    });
    assert.equal(call.status, 409);
    await s.api.request("/v1/rigs/cpu-9/git/kits/k.git/info/refs", {
      headers: {
        authorization: `Bearer ${RIG_TOKEN}`,
        "x-thermite-version": "9.0.0",
        "x-thermite-protocol": "9",
        "x-thermite-oldest-protocol": "9",
      },
    });
    assert.equal(s.store.refusals.get("cpu-9")?.calls, 2);
    s.lastSeen("cpu-9", 2 * 24 * 60 * MIN);
    const page = await s.page("/ui/rigs/cpu-9");
    assert.match(page, /data-state="refused"/);
    assert.match(page, /Control refuses this rig: its version is too new\./);
    assert.match(page, /To fix it, update control to the rig's version or later\./);
    assert.match(page, /Control refused 2 of its calls in the last \d+ s, the last one 0s ago/);
    assert.match(page, /<dt>Calls refused<\/dt><dd>2 in the last \d+ s · the last one 0s ago/);
    assert.match(page, /Control sends no command to a refused rig, so its checks can't run\./);
    assert.match(page, /data-confirm="retire cpu-9"/);
    assert.doesNotMatch(page, /data-state="offline"/, "a refused rig is not called offline");
    assert.match(page, /<span class="bad">refused<\/span>/);
    // Retire needs the words.
    assert.match(
      await s.post("/ui/rigs/cpu-9/retire", { confirm: "retire" }),
      /error=Type "retire cpu-9"/,
    );
    assert.match(
      await s.post("/ui/rigs/cpu-9/retire", { confirm: "retire cpu-9" }),
      /ok=cpu-9 is retired/,
    );
  });

  test("an older rig refused: Update for a rig control set up, and the words for the others", async () => {
    const s = await control();
    await machineRig(s, "gpu-1");
    s.store.refusals.set(
      "gpu-1",
      "Control cannot work with this rig: its harness speaks protocol 0, older than the oldest control works with (1). Update the rig's images.",
    );
    const page = await s.page("/ui/rigs/gpu-1");
    assert.match(page, /Control refuses this rig: its version is too old\./);
    assert.match(page, /To fix it, update the rig to 0\.1\.0\.<\/b> Control does it on gpu-host-1/);
    assert.match(page, />Update to 0\.1\.0</);
  });
});

describe("a rig's page: stale and offline", () => {
  test("stale: the windows, what still works, Check again over SSH, and Restart", async () => {
    const m = fakeMachine(
      "harness=active\nsupervisor=active\nps=thermite-gpu-1-harness|Up 3 days\nps=thermite-gpu-1-supervisor|Up 3 days\nlog=control: connection refused\n",
    );
    const s = await control({ ssh: m.ssh });
    await machineRig(s, "gpu-1");
    s.builds("gpu-1", CONTROL);
    s.lastSeen("gpu-1", 6 * MIN);
    let page = await s.page("/ui/rigs/gpu-1");
    assert.match(page, /data-state="stale"/);
    assert.match(page, /No report for 6 minutes\./);
    assert.match(
      page,
      /Control calls a rig stale after 3 minutes without a report, and offline after 15 minutes\./,
    );
    assert.match(page, /A stale rig may still be at work/);
    assert.match(page, /Control has not checked its machine yet\./);
    assert.match(page, /action="\/ui\/rigs\/gpu-1\/check"/);
    assert.match(
      page,
      /action="\/ui\/rigs\/gpu-1\/machine\/restart"><input[^>]*><button class="">Restart the rig/,
    );
    assert.match(page, /Stale: no report for 3 minutes\./);
    assert.match(page, /<span class="warn">stale<\/span> · no report for 6 minutes/);
    const checked = await s.post("/ui/rigs/gpu-1/check");
    assert.match(
      checked,
      /ok=Both containers run: the harness is running \(up 3 days\), the supervisor is running \(up 3 days\)\. The supervisor's last log lines: control: connection refused/,
    );
    assert.match(m.calls.at(-1)?.script ?? "", /is-active thermite-gpu-1-harness\.service/);
    page = await s.page("/ui/rigs/gpu-1");
    assert.match(page, /Control checked its machine 0s ago\. Both containers run/);
    assert.match(page, /Control checked its machine: Both containers run/);
  });

  test("offline: no report for long, a cluster's API that does not answer, and Retire", async () => {
    const s = await control();
    s.store.clusters.addRig({
      rig: "wc-1",
      cluster: "cluster-1",
      namespace: "thermite-wc-1",
      placement: "created",
      spec: { gpus: 0, gpuMode: "device-plugin", storageGi: 10, images: IMAGES },
      created_by: "owner:ui",
    });
    s.store.clusters.setRigStatus("wc-1", "running");
    await s.report("wc-1");
    s.builds("wc-1", CONTROL);
    s.lastSeen("wc-1", 3 * 60 * MIN + 12 * MIN);
    const page = await s.page("/ui/rigs/wc-1");
    assert.match(page, /data-state="offline"/);
    assert.match(page, /Offline: no report for 3 h 12 min\./);
    assert.match(page, />Check the cluster</);
    assert.match(page, /data-confirm="retire wc-1"/);
    assert.match(page, /Offline: no report for 15 minutes\./);
    // The cluster's own words stay on control: the address names them by an ID.
    const checked = await s.post("/ui/rigs/wc-1/check");
    assert.match(checked, /error=note-[0-9a-f]+$/);
    assert.match(await s.page(checked), /cluster-1's API did not answer: .*connection refused/);
    assert.match(
      await s.page("/ui/rigs/wc-1"),
      /Control checked the cluster 0s ago\. cluster-1's API did not answer/,
    );
  });

  test("a rig control can't reach: the words to check it there, and no Check button", async () => {
    const s = await control();
    await s.report("own-1");
    s.builds("own-1", CONTROL);
    s.lastSeen("own-1", 20 * MIN);
    const page = await s.page("/ui/rigs/own-1");
    assert.match(page, /data-state="offline"/);
    assert.match(page, /Control can't reach where this rig runs\. Check it there/);
    assert.doesNotMatch(page, /\/ui\/rigs\/own-1\/check/);
    assert.match(
      await s.post("/ui/rigs/own-1/check"),
      /error=Control can't reach where this rig runs\./,
    );
    assert.match(await s.post("/ui/rigs/own-1/update"), /error=Control didn't set own-1 up/);
  });
});

describe("control looks where a quiet rig runs", () => {
  test("once when it turns stale, once more when it turns offline; never for a rig it can't reach", async () => {
    const m = fakeMachine("harness=active\nsupervisor=inactive\n");
    const s = await control({ ssh: m.ssh });
    await machineRig(s, "gpu-1");
    s.builds("gpu-1", CONTROL);
    await s.report("own-1");
    const quiet = () =>
      checkQuietRigs({
        store: s.store,
        check: (rig, by) => checkRigPlace(s.places, rig, by),
        staleAfterMs: 3 * MIN,
        offlineAfterMs: 15 * MIN,
      });
    assert.deepEqual(await quiet(), [], "both report");
    s.lastSeen("gpu-1", 6 * MIN);
    s.lastSeen("own-1", 6 * MIN);
    assert.deepEqual(await quiet(), ["gpu-1"], "control can't reach own-1");
    assert.deepEqual(await quiet(), [], "once while it is stale");
    const step = s.store.rigHistory.list("gpu-1").find((e) => e.step === "check");
    assert.equal(step?.ok, false);
    assert.match(
      step?.detail ?? "",
      /Not both containers run: the harness is running, the supervisor is inactive\./,
    );
    assert.ok(
      s.store.auditLog
        .list(20)
        .some((a) => a.action === "rig_check_place" && a.actor === "control"),
    );
    assert.match(
      await s.page("/ui/rigs/gpu-1"),
      /Control checked its machine 0s ago\. Not both containers run/,
    );
    // 14 minutes later, it is offline: checked once more.
    s.lastSeen("gpu-1", 20 * MIN);
    s.store.db
      .prepare("update rig_setup_event set at = ? where rig = ? and step = 'check'")
      .run(new Date(Date.now() - 14 * MIN).toISOString(), "gpu-1");
    assert.deepEqual(await quiet(), ["gpu-1"]);
    assert.deepEqual(await quiet(), []);
    // A refused rig is quiet because control refuses it: not checked.
    s.lastSeen("gpu-1", 60 * MIN);
    s.store.refusals.set(
      "gpu-1",
      "Control cannot work with this rig: its harness speaks protocol 0. Update the rig's images.",
    );
    s.lastSeen("gpu-1", 2 * 60 * MIN);
    assert.deepEqual(await quiet(), []);
  });
});

describe("a rig's page: its checks", () => {
  test("a smoke check that passed with a note shows passed with the note, and the rig's view keeps it", async () => {
    const s = await control();
    await machineRig(s, "gpu-1");
    s.builds("gpu-1", CONTROL);
    const note = "The timing on this machine is noisy. Results here need more repeats.";
    await s.report("gpu-1", [
      { kind: "rig_check_started", subject: "smoke", body: { id: "chk-1", check: "smoke" } },
      {
        kind: "rig_check_finished",
        subject: "smoke",
        body: {
          id: "chk-1",
          check: "smoke",
          ok: true,
          summary: `smoke on smoke-cpu: 11 of 12 candidates were judged as expected; the no-op came out inconclusive, not neutral (run check-smoke-1). Note: ${note}`,
          note,
        },
      },
      { kind: "rig_check_started", subject: "model", body: { id: "chk-2", check: "model" } },
      {
        kind: "rig_check_finished",
        subject: "model",
        body: { id: "chk-2", check: "model", ok: true, summary: "a correct tool call" },
      },
    ]);
    const v = rigView(s.store, "gpu-1");
    assert.equal(v?.checks.smoke?.ok, true);
    assert.equal(v?.checks.smoke?.note, note);
    assert.equal(v?.checks.model?.note, null);
    const page = await s.page("/ui/rigs/gpu-1");
    assert.match(
      page,
      /<span class="ck-res"><span class="chip ok">passed<\/span><\/span><span class="ck-main"><span><b>Judge smoke<\/b>/,
    );
    assert.match(
      page,
      /the no-op came out inconclusive, not neutral \(run check-smoke-1\)\. Note: The timing on this machine is noisy\. Results here need more repeats\./,
    );
  });
});
