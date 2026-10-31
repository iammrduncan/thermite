import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createUser } from "@nats-io/nkeys";
import {
  BUS_REACH_GRACE_MS,
  BUS_REGISTERED_STEP,
  noteOffBusCall,
  offBus,
  offBusFix,
} from "../../../src/control/bus/index.ts";
import { newSealKey } from "../../../src/core/link/config.ts";
import { controlOnly, RIG_TOKEN, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * A rig off the message bus is broken (control/bus/reach.ts): it calls over HTTP with no keys on
 * the bus, it registered its keys and nothing came from it on the bus since, or it is a pod
 * control's bus can't dial. Its page, the rigs list and Needs you say so, in words, with what to
 * do.
 */

const report = (store: Parameters<typeof ingestReport>[0], rig = "rig-a") =>
  ingestReport(store, {
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: 0,
    next: 0,
    events: [],
    summary: {},
    generated_at: new Date().toISOString(),
  });

describe("a rig off the message bus", () => {
  test("one that calls over HTTP with no keys is broken while it calls, its history says so once a day, and it is set up again", async () => {
    const s = controlOnly();
    const call = await s.api(
      "POST",
      "/v1/rigs/rig-a/supervisor",
      { at: new Date().toISOString() },
      RIG_TOKEN,
    );
    assert.equal(call.status, 409);
    assert.match(
      ((await call.json()) as { error: string }).error,
      /^this rig has no keys on the message bus: control takes a rig's reports, commands and config only on the bus\. Set the rig up again/,
    );
    noteOffBusCall(s.store, "rig-a");
    const off = offBus(s.store, "rig-a", { lastSeen: "", now: Date.now() });
    assert.equal(off?.why, "http");
    assert.match(off?.words ?? "", /It calls control over HTTP, with no keys on the message bus/);
    assert.match(offBusFix(s.store, "rig-a", off as NonNullable<typeof off>), /Set it up again/);
    assert.equal(s.store.rigHistory.list("rig-a").filter((h) => h.step === "bus_off").length, 1);
    // Fifteen minutes with no such call: no longer said.
    assert.equal(
      offBus(s.store, "rig-a", { lastSeen: "", now: Date.now() + 16 * 60_000 }),
      undefined,
    );
  });

  test("one that registered its keys and has not reported on the bus since is broken, after a grace", async () => {
    const s = controlOnly();
    const registered = await s.api(
      "POST",
      "/v1/rigs/rig-a/supervisor",
      {
        at: new Date().toISOString(),
        bus_key: createUser().getPublicKey(),
        bus_seal_key: newSealKey().publicKey,
      },
      RIG_TOKEN,
    );
    assert.equal(registered.status, 200);
    const step = s.store.rigHistory.list("rig-a").find((h) => h.step === BUS_REGISTERED_STEP);
    assert.ok(step);
    const at = Date.parse(step.at);
    assert.equal(offBus(s.store, "rig-a", { lastSeen: "", now: at + 60_000 }), undefined, "grace");
    const later = at + BUS_REACH_GRACE_MS + 1000;
    const off = offBus(s.store, "rig-a", { lastSeen: "", now: later });
    assert.equal(off?.why, "silent");
    assert.match(off?.words ?? "", /nothing came from it on the message bus since/);
    // A report on the bus since: not broken.
    await report(s.store);
    const seen = s.store.reportedRigs.list()[0]?.last_seen ?? "";
    assert.equal(offBus(s.store, "rig-a", { lastSeen: seen, now: later }), undefined);
  });

  test("its page, the rigs list and Needs you say it is broken, with what to do", async () => {
    const s = controlOnly();
    await report(s.store);
    noteOffBusCall(s.store, "rig-a");
    const ui = await signIn(s.control);
    const page = await ui.page("/ui/rigs/rig-a");
    assert.match(page, /data-state="broken"/);
    assert.match(page, /Broken: rig-a is off the message bus\./);
    assert.match(page, /<b>To fix it:<\/b> Set it up again with this version/);
    assert.match(page, /<span class="bad">broken<\/span> · off the message bus/);
    const list = await ui.page("/ui/rigs");
    assert.match(list, /<span class="chip bad">Broken: off the bus<\/span>/);
    assert.match(list, /1 broken, off the bus/);
    const needs = await ui.page("/ui");
    assert.match(needs, /rig-a is broken: it is off the message bus/);
    assert.doesNotMatch(needs, /rig-a stopped reporting/, "said once, as broken");
  });
});
