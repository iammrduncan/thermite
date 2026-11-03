import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMMANDS_WAITING_MAX,
  heldCommands,
  publishHeld,
  sendCommandsOn,
} from "../../../src/control/issue/bus.ts";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { verifyCommand } from "../../../src/core/commands.ts";
import {
  COMMAND_STREAM,
  COMMAND_STREAM_CONFIG,
  commandSubject,
} from "../../../src/core/link/commands.ts";
import { controlOnly } from "../../helpers/control-stack.ts";
import { answerCommand } from "../../helpers/control-store.ts";
import { FakeBus, settle } from "../../helpers/fake-bus.ts";

const SUBJECT = commandSubject("rig-a");

/** Control with rig-a, its commands sent on a bus. */
async function control() {
  const c = controlOnly();
  const bus = new FakeBus();
  await sendCommandsOn(c.store, bus);
  /** A pause of run-1 on rig-a, as the dashboard, MCP and the API issue a command: its id. */
  const pause = (reason = "a test") =>
    issueCommand(c.store, c.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "pause_run",
      payload: { run: "run-1", reason },
      issuedBy: "owner:test",
    }).id;
  /** The ids of rig-a's pending commands, as control's store holds them. */
  const pending = async () => c.store.commands.pending("rig-a").map((x) => x.envelope.id);
  /** The ids of rig-a's commands control holds off the bus. */
  const held = () => heldCommands(c.store, "rig-a").map((h) => h.id);
  /** The command as control's store records it. */
  const recorded = (id: string) =>
    String(
      (c.store.db.prepare("select signed from command where id = ?").get(id) as { signed: string })
        .signed,
    );
  return { ...c, bus, pause, pending, held, recorded };
}

