import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildInfo } from "../../src/common/build-info.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import type { RigVersions } from "../../src/control/versions.ts";
import { reportingState, rigView } from "../../src/control/views/index.ts";
import { generateSigningKeys, reportBody, signJson } from "../../src/core/commands.ts";
import {
  BUILD_HEADERS,
  type BuildInfo,
  OLDEST_PROTOCOL,
  PROTOCOL,
} from "../../src/core/version.ts";
import { AskRefused, ask } from "../../src/supervisor/ask.ts";
import {
  ADMIN,
  controlOnly,
  controlStack,
  mcpClient,
  RIG_TOKEN,
} from "../helpers/control-stack.ts";
import { foldOnBus, heldEvents } from "../helpers/control-store.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { appendOther } from "../helpers/kinds.ts";

const tokens = { admin: ADMIN, rigs: { "rig-a": RIG_TOKEN } };
const owner = { authorization: `Bearer ${tokens.admin}`, "content-type": "application/json" };

interface Listed {
  control: BuildInfo;
  rigs: { id: string; state: string; version: RigVersions }[];
}

/**
 * Control and one rig (harness and supervisor) wired in-process on the fake bus. `supervisor`
 * changes the build headers the supervisor's reports carry: null sends none, as a supervisor
 * from before version checks. `seen` keeps each report's headers.
 */
function setup(build?: BuildInfo) {
  const s = controlStack({ env: makeHarnessEnv("rig-a"), options: build ? { build } : {} });
  const { env, store, control, bus } = s;
  const rig: { supervisor: Record<string, string> | null | undefined; seen: Headers[] } = {
    supervisor: undefined,
    seen: [],
  };
  s.cfg.bus = {
    publish: (subject, data, o) => {
      const headers = { ...(o.headers ?? {}) };
      if (rig.supervisor !== undefined)
        for (const h of Object.values(BUILD_HEADERS)) {
          const v = rig.supervisor?.[h];
          if (v === undefined) delete headers[h];
          else headers[h] = v;
        }
      rig.seen.push(new Headers(headers));
      return bus.publish(subject, data, { ...o, headers });
    },
    request: (subject, data, timeoutMs) => bus.request(subject, data, timeoutMs),
  };
  const listed = async () =>
    (await (await control.request("/v1/rigs", { headers: owner })).json()) as Listed;
  const issue = () =>
    control.request("/v1/commands", {
      method: "POST",
      headers: owner,
      body: JSON.stringify({ rig: "rig-a", kind: "assign_campaign", payload: env.assignPayload() }),
    });
  const audits = (action: string) =>
    store.auditLog.list(1000).filter((a) => a.action === action) as { body: unknown }[];
  /** The supervisor's daily report on the bus: control's answer, or its refusal. */
  const daily = async () => {
    await s.relay(0);
    return await ask({ rig: "rig-a", bus }, "daily", { kind: "daily", body: "# The day" });
  };
  return { env, store, api: control, rig, relay: s.relay, listed, issue, audits, daily, bus };
}

const hdrs = (b: Partial<BuildInfo>) => ({
  ...(b.version ? { [BUILD_HEADERS.version]: b.version } : {}),
  ...(b.commit ? { [BUILD_HEADERS.commit]: b.commit } : {}),
  ...(b.protocol !== undefined ? { [BUILD_HEADERS.protocol]: String(b.protocol) } : {}),
  ...(b.oldest_protocol !== undefined
    ? { [BUILD_HEADERS.oldest_protocol]: String(b.oldest_protocol) }
    : {}),
});

