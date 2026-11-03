import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canonicalAddress,
  REACH_MAX_ENTRIES,
  REACH_MAX_PORTS,
  ReachList,
} from "../../src/core/reach.ts";

const MODEL = "100.64.0.7"; // public-check: allow (a shared address, for the test)

describe("the list of addresses cluster rigs may reach", () => {
  test("an address is one IPv4 or IPv6 host, in one form", () => {
    assert.equal(canonicalAddress(` ${MODEL} `), MODEL);
    assert.equal(canonicalAddress("FD7A:115C:A1E0:0:0:0:0:7"), "fd7a:115c:a1e0::7");
    assert.equal(canonicalAddress("::1"), "::1");
    for (const bad of [
      "100.64.0",
      "100.64.0.256", // public-check: allow (not an address, for the test)
      "100.064.0.7",
      `${MODEL}/32`,
      "fd7a::7%eth0",
      "model.local",
      "[fd7a::7]",
      `${MODEL}:8000`,
      "",
    ])
      assert.equal(canonicalAddress(bad), undefined, bad);
  });

  test("the list keeps each address once, its ports in order, and refuses in words", () => {
    const ok = ReachList.parse([{ address: MODEL, ports: [8443, 8000, 8000], note: " model " }]);
    assert.deepEqual(ok, [{ address: MODEL, ports: [8000, 8443], note: "model" }]);
    const words = (raw: unknown) => {
      const r = ReachList.safeParse(raw);
      assert.equal(r.success, false);
      return r.error?.issues.map((i) => i.message).join("; ") ?? "";
    };
    assert.match(words([{ address: `${MODEL}/30`, ports: [80] }]), /is a range: give one address/);
    assert.match(
      words([{ address: "model.local", ports: [80] }]),
      /is not one IPv4 or IPv6 address/,
    );
    assert.match(words([{ address: MODEL, ports: [] }]), /give at least one TCP port/);
    assert.match(
      words([
        { address: MODEL, ports: Array.from({ length: REACH_MAX_PORTS + 1 }, (_, i) => i + 1) },
      ]),
      new RegExp(`at most ${REACH_MAX_PORTS} ports`),
    );
    assert.equal(ReachList.safeParse([{ address: MODEL, ports: [0] }]).success, false);
    assert.equal(ReachList.safeParse([{ address: MODEL, ports: [65536] }]).success, false);
    assert.match(
      words([
        { address: MODEL, ports: [80] },
        { address: MODEL, ports: [81] },
      ]),
      /listed twice: give it once, with all its ports/,
    );
    const many = Array.from({ length: REACH_MAX_ENTRIES + 1 }, (_, i) => ({
      address: `fd7a::${i + 1}`,
      ports: [80],
    }));
    assert.match(words(many), new RegExp(`at most ${REACH_MAX_ENTRIES} addresses`));
    assert.deepEqual(ReachList.parse([]), []);
  });
});
