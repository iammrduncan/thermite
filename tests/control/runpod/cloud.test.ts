import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createPod, readRunpod, runpodLine } from "../../../src/control/runpod/cloud.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { FAKE_RUNPOD_KEY, fakeRunpod as runpodFake } from "../../helpers/fake-runpod.ts";

const KEY = "rpa_test-key-0123456789abcdef";

/** RunPod's API behind a fake fetch: what it answers to the right key, and every call it got. */
function fakeRunpod(o: { down?: boolean; pods?: unknown[]; noBilling?: boolean } = {}) {
  const calls: { url: string; auth: string; method: string }[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ url, auth, method: init?.method ?? "GET" });
    if (o.down) throw new Error("getaddrinfo ENOTFOUND api.runpod.io");
    if (auth !== `Bearer ${KEY}`) return json({ error: "unauthorized" }, 401);
    const path = new URL(url).pathname;
    if (path === "/v2/billing") {
      if (o.noBilling) return json({ title: "Forbidden" }, 403);
      const monthly = new URL(url).searchParams.get("bucketSize") === "month";
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      return json(
        monthly
          ? { records: [], metadata: { totals: { totalAmount: 12.34 } } }
          : {
              records: [
                { startTime: `${yesterday}T00:00:00Z`, totalAmount: 1.5 },
                { startTime: `${today}T00:00:00Z`, totalAmount: 0.25 },
              ],
              metadata: { totals: { totalAmount: 1.75 } },
            },
      );
    }
    if (path === "/v2/pods")
      return json({
        pods: o.pods ?? [
          {
            id: "p1",
            name: "spike",
            status: "RUNNING",
            cost: 0.69,
            gpu: { count: 1, id: "NVIDIA RTX A4000" },
          },
        ],
      });
    if (path === "/v2/catalog/gpus")
      return json({
        gpus: [
          {
            id: "NVIDIA H100 80GB HBM3",
            name: "H100 SXM",
            memory: 80,
            secure: true,
            community: false,
            price: { secure: 2.69, community: null },
            availability: "LOW",
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
    if (path === "/v2/catalog/datacenters")
      return json({ dataCenters: [{ id: "EU-RO-1", name: "Romania", region: "Europe" }] });
    if (path === "/v2/network-volumes")
      return json({
        networkVolumes: [{ id: "v1", name: "kits", size: 50, dataCenter: "EU-RO-1" }],
        pagination: {},
      });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  return { f, calls };
}

describe("RunPod reader", () => {
  test("reads GPU types (cheapest first), data centers, volumes and pods; only reads", async () => {
    const rp = fakeRunpod();
    const facts = await readRunpod(KEY, rp.f);
    assert.deepEqual(
      facts.gpus.map((g) => [g.name, g.price_secure, g.price_community, g.availability]),
      [
        ["RTX A4000", 0.25, 0.17, "HIGH"],
        ["H100 SXM", 2.69, null, "LOW"],
      ],
    );
    assert.deepEqual(facts.datacenters, [{ id: "EU-RO-1", name: "Romania", region: "Europe" }]);
    assert.deepEqual(facts.volumes, [
      { id: "v1", name: "kits", size_gb: 50, datacenter: "EU-RO-1" },
    ]);
    assert.deepEqual(facts.pods, [
      { id: "p1", name: "spike", status: "RUNNING", cost_per_hr: 0.69, gpus: 1 },
    ]);
    assert.ok(
      rp.calls.every((c) => c.method === "GET" && c.url.startsWith("https://api.runpod.io/v2/")),
    );
    assert.equal(
      runpodLine(facts),
      "2 GPU types · from $0.25/h (RTX A4000, Secure) · 1 data centers · 1 pod running, $0.69/h · $12.34 spent this month",
    );
  });

  test("a pod's volume and data center use the names of RunPod's create-a-pod body (v2)", async () => {
    const cloud = runpodFake();
    const spec = {
      name: "thermite-rig-1",
      image: "registry.example.com/rig:1",
      gpu: "NVIDIA RTX A4000",
      gpuCount: 1,
      cloud: "SECURE" as const,
      diskGb: 40,
      datacenter: "EU-RO-1",
      volumeGb: 40,
      volumeMountPath: "/workspace",
      ports: ["8700/http"],
      env: {},
    };
    const pod = await createPod(FAKE_RUNPOD_KEY, spec, cloud.fetch);
    assert.equal(pod.datacenter, "EU-RO-1");
    const body = cloud.calls.find((c) => c.method === "POST")?.body as Record<string, unknown>;
    assert.deepEqual(body.mounts, { persistent: { size: 40, path: "/workspace" } });
    assert.deepEqual(body.dataCenterIds, ["EU-RO-1"]);
    assert.equal(body.volume, undefined);
    // RunPod refuses a body it cannot take, and names the field: the words keep it.
    await assert.rejects(
      createPod(FAKE_RUNPOD_KEY, { ...spec, volumeGb: 5 }, cloud.fetch),
      /RunPod answered 422 for POST \/v2\/pods \(Unprocessable Entity: Request validation failed\.: \[\{"field":"mounts"\}\]\)/,
    );
  });

  test("a wrong key and an unreachable API are said in words", async () => {
    await assert.rejects(readRunpod("wrong-key-000000", fakeRunpod().f), /RunPod refused the key/);
    await assert.rejects(
      readRunpod(KEY, fakeRunpod({ down: true }).f),
      /control could not reach RunPod: getaddrinfo ENOTFOUND/,
    );
  });
});

async function control(f: typeof fetch) {
  const secrets = SecretBox.ephemeral();
  const { store, control: api } = controlOnly({
    tokens: { rigs: {} },
    options: { secrets, cloudFetch: f },
  });
  const ui = await signIn(api);
  const { page } = ui;
  const csrf = ui.csrfOf(await page("/ui/settings"));
  const post = async (path: string, form: Record<string, string>) =>
    decodeURIComponent(String((await ui.post(path, { csrf, ...form })).headers.get("location")));
  return { store, secrets, page, post };
}

describe("RunPod in Providers", () => {
  test("added with its key sealed, read, shown, re-keyed and deleted; a refused key is not kept", async () => {
    const rp = fakeRunpod();
    const s = await control(rp.f);
    assert.match(
      await s.page(
        await s.post("/ui/settings/add", {
          type: "runpod",
          name: "runpod",
          runpod_key: "wrong-key-000000",
        }),
      ),
      /Not added: RunPod refused the key/,
    );
    assert.equal(s.store.gpuClouds.get("runpod"), undefined);
    // The refusal is kept in control's log, without the key.
    const refusal = s.store.auditLog.list(10, { action: "refused" })[0]?.body as
      | { path?: string; why?: string }
      | undefined;
    assert.equal(refusal?.path, "/ui/settings/add");
    assert.match(String(refusal?.why), /RunPod refused the key/);
    assert.ok(!JSON.stringify(s.store.auditLog.list(100)).includes("wrong-key-000000"));
    // A name typed with capitals is taken in lowercase.
    assert.match(
      await s.post("/ui/settings/add", { type: "runpod", name: "RunPod", runpod_key: KEY }),
      /"runpod" is added and read/,
    );
    const g = s.store.gpuClouds.get("runpod");
    assert.equal(s.secrets.open(g?.key_sealed ?? ""), KEY);
    assert.equal(g?.key_hint, "…cdef");
    let page = await s.page("/ui/settings");
    assert.ok(!page.includes(KEY), "the key is never shown");
    assert.match(page, /RunPod \(a GPU cloud\)/);
    assert.match(page, /2 GPU types · from \$0\.25\/h \(RTX A4000, Secure\)/);
    assert.match(
      page,
      /<td>H100 SXM<\/td><td class="num">80 GB<\/td><td class="num">\$2\.69<\/td><td class="num">–<\/td><td>low<\/td>/,
    );
    assert.match(page, /1 pod running: billed while they run/);
    assert.match(page, /kits: 50 GB in EU-RO-1/);
    assert.match(page, /control starts only the pods you ask for/);
    assert.match(page, /href="\/ui\/rigs\/add\/runpod\?cloud=runpod">Launch a rig<\/a>/);
    // Spend, from RunPod's billing.
    assert.match(page, /\$12\.34 spent this month/);
    assert.match(
      page,
      /today <b>\$0\.25<\/b> · this month <b>\$12\.34<\/b> · last 30 days <b>\$1\.75<\/b>/,
    );
    assert.match(
      await s.post("/ui/settings/add", { type: "runpod", name: "runpod", runpod_key: KEY }),
      /exists already/,
    );

    // A new key RunPod refuses leaves the old one in place.
    assert.match(
      await s.page(
        await s.post("/ui/settings/clouds/runpod/key", { runpod_key: "wrong-key-000000" }),
      ),
      /Kept the old key: RunPod refused the key/,
    );
    assert.equal(s.secrets.open(s.store.gpuClouds.get("runpod")?.key_sealed ?? ""), KEY);

    // A key that may not read billing: the rest is read, and the spend says why.
    const nb = await control(fakeRunpod({ noBilling: true }).f);
    assert.match(
      await nb.post("/ui/settings/add", { type: "runpod", name: "rp-nb", runpod_key: KEY }),
      /"rp-nb" is added and read/,
    );
    assert.match(await nb.page("/ui/settings"), /RunPod refused this key for billing/);

    // RunPod can't be reached: the last read stays, with why.
    const down = await control(fakeRunpod({ down: true }).f);
    assert.match(
      await down.page(
        await down.post("/ui/settings/add", { type: "runpod", name: "rp", runpod_key: KEY }),
      ),
      /Not added: control could not reach RunPod/,
    );

    assert.match(await s.post("/ui/settings/clouds/runpod/check", {}), /Read "runpod" again/);
    assert.match(
      await s.post("/ui/settings/clouds/runpod/delete", {}),
      /"runpod" is deleted: control keeps nothing of its key/,
    );
    assert.equal(s.store.gpuClouds.get("runpod"), undefined);
    page = await s.page("/ui/settings");
    assert.ok(!page.includes("RunPod ·"));
    // Every call only read.
    assert.ok(rp.calls.every((c) => c.method === "GET"));
  });
});