describe("control's commands on the message bus", () => {
  test("a command control issues is recorded, and published to its rig's subject as signed", async () => {
    const c = await control();
    assert.deepEqual(c.bus.made.get(COMMAND_STREAM), COMMAND_STREAM_CONFIG, "control made it");
    const id = c.pause();
    // Recorded at once: the store stays the record, and the command's status there the truth.
    assert.equal(c.store.commands.get(id)?.status, "pending");
    await settle();
    const [m, ...more] = c.bus.on(SUBJECT);
    assert.equal(more.length, 0);
    assert.equal(m?.id, id, "its message id is the command's");
    assert.equal(m?.data, c.recorded(id), "the message is the command as control records it");
    assert.ok(verifyCommand(JSON.parse(m?.data ?? "{}"), c.keys.publicKeyPem, "rig-a").ok);
    assert.deepEqual(await c.pending(), [id], "pending until the rig's events give its outcome");
    assert.deepEqual(c.held(), []);

    // A command issued over REST goes the same way.
    const r = await c.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "resume_run",
      payload: { run: "run-1" },
    });
    assert.equal(r.status, 201);
    const { id: resumed } = (await r.json()) as { id: string };
    await settle();
    assert.deepEqual(
      c.bus.on(SUBJECT).map((x) => x.id),
      [id, resumed],
    );
  });

  test("a publish that fails holds the command, pending, and publishes it again once the bus takes it", async () => {
    const c = await control();
    c.bus.failing = true;
    const lost = c.pause("the bus is away");
    await settle();
    assert.equal(c.bus.on(SUBJECT).length, 0);
    assert.equal(c.store.commands.get(lost)?.status, "pending");
    assert.deepEqual(c.held(), [lost]);
    assert.match(heldCommands(c.store)[0]?.why ?? "", /^the bus did not take it: /);
    // The bus is back: the next command goes on it, and the one held goes again.
    c.bus.failing = false;
    const next = c.pause("the bus is back");
    await settle();
    await publishHeld(c.store);
    await settle();
    assert.deepEqual(
      c.bus
        .on(SUBJECT)
        .map((m) => m.id)
        .sort(),
      [lost, next].sort(),
    );
    assert.deepEqual(c.held(), []);
  });

  test("a rig's commands reach the bus in the order issued, and too many waiting are held", async () => {
    const c = await control();
    let answer = () => {};
    c.bus.hold = new Promise((r) => {
      answer = r;
    });
    const ids = Array.from({ length: COMMANDS_WAITING_MAX + 2 }, (_, i) => c.pause(`step ${i}`));
    await settle();
    assert.equal(c.bus.kept.length, 0, "the bus has not answered yet");
    answer();
    await settle();
    const published = c.bus.on(SUBJECT).map((m) => m.id);
    assert.deepEqual(published, ids.slice(0, COMMANDS_WAITING_MAX), "each in its turn, in order");
    // The two past the limit are held, and every one is pending in the store.
    assert.equal((await c.pending()).length, ids.length);
    assert.deepEqual(c.held(), ids.slice(COMMANDS_WAITING_MAX));
    await publishHeld(c.store);
    await settle();
    assert.equal(c.bus.on(SUBJECT).length, ids.length, "then published again, after the others");
  });

  test("a command the owner cancels is taken off the bus, even before its publish", async () => {
    const c = await control();
    const cancel = async (id: string) =>
      (await c.api("POST", `/v1/commands/${id}/cancel`)).json() as Promise<object>;
    const id = c.pause();
    await settle();
    assert.equal(c.bus.on(SUBJECT).length, 1);
    assert.deepEqual(await cancel(id), { cancelled: true });
    await settle();
    assert.equal(c.bus.on(SUBJECT).length, 0, "its supervisor will never take it");
    assert.equal(c.store.commands.get(id)?.status, "failed");
    assert.deepEqual(await c.pending(), []);

    // Cancelled while its publish still waits its turn: taken off once it is on.
    let answer = () => {};
    c.bus.hold = new Promise((r) => {
      answer = r;
    });
    const early = c.pause();
    assert.deepEqual(await cancel(early), { cancelled: true });
    answer();
    await settle();
    assert.equal(c.bus.on(SUBJECT).length, 0);
    // A command no longer pending is not cancelled again.
    assert.deepEqual(await cancel(early), { error: "no such pending command" });
  });

  test("as control starts, its pending commands go on the bus again: once each, and none other", async () => {
    const c = await control();
    const waits = c.pause("waits");
    const taken = c.pause("taken by the rig, its outcome not at control yet");
    const cancelled = c.pause("cancelled");
    const delivered = c.pause("delivered");
    const expired = c.pause("expired");
    await settle();
    assert.ok(c.store.commands.cancel(cancelled, "owner:test"));
    assert.ok(answerCommand(c.store, "rig-a", delivered, "delivered", {}));
    const past = new Date(Date.now() - 60_000).toISOString();
    c.store.db
      .prepare(
        "update command set signed = json_set(signed, '$.envelope.expires_at', ?) where id = ?",
      )
      .run(past, expired);
    // The rig's supervisor took one; the bus holds the others it was given.
    await c.bus.take(SUBJECT, (m) =>
      m.header("Nats-Msg-Id") === taken ? undefined : { againInMs: 5_000 },
    );
    const before = c.bus.on(SUBJECT).map((m) => m.id);
    assert.deepEqual(before, [waits, cancelled, delivered, expired]);

    // Control starts again on the same bus: what the stream knows by its id is not kept twice.
    await sendCommandsOn(c.store, c.bus);
    await settle();
    assert.deepEqual(
      c.bus.on(SUBJECT).map((m) => m.id),
      before,
    );
    assert.equal(c.store.commands.get(expired)?.status, "expired", "marked as it is looked at");

    // On a bus whose stream was lost: the commands still pending, in the order issued.
    const lost = new FakeBus();
    await sendCommandsOn(c.store, lost);
    await settle();
    assert.deepEqual(
      lost.on(SUBJECT).map((m) => m.id),
      [waits, taken],
    );
    const [m] = lost.on(SUBJECT);
    assert.equal(m?.data, c.recorded(waits), "as control records it");
    assert.deepEqual(await c.pending(), [waits, taken]);
  });
});
