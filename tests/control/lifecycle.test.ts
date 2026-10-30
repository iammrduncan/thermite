import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { propagateChampion } from "../../src/control/issue/index.ts";
import {
  advanceResets,
  ComposeDriver,
  confirmReset,
  type DeploymentDriver,
  inClusterApi,
  KubernetesDriver,
} from "../../src/control/lifecycle.ts";
import { leaderboard } from "../../src/control/views/index.ts";
import { generateSigningKeys } from "../../src/core/commands.ts";
import { KB_OUTBOX_FILES } from "../../src/core/kb.ts";
import { WIPE_MARKER, wipeIfRequested } from "../../src/harness/service/index.ts";
import { ADMIN, controlOnly, controlStack, mcpClient } from "../helpers/control-stack.ts";
import { controlStore, ingestReport } from "../helpers/control-store.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../helpers/judge-env.ts";

function fakeServer(
  handler: (method: string, url: string, headers: Record<string, unknown>) => [number, unknown],
) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const [status, body] = handler(String(req.method), String(req.url), req.headers);
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(body === undefined ? "" : JSON.stringify(body));
  });
  return { server, seen };
}

describe("deployment drivers", () => {
  test("Kubernetes: the rig's pods are found by label in its namespace and deleted", async () => {
    let auth = "";
    const { server, seen } = fakeServer((method, url, headers) => {
      auth = String(headers.authorization ?? "");
      if (method === "GET") {
        const harness = url.includes("component%3Dharness");
        return [
          200,
          { items: [{ metadata: { name: harness ? "harness-abc" : "supervisor-def" } }] },
        ];
      }
      return [200, {}];
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const d = new KubernetesDriver({
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: "sa-token",
      namespaceTemplate: "ar-{rig}",
      selectors: {
        harness: "app.kubernetes.io/component=harness",
        supervisor: "app.kubernetes.io/component=supervisor",
      },
    });
    assert.deepEqual(await d.restart("gpu-rig-1", ["harness", "supervisor"]), [
      "ar-gpu-rig-1/harness-abc",
      "ar-gpu-rig-1/supervisor-def",
    ]);
    assert.equal(auth, "Bearer sa-token");
    assert.ok(seen.includes("DELETE /api/v1/namespaces/ar-gpu-rig-1/pods/harness-abc"));
    await assert.rejects(d.restart("../kube-system", ["harness"]), /not a rig name/);
    server.close();
  });

  test("Kubernetes from control's settings: thermite-{rig} by default, a set template kept", async () => {
    const { server, seen } = fakeServer((method) =>
      method === "GET" ? [200, { items: [{ metadata: { name: "harness-abc" } }] }] : [200, {}],
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const dir = mkdtempSync(join(tmpdir(), "thermite-k8s-"));
    writeFileSync(join(dir, "token"), "sa-token\n");
    writeFileSync(join(dir, "ca.crt"), "not used over http\n");
    const env = {
      THERMITE_K8S_API: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      THERMITE_K8S_TOKEN_FILE: join(dir, "token"),
      THERMITE_K8S_CA_FILE: join(dir, "ca.crt"),
    };
    // Not set, or set empty (compose passes an unset variable on as ""): the default.
    for (const unset of [env, { ...env, THERMITE_K8S_NAMESPACE: "" }])
      assert.deepEqual(await KubernetesDriver.inCluster(unset).restart("rig-1", ["harness"]), [
        "thermite-rig-1/harness-abc",
      ]);
    // A deployment that names its namespaces keeps them, whatever the default.
    const own = KubernetesDriver.inCluster({ ...env, THERMITE_K8S_NAMESPACE: "ar-{rig}" });
    assert.deepEqual(await own.restart("rig-1", ["harness"]), ["ar-rig-1/harness-abc"]);
    assert.ok(seen.includes("DELETE /api/v1/namespaces/thermite-rig-1/pods/harness-abc"));
    assert.ok(seen.includes("DELETE /api/v1/namespaces/ar-rig-1/pods/harness-abc"));
    server.close();
  });

  test("compose: the rig's services are restarted through the engine's socket", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "thermite-eng-")), "engine.sock");
    const { server, seen } = fakeServer((method) =>
      method === "GET" ? [200, [{ Id: "c0ffee" }]] : [204, undefined],
    );
    await new Promise<void>((r) => server.listen(sock, r));
    const d = new ComposeDriver({
      socketPath: sock,
      project: "thermite",
      services: { "local-2": { harness: "harness-2", supervisor: "supervisor-2" } },
    });
    assert.deepEqual(await d.restart("local-2", ["harness"]), ["harness-2"]);
    assert.ok(seen.some((s) => s.startsWith("GET /containers/json") && s.includes("harness-2")));
    assert.ok(seen.includes("POST /containers/c0ffee/restart?t=10"));
    await assert.rejects(d.restart("local-9", ["harness"]), /no harness service/);
    server.close();
  });
});

