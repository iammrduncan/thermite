import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { RetentionRemoved } from "../../src/core/retention/index.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { buildsDir, spaceOf } from "../../src/harness/retention.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

/**
 * A retention policy on the rig (harness/retention.ts): the judge's builds it covers go on
 * control's signed command, those a run still open, a champion or a judge's job needs stay, a
 * removed build is made again when needed (its record stays), and what went is one
 * `retention_removed` event.
 */

const DAY = 86_400_000;
const key = (c: string) => c.repeat(64);

async function setup() {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.equal(out.status, "applied");
  const { ledger } = env.service;
  const state = env.service.paths.stateDir;
  /** A stored build of `commit`, `days` old, `bytes` big. */
  const build = (k: string, commit: string, days: number, bytes = 1000) => {
    ledger.builds.record({
      key: k,
      repo: "smoke-kernels",
      commit,
      kitCommit: "k".repeat(40),
      ok: true,
      manifest: { key: k },
      actor: "judge",
    });
    const dir = join(buildsDir(state), k);
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(join(dir, "out", "bin"), Buffer.alloc(bytes));
    writeFileSync(join(dir, "manifest.json"), "{}\n");
    const at = new Date(Date.now() - days * DAY);
    utimesSync(join(dir, "manifest.json"), at, at);
    return dir;
  };
  /** An attempt of smoke-1 at `commit`, with a judge's job in `state`. */
  const attempt = (id: string, commit: string, jobState: string) => {
    const now = new Date().toISOString();
    ledger.db
      .prepare(
        `insert into attempt (id, run, parent_ref, parent_commit, commit_sha, ref, diff_sha, normalized_diff_sha, lifecycle, created_at, updated_at)
         values (?, 'smoke-1', 'main', ?, ?, 'refs/x', 'd', 'n', 'proposed', ?, ?)`,
      )
      .run(id, env.seedCommit, commit, now, now);
    ledger.db
      .prepare(
        "insert into job (attempt, kind, state, created_at, updated_at) values (?, 'measure', ?, ?, ?)",
      )
      .run(id, jobState, now, now);
  };
  const run = (rule: Record<string, unknown>, by: "schedule" | "hand" = "hand") =>
    env.service.applyCommand(
      env.sign("retention_run", { policy: 7, name: "Old builds", rule, by }),
    );
  const removals = () =>
    ledger.events.list("retention_removed").map((e) => RetentionRemoved.parse(e.body));
  return { env, ledger, state, build, attempt, run, removals };
}

