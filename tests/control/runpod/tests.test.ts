import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PROBE_CMD, PROBE_JS } from "../../../src/control/runpod/probe.ts";
import { findings, RunpodTests } from "../../../src/control/runpod/tests.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import { controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";

const KEY = "rpa_test-key-0123456789abcdef";
const IMAGE = "ghcr.io/example/thermite-harness:test-cuda";

/** A probe's report, as the pod serves it. */
const report = (startedAt: string) => ({
  version: 1,
  phase: "done",
  started_at: startedAt,
  steps: {
    machine: { ok: true, value: { uid: 0, cpus: 8 } },
    capabilities: {
      ok: true,
      value: {
        effective: ["chown", "dac_override", "fowner", "kill", "setgid", "setuid", "net_raw"],
        no_new_privs: false,
      },
    },
    gpus: { ok: true, value: { detail: "NVIDIA RTX A4000, 570.1, 16376 MiB, GPU-1" } },
    device_chown: { ok: true, value: { nvidia0: "ok" } },
    temp_modes: { ok: true, value: { "/tmp": "ok", "/dev/shm": "ok" } },
    runpod_variables: {
      ok: true,
      value: { in_environment: ["RUNPOD_API_KEY", "RUNPOD_POD_ID"], in_files: {} },
    },
    role_reads_runpod_variables: {
      ok: true,
      value: { pid1: "EACCES", own: [], "/etc/environment": "ENOENT" },
    },
    outbound_https: { ok: true, value: { "https://github.com": { status: 200, ms: 80 } } },
    isolation_selftest: { ok: true, value: { exit: 0, passed: true } },
  },
});

