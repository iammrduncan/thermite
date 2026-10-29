import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  BusMessage,
  ConsumerSettings,
  StreamSettings,
} from "../../../src/common/bus/index.ts";
import { foldLive, followLive, LIVE_REFUSALS, LiveTaken } from "../../../src/control/live/index.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import { generateSigningKeys, signJson } from "../../../src/core/commands.ts";
import {
  LIVE_CONSUMER_CONFIG,
  LIVE_RIG_HEADER,
  LIVE_STREAM_CONFIG,
} from "../../../src/core/link/live.ts";
import { type LiveEntry, liveBody } from "../../../src/core/live.ts";

/**
 * Control's live view from the message bus (goal 168, step 2): each message checked as a batch
 * posted over HTTP is, against the rig its subject or header names and control's run registry,
 * and folded into the same live view. A message refused is counted by why and passed over.
 */

const keys = generateSigningKeys();
const other = generateSigningKeys();

/** Control's store with rig-a and rig-b known, rig-a's report key pinned, and rig-a's run r1. */
function setup() {
  const store = new ControlStore(":memory:");
  store.enrollments.setConfiguredRigs(["rig-a", "rig-b"]);
  store.reportedRigs.pinKey("rig-a", keys.publicKeyPem);
  const at = new Date().toISOString();
  store.runRegistry.registerRunCreated("rig-a", "ledger-1", {
    kind: "run_created",
    subject: "r1",
    body: {},
    at,
  });
  const taken = new LiveTaken();
  const fold = (m: BusMessage) => foldLive({ store, taken }, m);
  return { store, taken, fold };
}

let seq = 0;
const line = (source: string, run?: string, over: Partial<LiveEntry> = {}): LiveEntry => ({
  seq: ++seq,
  at: new Date().toISOString(),
  source,
  kind: "status",
  text: `line ${seq}`,
  ...(run ? { run } : {}),
  ...over,
});

/** A batch as the harness signs it (with `key`), or unsigned as the supervisor's own. */
function batch(entries: unknown[], o: { rig?: string; key?: typeof keys | null } = {}) {
  const b = { rig: o.rig ?? "rig-a", log_id: "log-1", from: 0, next: seq, entries };
  const key = o.key === undefined ? keys : o.key;
  return key
    ? {
        ...b,
        rig_pubkey: key.publicKeyPem,
        signature: signJson(liveBody(b), key.privateKeyPem),
      }
    : b;
}

/** A message on `subject`, with the rig in its header unless told otherwise. */
function msg(
  subject: string,
  data: unknown,
  headers: Record<string, string> = { [LIVE_RIG_HEADER]: "rig-a" },
): BusMessage {
  return {
    subject,
    seq: 1,
    data: new TextEncoder().encode(typeof data === "string" ? data : JSON.stringify(data)),
    header: (k) => headers[k],
  };
}