describe("the judge's builds under a retention policy", () => {
  test("removes what the rule covers; keeps champions, runs still open and builds a job needs", async () => {
    const s = await setup();
    const champion = s.build(key("a"), s.env.seedCommit, 90);
    const orphan = s.build(key("b"), "1".repeat(40), 90, 5000);
    const young = s.build(key("c"), "2".repeat(40), 1);
    s.attempt("a-0000000000000001", "3".repeat(40), "queued");
    const busy = s.build(key("d"), "3".repeat(40), 90);
    s.attempt("a-0000000000000002", "4".repeat(40), "done");
    const ofOpenRun = s.build(key("e"), "4".repeat(40), 90);

    const space = await spaceOf(s.ledger, s.state);
    assert.deepEqual(space.open_runs, ["smoke-1"]);
    assert.equal(space.builds.items.length, 5);
    assert.ok(space.builds.bytes >= 9000);

    const out = await s.run({ kind: "builds", rule: "older", older_n: 30 });
    assert.equal(out.status, "applied");
    assert.equal((out as { accepted: boolean }).accepted, true);
    assert.ok(existsSync(champion), "the run's champion stays");
    assert.ok(existsSync(young), "inside the rule");
    assert.ok(existsSync(busy), "a judge's job needs it");
    assert.ok(existsSync(ofOpenRun), "its run is still open");
    assert.equal(existsSync(orphan), false, "removed");
    const [r] = s.removals();
    assert.equal(r?.policy, 7);
    assert.equal(r?.kind, "builds");
    assert.equal(r?.count, 1);
    assert.ok((r?.bytes ?? 0) >= 5000);
    assert.equal(r?.by, "hand");
    // Its record stays: the judge makes it again from its commit when it is needed.
    assert.ok(s.ledger.builds.get(key("b"))?.ok);

    // Without the keeps, only the build a job needs stays.
    await s.run({
      kind: "builds",
      rule: "older",
      older_n: 30,
      keep: { open: false, champions: false },
    });
    assert.equal(existsSync(champion), false);
    assert.equal(existsSync(ofOpenRun), false);
    assert.ok(existsSync(busy), "never while a judge's job of its commit is queued or under way");
    assert.equal(s.removals().length, 2);
  });

  test("a rig's runners' builds: Space counts them, and a policy removes them there (goal 259)", async () => {
    const s = await setup();
    const now = Date.now();
    // Builds the judge made on the runner gpu-1, as the core records them; one it doesn't know.
    const record = (k: string, commit: string) =>
      s.ledger.builds.record({
        key: k,
        repo: "smoke-kernels",
        commit,
        kitCommit: "k".repeat(40),
        ok: true,
        manifest: { key: k },
        actor: "judge",
      });
    record(key("f"), "5".repeat(40));
    record(key("g"), "6".repeat(40));
    s.attempt("a-0000000000000003", "6".repeat(40), "leased");
    record(key("h"), "7".repeat(40));
    const onRunner = new Map<string, [number, number]>([
      [key("f"), [now - 90 * DAY, 4000]],
      [key("g"), [now - 90 * DAY, 3000]],
      [key("h"), [now - DAY, 2000]],
      [key("9"), [now - 90 * DAY, 1000]],
    ]);
    const asked: string[] = [];
    s.env.service.runnerBuilds = {
      kept: async () => [
        {
          runner: "gpu-1",
          kept: {
            builds: [...onRunner].map(
              ([k, [at, bytes]]) => [k, at, bytes] as [string, number, number],
            ),
            more: 0,
          },
        },
        { runner: "gpu-2", error: "the runner process gpu-2 is away" },
      ],
      remove: async (runner, k) => {
        asked.push(`${runner}/${k}`);
        return onRunner.delete(k);
      },
    };

    const space = await spaceOf(s.ledger, s.state, s.env.service.runnerBuilds);
    assert.equal(space.builds.items.length, 4, "gpu-1's four builds");
    assert.equal(space.builds.bytes, 10_000);
    assert.match(String(space.builds.error), /runner gpu-2: the runner process gpu-2 is away/);

    const out = await s.run({ kind: "builds", rule: "older", older_n: 30 });
    assert.equal((out as { accepted: boolean }).accepted, true, JSON.stringify(out));
    // The old build and the one the core doesn't know go; the one a job holds and the young stay.
    assert.deepEqual(asked.sort(), [`gpu-1/${key("9")}`, `gpu-1/${key("f")}`].sort());
    assert.deepEqual([...onRunner.keys()].sort(), [key("g"), key("h")]);
    const [r] = s.removals();
    assert.equal(r?.count, 2);
    assert.equal(r?.bytes, 5000);
    assert.match(String(r?.error), /runner gpu-2/, "a runner that could not say is named");
  });

  test("the advisors' records are the supervisor's; a kind kept on control is refused", async () => {
    const s = await setup();
    const out = await s.run({ kind: "advisor_records", rule: "older", older_n: 1 });
    assert.equal(out.status, "applied");
    assert.deepEqual((out as { result: unknown }).result, {
      kind: "advisor_records",
      left_to: "the supervisor",
    });
    assert.equal(s.removals().length, 0, "the supervisor records what it removes");
    const refused = await s.run({ kind: "audit", rule: "older", older_n: 1 });
    assert.equal((refused as { accepted: boolean }).accepted, false);
    assert.match(
      JSON.stringify((refused as { result: unknown }).result),
      /kept on control, which removes it/,
    );
  });

  test("only the owner's command runs a policy: an operator's or an agent's is refused", async () => {
    const s = await setup();
    s.build(key("b"), "1".repeat(40), 90);
    const out = await s.env.service.applyCommand(
      s.env.sign(
        "retention_run",
        { policy: 1, name: "x", rule: { kind: "builds", rule: "older", older_n: 1 }, by: "hand" },
        { issuedBy: "agent:mcp" },
      ),
    );
    assert.equal((out as { accepted: boolean }).accepted, false);
    assert.ok(existsSync(join(buildsDir(s.state), key("b"))));
  });

  test("the supervisor's routes: what the rig keeps, and what the supervisor removed", async () => {
    const s = await setup();
    s.build(key("b"), "1".repeat(40), 90, 3000);
    const api = createHarnessApi(s.env.service, { supervisor: "sup-token-abcdef" });
    const as = (path: string, init: RequestInit = {}, token = "sup-token-abcdef") =>
      api.request(path, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    assert.equal((await as("/v1/space", {}, "wrong-token")).status, 401);
    const space = (await (await as("/v1/space")).json()) as {
      builds: { bytes: number; items: unknown[] };
      open_runs: string[];
    };
    assert.deepEqual(space.open_runs, ["smoke-1"]);
    assert.equal(space.builds.items.length, 1);
    assert.ok(space.builds.bytes >= 3000);
    const body = {
      policy: 2,
      name: "Old records",
      kind: "advisor_records",
      by: "schedule",
      count: 3,
      bytes: 900,
      oldest: null,
      newest: null,
    };
    assert.equal(
      (await as("/v1/retention/removed", { method: "POST", body: JSON.stringify(body) })).status,
      200,
    );
    const [e] = s.ledger.events.list("retention_removed");
    assert.equal(e?.actor, "supervisor");
    assert.deepEqual(RetentionRemoved.parse(e?.body), body);
    const bad = await as("/v1/retention/removed", {
      method: "POST",
      body: JSON.stringify({ ...body, kind: "ledger" }),
    });
    assert.equal(bad.status, 400);
  });
});
