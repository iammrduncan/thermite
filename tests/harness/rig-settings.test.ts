import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { signEnvelope } from "../../src/core/commands.ts";
import type { RigSettings } from "../../src/core/rig-settings.ts";
import { RigSettingsStore } from "../../src/harness/rig-settings.ts";
import { makeJudgeEnv } from "../helpers/judge-env.ts";

const defaults: RigSettings = {
  judge: true,
  workers: true,
  lanes: 2,
  planner: true,
  auditor: true,
  teachers: true,
  review: true,
  exports: true,
  trial_minutes: 20,
  max_turns: null,
  quiet_minutes: null,
  program_mode: "headless",
  promotion: "owner_approval",
  judge_gpus: null,
};

describe("the rig's own settings (Edit rig)", () => {
  test("a settings file that can't be read is kept aside and reported, never lost (goal 164)", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-settings-"));
    const file = join(dir, "rig-settings.json");
    writeFileSync(file, '{"lanes": 3, "judge": fal');
    const store = new RigSettingsStore(defaults, file);
    assert.deepEqual(store.get(), defaults);
    const kept = store.unreadable?.kept ?? "";
    assert.match(kept, /rig-settings\.json\.unreadable-/);
    assert.equal(readFileSync(kept, "utf8"), '{"lanes": 3, "judge": fal');
    assert.match(store.unreadable?.error ?? "", /JSON/);
    // A later change starts a new file; the old one stays for the owner.
    store.set({ lanes: 2 });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { set_keys: ["lanes"], lanes: 2 });
    assert.ok(existsSync(kept));
  });

  test("a change is kept across restarts and tells the loops that read it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "thermite-settings-")), "rig-settings.json");
    const store = new RigSettingsStore(defaults, file);
    const seen: RigSettings[] = [];
    store.onChange((s) => seen.push(s));
    const now = store.set({ judge: false, lanes: 3, max_turns: 200 });
    assert.equal(now.judge, false);
    assert.equal(now.lanes, 3);
    assert.equal(now.workers, true);
    assert.equal(seen.length, 1);
    // A restart reads what was kept, over the environment's defaults.
    assert.deepEqual(new RigSettingsStore({ ...defaults, lanes: 1 }, file).get(), now);
    // Back to no turn cap.
    assert.equal(store.set({ max_turns: null }).max_turns, null);
  });

  test("no trial length unless someone sets one: the environment, Edit rig, or a file from before (goal 079)", async () => {
    const { trialMinutesFromEnv } = await import("../../src/harness/rig-settings.ts");
    assert.equal(trialMinutesFromEnv(undefined), null);
    assert.equal(trialMinutesFromEnv(""), null);
    assert.equal(trialMinutesFromEnv("45"), 45);
    assert.throws(
      () => trialMinutesFromEnv("0"),
      /THERMITE_TRIAL_MINUTES takes a whole number of minutes from 1 to 1440, not "0"/,
    );
    const none = { ...defaults, trial_minutes: null };
    const dir = mkdtempSync(join(tmpdir(), "thermite-settings-"));
    // A file written before kept every setting, the old 20-minute default too: not a choice.
    const { writeFileSync, readFileSync } = await import("node:fs");
    const old = join(dir, "old.json");
    writeFileSync(old, JSON.stringify({ ...defaults, lanes: 3, trial_minutes: 20 }));
    const s = new RigSettingsStore(none, old).get();
    assert.equal(s.trial_minutes, null, "the old default is dropped");
    assert.equal(s.lanes, 3, "what else it kept stays");
    // From now on, only what someone set is kept, and named.
    const file = join(dir, "rig-settings.json");
    const store = new RigSettingsStore(none, file);
    store.set({ trial_minutes: 20 });
    const kept = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.deepEqual(kept, { set_keys: ["trial_minutes"], trial_minutes: 20 });
    assert.equal(new RigSettingsStore(none, file).get().trial_minutes, 20, "a choice stays");
    // Edit rig's empty field clears it.
    assert.equal(store.set({ trial_minutes: null }).trial_minutes, null);
    assert.equal(new RigSettingsStore(none, file).get().trial_minutes, null);
  });

  test("only a signed owner command changes them; the rig reports what it runs with", async () => {
    const env = makeJudgeEnv({ promotion: "owner_approval" });
    const r = await env.service.applyCommand(
      env.sign("rig_settings", { workers: false, promotion: "auto" }),
    );
    assert.equal(r.status, "applied");
    assert.equal((r as { accepted: boolean }).accepted, true);
    assert.equal(env.service.settings.get().workers, false);
    assert.equal(env.service.promotion, "auto");
    // In their own terminal until someone sets headless (goal 169); then the next trial is headless.
    assert.equal(env.service.settings.get().program_mode, "terminal");
    const headless = await env.service.applyCommand(
      env.sign("rig_settings", { program_mode: "headless" }),
    );
    assert.equal((headless as { accepted: boolean }).accepted, true);
    assert.equal(env.service.settings.get().program_mode, "headless");
    const bad = (await env.service.applyCommand(
      env.sign("rig_settings", { program_mode: "tui" }),
    )) as { status: string; accepted?: boolean };
    assert.ok(bad.status === "rejected" || bad.accepted === false, JSON.stringify(bad));
    assert.equal(env.service.settings.get().program_mode, "headless");
    const report = env.service.snapshot(0, 10) as { summary: { settings: RigSettings } };
    assert.equal(report.summary.settings.workers, false);
    assert.ok(
      env.ledger.db.prepare("select 1 from event where kind = 'rig_settings_changed'").get(),
    );
    // An agent's token can steer, but not change what runs on the rig.
    const agent = signEnvelope(
      {
        v: 1,
        id: "0f9b2c1e-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
        rig: env.service.rig,
        kind: "rig_settings",
        issued_by: "agent:mcp",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload: { judge: false },
      },
      env.keys.privateKeyPem,
    );
    const refused = await env.service.applyCommand(agent);
    assert.equal((refused as { accepted: boolean }).accepted, false);
    assert.equal(env.service.settings.get().judge, true);
    // Unknown fields are refused.
    const odd = (await env.service.applyCommand(env.sign("rig_settings", { gpus: 9 }))) as {
      status: string;
      accepted?: boolean;
    };
    assert.ok(odd.status === "rejected" || odd.accepted === false, JSON.stringify(odd));
  });

  test("a drain before an image update: the report says what still runs, until the drain ends (goal 079)", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    // A trial at work, and a judge job under lease.
    env.ledger.db
      .prepare(
        "insert into trial (id, run, lane, epoch, family, parent_commit, started_at) values ('t-1', 'js-1', 'lane-1', 1, 'f', ?, ?)",
      )
      .run(env.seed, new Date().toISOString());
    const work = () =>
      (env.service.snapshot(0, 10) as { summary: { work: Record<string, unknown> } }).summary.work;
    // Its open trials are listed too, with what each is doing (goal 143).
    const { open, ...counts } = work() as { open: { trial: string }[] };
    assert.deepEqual(counts, { trials: 1, judge_jobs: 0, draining: null });
    assert.deepEqual(
      open.map((t) => t.trial),
      ["t-1"],
    );
    const on = await env.service.applyCommand(
      env.sign("drain_rig", { drain: true, reason: "its images are about to change" }),
    );
    assert.equal(on.status, "applied");
    assert.ok(env.service.draining, "it drains");
    const w = work() as { trials: number; draining: { reason: string } | null };
    assert.equal(w.trials, 1);
    assert.equal(w.draining?.reason, "its images are about to change");
    assert.ok(env.ledger.db.prepare("select 1 from event where kind = 'rig_drain'").get());
    // The trial ends: nothing runs any more, and the report says so (control restarts the rig).
    env.ledger.db
      .prepare("update trial set ended_at = ? where id = 't-1'")
      .run(new Date().toISOString());
    assert.equal((work() as { trials: number }).trials, 0);
    // The update is called off: the drain ends.
    await env.service.applyCommand(env.sign("drain_rig", { drain: false }));
    assert.equal(env.service.draining, undefined);
    assert.equal((work() as { draining: unknown }).draining, null);
  });

  test("a drain waits on a judge job only while its lease is in force; one that ran out is taken back (goal 079)", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const work = () =>
      (env.service.snapshot(0, 10) as { summary: { work: { judge_jobs: number } } }).summary.work;
    const lease = (minutes: number) =>
      Number(
        env.ledger.db
          .prepare(
            "insert into job (kind, state, lease_owner, lease_until, fence, created_at, updated_at) values ('evaluate', 'leased', 'executor-0', ?, 1, ?, ?)",
          )
          .run(
            new Date(Date.now() + minutes * 60_000).toISOString(),
            new Date().toISOString(),
            new Date().toISOString(),
          ).lastInsertRowid,
      );
    await env.service.applyCommand(env.sign("drain_rig", { drain: true, reason: "new images" }));
    // A job whose holder renews its lease: the drain waits for it.
    const live = lease(10);
    assert.equal(work().judge_jobs, 1);
    // A job whose lease ran out (its holder died): not work, so the drain does not wait on it.
    const dead = lease(-1);
    assert.equal(work().judge_jobs, 1, "the lease that ran out is not counted");
    // Taking it back starts nothing, so a draining rig does it: the job is queued again.
    assert.deepEqual(env.judge.expireLeases(), [dead]);
    const state = (id: number) =>
      String(env.ledger.db.prepare("select state from job where id = ?").get(id)?.state);
    assert.equal(state(dead), "queued");
    assert.equal(state(live), "leased");
  });
});