describe("full reset", () => {
  test("pause, export, verified push, wipe, restart; the harness starts again with a fresh ledger", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    // A job the judge has not taken: once the run is paused it stays queued, and the reset must
    // not wait for it (goal 165).
    const queued = env.ledger.jobs.enqueue({ kind: "validate", spec: { run: "js-1" }, actor: "t" });
    let wiped = false;
    env.service.onWipe = () => {
      wiped = true;
    };
    const { store, relay } = controlStack({ env });
    await relay();
    const restarts: string[] = [];
    const driver: DeploymentDriver = {
      kind: "fake",
      restart: async (rig, components) => {
        restarts.push(`${rig}:${components.join(",")}`);
        return components;
      },
    };
    const step = () =>
      advanceResets({
        store,
        privateKeyPem: env.keys.privateKeyPem,
        driver,
        staleAfterMs: 180_000,
      });
    const state = () =>
      String(store.fullResets.open("rig-a")?.state ?? store.fullResets.list(1)[0]?.state);
    const id = store.fullResets.create("rig-a", "owner:test");
    await step();
    assert.equal(state(), "quiescing");
    await relay(); // the pause reaches the harness; the rig reports idle
    assert.equal(env.ledger.runs.get("js-1")?.status, "paused");
    await step();
    assert.equal(state(), "quiescing", "its queued job counts until control sees the run paused");
    await relay(); // the harness's report of the pause
    await step();
    assert.equal(state(), "exporting");
    assert.equal(env.ledger.jobs.get(queued)?.state, "queued");
    await relay(); // the full export (the supervisor's acknowledgement)
    await step();
    assert.equal(state(), "exporting", "waits for the harness's own record of the export");
    await relay(); // the harness's signed report carries it
    await step();
    assert.equal(state(), "verifying");
    const name = String(store.fullResets.open("rig-a")?.export_name);
    await step();
    assert.equal(state(), "verifying", "waits until the supervisor reports the export pushed");
    store.reportedRigs.setSupervisor("rig-a", {
      export: { remote: true, pushed: [name], pushed_commit: "c".repeat(40) },
    });
    await step();
    assert.equal(state(), "awaiting_owner", "the owner checks the pushed commit and confirms");
    assert.match(String(store.fullResets.open("rig-a")?.detail), /c{40}/);
    confirmReset(store, id, "owner:test");
    await step();
    assert.equal(state(), "wiping");
    await relay();
    assert.ok(existsSync(join(env.paths.stateDir, WIPE_MARKER)));
    await relay(); // the harness's record of the wipe
    await step();
    assert.equal(state(), "done");
    assert.deepEqual(restarts, ["rig-a:harness,supervisor"]);
    await new Promise((r) => setTimeout(r, 2200));
    assert.ok(wiped, "the controller is told to exit");
    const before = env.ledger.ledgerId();
    env.ledger.close();
    // A locked build tree (as the build store leaves them) does not stop the wipe.
    const locked = join(env.paths.stateDir, "builds", "locked", "sub");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o555);
    chmodSync(join(env.paths.stateDir, "builds", "locked"), 0o555);
    // A file of the knowledge base the supervisor has yet to put on the bus stays (goal 175).
    const kbFile = join(env.paths.outboxDir, KB_OUTBOX_FILES, "a".repeat(64));
    mkdirSync(join(env.paths.outboxDir, KB_OUTBOX_FILES), { recursive: true });
    writeFileSync(kbFile, "waiting");
    mkdirSync(join(env.paths.outboxDir, "an-export"), { recursive: true });
    assert.ok(wipeIfRequested(env.paths, ["rig-signing.key", "rig-signing.key.pub"]));
    assert.ok(existsSync(kbFile));
    assert.ok(!existsSync(join(env.paths.outboxDir, "an-export")));
    assert.ok(!existsSync(join(env.paths.stateDir, "builds")));
    assert.ok(!existsSync(join(env.paths.stateDir, "ledger", "ledger.db")));
    const { Ledger } = await import("../../src/harness/ledger/index.ts");
    const fresh = Ledger.open(join(env.paths.stateDir, "ledger", "ledger.db"));
    assert.notEqual(fresh.ledgerId(), before);
    fresh.close();
  });

  test("the harness refuses a wipe when research was recorded after the verified export", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const plain = await env.service.export("t");
    const notFull = await env.service.applyCommand(
      env.sign("wipe_state", {
        confirm: "wipe",
        export: String(plain.dir.split("/").pop()),
        through_event: 0,
      }),
    );
    assert.ok(notFull.status === "applied" && !notFull.accepted);
    assert.match(JSON.stringify(notFull.result), /not a full export/);
    const exp = await env.service.export("t", { full: true });
    await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "late",
        known_flaws: [],
      },
      "t",
    );
    const r = await env.service.applyCommand(
      env.sign("wipe_state", {
        confirm: "wipe",
        export: String(exp.dir.split("/").pop()),
        through_event: 0,
      }),
    );
    assert.ok(r.status === "applied" && !r.accepted);
    assert.match(JSON.stringify(r.result), /research was recorded after the export/);
    assert.ok(!existsSync(join(env.paths.stateDir, WIPE_MARKER)));
  });
});

