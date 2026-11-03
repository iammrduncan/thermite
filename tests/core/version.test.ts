import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { buildInfo } from "../../src/common/build-info.ts";
import {
  buildFromHeaders,
  buildHeaders,
  compareVersions,
  incompatibility,
  OLDEST_PROTOCOL,
  PROTOCOL,
  readBuild,
} from "../../src/core/version.ts";

describe("builds and protocols", () => {
  test("a process reports package.json's version and the protocol it speaks", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    const own = buildInfo();
    assert.equal(own.version, pkg.version);
    assert.equal(own.protocol, PROTOCOL);
    assert.equal(own.oldest_protocol, OLDEST_PROTOCOL);
  });

  test("an update never cuts off the build before it: the protocol before this one stays accepted", () => {
    // When PROTOCOL goes up, OLDEST_PROTOCOL stays at the protocol before it for a release.
    assert.ok(OLDEST_PROTOCOL <= Math.max(1, PROTOCOL - 1));
    assert.ok(OLDEST_PROTOCOL <= PROTOCOL);
    const own = buildInfo();
    for (let p = OLDEST_PROTOCOL; p <= PROTOCOL; p++)
      assert.equal(incompatibility(own, { protocol: p, oldest_protocol: p }), null);
    if (PROTOCOL > 1)
      assert.equal(incompatibility(own, { protocol: PROTOCOL - 1, oldest_protocol: null }), null);
  });

  test("headers carry a build both ways; none, or none readable, is unknown", () => {
    const b = { version: "0.2.0-rc.1", commit: "1a2b3c4d5e6f", protocol: 3, oldest_protocol: 2 };
    const h = buildHeaders(b);
    assert.deepEqual(
      buildFromHeaders((n) => h[n]),
      b,
    );
    assert.equal(
      buildFromHeaders(() => undefined),
      null,
    );
    // A malformed part is unknown, never trusted; the rest is kept.
    assert.deepEqual(
      buildFromHeaders(
        (n) =>
          ({
            "x-thermite-version": "0.1.0",
            "x-thermite-commit": "not a commit",
            "x-thermite-protocol": "-1",
          })[n],
      ),
      { version: "0.1.0", commit: null, protocol: null, oldest_protocol: null },
    );
    assert.equal(readBuild({ version: "a b", protocol: "x" }), null);
    assert.equal(readBuild("0.1.0"), null);
    assert.deepEqual(readBuild({ protocol: 2 }), {
      version: null,
      commit: null,
      protocol: 2,
      oldest_protocol: null,
    });
  });

  test("versions order as semantic versions; others do not compare", () => {
    assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
    assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
    assert.equal(compareVersions("0.2.0-rc.1", "0.2.0"), -1);
    assert.equal(compareVersions("0.2.0", "0.2.0-rc.1"), 1);
    assert.equal(compareVersions("0.2.0-rc.2", "0.2.0-rc.10"), -1);
    assert.equal(compareVersions("0.2.0-1", "0.2.0-rc"), -1);
    assert.equal(compareVersions("0.2.0-rc", "0.2.0-rc.1"), -1);
    assert.equal(compareVersions("v0.2.0", "0.2.0+build.5"), 0);
    assert.equal(compareVersions("main", "0.2.0"), null);
  });

  test("only two known protocols that do not meet are a reason to refuse", () => {
    const control = { protocol: 3, oldest_protocol: 2 };
    assert.equal(incompatibility(control, null), null);
    assert.equal(incompatibility(control, { protocol: null, oldest_protocol: 9 }), null);
    assert.equal(incompatibility(control, { protocol: 2, oldest_protocol: 1 }), null);
    // Newer than control, and it still works with control's protocol.
    assert.equal(incompatibility(control, { protocol: 5, oldest_protocol: 3 }), null);
    // Newer, and it does not say how old a control it works with: not known, so not refused.
    assert.equal(incompatibility(control, { protocol: 5, oldest_protocol: null }), null);
    assert.deepEqual(incompatibility(control, { protocol: 1, oldest_protocol: 1 }), {
      reason: "speaks protocol 1, and control works with protocols 2 to 3",
      update: "rig",
    });
    assert.deepEqual(incompatibility(control, { protocol: 5, oldest_protocol: 4 }), {
      reason: "works with protocol 4 or later, and control speaks protocol 3",
      update: "control",
    });
    assert.deepEqual(
      incompatibility({ protocol: 1, oldest_protocol: 1 }, { protocol: 0, oldest_protocol: 0 }),
      { reason: "speaks protocol 0, and control works with protocol 1", update: "rig" },
    );
  });
});
