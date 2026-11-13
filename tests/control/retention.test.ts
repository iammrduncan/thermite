import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildInfo } from "../../src/common/build-info.ts";
import { answerRigAsk } from "../../src/control/bus/asks.ts";
import { Screens } from "../../src/control/live/index.ts";
import {
  createPolicy,
  previewOf,
  retentionTick,
  runPolicy,
  setPolicyOn,
} from "../../src/control/retention/index.ts";
import { sqliteBehind } from "../../src/control/store/behind.ts";
import { type ControlStore, openControlStore } from "../../src/control/store/index.ts";
import { copiesPolicyOn } from "../../src/control/store/retention.ts";
import { packItems, type RetentionItem } from "../../src/core/retention/index.ts";
import { controlOnly, mcpClient } from "../helpers/control-stack.ts";
import { applied, controlStore } from "../helpers/control-store.ts";
import { report } from "../helpers/view-events.ts";

/**
 * The owner's retention policies on control (control/retention/): none by default, each made,
 * changed, turned on and off and deleted by the owner alone, each change in the audit log; what a
 * policy would remove before it does; control's own kinds removed at the policy's time or by Run
 * now; a rig's kind sent to each rig it covers, and what the rig removed in the history.
 */

const OWNER = "owner-token-abcdef";
const OPERATOR = "operator-token-abcdef";
const RIG_A = "rig-a-token-abcdef";
const DAY = 86_400_000;

const design = (o: Record<string, unknown> = {}) => ({
  name: "Old audit",
  kind: "audit",
  rule: "older",
  older_n: 30,
  ...o,
});

// biome-ignore lint/suspicious/noExplicitAny: the API's answers, read loosely in assertions
type Answer = any;
/** A REST answer's JSON. */
const read = async (r: Response): Promise<Answer> => r.json();

const audits = async (store: ControlStore, action: string) =>
  (await store.auditLog.list(500)).filter((a) => a.action === action);

/** An audit entry `days` old. */
function oldEntry(store: ControlStore, action: string, days: number) {
  sqliteBehind(store)
    .db.prepare("insert into audit (at, actor, action, body) values (?, 'owner:api', ?, '{}')")
    .run(new Date(Date.now() - days * DAY).toISOString(), action);
}

/** What rig-a says it keeps of its builds. */
async function rigSays(store: ControlStore, rig: string, items: RetentionItem[]) {
  const out = await answerRigAsk(
    { store, control: buildInfo(), privateKeyPem: "", screens: new Screens() },
    rig,
    "space",
    { read_at: new Date().toISOString(), kinds: { builds: packItems(items) } },
  );
  assert.deepEqual(out, { ok: true });
}

const build = (id: string, days: number, o: Partial<RetentionItem> = {}): RetentionItem => ({
  id,
  rig: null,
  run: "r-1",
  at: new Date(Date.now() - days * DAY).toISOString(),
  bytes: 1000,
  count: 1,
  ...o,
});