describe("control's live view from the message bus", () => {
  test("the harness's lines are kept signed, the supervisor's unsigned, and the counts say so", () => {
    const s = setup();
    const planner = [line("planner", "r1"), line("planner", "r1")];
    assert.deepEqual(s.fold(msg("thermite.run.r1.live.planner", batch(planner))), {
      added: 2,
      leftOut: 0,
    });
    // The rig's own subject names the rig itself: no header needed.
    const judge = [line("judge")];
    assert.deepEqual(s.fold(msg("thermite.rig.rig-a.live.judge", batch(judge), {})), {
      added: 1,
      leftOut: 0,
    });
    const own = [line("supervisor", "r1")];
    const unsigned = batch(own, { key: null });
    assert.deepEqual(s.fold(msg("thermite.run.r1.live.supervisor", unsigned)), {
      added: 1,
      leftOut: 0,
    });
    // The same message again adds nothing: a line is kept once.
    assert.deepEqual(s.fold(msg("thermite.run.r1.live.planner", batch(planner))), {
      added: 0,
      leftOut: 0,
    });
    assert.deepEqual(
      s.store.liveLines.tail("rig-a", 10).map((e) => [e.source, e.signed]),
      [
        ["planner", true],
        ["planner", true],
        ["judge", true],
        ["supervisor", false],
      ],
    );
    assert.equal(s.taken.messages, 4);
    assert.equal(s.taken.lines, 4);
    assert.deepEqual(Object.fromEntries(s.taken.rigs), { "rig-a": 4 });
  });

  test("a line of another subject, or of a kind control does not know, is left out and counted", () => {
    const s = setup();
    const mixed = [
      line("planner", "r1"),
      line("judge", "r1"),
      line("planner", "r2"),
      { ...line("planner", "r1"), kind: "diff" },
    ];
    assert.deepEqual(s.fold(msg("thermite.run.r1.live.planner", batch(mixed))), {
      added: 1,
      leftOut: 3,
    });
    // On the rig's subject, a line may name any run: the supervisor sends a run's lines there
    // while the bus refuses the run's own subject.
    const fallback = [line("planner", "r1"), line("judge", "r1")];
    assert.deepEqual(s.fold(msg("thermite.rig.rig-a.live.planner", batch(fallback), {})), {
      added: 1,
      leftOut: 1,
    });
    assert.equal(s.taken.leftOut, 4);
  });

  test("each refusal is counted by why, and nothing is kept", () => {
    const s = setup();
    const ok = [line("planner", "r1")];
    const tampered = { ...batch(ok), entries: [{ ...ok[0], text: "something else" }] };
    const cases: [BusMessage, string][] = [
      [msg("thermite.rig.rig-a.report", batch(ok)), "not a live subject"],
      [msg("thermite.run.r1.live.planner", batch(ok), {}), "no rig named"],
      [
        msg("thermite.rig.rig-z.live.planner", batch(ok, { rig: "rig-z" }), {}),
        "no such rig: control has no token for it",
      ],
      [
        msg("thermite.run.r2.live.planner", batch([line("planner", "r2")])),
        "a run control does not give this rig",
      ],
      [
        msg("thermite.run.r1.live.planner", batch(ok), { [LIVE_RIG_HEADER]: "rig-b" }),
        "a run control does not give this rig",
      ],
      [msg("thermite.run.r1.live.planner", "{not json"), "not a live message"],
      [msg("thermite.run.r1.live.planner", { rig: "rig-a" }), "not a live message"],
      [msg("thermite.rig.rig-a.live.planner", batch(ok, { rig: "rig-b" }), {}), "rig mismatch"],
      [
        msg("thermite.run.r1.live.planner", batch(ok, { key: other })),
        "live lines must be signed with the rig's pinned key",
      ],
      [msg("thermite.run.r1.live.planner", tampered), "bad live signature"],
      [
        msg("thermite.run.r1.live.planner", batch(ok, { key: null })),
        "unsigned lines must be the supervisor's own",
      ],
    ];
    for (const [m, why] of cases) assert.deepEqual(s.fold(m), { refused: why }, why);
    s.store.retired.add("rig-a", "owner:test");
    assert.deepEqual(s.fold(msg("thermite.run.r1.live.planner", batch(ok))), {
      refused: "this rig is retired in control",
    });
    assert.deepEqual(s.store.liveLines.tail("rig-a", 10), []);
    assert.equal(s.taken.messages, 0);
    assert.equal(s.taken.refused["not a live message"], 2);
    for (const why of Object.keys(s.taken.refused))
      assert.ok((LIVE_REFUSALS as readonly string[]).includes(why), why);
  });

  test("a rig whose report key control has not accepted yet has its lines refused", () => {
    const s = setup();
    s.store.enrollments.setConfiguredRigs(["rig-a", "rig-b", "rig-c"]);
    s.store.runRegistry.registerRunCreated("rig-c", "ledger-3", {
      kind: "run_created",
      subject: "r3",
      body: {},
      at: new Date().toISOString(),
    });
    const m = msg(
      "thermite.run.r3.live.planner",
      batch([line("planner", "r3")], { rig: "rig-c" }),
      {
        [LIVE_RIG_HEADER]: "rig-c",
      },
    );
    assert.deepEqual(s.fold(m), { refused: "the rig's report key is not accepted yet" });
  });

  test("control follows the live stream with its own consumer, folding each message", async () => {
    const s = setup();
    let followed: [StreamSettings | string, ConsumerSettings] | undefined;
    let folded: unknown;
    await followLive(
      {
        follow: async (stream, consumer, handle) => {
          followed = [stream, consumer];
          folded = await handle(
            msg("thermite.run.r1.live.planner", batch([line("planner", "r1")])),
          );
        },
      },
      { store: s.store, taken: s.taken },
    );
    assert.deepEqual(followed, [LIVE_STREAM_CONFIG, LIVE_CONSUMER_CONFIG]);
    assert.equal(folded, undefined, "acked once folded");
    assert.equal(s.store.liveLines.tail("rig-a", 10).length, 1);
  });
});