describe("versions between control and its rigs", () => {
  test("a control update never cuts off a rig on the build before version checks: it reports, takes commands, and shows as unknown", async () => {
    const s = setup();
    // The build before: its supervisor sends no build headers, its harness no build.
    s.rig.supervisor = null;
    s.env.service.build = undefined;
    const issued = await s.issue();
    assert.equal(issued.status, 201);
    const { id } = (await issued.json()) as { id: string };
    await s.relay(2);
    assert.equal(s.store.commands.get(id)?.status, "delivered");
    assert.ok((await heldEvents(s.store, "rig-a")).length > 0);
    const r = (await s.listed()).rigs.find((x) => x.id === "rig-a");
    assert.equal(r?.state, "reporting");
    assert.equal(r?.version.state, "unknown");
    assert.equal(r?.version.refused, null);
    assert.equal(r?.version.harness, null);
    assert.equal(r?.version.supervisor, null);
    assert.match(
      String(r?.version.notice),
      /harness and supervisor send no version\. Their images are older than version checks\. Control still works with it\./,
    );
    assert.equal(s.audits("rig_refused").length, 0);
  });

  test("a control one protocol newer still works with rigs on the protocol before it, and marks them behind", async () => {
    const own = buildInfo();
    // The next control, as the rule for PROTOCOL and OLDEST_PROTOCOL makes it.
    const next = {
      version: "99.0.0",
      commit: "abcdef123456",
      protocol: PROTOCOL + 1,
      oldest_protocol: Math.max(OLDEST_PROTOCOL, PROTOCOL),
    };
    const s = setup(next);
    // Every report the supervisor publishes carries its build.
    const issued = await s.issue();
    const { id } = (await issued.json()) as { id: string };
    await s.relay(2);
    assert.equal(s.store.commands.get(id)?.status, "delivered");
    assert.ok(s.rig.seen.length >= 3);
    for (const h of s.rig.seen) {
      assert.equal(h.get(BUILD_HEADERS.version), own.version);
      assert.equal(h.get(BUILD_HEADERS.protocol), String(own.protocol));
    }
    // The harness's build rides in its signed report.
    const snap = s.env.service.snapshot(0, 1) as { summary: { build?: unknown } };
    assert.deepEqual(snap.summary.build, own);
    const list = await s.listed();
    assert.deepEqual(list.control, next);
    const r = list.rigs.find((x) => x.id === "rig-a");
    assert.equal(r?.version.state, "behind");
    assert.equal(r?.version.refused, null);
    assert.equal(r?.version.harness?.version, own.version);
    assert.equal(r?.version.supervisor?.protocol, own.protocol);
    assert.equal(
      r?.version.notice,
      `This rig runs an older Thermite than control: harness ${own.version}, supervisor ${own.version}. Control runs 99.0.0. Control still works with it. Update the rig's images.`,
    );
    // The rig's own view says the same.
    const view = (await (
      await s.api.request("/v1/rigs/rig-a/view", { headers: owner })
    ).json()) as {
      state: string;
      version: RigVersions;
    };
    assert.equal(view.state, "reporting");
    assert.equal(view.version.state, "behind");
  });

  test("an incompatible rig is refused, with the reason, on its reports and commands, until it runs a build control works with", async () => {
    const control = { version: "0.9.0", commit: null, protocol: 3, oldest_protocol: 2 };
    const s = setup(control);
    appendOther(s.env.service.ledger, "t", "one", null, {});
    s.rig.supervisor = hdrs({ version: "0.1.0", protocol: 1, oldest_protocol: 1 });
    const why =
      "Control cannot work with this rig: its supervisor speaks protocol 1, and control works with protocols 2 to 3. Update the rig's images.";
    // Its report is refused, and so are its asks of control, with the reason.
    await s.relay();
    await assert.rejects(s.daily(), (err: unknown) => {
      assert.ok(err instanceof AskRefused);
      assert.ok(err.message.includes(why), err.message);
      return true;
    });
    assert.equal((await heldEvents(s.store, "rig-a")).length, 0);
    // Listed, though it never reported: offline, refused, and why.
    const r = (await s.listed()).rigs.find((x) => x.id === "rig-a");
    assert.equal(r?.state, "offline");
    assert.equal(r?.version.state, "refused");
    assert.equal(r?.version.refused?.reason, why);
    assert.equal(r?.version.notice, why);
    assert.equal(r?.version.supervisor?.protocol, 1);
    // In the audit log once, not once for each call it makes.
    const refused = s.audits("rig_refused");
    assert.equal(refused.length, 1);
    const body = refused[0]?.body as { reason: string; control: BuildInfo } | undefined;
    assert.equal(body?.reason, why);
    assert.equal(body?.control.protocol, 3);
    // A command for it is refused when issued, and why.
    const issued = await s.issue();
    assert.equal(issued.status, 400);
    assert.deepEqual(await issued.json(), {
      error: `Control sends no commands to rig-a. ${why}`,
    });
    // Its images updated: it reports again, and the refusal ends (in the audit log too).
    s.rig.supervisor = hdrs({ version: "0.9.0", protocol: 3, oldest_protocol: 2 });
    s.env.service.build = { version: "0.9.0", commit: null, protocol: 3, oldest_protocol: 2 };
    // The page control refused goes again from its place, once the bus's duplicate window passed.
    s.bus.forgetIds();
    await s.relay(3);
    assert.ok((await heldEvents(s.store, "rig-a")).length > 0);
    const after = (await s.listed()).rigs.find((x) => x.id === "rig-a");
    assert.equal(after?.version.state, "current");
    assert.equal(after?.version.refused, null);
    assert.equal(after?.version.notice, null);
    assert.equal(s.audits("rig_refusal_ended").length, 1);
    assert.equal((await s.issue()).status, 201);
  });

  test("a harness control cannot work with is refused, though its supervisor is fine", async () => {
    const s = setup();
    appendOther(s.env.service.ledger, "t", "one", null, {});
    const own = buildInfo();
    s.env.service.build = { version: "9.0.0", commit: null, protocol: 70, oldest_protocol: 70 };
    const why = `Control cannot work with this rig: its harness works with protocol 70 or later, and control speaks protocol ${own.protocol}. Update control.`;
    await s.relay();
    assert.equal(s.store.refusals.get("rig-a")?.reason, why);
    assert.equal(s.store.builds.ofRig("rig-a", "harness")?.protocol, 70);
    // Its asks wait on the harness too: the supervisor's own build is not enough.
    await assert.rejects(s.daily(), AskRefused);
    s.env.service.build = own;
    s.bus.forgetIds();
    await s.relay(3);
    assert.equal(s.store.refusals.get("rig-a"), undefined);
    assert.ok((await heldEvents(s.store, "rig-a")).length > 0);
  });

  test("a protocol control does not know is never a reason to refuse", async () => {
    const s = setup();
    // A newer supervisor that does not say how old a control it works with, and a harness that
    // sends a malformed protocol.
    s.rig.supervisor = hdrs({ version: "5.0.0", protocol: 9 });
    s.env.service.build = {
      version: "5.0.0",
      commit: null,
      protocol: "nine" as unknown as number,
      oldest_protocol: 0,
    };
    await s.relay();
    const r = (await s.listed()).rigs.find((x) => x.id === "rig-a");
    assert.equal(r?.version.refused, null);
    assert.equal(r?.version.state, "ahead");
    assert.equal(r?.version.harness?.protocol, null);
    assert.match(String(r?.version.notice), /a newer Thermite than control.*Update control\./);
  });

  test("a new control checks refused rigs again: one it can work with is no longer refused", () => {
    const store = new ControlStore(":memory:");
    const env = makeHarnessEnv("rig-a");
    store.builds.setRig("rig-a", "supervisor", {
      version: "0.1.0",
      commit: null,
      protocol: 1,
      oldest_protocol: 1,
    });
    store.refusals.set("rig-a", "an older control's reason");
    controlOnly({
      store,
      keys: env.keys,
      tokens,
      options: { build: { version: "0.2.0", commit: null, protocol: 2, oldest_protocol: 1 } },
    });
    assert.equal(store.refusals.get("rig-a"), undefined);
    assert.equal(
      store.auditLog.list(100).filter((a) => a.action === "rig_refusal_ended").length,
      1,
    );
  });

  test("a rig that stops reporting is stale, then offline; one that never reported is offline", async () => {
    const at = Date.parse("2026-10-20T12:00:00Z");
    const opts = { staleAfterMs: 180_000, offlineAfterMs: 900_000 };
    const seen = (ago: number) => new Date(at - ago).toISOString();
    assert.equal(reportingState(seen(60_000), { ...opts, now: at }), "reporting");
    assert.equal(reportingState(seen(181_000), { ...opts, now: at }), "stale");
    assert.equal(reportingState(seen(900_000), { ...opts, now: at }), "stale");
    assert.equal(reportingState(seen(901_000), { ...opts, now: at }), "offline");
    assert.equal(reportingState(new Date(0).toISOString(), { ...opts, now: at }), "offline");
    // Never offline before it is stale, and the default offline time is 15 minutes.
    assert.equal(
      reportingState(seen(200_000), { staleAfterMs: 300_000, offlineAfterMs: 60_000, now: at }),
      "reporting",
    );
    assert.equal(reportingState(seen(899_000), { staleAfterMs: 180_000, now: at }), "stale");
    assert.equal(reportingState(seen(901_000), { staleAfterMs: 180_000, now: at }), "offline");
    // The rig view says it, with stale kept for both.
    const s = setup();
    await s.relay();
    const last = Date.parse(String(s.store.reportedRigs.list()[0]?.last_seen));
    const view = (now: number) => rigView(s.store, "rig-a", { ...opts, now });
    assert.deepEqual([view(last)?.state, view(last)?.stale], ["reporting", false]);
    assert.deepEqual([view(last + 200_000)?.state, view(last + 200_000)?.stale], ["stale", true]);
    assert.deepEqual(
      [view(last + 1_000_000)?.state, view(last + 1_000_000)?.stale],
      ["offline", true],
    );
  });

  test("MCP's list_rigs shows each rig's state and versions", async () => {
    const s = setup({
      version: "99.0.0",
      commit: null,
      protocol: PROTOCOL,
      oldest_protocol: OLDEST_PROTOCOL,
    });
    await s.relay();
    const client = await mcpClient(s.api, tokens.admin);
    assert.equal(client.getServerVersion()?.version, "99.0.0");
    const r = await client.callTool({ name: "list_rigs", arguments: {} });
    const rigs = JSON.parse((r.content as { text: string }[])[0]?.text ?? "") as {
      rig: string;
      state: string;
      stale: boolean;
      version: RigVersions;
    }[];
    assert.equal(rigs[0]?.rig, "rig-a");
    assert.equal(rigs[0]?.state, "reporting");
    assert.equal(rigs[0]?.version.state, "behind");
    assert.equal(rigs[0]?.version.control.version, "99.0.0");
    assert.match(String(rigs[0]?.version.notice), /Update the rig's images\./);
    await client.close();
  });
});

describe("a newer rig's fields that control does not know", () => {
  /** A supervisor from a newer build, on a protocol this control works with. */
  const newer = hdrs({ version: "99.0.0", protocol: PROTOCOL, oldest_protocol: OLDEST_PROTOCOL });
  const asRig = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tokens.rigs["rig-a"]}`,
    "content-type": "application/json",
    ...newer,
    ...extra,
  });

  test("a newer supervisor's figures and daily report are taken; the fields control does not know are dropped", async () => {
    const s = setup();
    s.rig.supervisor = newer;
    await s.relay();
    const at = new Date().toISOString();
    const figures = (relay: unknown) => ({
      at,
      relay,
      // Fields a later build might add, at every level.
      uptime_s: 4000,
      export: {
        remote: false,
        to: "control",
        exports: 1,
        pushed: [],
        last_push_at: null,
        last_error: null,
        bandwidth: { bytes_per_s: 10 },
      },
      models: [
        {
          name: "weights",
          path: "models/weights.bin",
          sha256: "a".repeat(64),
          from: "https://models.example/weights.bin",
          state: "downloading",
          bytes: 10,
          total: 100,
          resumed_from: 0,
          started_at: at,
          updated_at: at,
          mirror: "second",
        },
      ],
      advisors: {
        teacher_runs: 2,
        directive_sets: 1,
        directives: 3,
        audits: 0,
        reviews: 0,
        errors: 0,
        tokens_in: 100,
        tokens_out: 20,
        usd: 0,
        cache_hits: 7,
        roles: { teachers: 2, merged_by: true, auditor: false, review_panel: 0, scout: 1 },
      },
    });
    // Its regular call, on the bus.
    const onBus = { rig: "rig-a", bus: s.bus };
    await ask(onBus, "figures", figures({ cursor: 3, lag_ms: 20 }) as never);
    // Stored as this control knows them: nothing it does not know is kept or shown.
    const sup = s.store.reportedRigs.supervisor("rig-a") as Record<string, unknown>;
    assert.deepEqual(sup.relay, { cursor: 3 });
    assert.equal("uptime_s" in sup, false);
    assert.equal("bandwidth" in (sup.export as object), false);
    assert.equal("mirror" in ((sup.models as object[])[0] as object), false);
    const advisors = sup.advisors as { cache_hits?: number; roles: Record<string, unknown> };
    assert.equal(advisors.cache_hits, undefined);
    assert.deepEqual(advisors.roles, {
      teachers: 2,
      merged_by: true,
      auditor: false,
      review_panel: 0,
    });
    // The rest is used: the download is a step in the rig's history.
    assert.ok(s.store.rigHistory.list("rig-a").some((e) => e.step === "model_started"));
    // A field control knows keeps its check.
    await assert.rejects(
      ask(onBus, "figures", figures({ cursor: "three" }) as never),
      /control refused the rig's figures: the figures is not one control takes: relay\.cursor/,
    );
    // The daily report, with a field from a later build.
    const daily = await ask(onBus, "daily", {
      kind: "daily",
      body: "# The day",
      format: "markdown",
    } as never);
    assert.equal(s.store.rigReports.list(5, "rig-a")[0]?.id, daily.id);
    // The rig is ahead of control, not refused.
    const listed = (await s.listed()).rigs.find((x) => x.id === "rig-a");
    assert.equal(listed?.version.state, "ahead");
    assert.equal(listed?.version.refused, null);
  });

  test("a newer supervisor's export is taken with a field control does not know", async () => {
    const { control: api } = controlOnly({
      tokens,
      options: { exportsDir: join(mkdtempSync(join(tmpdir(), "thermite-versions-")), "exports") },
    });
    const bytes = Buffer.from("one\n");
    const r = await api.request("/v1/rigs/rig-a/exports/20261020T120000Z-0123abcd", {
      method: "POST",
      headers: asRig(),
      body: JSON.stringify({
        manifest: {
          rig: "rig-a",
          from_event: 0,
          through_event: 1,
          files: { "events.jsonl": createHash("sha256").update(bytes).digest("hex") },
        },
        files: { "events.jsonl": bytes.length },
        compression: "none",
      }),
    });
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(((await r.json()) as { received: unknown }).received, { "events.jsonl": 0 });
  });

  test("a signed report stays exact: a field a newer harness signed fails the signature; one the supervisor adds is dropped", async () => {
    const s = setup();
    appendOther(s.env.service.ledger, "t", "one", null, {});
    const snap = s.env.service.snapshot(0, 100) as Omit<
      Parameters<typeof reportBody>[0],
      "events"
    > & {
      events: Record<string, unknown>[];
    };
    const ingest = (body: unknown) => foldOnBus(s.store, "rig-a", body);
    const withField = snap.events.map((e, i) => (i ? e : { ...e, trial: "t-1" }));
    // A newer harness that signs an event field this control does not know: refused, since
    // control checks the signature over the fields it reads.
    const keys = generateSigningKeys();
    const signed = { ...snap, events: withField };
    const newer = await ingest({
      ...signed,
      rig_pubkey: keys.publicKeyPem,
      signature: signJson(reportBody(signed), keys.privateKeyPem),
    });
    assert.deepEqual(newer, { refused: "bad report signature" });
    // The harness's own report, with fields a supervisor added outside and inside it: taken,
    // and what control does not know is not kept.
    const taken = await ingest({ ...snap, events: withField, relayed_by: "a later supervisor" });
    assert.ok("folded" in taken, JSON.stringify(taken));
    const stored = await heldEvents(s.store, "rig-a");
    assert.ok(stored.length > 0);
    assert.doesNotMatch(JSON.stringify(stored), /t-1|relayed_by/);
  });
});