describe("retention policies on control", () => {
  test("none by default; the owner makes, changes, turns on and off and deletes one over REST, each in the audit log", async () => {
    const { api, store } = await controlOnly({
      tokens: { admin: OWNER, operator: OPERATOR, rigs: { "rig-a": RIG_A } },
    });
    const list = await read(await api("GET", "/v1/retention"));
    assert.deepEqual(list.policies, [], "nothing is removed by default");
    assert.deepEqual(
      list.kinds.map((k: { kind: string }) => k.kind),
      ["events", "builds", "trial_logs", "advisor_records", "kb_versions", "store_copies", "audit"],
    );

    // Only the owner's token: an operator's, a rig's and none are refused.
    for (const token of [OPERATOR, RIG_A, ""]) {
      assert.equal((await api("GET", "/v1/retention", undefined, token)).status, 401);
      assert.equal((await api("POST", "/v1/retention/policies", design(), token)).status, 401);
    }

    const made = await api("POST", "/v1/retention/policies", design());
    assert.equal(made.status, 200);
    const { policy, said } = await read(made);
    assert.equal(said, "Saved “Old audit”, off.");
    assert.equal(policy.on, false, "a new policy is off");
    assert.equal(policy.rule_words, "older than 30 days");
    assert.equal(policy.where_words, "control");
    assert.equal(policy.when_words, "every day at 03:00 UTC");

    // A design that is not one is refused in words; a policy control has not is 404.
    const bad = await api("POST", "/v1/retention/policies", design({ older_n: 0 }));
    assert.equal(bad.status, 400);
    assert.match((await read(bad)).error, /^not a retention policy: older_n/);
    const noRig = await api(
      "POST",
      "/v1/retention/policies",
      design({ kind: "builds", where: "rigs", rigs: ["rig-z"] }),
    );
    assert.match((await read(noRig)).error, /control knows no rig rig-z/);
    assert.equal((await api("GET", "/v1/retention/policies/99")).status, 404);

    const changed = await api(
      "PUT",
      `/v1/retention/policies/${policy.id}`,
      design({ name: "Old entries", older_n: 90 }),
    );
    assert.equal((await read(changed)).policy.rule_words, "older than 90 days");
    const on = await read(
      await api("POST", `/v1/retention/policies/${policy.id}/on`, { on: true }),
    );
    assert.equal(on.policy.on, true);
    assert.equal(on.said, "“Old entries” is on: it runs every day at 03:00 UTC.");
    assert.ok((await store.retention.get(policy.id))?.on_since, "on from now");
    const gone = await read(await api("DELETE", `/v1/retention/policies/${policy.id}`));
    assert.equal(gone.said, "Deleted “Old entries”. What it removed stays in the history.");
    assert.equal(await store.retention.get(policy.id), undefined);
    for (const action of ["created", "changed", "on", "deleted"])
      assert.equal((await audits(store, `retention_policy_${action}`)).length, 1, action);
    assert.match(
      JSON.stringify((await audits(store, "retention_policy_changed"))[0]?.body),
      /"was":\{.*"policy":"Audit log, control: removes older than 30 days, every day at 03:00 UTC"/,
    );
  });

  test("the audit log: a preview first, then Run now removes what it covers; a removal's own entry stays", async () => {
    const { api, store } = await controlOnly({ tokens: { admin: OWNER } });
    oldEntry(store, "old_thing", 40);
    oldEntry(store, "old_thing", 50);
    oldEntry(store, "retention_removed", 60);
    oldEntry(store, "new_thing", 1);
    const preview = await read(await api("POST", "/v1/retention/preview", design()));
    assert.equal(preview.count, 2, "never a removal's own entry");
    assert.match(
      preview.words,
      /^It would remove 2 entries, \d+ B, from \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d\.$/,
    );
    assert.equal((await audits(store, "old_thing")).length, 2, "a preview removes nothing");

    const { policy } = await read(await api("POST", "/v1/retention/policies", design()));
    const run = await read(await api("POST", `/v1/retention/policies/${policy.id}/run`));
    assert.match(run.said, /^“Old audit” removed 2 entries, \d+ B, from .* from control\.$/);
    assert.equal((await audits(store, "old_thing")).length, 0);
    assert.equal((await audits(store, "new_thing")).length, 1);
    assert.equal(
      (await audits(store, "retention_removed")).length,
      2,
      "the old one stays, and this run's is added",
    );
    const removals = await read(await api("GET", "/v1/retention/removals"));
    assert.equal(removals.removals.length, 1);
    assert.deepEqual(
      [
        removals.removals[0].name,
        removals.removals[0].rig,
        removals.removals[0].by,
        removals.removals[0].count,
      ],
      ["Old audit", null, "Run now", 2],
    );
    // The same removal again: nothing left to remove.
    const again = await read(await api("POST", `/v1/retention/policies/${policy.id}/run`));
    assert.equal(
      again.said,
      "“Old audit” removed nothing: everything it covers is inside the rule.",
    );
  });

  test("older versions of the knowledge base's items: the newest always stays", async () => {
    const store = openControlStore(":memory:");
    const rig = { rig: "rig-a", ledger: "ledger-a" };
    await store.kb().index(rig, {
      at: "2026-10-01T10:00:00.000Z",
      actor: "harness",
      kind: "run_created",
      subject: "r-1",
      body: { campaign: "speed", mode: "goal" },
    });
    for (let v = 1; v <= 3; v++)
      await store.kb().write(
        {
          ...rig,
          run: "r-1",
          event: 10 + v,
          at: new Date(Date.now() - (40 - v) * DAY).toISOString(),
        },
        {
          slot: "worker-1",
          item: 1,
          version: v,
          kind: "finding",
          title: `Finding ${v}`,
          text: `Text ${v}`,
          links: [],
        },
      );
    const p = await createPolicy(
      store,
      design({ name: "Old versions", kind: "kb_versions", rule: "newest", newest_n: 0 + 1 }),
      false,
      "owner:ui",
    );
    // Keep the newest 1 of the older versions: version 1 goes; 2 stays as the newest older one.
    assert.equal((await previewOf(store, p)).count, 1);
    await runPolicy({ store, privateKeyPem: "" }, p.id, "hand", "owner:ui");
    const id = (
      sqliteBehind(store).db.prepare("select id from kb_item where slot = 'worker-1'").get() as {
        id: number;
      }
    ).id;
    assert.deepEqual(
      (await store.kb().versions(id)).map((v) => v.version),
      [2, 3],
    );
    const all = await createPolicy(
      store,
      design({ name: "All old", kind: "kb_versions", rule: "older", older_n: 1 }),
      false,
      "owner:ui",
    );
    await runPolicy({ store, privateKeyPem: "" }, all.id, "hand", "owner:ui");
    assert.deepEqual(
      (await store.kb().versions(id)).map((v) => v.version),
      [3],
      "the newest stays",
    );
    assert.throws(
      () => sqliteBehind(store).db.prepare("delete from kb_version").run(),
      /newest version of an item is never removed/,
    );
  });

  test("copies of control's store: removed beside it, the newest kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-retention-copies-"));
    const path = join(dir, "control.db");
    const store = openControlStore(path);
    const copy = (stamp: string) => {
      const p = `${path}.v20.${stamp}.copy`;
      writeFileSync(p, Buffer.alloc(500));
      return p;
    };
    const old = copy("2026-09-01T00-00-00-000Z");
    const newest = copy("2026-09-02T00-00-00-000Z");
    const p = await createPolicy(
      store,
      design({ name: "Copies", kind: "store_copies", rule: "older", older_n: 1 }),
      false,
      "owner:ui",
    );
    const r = await runPolicy({ store, privateKeyPem: "" }, p.id, "hand", "owner:ui");
    assert.equal(r.removed?.count, 1);
    assert.equal(existsSync(old), false);
    assert.ok(existsSync(newest), "the newest copy is kept");
    await store.close();
  });

  test("store copies: control keeps the two newest itself until a policy of them is on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-retention-default-"));
    const store = openControlStore(join(dir, "control.db"));
    assert.equal(copiesPolicyOn(sqliteBehind(store).db), false);
    const p = await createPolicy(
      store,
      design({ name: "Copies", kind: "store_copies", rule: "newest", newest_n: 5 }),
      false,
      "owner:ui",
    );
    assert.equal(
      copiesPolicyOn(sqliteBehind(store).db),
      false,
      "an off policy does not stop control's own rule",
    );
    await setPolicyOn(store, p.id, true, "owner:ui");
    assert.equal(copiesPolicyOn(sqliteBehind(store).db), true, "an on policy decides instead");
    await store.close();
  });

  test("the schedule: once for each due time, kept across a restart; off or by hand never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-retention-schedule-"));
    const path = join(dir, "control.db");
    const store = openControlStore(path);
    const deps = { store, privateKeyPem: "" };
    const p = await createPolicy(store, design({ time: "03:00" }), false, "owner:ui");
    // On, but only by hand: never run by the schedule.
    await createPolicy(store, design({ name: "By hand", when: "hand" }), true, "owner:ui");
    oldEntry(store, "old_thing", 40);
    const at = (iso: string) => new Date(iso);
    assert.equal(
      await retentionTick(deps, at("2030-01-02T04:00:00Z")),
      0,
      "off: it removes nothing",
    );
    sqliteBehind(store)
      .db.prepare("update retention_policy set enabled = 1, on_since = ? where id = ?")
      .run("2030-01-01T00:00:00Z", p.id);
    assert.equal(
      await retentionTick(deps, at("2030-01-02T02:59:00Z")),
      1,
      "yesterday's time, missed while away",
    );
    assert.equal(await retentionTick(deps, at("2030-01-02T02:59:30Z")), 0, "once for that time");
    assert.equal(await retentionTick(deps, at("2030-01-02T03:00:00Z")), 1, "today's time");
    assert.equal((await store.retention.get(p.id))?.last_due, "2030-01-02T03:00:00.000Z");
    await store.close();
    // Control starts again: the due time it ran for is kept, so it does not run again.
    const again = openControlStore(path);
    assert.equal(
      await retentionTick({ store: again, privateKeyPem: "" }, at("2030-01-02T09:00:00Z")),
      0,
    );
    assert.equal(
      await retentionTick({ store: again, privateKeyPem: "" }, at("2030-01-03T03:00:00Z")),
      1,
    );
    assert.equal((await again.retention.removals(10)).filter((r) => r.by === "schedule").length, 3);
    await setPolicyOn(again, p.id, false, "owner:ui");
    assert.equal(
      await retentionTick({ store: again, privateKeyPem: "" }, at("2030-01-04T03:00:00Z")),
      0,
    );
    await again.close();
  });

  test("a rig's kind: the preview from what the rig said, Run now sends it the signed command, and what it removed reaches the history", async () => {
    const store = controlStore();
    const { api } = await controlOnly({
      store,
      tokens: { admin: OWNER, rigs: { "rig-a": RIG_A, "rig-b": "rig-b-token-abcdef" } },
    });
    await report(store, "rig-a", "ledger-a", [
      { kind: "run_created", subject: "r-1", body: { campaign: "speed", mode: "hill_climb" } },
    ]);
    await report(store, "rig-b", "ledger-b", [
      { kind: "run_created", subject: "r-2", body: { campaign: "other", mode: "hill_climb" } },
    ]);
    await rigSays(store, "rig-a", [
      build("x", 40),
      build("y", 40, { champion: true }),
      build("z", 2),
      build("o", 40, { open: true }),
    ]);
    const builds = design({ name: "Old builds", kind: "builds", rule: "older", older_n: 30 });
    const preview = await read(await api("POST", "/v1/retention/preview", builds));
    assert.equal(preview.count, 1, "champions' builds and runs still open are kept");
    assert.deepEqual(preview.unreported, ["rig-b"], "rig-b has not said what it keeps");
    const campaign = await read(
      await api("POST", "/v1/retention/preview", {
        ...builds,
        where: "campaigns",
        campaigns: ["speed"],
      }),
    );
    assert.deepEqual(campaign.unreported, [], "only the rigs that ran speed");

    const { policy } = await read(
      await api("POST", "/v1/retention/policies", { ...builds, where: "rigs", rigs: ["rig-a"] }),
    );
    const run = await read(await api("POST", `/v1/retention/policies/${policy.id}/run`));
    assert.match(
      run.said,
      /^Sent “Old builds” to rig-a: on each, it removes what the policy covers there/,
    );
    const [sent] = await store.commands.pending("rig-a");
    assert.equal(sent?.envelope.kind, "retention_run");
    assert.equal(sent?.envelope.issued_by, "owner:api");
    assert.deepEqual(sent?.envelope.payload, {
      policy: policy.id,
      name: "Old builds",
      rule: {
        kind: "builds",
        rule: "older",
        older_n: 30,
        older_unit: "days",
        newest_n: 20,
        newest_per: "rig",
        size_gib: 50,
        keep: { open: true, champions: true, newest: true },
      },
      by: "hand",
    });
    assert.equal(
      (await store.commands.pending("rig-b")).length,
      0,
      "a rig the policy does not cover gets nothing",
    );

    // The rig's event of what it removed: in the history and the audit log.
    await report(
      store,
      "rig-a",
      "ledger-a",
      [
        {
          kind: "retention_removed",
          subject: null,
          actor: "control:owner:api",
          body: {
            policy: policy.id,
            name: "Old builds",
            kind: "builds",
            by: "hand",
            count: 1,
            bytes: 1000,
            oldest: build("x", 40).at,
            newest: build("x", 40).at,
          },
        },
      ],
      {},
      1,
    );
    await applied(store);
    const [r] = await store.retention.removals(5);
    assert.deepEqual(
      [r?.rig, r?.kind, r?.count, r?.bytes, r?.by],
      ["rig-a", "builds", 1, 1000, "Run now"],
    );
    assert.equal((await audits(store, "retention_removed"))[0]?.actor, "rig:rig-a");
  });

  test("over MCP: the owner and an operator read and preview; only the owner changes or runs one", async () => {
    const { control, store } = await controlOnly({ tokens: { admin: OWNER, operator: OPERATOR } });
    const owner = await mcpClient(control, OWNER);
    const operator = await mcpClient(control, OPERATOR);
    const names = async (c: typeof owner) => (await c.listTools()).tools.map((t) => t.name);
    const changing = [
      "create_retention_policy",
      "update_retention_policy",
      "set_retention_policy_on",
      "delete_retention_policy",
      "run_retention_policy",
    ];
    for (const t of ["retention_policies", "retention_preview", "retention_removals", ...changing])
      assert.ok((await names(owner)).includes(t), t);
    for (const t of ["retention_policies", "retention_preview", "retention_removals"])
      assert.ok((await names(operator)).includes(t), t);
    for (const t of changing)
      assert.ok(!(await names(operator)).includes(t), `${t} is the owner's`);

    const text = (r: unknown) =>
      JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? "{}");
    const made = text(
      await owner.callTool({ name: "create_retention_policy", arguments: design() }),
    );
    assert.equal(made.policy.on, false);
    const listed = text(await operator.callTool({ name: "retention_policies", arguments: {} }));
    assert.equal(listed.policies.length, 1);
    const refused = await operator.callTool({
      name: "delete_retention_policy",
      arguments: { id: made.policy.id },
    });
    assert.equal(refused.isError, true);
    assert.ok(await store.retention.get(made.policy.id), "an operator deletes nothing");
    const on = text(
      await owner.callTool({
        name: "set_retention_policy_on",
        arguments: { id: made.policy.id, on: true },
      }),
    );
    assert.equal(on.policy.on, true);
    assert.equal((await audits(store, "retention_policy_on"))[0]?.actor, "owner:mcp");
  });
});
