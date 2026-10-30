import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mcpClient } from "../../../helpers/control-stack.ts";
import {
  ADMIN,
  control,
  fakeCluster,
  KUBECONFIG,
  OPERATOR,
} from "../../../helpers/fake-cluster.ts";

const MODEL = "100.64.0.7"; // public-check: allow (a shared address, for the test)
const OTHER = "192.168.5.20"; // public-check: allow (a private address, for the test)

/** The harness's network rule in the last apply that had one. */
function harnessRule(calls: { args: string[]; stdin?: string }[]) {
  type Obj = { kind: string; metadata: { name: string }; spec: { egress: unknown[] } };
  const applies = calls.filter((c) => c.args[0] === "apply" && c.stdin?.includes("NetworkPolicy"));
  const items = (JSON.parse(applies.at(-1)?.stdin ?? "{}") as { items?: Obj[] }).items ?? [];
  return items.find((o) => o.kind === "NetworkPolicy" && o.metadata.name.endsWith("harness-net"));
}

describe("addresses cluster rigs may reach", () => {
  test("the owner keeps the list in Settings; control writes it into a created rig's rules at once", async () => {
    const f = fakeCluster();
    const s = await control(f.k);
    await s.post("/ui/settings/add", {
      type: "k8s",
      name: "k8s-a",
      kubeconfig: KUBECONFIG,
      placement: "created",
      namespace_pattern: "thermite-{rig}",
    });
    let page = await s.page("/ui/settings");
    assert.match(page, /<h2>Addresses cluster rigs may reach<\/h2><span class="n">0<\/span>/);
    assert.match(page, /No address: cluster rigs' harnesses reach DNS and the internet only/);
    // Every label has its hover description.
    for (const label of ["Address", "TCP ports", "What it is"])
      assert.match(
        page,
        new RegExp(`${label}<i class="ii" tabindex="0" data-tip="[^"]+">i</i>`),
        label,
      );
    // Refused in words: a range, a public address, a port that is not one.
    assert.match(
      await s.post("/ui/settings/reach", { address: "100.64.0.0/10", ports: "8000" }), // public-check: allow (a reserved range, for the test)
      /error=addresses\[0\]\.address: "100\.64\.0\.0\/10" is a range: give one address.*at=reach#reach/, // public-check: allow (a reserved range, for the test)
    );
    assert.match(
      await s.post("/ui/settings/reach", { address: "203.0.113.5", ports: "443" }),
      /error=203\.0\.113\.5 is outside the private, shared and link-local ranges: rigs' harnesses reach it already, on every port/,
    );
    assert.match(
      await s.post("/ui/settings/reach", { address: MODEL, ports: "8000, http" }),
      /error="http" is not a TCP port/,
    );
    // A rig in a namespace control creates gets the list in its harness's rule.
    await s.post("/ui/rigs/add", {
      place: "cluster:k8s-a",
      rig: "k8s-a-1",
      "k_gpus__k8s-a": "0",
    });
    await new Promise((r) => setTimeout(r, 20));
    s.store.clusters.setRigStatus("k8s-a-1", "running");
    assert.equal(harnessRule(f.calls)?.spec.egress.length, 2, "DNS and the internet only");
    const said = await s.post("/ui/settings/reach", {
      address: MODEL,
      ports: "8000 8443",
      note: "the model server",
    });
    assert.match(
      said,
      /ok=The list holds 1 address\. Control applies it to the network rules of k8s-a-1 now\.&at=reach#reach/,
    );
    await new Promise((r) => setTimeout(r, 20));
    const rule = harnessRule(f.calls);
    assert.deepEqual(rule?.spec.egress.at(-1), {
      to: [{ ipBlock: { cidr: `${MODEL}/32` } }],
      ports: [
        { port: 8000, protocol: "TCP" },
        { port: 8443, protocol: "TCP" },
      ],
    });
    // Only the network rules: no deployment restarts for it.
    const last = f.calls.filter((c) => c.args[0] === "apply").at(-1)?.stdin ?? "";
    assert.ok(!last.includes('"Deployment"'));
    assert.deepEqual(
      s.store.rigHistory
        .list("k8s-a-1")
        .filter((e) => e.step === "network")
        .map((e) => [e.ok, e.detail]),
      [[true, "1 address of the list"]],
    );
    page = await s.page("/ui/settings");
    assert.match(
      page,
      /<code>100\.64\.0\.7<\/code><span class="small">on ports 8000 and 8443 · the model server/,
    ); // public-check: allow (a shared address, for the test)
    const rigPage = await s.page("/ui/rigs/k8s-a-1");
    assert.match(rigPage, /Its network rules applied with the list of addresses rigs may reach/);
    assert.match(
      rigPage,
      /<dt>Its harness reaches<\/dt><dd>DNS, the internet, and <a href="\/ui\/settings#reach">the list in Settings<\/a>: 100\.64\.0\.7 on ports 8000 and 8443 \(the model server\)/,
    ); // public-check: allow (a shared address, for the test)
    // The same address again takes the new ports in place of its own; Remove takes it out.
    await s.post("/ui/settings/reach", { address: MODEL, ports: "8000" });
    assert.deepEqual(
      s.store.reachable.list().map((e) => [e.address, e.ports, e.note]),
      [[MODEL, [8000], ""]],
    );
    assert.match(
      await s.post("/ui/settings/reach/remove", { address: MODEL }),
      /ok=The list holds no address/,
    );
    assert.deepEqual(s.store.reachable.list(), []);
    assert.equal(s.store.auditLog.list(50, { action: "reachable_addresses_set" }).length, 3);
  });

  test("REST and MCP: the owner sets the list; the operator reads it", async () => {
    const f = fakeCluster();
    const s = await control(f.k);
    const rest = (method: string, token: string, body?: unknown) =>
      s.api.request("/v1/reachable-addresses", {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const put = await rest("PUT", ADMIN, {
      addresses: [{ address: "FD7A:115C:A1E0::7", ports: [9000], note: "a target" }],
    });
    assert.equal(put.status, 200, await put.clone().text());
    const answer = (await put.json()) as {
      addresses: { address: string; set_by: string }[];
      said: string;
    };
    assert.equal(answer.addresses[0]?.address, "fd7a:115c:a1e0::7");
    assert.equal(answer.addresses[0]?.set_by, "owner:api");
    assert.equal(answer.said, "The list holds 1 address.");
    const bad = await rest("PUT", ADMIN, {
      addresses: [
        { address: OTHER, ports: [22] },
        { address: OTHER, ports: [80] },
      ],
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /listed twice/);
    assert.equal((await rest("PUT", ADMIN, { list: [] })).status, 400);
    assert.equal((await rest("PUT", OPERATOR, { addresses: [] })).status, 401);
    assert.equal((await rest("GET", OPERATOR)).status, 401);
    const got = (await (await rest("GET", ADMIN)).json()) as { addresses: unknown[] };
    assert.equal(got.addresses.length, 1);

    const operator = await mcpClient(s.api, OPERATOR);
    const names = (await operator.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("reachable_addresses"));
    assert.ok(!names.includes("set_reachable_addresses"), "setting it is the owner's");
    const read = (await operator.callTool({ name: "reachable_addresses", arguments: {} })) as {
      content: { text: string }[];
    };
    assert.equal(JSON.parse(read.content[0]?.text ?? "{}").addresses.length, 1);
    await operator.close();
    const owner = await mcpClient(s.api, ADMIN);
    const set = async (addresses: unknown[]) =>
      (await owner.callTool({ name: "set_reachable_addresses", arguments: { addresses } })) as {
        isError?: boolean;
        content: { text: string }[];
      };
    assert.notEqual((await set([{ address: MODEL, ports: [8000] }])).isError, true);
    assert.equal(s.store.reachable.list()[0]?.set_by, "owner:mcp");
    const refused = await set([{ address: "203.0.113.5", ports: [8000] }]);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]?.text ?? "", /rigs' harnesses reach it already, on every port/);
    await owner.close();
  });

  test("a slot whose rule opens exactly a listed address and port is taken, and its page says so", async () => {
    const opens = (ports: unknown[] | undefined) => ({
      to: [{ ipBlock: { cidr: `${MODEL}/32` } }],
      ...(ports ? { ports } : {}),
    });
    const f = fakeCluster({
      canCreateNamespaces: false,
      slots: { "thermite-slot-1": true },
      moreEgress: [opens([{ port: 8000, protocol: "TCP" }])],
    });
    const s = await control(f.k);
    const add = {
      type: "k8s",
      name: "k8s-b",
      kubeconfig: KUBECONFIG,
      placement: "slot",
      slots: "thermite-slot-1",
    };
    await s.post("/ui/settings/add", add);
    // Not in the list: refused, as before.
    assert.match(
      await s.page("/ui/settings"),
      /thermite-slot-1: <span class="chip warn">refused: the rule &quot;thermite-harness&quot; lets the harness reach private, shared or link-local addresses/,
    );
    const rig = {
      place: "cluster:k8s-b",
      rig: "k8s-b-1",
      "k_gpus__k8s-b": "0",
      "k_slot__k8s-b": "thermite-slot-1",
    };
    assert.match(
      await s.post("/ui/rigs/add", rig),
      /Refused: in the slot thermite-slot-1, the rule "thermite-harness" lets the harness reach private, shared or link-local addresses/,
    );
    // Listed on another port only: still refused, in words.
    s.store.reachable.set([{ address: MODEL, ports: [9000], note: "" }], "owner:test");
    assert.match(
      await s.post("/ui/rigs/add", rig),
      /opens 100\.64\.0\.7 on more than its listed TCP ports \(9000\)/,
    ); // public-check: allow (a shared address, for the test)
    // Listed with its port: taken, and the rig's page lists the opening.
    s.store.reachable.set(
      [{ address: MODEL, ports: [8000], note: "the model server" }],
      "owner:test",
    );
    await s.post("/ui/settings/clusters/k8s-b/check", {});
    assert.match(await s.page("/ui/settings"), /thermite-slot-1: <span class="chip ok">free/);
    assert.equal(await s.post("/ui/rigs/add", rig), "/ui/rigs/k8s-b-1");
    assert.deepEqual(s.store.clusters.rig("k8s-b-1")?.spec.openings, [
      { address: MODEL, ports: [8000], rule: "thermite-harness" },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    assert.match(
      await s.page("/ui/rigs/k8s-b-1"),
      /<dt>Its harness reaches<\/dt><dd>DNS, the internet, and what the slot's rules open of <a href="\/ui\/settings#reach">the list in Settings<\/a>: 100\.64\.0\.7 on port 8000, by the rule &quot;thermite-harness&quot;/, // public-check: allow (a shared address, for the test)
    );
    // Control writes no rule in a slot: a change of the list applies nothing there.
    const applies = f.calls.filter((c) => c.args[0] === "apply").length;
    await s.post("/ui/settings/reach", { address: MODEL, ports: "8000 8001" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.calls.filter((c) => c.args[0] === "apply").length, applies);
  });
});
