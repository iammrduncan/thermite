import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { heldCommands, publishHeld } from "../../../src/control/issue/bus.ts";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { canonicalJson } from "../../../src/core/canonical.ts";
import { signEnvelope } from "../../../src/core/commands.ts";
import { commandSubject } from "../../../src/core/link/commands.ts";
import { COMMAND_AGAIN_MS, takeCommand } from "../../../src/supervisor/relay/commands.ts";
import { oneAtATime } from "../../../src/supervisor/relay/index.ts";
import { controlStack } from "../../helpers/control-stack.ts";
import { settle } from "../../helpers/fake-bus.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

const SUBJECT = commandSubject("rig-a");

/**
 * Control, rig-a's harness and its supervisor's relay, with control's commands on the stack's
 * bus. `take()` hands the bus's messages to the supervisor as its consumer does; `report()` sends
 * the harness's events, which carry each command's outcome to control; `failHarness` makes the
 * harness's commands route fail that many times, as when it restarts.
 */
async function rig() {
  const s = controlStack({ env: makeHarnessEnv("rig-a") });
  await s.relay();
  const delivered: string[] = [];
  let failHarness = 0;
  const fetchImpl = s.cfg.fetchImpl as typeof fetch;
  s.cfg.fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "harness" && url.pathname === "/v1/commands") {
      delivered.push((JSON.parse(String(init?.body)) as { envelope: { id: string } }).envelope.id);
      if (failHarness > 0) {
        failHarness--;
        return Response.json({ error: "the harness is restarting" }, { status: 503 });
      }
    }
    return fetchImpl(input, init);
  };
  s.cfg.turn = oneAtATime();
  const issue = async (kind: string, payload: unknown) => {
    const r = await s.api("POST", "/v1/commands", { rig: "rig-a", kind, payload });
    assert.equal(r.status, 201, await r.clone().text());
    await settle();
    return ((await r.json()) as { id: string }).id;
  };
  return {
    ...s,
    delivered,
    issue,
    take: () => s.bus.take(SUBJECT, (m) => takeCommand(s.cfg, m)),
    report: () => s.relay(),
    failHarness: (n: number) => {
      failHarness = n;
    },
    status: (id: string) => s.store.commands.get(id)?.status,
  };
}

