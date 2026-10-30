import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CLOSED_RANGES,
  harnessKeptOffCluster,
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
});
