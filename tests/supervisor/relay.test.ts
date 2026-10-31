import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import type { Folded } from "../../src/control/ingest.ts";
import { publishCommand } from "../../src/control/issue/bus.ts";
import { issueCommand } from "../../src/control/issue/index.ts";
import { fingerprint } from "../../src/control/store/index.ts";
import { generateSigningKeys, signEnvelope } from "../../src/core/commands.ts";
import { REPORT_STREAM_CONFIG } from "../../src/core/link/report.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { relayOnce } from "../../src/supervisor/relay/index.ts";
import { controlOnly, controlStack } from "../helpers/control-stack.ts";
import { busOf, foldOnBus, heldEvents, ingestReport } from "../helpers/control-store.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { appendOther } from "../helpers/kinds.ts";

describe("supervisor relay between control and harness, on the message bus", () => {
  test("commands flow control -> bus -> supervisor -> harness and events flow back exactly once", async () => {
    const { env, store, api, relay } = controlStack({ env: makeHarnessEnv("rig-a") });

    const issued = await api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: env.assignPayload(),
    });
    assert.equal(issued.status, 201);
    const { id } = (await issued.json()) as { id: string };
    assert.equal(store.commands.get(id)?.status, "pending");

    // The harness's outcome reaches control in its events, with the report after the command.
    await relay();
    assert.equal(store.commands.get(id)?.status, "delivered");
    assert.equal(env.service.ledger.runs.get("smoke-1")?.status, "running");

    await relay();
    const events = await heldEvents(store, "rig-a");
    assert.equal(events.length, env.service.ledger.latestEventId());
    assert.ok(events.some((e) => e.kind === "run_created"));
    assert.equal(
      await ingestReport(store, {
        rig: "rig-a",
        ledger_id: env.service.ledger.ledgerId(),
        cursor: 0,
        next: 1,
        events: [events[0] as never],
        summary: {},
      }),
      0,
    );

    // A command another key signed: the harness refuses it, and its refusal is the outcome.
    const foreign = generateSigningKeys();
    const forged = signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind: "pause_run",
        issued_by: "someone",
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        payload: { run: "smoke-1", reason: "forged" },
      },
      foreign.privateKeyPem,
    );
    store.commands.enqueue(forged);
    publishCommand(store, forged);
    await relay();
    const statuses = store.db
      .prepare("select kind, status from command order by issued_at")
      .all() as { kind: string; status: string }[];
    assert.deepEqual(
      statuses.map((s) => s.status),
      ["delivered", "rejected"],
    );
    assert.match(JSON.stringify(store.commands.get(forged.envelope.id)?.outcome), /harness/);
    assert.equal(env.service.ledger.runs.get("smoke-1")?.status, "running");
  });

  test("a command whose content could not be fetched fails with the reason, and is never applied", async () => {
    const s = controlStack({ env: makeHarnessEnv("rig-a") });
    const { env, store } = s;
    let harnessCalls = 0;
    const fetchImpl = s.cfg.fetchImpl as typeof fetch;
    s.cfg.fetchImpl = async (input, init) => {
      const url = new URL(String(input));
      if (url.host === "harness" && url.pathname === "/v1/commands") harnessCalls++;
      return fetchImpl(input, init);
    };
    const issued = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: env.assignPayload(),
    });
    const { id } = (await issued.json()) as { id: string };
    let asked = 0;
    s.cfg.stage = async () =>
      ++asked === 1 ? ("wait" as const) : { failed: "staging: the repository has no commit" };
    await s.relay();
    assert.equal(
      store.commands.get(id)?.status,
      "pending",
      "it waits while its content is fetched",
    );
    await s.relay();
    const cmd = store.commands.get(id) as { status: string; outcome: unknown };
    assert.equal(cmd.status, "failed");
    assert.match(JSON.stringify(cmd.outcome), /staging: the repository has no commit/);
    assert.match(JSON.stringify(cmd.outcome), /harness/, "from the harness's own record");
    assert.equal(harnessCalls, 0);
    assert.equal(env.service.ledger.runs.get("smoke-1"), undefined);
  });

  test("a command that waits for its sources stays on the bus until they are staged, then is delivered once", async () => {
    const s = controlStack({ env: makeHarnessEnv("rig-a") });
    const { env, store } = s;
    const issued = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: env.assignPayload(),
    });
    const { id } = (await issued.json()) as { id: string };
    let ready = false;
    s.cfg.stage = async () => (ready ? ("ready" as const) : ("wait" as const));
    await s.relay(3);
    assert.equal(store.commands.get(id)?.status, "pending", "it waits for its sources");
    assert.equal(s.bus.on("thermite.rig.rig-a.cmd").length, 1, "still on the bus");
    assert.ok(s.cfg.staging?.has(id));
    // Its sources arrive: the command it holds is delivered, and leaves what it holds.
    ready = true;
    await s.relay();
    assert.equal(store.commands.get(id)?.status, "delivered");
    assert.equal(env.service.ledger.runs.get("smoke-1")?.status, "running");
    assert.equal(s.cfg.held?.size, 0);
    assert.equal(s.bus.on("thermite.rig.rig-a.cmd").length, 0, "acked off the bus");
    await s.relay();
    assert.equal(env.service.ledger.commands.get(id)?.accepted, true, "applied once");
  });

  test("an assignment whose sources take longer than its life stays alive while they stage (goal 171)", async () => {
    const s = controlStack({ env: makeHarnessEnv("rig-a") });
    const { env, store } = s;
    await s.relay();
    // A life of under two seconds stands in for an hour, and a slow model download for longer.
    const { id } = issueCommand(store, env.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: env.assignPayload(),
      ttlMinutes: 0.03,
      issuedBy: "owner:test",
    });
    let ready = false;
    s.cfg.stage = async () => (ready ? ("ready" as const) : ("wait" as const));
    await s.relay(2);
    await new Promise((r) => setTimeout(r, 2000));
    await s.relay();
    assert.equal(store.commands.get(id)?.status, "pending", "alive while its sources stage");
    assert.ok(
      store.auditLog.list(20).some((a) => a.action === "command_renewed"),
      "the renewal is in the audit log",
    );
    assert.ok(
      Date.parse(String(s.cfg.held?.get(id)?.envelope.expires_at)) > Date.now() + 30 * 60_000,
      "the supervisor holds the renewed form",
    );
    ready = true;
    await s.relay();
    assert.equal(store.commands.get(id)?.status, "delivered");
    assert.equal(env.service.ledger.runs.get("smoke-1")?.status, "running");
  });

  test("a reset harness ledger restarts the cursor, and control keeps both ledgers' events", async () => {
    const controlTokens = { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } };
    const { store, control } = controlOnly({ tokens: controlTokens });
    const bus = busOf(store).bus;
    await bus.makeStream(REPORT_STREAM_CONFIG);
    const harnessTokens = { supervisor: "sup-token-abcdef" };
    let harness = createHarnessApi(makeHarnessEnv("rig-a").service, harnessTokens);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      return harness.request(`${url.pathname}${url.search}`, init as RequestInit);
    };
    const cfg = {
      rig: "rig-a",
      harnessUrl: "http://harness",
      harnessToken: harnessTokens.supervisor,
      fetchImpl,
      bus,
    };
    /** The pages published since, as control folds them from the bus. */
    const fold = async () => {
      const out: Folded[] = [];
      await bus.take("thermite.rig.rig-a.report", async (m) => {
        out.push(await foldOnBus(store, "rig-a", JSON.parse(new TextDecoder().decode(m.data))));
        return undefined;
      });
      return out;
    };
    const accept = async () => {
      const pending = fingerprint(String(store.reportedRigs.key("rig-a").pending));
      const r = await control.request(`/v1/rigs/rig-a/key/accept?fingerprint=${pending}`, {
        method: "POST",
        headers: { authorization: `Bearer ${controlTokens.admin}` },
      });
      assert.equal(r.status, 200);
    };
    const first = makeHarnessEnv("rig-a");
    harness = createHarnessApi(first.service, harnessTokens);
    for (let i = 0; i < 5; i++) appendOther(first.service.ledger, "t", "old", null, { i });
    const state = await relayOnce(cfg, { cursor: 0 });
    assert.equal(state.cursor, 5);
    assert.ok("folded" in ((await fold())[0] ?? {}));

    const wiped = makeHarnessEnv("rig-a"); // a fresh ledger: event ids start at 1 again
    harness = createHarnessApi(wiped.service, harnessTokens);
    for (let i = 0; i < 3; i++) appendOther(wiped.service.ledger, "t", "new", null, { i });
    // A wiped harness also has a new signing key: control holds it until the owner accepts.
    const after = await relayOnce(cfg, state);
    assert.equal(after.cursor, 3);
    assert.equal(after.ledgerId, wiped.service.ledger.ledgerId());
    assert.ok("refused" in ((await fold())[0] ?? {}));
    // The owner accepts the key whose fingerprint they checked; the pages go again, once the
    // bus's duplicate window passed (healCursor sends them again a round at a time).
    await accept();
    bus.forgetIds();
    await relayOnce(cfg, { ...after, cursor: 0 });
    assert.ok("folded" in ((await fold())[0] ?? {}));
    const kinds = (await heldEvents(store, "rig-a")).map((e) => e.kind);
    assert.deepEqual(kinds, ["old", "old", "old", "old", "old", "new", "new", "new"]);
  });

  test("a supervisor cannot forge or alter a harness report", async () => {
    const env = makeHarnessEnv("rig-a");
    const tokens = { admin: "admin-token-abcdef", rigs: { "rig-a": "rig-token-abcdef" } };
    const { store } = controlOnly({ keys: env.keys, tokens });
    appendOther(env.service.ledger, "t", "real", null, {});
    const snap = env.service.snapshot(0, 100) as Record<string, unknown>;
    assert.ok("folded" in (await foldOnBus(store, "rig-a", snap)));
    const events = snap.events as { id: number; kind: string }[];
    const forged = {
      ...snap,
      next: Number(snap.next) + 1,
      events: [
        ...events,
        {
          id: Number(snap.next) + 1,
          at: new Date().toISOString(),
          actor: "judge",
          kind: "champion_promoted",
          subject: "smoke-1",
          body: { seq: 99 },
        },
      ],
    };
    assert.ok("refused" in (await foldOnBus(store, "rig-a", forged)));
    const { signature: _s, ...unsigned } = snap;
    // Unsigned, the page control has already: it takes nothing of it.
    assert.ok(!("folded" in (await foldOnBus(store, "rig-a", unsigned))));
    const kinds = (await heldEvents(store, "rig-a")).map((e) => e.kind);
    assert.ok(!kinds.includes("champion_promoted"));
  });

  test("a report on one rig's subject for another rig is refused; a rig token reads no admin view", async () => {
    const tokens = {
      admin: "admin-token-abcdef",
      rigs: { "rig-a": "rig-token-aaaaaa", "rig-b": "rig-token-bbbbbb" },
    };
    const { store, control } = controlOnly({ tokens });
    const report = {
      rig: "rig-b",
      ledger_id: "l",
      cursor: 0,
      next: 0,
      events: [],
      summary: {},
      generated_at: new Date().toISOString(),
      latest_event: 0,
    };
    assert.ok("refused" in (await foldOnBus(store, "rig-a", report)));
    const asA = { authorization: "Bearer rig-token-aaaaaa", "content-type": "application/json" };
    assert.equal((await control.request("/v1/rigs", { headers: asA })).status, 401);
  });
});