describe("the supervisor's commands from the message bus", () => {
  test("a command is delivered as it comes, acked once the harness has its outcome, which reaches control in its events", async () => {
    const r = await rig();
    const id = await r.issue("assign_campaign", r.env.assignPayload());
    // The harness does not answer: the bus keeps the command and hands it again.
    r.failHarness(1);
    assert.deepEqual(await r.take(), { acked: 0, again: 1 });
    assert.equal(r.status(id), "pending");
    assert.equal(r.bus.on(SUBJECT).length, 1);
    // Handed again: the harness applies it, and the bus lets go.
    assert.deepEqual(await r.take(), { acked: 1, again: 0 });
    assert.equal(r.env.service.ledger.runs.get("smoke-1")?.status, "running");
    assert.deepEqual(r.delivered, [id, id]);
    assert.equal(r.bus.on(SUBJECT).length, 0);
    assert.equal(r.cfg.held?.size, 0);
    // Its outcome reaches control with the harness's next report, never from the supervisor.
    assert.equal(r.status(id), "pending");
    await r.report();
    assert.equal(r.status(id), "delivered");

    // The bus hands it once more, after its duplicate window: acked, and not delivered again.
    r.bus.forgetIds();
    const signed = r.store.db.prepare("select signed from command where id = ?").get(id) as {
      signed: string;
    };
    await r.bus.publish(SUBJECT, signed.signed, { id });
    assert.deepEqual(await r.take(), { acked: 1, again: 0 });
    assert.deepEqual(r.delivered, [id, id]);
  });

  test("a command that waits for its sources is handed again, and the ones after it go on", async () => {
    const r = await rig();
    let ready = false;
    r.cfg.stage = async (cmd) =>
      cmd.envelope.kind === "assign_campaign" && !ready ? "wait" : "ready";
    const assign = await r.issue("assign_campaign", r.env.assignPayload());
    const check = await r.issue("pause_run", { run: "smoke-1", reason: "after it" });
    assert.deepEqual(await r.take(), { acked: 1, again: 1 });
    assert.equal(r.status(assign), "pending");
    assert.ok(r.cfg.staging?.has(assign), "its sources stage");
    assert.ok(r.cfg.held?.has(assign));
    // The next one went on: the harness refused it (no such run yet), and its events say so.
    await r.report();
    assert.equal(r.status(check), "failed");
    assert.equal(COMMAND_AGAIN_MS, 5000);
    ready = true;
    assert.deepEqual(await r.take(), { acked: 1, again: 0 });
    await r.report();
    assert.equal(r.status(assign), "delivered");
    assert.equal(r.cfg.staging?.size, 0);
  });

  test("a command the bus did not take is held by control, in words, and published again once it does", async () => {
    const r = await rig();
    const assign = await r.issue("assign_campaign", r.env.assignPayload());
    assert.deepEqual(await r.take(), { acked: 1, again: 0 });
    // The rig's queue is full: the stream refuses its next command.
    const publish = r.bus.publish.bind(r.bus);
    r.bus.publish = async () => {
      throw new Error("maximum messages per subject exceeded");
    };
    const pause = await r.issue("pause_run", { run: "smoke-1", reason: "held" });
    assert.deepEqual(await r.take(), { acked: 0, again: 0 }, "the bus never had it");
    const [held] = heldCommands(r.store, "rig-a");
    assert.equal(held?.id, pause);
    assert.equal(held?.why, "the rig's queue on the bus holds 100 commands it has not taken");
    assert.equal(r.status(pause), "pending");
    // The queue has room again: control publishes it again, and it reaches the rig.
    r.bus.publish = publish;
    await publishHeld(r.store);
    assert.deepEqual(heldCommands(r.store, "rig-a"), []);
    assert.deepEqual(await r.take(), { acked: 1, again: 0 });
    await r.report();
    assert.equal(r.status(pause), "delivered");
    assert.equal(r.env.service.ledger.runs.get("smoke-1")?.status, "paused");
    assert.deepEqual(r.delivered, [assign, pause]);
  });

  test("commands from the bus are staged and delivered one at a time", async () => {
    const r = await rig();
    let staging = 0;
    let most = 0;
    r.cfg.stage = async () => {
      most = Math.max(most, ++staging);
      await new Promise((ok) => setTimeout(ok, 20));
      staging--;
      return "ready";
    };
    const id = await r.issue("assign_campaign", r.env.assignPayload());
    const [m] = r.bus.on(SUBJECT);
    assert.ok(m);
    const message = { subject: m.subject, seq: m.seq, data: new TextEncoder().encode(m.data) };
    const handed = { ...message, header: () => undefined };
    // Handed twice at once, as after a redelivery: it reaches the harness once.
    await Promise.all([takeCommand(r.cfg, handed), takeCommand(r.cfg, handed)]);
    assert.equal(most, 1, "one command staged at a time");
    assert.deepEqual(r.delivered, [id], "the harness had it once");
  });

  test("a cancelled command is never delivered; nor are an expired one and another rig's", async () => {
    const r = await rig();
    const cancelled = await r.issue("pause_run", { run: "smoke-1", reason: "never mind" });
    await r.api("POST", `/v1/commands/${cancelled}/cancel`);
    await settle();
    assert.deepEqual(await r.take(), { acked: 0, again: 0 }, "control took it off the bus");
    assert.equal(r.status(cancelled), "failed");

    const expired = issueCommand(r.store, r.env.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "pause_run",
      payload: { run: "smoke-1", reason: "too late" },
      ttlMinutes: 0.0001,
      issuedBy: "owner:test",
    }).id;
    await settle();
    await new Promise((ok) => setTimeout(ok, 20));
    const now = new Date().toISOString();
    const forRigB = signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-b",
        kind: "pause_run",
        issued_by: "owner:test",
        issued_at: now,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        payload: { run: "smoke-1", reason: "for rig-b" },
      },
      r.env.keys.privateKeyPem,
    );
    await r.bus.publish(SUBJECT, canonicalJson(forRigB), { id: forRigB.envelope.id });
    await r.bus.publish(SUBJECT, "{", { id: "not-a-command" });
    // The expired one: control holds no newer form of it, and marks it expired as it is asked.
    assert.deepEqual(await r.take(), { acked: 3, again: 0 });
    assert.deepEqual(r.delivered, [], "the harness had none of them");
    assert.equal(r.status(expired), "expired");
  });
});