describe("leaderboard and propagation", () => {
  test("a champion is cross-verified once another rig's judge accepted it", async () => {
    const store = controlStore();
    const ev = (id: number, kind: string, subject: string, body: unknown) => ({
      id,
      at: new Date(Date.now() + id).toISOString(),
      actor: "t",
      kind,
      subject,
      body,
    });
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "la",
      cursor: 0,
      next: 6,
      summary: {},
      events: [
        ev(1, "run_created", "c-1", {
          campaign: "camp",
          mode: "hill_climb",
          seed: { repo: "proj", commit: "s" },
        }),
        ev(2, "attempt_recorded", "a-1", { run: "c-1", lane: null, lifecycle: "queued" }),
        ev(3, "verdict", "a-1", { verdict: "win_confirmed", delta: 0.2 }),
        ev(5, "champion_promoted", "c-1", { seq: 2, attempt: "a-1", commit: "c2" }),
        ev(6, "champion_published", "c-1", {
          seq: 2,
          repo: "proj",
          base_commit: "a".repeat(40),
          tree: "b".repeat(40),
          sha256: "f".repeat(64),
          path: "champions/c-1/2.patch",
        }),
      ],
    });
    // Rig b's own run of the campaign: a run's name is used once on control (goal 170).
    await ingestReport(store, {
      rig: "rig-b",
      ledger_id: "lb",
      cursor: 0,
      next: 3,
      summary: {},
      events: [
        ev(1, "run_created", "c-1b", {
          campaign: "camp",
          mode: "hill_climb",
          seed: { repo: "proj", commit: "s" },
        }),
        ev(2, "propagation_received", "c-1b", {
          tree: "b".repeat(40),
          attempt: "p-1",
          source_rig: "rig-a",
          source_run: "c-1",
          source_seq: 2,
        }),
        ev(3, "propagation_accepted", "c-1b", {
          attempt: "p-1",
          source_rig: "rig-a",
          source_run: "c-1",
          source_seq: 2,
          verdict: "win_confirmed",
        }),
      ],
    });
    const board = leaderboard(store, { staleAfterMs: 180_000 });
    const a = board.camp?.find((r) => r.rig === "rig-a");
    assert.deepEqual(a?.verified_by, ["rig-b"]);
    assert.ok(Math.abs((a?.gain ?? 0) - 0.2) < 1e-9);
    // propagateChampion builds the content-addressed command from the published champion.
    const keys = generateSigningKeys();
    const { id, seq } = await propagateChampion(store, keys.privateKeyPem, {
      run: "c-1",
      toRun: "c-1b",
      issuedBy: "owner",
      staleAfterMs: 180_000,
    });
    assert.equal(seq, 2);
    const cmd = store.commands.pending("rig-b").find((c) => c.envelope.id === id);
    assert.ok(cmd);
    assert.deepEqual((cmd.envelope.payload as { import: unknown }).import, {
      kind: "champion_patch",
      path: "propagate/rig-a/c-1/2.patch",
      repo: "proj",
      base_commit: "a".repeat(40),
      tree: "b".repeat(40),
      sha256: "f".repeat(64),
    });
    await assert.rejects(
      propagateChampion(store, keys.privateKeyPem, {
        run: "c-1b",
        toRun: "c-1",
        issuedBy: "owner",
        staleAfterMs: 180_000,
      }),
      /no champion beyond its seed/,
    );
    // During the owner's full reset of the receiving rig, an agent's token does not propagate to
    // it; the owner's does.
    store.fullResets.create("rig-b", "owner:api");
    const { control } = controlOnly({ store, keys, tokens: { agent: "agent-token-abcdef" } });
    const call = async (token: string) =>
      (await mcpClient(control, token)).callTool({
        name: "propagate_champion",
        arguments: { run: "c-1", to_run: "c-1b" },
      });
    const refused = (await call("agent-token-abcdef")) as {
      isError?: boolean;
      content: { text: string }[];
    };
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]?.text ?? "", /rig-b is being reset by the owner/);
    assert.ok(!(await call(ADMIN)).isError);
  });
});

describe("the in-cluster API address", () => {
  test("comes from the pod's service variables, so control needs no DNS", () => {
    assert.equal(
      inClusterApi({
        KUBERNETES_SERVICE_HOST: "apiserver.example",
        KUBERNETES_SERVICE_PORT: "443",
      }),
      "https://apiserver.example:443",
    );
    assert.equal(
      inClusterApi({ KUBERNETES_SERVICE_HOST: "2001:db8::1" }),
      "https://[2001:db8::1]:443",
    );
    assert.equal(inClusterApi({}), "https://kubernetes.default.svc");
  });
});
