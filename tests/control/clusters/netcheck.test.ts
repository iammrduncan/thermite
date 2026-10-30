import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CLOSED_RANGES,
  harnessIngress,
  harnessKeptOffCluster,
  reachEgress,
  reachedAnyway,
  reachesClosed,
  selects,
} from "../../../src/control/clusters/netcheck.ts";

const harness = {
  "app.kubernetes.io/name": "thermite",
  "app.kubernetes.io/component": "harness",
  "app.kubernetes.io/instance": "lab-1",
};
const dns = {
  ports: [
    { port: 53, protocol: "UDP" },
    { port: 53, protocol: "TCP" },
  ],
};
const internet = {
  to: [{ ipBlock: { cidr: "0.0.0.0/0", except: CLOSED_RANGES } }],
};
const policy = (name: string, podSelector: object, egress: object[]) => ({
  metadata: { name },
  spec: { podSelector, policyTypes: ["Egress"], egress },
});

describe("a slot's network rules and the harness", () => {
  test("DNS plus the internet without the closed ranges keeps the harness off the cluster", () => {
    const r = harnessKeptOffCluster(
      [
        policy("thermite-harness", { matchLabels: { "app.kubernetes.io/component": "harness" } }, [
          dns,
          internet,
        ]),
      ],
      harness,
    );
    assert.deepEqual(r.ok, true, r.why);
    // A default deny for every pod also keeps it off (and from everything else).
    assert.equal(harnessKeptOffCluster([policy("deny", {}, [])], harness).ok, true);
  });

  test("no rule, a rule open to anywhere, to pods, or to a private range: refused in words", () => {
    assert.match(harnessKeptOffCluster([], harness).why, /no network rule/);
    assert.match(
      harnessKeptOffCluster([policy("open", {}, [{}])], harness).why,
      /connect anywhere/,
    );
    assert.match(
      harnessKeptOffCluster([policy("pods", {}, [{ to: [{ podSelector: {} }] }])], harness).why,
      /pods in the cluster/,
    );
    assert.match(
      harnessKeptOffCluster(
        [policy("all", {}, [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }])],
        harness,
      ).why,
      /private, shared or link-local addresses/,
    );
    // The private ranges alone are not enough: link-local (a cloud's instance metadata), the
    // shared range and "this network" stay closed too.
    const rfc1918 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]; // public-check: allow (reserved ranges, for the test)
    const metadata = "169.254.169.254/32"; // public-check: allow (a link-local address, for the test)
    const shared = "100.100.100.100/32"; // public-check: allow (a shared address, for the test)
    for (const cidr of ["0.0.0.0/0", metadata, shared, "0.0.0.0/8"])
      assert.match(
        harnessKeptOffCluster(
          [policy("rfc1918", {}, [{ to: [{ ipBlock: { cidr, except: rfc1918 } }] }])],
          harness,
        ).why,
        /private, shared or link-local addresses/,
        cidr,
      );
    // Rules add up: one permissive rule that selects the harness opens it, whatever else says.
    assert.equal(
      harnessKeptOffCluster(
        [
          policy("strict", {}, [dns, internet]),
          policy("loose", { matchLabels: { "app.kubernetes.io/name": "thermite" } }, [{}]),
        ],
        harness,
      ).ok,
      false,
    );
    // A rule for other pods says nothing about the harness.
    assert.match(
      harnessKeptOffCluster([policy("other", { matchLabels: { app: "web" } }, [dns])], harness).why,
      /no network rule/,
    );
  });

  test("selectors and address ranges are read as Kubernetes reads them", () => {
    assert.ok(
      selects(
        {
          matchExpressions: [
            { key: "app.kubernetes.io/component", operator: "In", values: ["harness"] },
          ],
        },
        harness,
      ),
    );
    assert.ok(!selects({ matchExpressions: [{ key: "tier", operator: "Exists" }] }, harness));
    assert.ok(reachesClosed("10.1.0.0/16")); // public-check: allow (a private range, for the test)
    assert.ok(reachesClosed("100.64.0.0/16")); // public-check: allow (a shared range, for the test)
    assert.ok(reachesClosed("169.254.169.254/32")); // public-check: allow (a link-local address, for the test)
    assert.ok(!reachesClosed("203.0.113.0/24"));
    assert.ok(!reachesClosed("0.0.0.0/0", CLOSED_RANGES));
    assert.ok(reachesClosed("0.0.0.0/0", ["10.0.0.0/8"])); // public-check: allow (a private range, for the test)
  });

  test("a rule that opens exactly an address of the owner's list on its ports is accepted, and said", () => {
    const model = "100.64.0.7"; // public-check: allow (a shared address, for the test)
    const reach = [
      { address: model, ports: [8000, 8443], note: "the model server" },
      { address: "fd7a:115c:a1e0::7", ports: [9000], note: "" },
    ];
    const opens = (cidr: string, ports?: object[]) => ({
      to: [{ ipBlock: { cidr } }],
      ...(ports ? { ports } : {}),
    });
    const slot = (rule: object) =>
      harnessKeptOffCluster(
        [policy("thermite-harness", {}, [dns, internet, rule])],
        harness,
        reach,
      );
    const tcp = (port: number) => ({ port, protocol: "TCP" });
    const ok = slot(opens(`${model}/32`, [tcp(8000)]));
    assert.equal(ok.ok, true, ok.why);
    assert.deepEqual(ok.openings, [{ address: model, ports: [8000], rule: "thermite-harness" }]);
    assert.match(ok.why, /and an address of the list of addresses rigs may reach/);
    // A port with no protocol is TCP, as Kubernetes reads it; IPv6 is named as /128.
    assert.equal(slot(opens(`${model}/32`, [{ port: 8443 }])).ok, true);
    const six = slot(opens("fd7a:115c:a1e0:0::7/128", [tcp(9000)]));
    assert.deepEqual(six.openings, [
      { address: "fd7a:115c:a1e0::7", ports: [9000], rule: "thermite-harness" },
    ]);
    // Anything wider is refused, in words: every port, another port, UDP, a port range, a
    // neighbour, an address not in the list.
    assert.match(
      slot(opens(`${model}/32`)).why,
      /opens every port of 100\.64\.0\.7, which the list gives only 8000, 8443/,
    ); // public-check: allow (a shared address, for the test)
    for (const ports of [
      [tcp(22)],
      [{ port: 8000, protocol: "UDP" }],
      [{ port: 8000, endPort: 8443 }],
      [{ port: "http" }],
    ])
      assert.match(
        slot(opens(`${model}/32`, ports)).why,
        /on more than its listed TCP ports \(8000, 8443\)/,
        JSON.stringify(ports),
      );
    for (const cidr of ["100.64.0.6/31", "100.64.0.8/32", "fd7a:115c:a1e0::7/64"]) // public-check: allow (shared addresses, for the test)
      assert.match(
        slot(opens(cidr, [tcp(8000)])).why,
        /private, shared or link-local addresses/,
        cidr,
      );
    // Without the list, the same rule is refused as before.
    assert.equal(
      harnessKeptOffCluster([policy("p", {}, [opens(`${model}/32`, [tcp(8000)])])], harness).ok,
      false,
    );
  });

  test("control's own rules open each address of the list alone, on its ports", () => {
    const model = "100.64.0.7"; // public-check: allow (a shared address, for the test)
    const reach = [
      { address: model, ports: [8000], note: "" },
      { address: "fd7a:115c:a1e0::7", ports: [9000, 9001], note: "" },
    ];
    const egress = reachEgress(reach);
    assert.deepEqual(egress, [
      { to: [{ ipBlock: { cidr: `${model}/32` } }], ports: [{ port: 8000, protocol: "TCP" }] },
      {
        to: [{ ipBlock: { cidr: "fd7a:115c:a1e0::7/128" } }],
        ports: [
          { port: 9000, protocol: "TCP" },
          { port: 9001, protocol: "TCP" },
        ],
      },
    ]);
    // They pass control's own check of a slot with the same list.
    assert.equal(
      harnessKeptOffCluster([policy("own", {}, [dns, internet, ...egress])], harness, reach).ok,
      true,
    );
    // An address the harness reaches anyway is one outside the closed ranges.
    assert.equal(reachedAnyway("203.0.113.5"), true);
    assert.equal(reachedAnyway(model), false);
    assert.equal(reachedAnyway("fd7a:115c:a1e0::7"), false);
  });

  test("a slot's ingress: only the rig's supervisor, or a warning in words; never a refusal", () => {
    const rule = (name: string, ingress: object[], policyTypes = ["Ingress"]) => ({
      metadata: { name },
      spec: { podSelector: {}, policyTypes, ingress },
    });
    const supervisor = {
      from: [
        {
          podSelector: {
            matchLabels: {
              "app.kubernetes.io/instance": "lab-1",
              "app.kubernetes.io/component": "supervisor",
            },
          },
        },
      ],
      ports: [{ port: 8700, protocol: "TCP" }],
    };
    assert.deepEqual(harnessIngress([rule("in", [supervisor])], harness), {
      ok: true,
      why: "only the rig's supervisor may connect to the harness",
    });
    // A rule that lets nothing in, beside the supervisor's, is fine too.
    assert.equal(harnessIngress([rule("deny", []), rule("in", [supervisor])], harness).ok, true);
    const why = (policies: object[]) => harnessIngress(policies as never[], harness).why;
    assert.match(
      why([]),
      /no network rule in the slot limits who may connect to the harness, so every pod in the cluster can reach its port 8700/,
    );
    assert.match(
      why([policy("out", {}, [dns])]),
      /no network rule in the slot limits who may connect/,
    );
    assert.match(
      why([rule("open", [{}])]),
      /the rule "open" lets any pod or address connect to the harness/,
    );
    assert.match(
      why([rule("pods", [{ from: [{ podSelector: {} }] }])]),
      /lets pods other than the rig's supervisor connect/,
    );
    assert.match(
      why([rule("ns", [{ from: [{ namespaceSelector: {} }] }])]),
      /lets pods of other namespaces connect/,
    );
    assert.match(
      why([rule("ip", [{ from: [{ ipBlock: { cidr: "0.0.0.0/0" } }] }])]),
      /lets addresses in 0\.0\.0\.0\/0 connect/,
    );
    // Rules add up: the supervisor's rule beside an open one leaves it open.
    assert.equal(
      harnessIngress([rule("in", [supervisor]), rule("open", [{}])] as never[], harness).ok,
      false,
    );
  });
});