/** RunPod's pod API and HTTP proxy behind a fake fetch, with every call it got. */
function fakeCloud(o: { refuseStart?: boolean; noCapacity?: boolean } = {}) {
  type Pod = { status: string; env: Record<string, string>; started: string };
  const pods = new Map<string, Pod>();
  const calls: { method: string; at: string; body?: unknown }[] = [];
  let n = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const podJson = (id: string, p: Pod) => ({
    id,
    status: p.status,
    cost: p.status === "RUNNING" ? 0.25 : 0,
    gpu: { id: "NVIDIA RTX A4000", count: p.status === "RUNNING" ? 1 : 0 },
    dataCenterId: "EU-RO-1",
  });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, at: `${url.host}${url.pathname}`, body });
    if (url.host.endsWith(".proxy.runpod.net")) {
      const p = pods.get(url.host.split("-")[0] ?? "");
      if (p?.status !== "RUNNING") return new Response("", { status: 502 });
      if (url.pathname !== `/${p.env.THERMITE_PROBE_TOKEN}/report.json`)
        return new Response("", { status: 404 });
      return json(report(p.started));
    }
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${KEY}`)
      return json({ title: "Unauthorized" }, 401);
    const path = url.pathname;
    if (path === "/v2/catalog/gpus")
      return json({
        gpus: [
          {
            id: "NVIDIA H100 80GB HBM3",
            name: "H100 SXM",
            memory: 80,
            secure: true,
            price: { secure: 2.69 },
            availability: "LOW",
          },
          {
            id: "NVIDIA RTX 2000 Ada",
            name: "RTX 2000 Ada",
            memory: 16,
            secure: true,
            price: { secure: 0.19 },
            availability: "NONE",
          },
          {
            id: "NVIDIA RTX A4000",
            name: "RTX A4000",
            memory: 16,
            secure: true,
            community: true,
            price: { secure: 0.25, community: 0.17 },
            availability: "HIGH",
          },
        ],
      });
    if (path === "/v2/pods" && method === "GET")
      return json({ pods: [...pods].map(([id, p]) => podJson(id, p)) });
    if (path === "/v2/pods" && method === "POST") {
      if (o.noCapacity)
        return json({ title: "Bad Request", detail: "no capacity for that GPU" }, 400);
      const id = `pod${++n}`;
      pods.set(id, { status: "PROVISIONING", env: body.env, started: new Date().toISOString() });
      return json(podJson(id, pods.get(id) as Pod), 201);
    }
    if (path.startsWith("/v2/catalog") || path === "/v2/network-volumes") return json({});
    const m = /^\/v2\/pods\/([^/]+)(\/action)?$/.exec(path);
    const p = m ? pods.get(m[1] ?? "") : undefined;
    if (!m || !p) return json({ title: "Not Found" }, 404);
    if (method === "DELETE") {
      pods.delete(m[1] ?? "");
      return new Response(null, { status: 204 });
    }
    if (m[2]) {
      if (body.action === "stop") p.status = "EXITED";
      else if (o.refuseStart) return json({ title: "Conflict", detail: "no GPU free" }, 409);
      else {
        p.status = "STARTING";
        p.started = new Date(Date.now() + 1000).toISOString();
      }
      return json(podJson(m[1] ?? "", p));
    }
    // Each read moves a starting pod on, as RunPod does in its own time.
    if (p.status === "PROVISIONING" || p.status === "STARTING") p.status = "RUNNING";
    return json(podJson(m[1] ?? "", p));
  }) as typeof fetch;
  return { f, calls, pods };
}

function setup(o: Parameters<typeof fakeCloud>[0] = {}) {
  const store = new ControlStore(":memory:");
  const secrets = SecretBox.ephemeral();
  store.gpuClouds.add({
    name: "runpod",
    kind: "runpod",
    key_sealed: secrets.seal(KEY),
    key_hint: "…cdef",
    by: "owner:ui",
  });
  const cloud = fakeCloud(o);
  let clock = Date.parse("2026-10-19T05:00:00Z");
  const tests = new RunpodTests(store, secrets, { fetch: cloud.f, image: IMAGE, now: () => clock });
  const until = async (id: string, done: () => boolean) => {
    for (let i = 0; i < 20 && !done(); i++) {
      clock += 60_000;
      await tests.advance();
    }
    return tests.view(id);
  };
  return { store, cloud, tests, until, tick: (ms: number) => (clock += ms) };
}

describe("RunPod test pods", () => {
  test("the cheapest GPU in stock, the probe's report read twice around a stop and a start, the pod removed, the cost and the findings in words", async () => {
    const s = setup();
    const started = await s.tests.start("runpod", {}, "owner:ui");
    assert.equal(started.gpu_name, "RTX A4000", "the cheapest in stock (the cheaper one has none)");
    const create = s.cloud.calls.find((c) => c.method === "POST" && c.at.endsWith("/v2/pods"));
    const body = create?.body as {
      image: string;
      gpu: { id: string; count: number; minCudaVersion: string };
      cloud: string;
      ports: string[];
      cmd: string[];
      env: Record<string, string>;
    };
    assert.equal(body.image, IMAGE);
    assert.deepEqual(body.gpu, { id: "NVIDIA RTX A4000", count: 1, minCudaVersion: "12.6" });
    assert.equal(body.cloud, "SECURE");
    assert.deepEqual(body.ports, ["8000/http"]);
    assert.deepEqual(body.cmd, PROBE_CMD);
    assert.match(body.env.THERMITE_PROBE_TOKEN ?? "", /^[0-9a-f]{48}$/);
    assert.equal(Buffer.from(body.env.THERMITE_PROBE_JS ?? "", "base64").toString(), PROBE_JS);
    assert.equal(started.token, "", "the report's secret path is never shown");
    await assert.rejects(s.tests.start("runpod", {}, "owner:ui"), /still running/);

    const done = await s.until(started.id, () => !s.tests.view(started.id)?.active);
    assert.equal(done?.phase, "done");
    assert.equal(done?.outcome, "passed", JSON.stringify(done?.findings));
    const actions = s.cloud.calls
      .filter((c) => c.method !== "GET")
      .map(
        (c) =>
          `${c.method} ${c.at.replace(/^api\.runpod\.io/, "")} ${JSON.stringify(c.body ?? "")}`,
      );
    assert.deepEqual(actions.slice(1), [
      'POST /v2/pods/pod1/action {"action":"stop"}',
      'POST /v2/pods/pod1/action {"action":"start"}',
      'DELETE /v2/pods/pod1 ""',
    ]);
    assert.equal(s.cloud.pods.size, 0, "the pod is gone");
    for (const f of [
      "Runs as root.",
      "Has every capability the broker needs (chown, dac_override, fowner, kill, setgid, setuid).",
      "The GPU device nodes can be given to a group, mode 0660.",
      "RunPod sets 2 variables: RUNPOD_API_KEY, RUNPOD_POD_ID.",
      "A role's user reads none of RunPod's variables.",
      "The isolation self-test passed.",
      "After a stop and a start it ran again with 1 GPU(s) and reported again.",
    ])
      assert.ok(done?.findings.includes(f), `${f}\n${JSON.stringify(done?.findings, null, 1)}`);
    assert.ok((done?.cost_usd ?? 0) > 0, "billed while it ran");
    assert.ok(done?.report_after_restart, "the second report is kept");
    const audit = s.store.auditLog.list(20).map((a) => a.action);
    assert.ok(audit.includes("runpod_test_started") && audit.includes("runpod_test_done"));
  });

  test("every other ending removes the pod too: a refused restart, the owner's limit, ending it by hand; no capacity starts nothing", async () => {
    const refused = setup({ refuseStart: true });
    const a = await refused.tests.start("runpod", {}, "operator:mcp");
    const ra = await refused.until(a.id, () => !refused.tests.view(a.id)?.active);
    assert.match(ra?.notes.join(" ") ?? "", /RunPod would not start the pod again: .*no GPU free/);
    assert.equal(ra?.outcome, "failed");
    assert.equal(refused.cloud.pods.size, 0);

    const limited = setup();
    const b = await limited.tests.start("runpod", { stop_after_minutes: 5, restart: false }, "o");
    limited.tick(6 * 60_000);
    await limited.tests.advance();
    const rb = limited.tests.view(b.id);
    assert.equal(rb?.phase, "done");
    assert.match(rb?.notes.join(" ") ?? "", /Ended at the 5-minute limit you set/);
    assert.equal(limited.cloud.pods.size, 0);

    const byHand = setup();
    const c = await byHand.tests.start("runpod", { cloud_type: "COMMUNITY" }, "o");
    assert.equal(c.price_per_hr, 0.17, "Community's price, while the new pod shows none yet");
    const rc = await byHand.tests.end(c.id, "owner:ui");
    assert.equal(rc.active, false);
    assert.equal(rc.outcome, "ended");
    assert.equal(byHand.cloud.pods.size, 0);

    const full = setup({ noCapacity: true });
    await assert.rejects(
      full.tests.start("runpod", {}, "o"),
      /RunPod answered 400 for POST \/v2\/pods \(Bad Request: no capacity for that GPU\)/,
    );
    assert.equal(full.store.runpod.tests().length, 0);
    await assert.rejects(setup().tests.start("runpod", { gpu: "B200" }, "o"), /no GPU type "B200"/);
  });

  test("an operator starts, follows and ends one over MCP; a reader only follows; the dashboard shows it", async () => {
    const cloud = fakeCloud();
    const store = new ControlStore(":memory:");
    const secrets = SecretBox.ephemeral();
    store.gpuClouds.add({
      name: "runpod",
      kind: "runpod",
      key_sealed: secrets.seal(KEY),
      key_hint: "…cdef",
      by: "owner:ui",
    });
    const { control: api } = controlOnly({
      store,
      tokens: {
        operator: "operator-token-abcdef",
        agent: "agent-token-abcdef",
        read: "read-token-abcdef",
        rigs: {},
      },
      options: { secrets, cloudFetch: cloud.f, runpodTestImage: IMAGE },
    });
    const text = (r: unknown) =>
      JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? "null");
    const operator = await mcpClient(api, "operator-token-abcdef");
    const started = text(
      await operator.callTool({ name: "runpod_test_start", arguments: { cloud: "runpod" } }),
    );
    assert.equal(started.gpu_name, "RTX A4000");
    const reader = await mcpClient(api, "read-token-abcdef");
    const readerTools = (await reader.listTools()).tools.map((t) => t.name);
    assert.ok(readerTools.includes("runpod_tests") && !readerTools.includes("runpod_test_start"));
    const listed = text(
      await reader.callTool({ name: "runpod_tests", arguments: { cloud: "runpod" } }),
    );
    assert.equal(listed[0].id, started.id);
    const agent = await mcpClient(api, "agent-token-abcdef");
    assert.ok(!(await agent.listTools()).tools.some((t) => t.name.startsWith("runpod_")));

    const ui = await signIn(api);
    const page = await ui.page("/ui/settings");
    assert.match(page, new RegExp(`Test ${started.id}</b> · RTX A4000, Secure`));
    assert.match(page, /End it now: remove the pod/);
    assert.match(page, /a test pod is running/);
    assert.ok(!page.includes("Start a test pod"), "one at a time");

    const ended = text(
      await operator.callTool({ name: "runpod_test_end", arguments: { id: started.id } }),
    );
    assert.equal(ended.active, false);
    assert.equal(cloud.pods.size, 0);
    const after = await ui.page("/ui/settings");
    assert.match(after, /Start a test pod/);
    assert.match(after, new RegExp(`value="${IMAGE}"`), "control's test image fills the form in");
    // The form and the MCP tool name both images a test pod can run.
    assert.match(
      after,
      /Image<i class="ii" tabindex="0" data-tip="What the pod runs: Thermite's CUDA harness image, or the one-container rig image that a rig on RunPod starts from/,
    );
    const tool = (await operator.listTools()).tools.find((t) => t.name === "runpod_test_start");
    assert.match(
      String(tool?.description),
      /one pod of Thermite's CUDA harness image, or of the one-container rig image/,
    );
    const json = await ui.get(`/ui/settings/clouds/runpod/tests/${started.id}.json`);
    assert.equal(((await json.json()) as { id: string }).id, started.id);
    await Promise.all([operator.close(), reader.close(), agent.close()]);
  });

  test("on the one-container rig image, RunPod's variables are said to be taken out, not missing", () => {
    const state = (removed: boolean) =>
      ({
        report: {
          ...report("2026-10-21T03:00:00Z"),
          steps: {
            ...report("2026-10-21T03:00:00Z").steps,
            runpod_variables: {
              ok: true,
              value: { in_environment: [], in_files: {}, removed_by_entry_point: removed },
            },
          },
        },
      }) as unknown as Parameters<typeof findings>[0];
    assert.ok(
      findings(state(true)).includes(
        "RunPod's variables reach no process: the image's entry point took them out.",
      ),
    );
    assert.ok(
      findings(state(false)).includes(
        "RunPod sets no RUNPOD_ variables in the container's environment.",
      ),
    );
  });

  test("the probe starts its self-test's broker without pull mode's variables", () => {
    assert.match(PROBE_JS, /startsWith\("THERMITE_TUNNEL_"\)\) delete env\[k\]/);
  });

  test("the probe is a script node can run", async () => {
    const { Script } = await import("node:vm");
    assert.doesNotThrow(() => new Script(PROBE_JS));
  });
});
