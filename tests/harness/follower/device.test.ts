import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { DeviceRefusal, DeviceServer } from "../../../src/harness/follower/device.ts";
import { refTips } from "../../../src/harness/git.ts";
import { baselineDir, baselineOf } from "../../../src/harness/judge/baseline.ts";
import { Ledger } from "../../../src/harness/ledger/index.ts";
import { CpuDriver } from "../../../src/harness/targets/cpu.ts";
import { FAST_KERNEL, makeJudgeEnv, WRONG_KERNEL } from "../../helpers/judge-env.ts";

/**
 * Goal 205, step 1: the leader's judge decides and records; a follower builds and measures on its
 * judge GPU for it. Every ask and answer passes through JSON, as on the bus.
 */

async function onFollower() {
  const env = makeJudgeEnv({ follower: true });
  await env.start();
  const submit = async (kernel: string, hypothesis: string) =>
    (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(kernel), hypothesis, known_flaws: [] },
        "proposer",
      )
    ).attempt;
  const verdicts = (id: string) =>
    env.ledger.db
      .prepare("select verdict from verdict where attempt = ? order by id")
      .all(id)
      .map((r) => r.verdict);
  return { ...env, submit, verdicts };
}

describe("a follower's judge GPU (goal 205)", () => {
  test("a run judged on the follower: its baseline, then a faster change screened, confirmed and promoted", async () => {
    const env = await onFollower();
    // The starting point was built and measured on the follower; the leader keeps the baseline's
    // record, its measurements and a copy of its folder, and the follower its own copy.
    const b = baselineOf(env.ledger, "js-1");
    assert.ok(b, "the leader has the run's baseline");
    assert.ok(existsSync(baselineDir(env.paths.stateDir, "js-1", b.job)), "the leader's copy");
    assert.ok(existsSync(baselineDir(env.followerPaths.stateDir, "js-1", b.job)), "the follower's");

    const id = await env.submit(FAST_KERNEL, "drop the wasted inner loop");
    await env.drain();
    assert.deepEqual(env.verdicts(id), ["win_screened", "win_confirmed"], env.explain(id));
    const champ = env.ledger.champions.current("js-1");
    assert.equal(champ.seq, 2);
    assert.equal(champ.attempt, id);

    // The builds are on the follower, and their records on the leader too.
    const builds = readdirSync(join(env.followerPaths.stateDir, "builds"));
    assert.ok(builds.length >= 2, `follower's builds: ${builds}`);
    assert.equal(existsSync(join(env.paths.stateDir, "builds")), false, "none on the leader");
    const recorded = env.ledger.db.prepare("select count(*) as n from build where ok = 1").get();
    assert.ok(Number(recorded?.n) >= 2, `the leader's build records: ${recorded?.n}`);

    // The measurements and receipts are the leader's, every arm named.
    const arms = env.ledger.db
      .prepare("select distinct arm from measurement order by arm")
      .all()
      .map((r) => r.arm);
    assert.deepEqual(arms, ["baseline", "candidate", "champion"]);

    // The follower holds the commits it was sent, under the leader's refs.
    const sent = await refTips(
      join(env.followerPaths.stateDir, "git", "proj.git"),
      "refs/thermite/imports/leader",
    );
    assert.ok(sent.includes(String(env.ledger.attempts.get(id)?.commit_sha)), `sent: ${sent}`);
  });

  test("a change with a wrong answer is invalid on the follower, as on the leader", async () => {
    const env = await onFollower();
    const id = await env.submit(WRONG_KERNEL, "return a guess");
    await env.drain();
    assert.deepEqual(env.verdicts(id), ["invalid"], env.explain(id));
  });
});

describe("a follower refuses what it did not name (goal 205)", () => {
  const server = () => {
    const root = mkdtempSync(join(tmpdir(), "thermite-follower-"));
    const paths = {
      stateDir: join(root, "state"),
      scratchDir: join(root, "scratch"),
      inboxDir: join(root, "inbox"),
    };
    for (const d of Object.values(paths)) mkdirSync(d, { recursive: true });
    return new DeviceServer({
      runner: new LocalRunner(paths.scratchDir),
      drivers: [new CpuDriver("test", { maxLoadFraction: Number.POSITIVE_INFINITY })],
      paths,
      ledger: Ledger.open(join(paths.stateDir, "ledger", "ledger.db")),
    });
  };

  test("a folder outside its runs, a card it lacks, a build outside its store", async () => {
    const s = server();
    await assert.rejects(s.ask({ op: "folder", act: "remove", dir: "/etc" }), DeviceRefusal);
    await assert.rejects(
      s.ask({ op: "baseline_work", card: 3, job: 1 }),
      (e: Error) => e instanceof DeviceRefusal && /no judge card 3/.test(e.message),
    );
    await assert.rejects(
      s.ask({
        op: "measure",
        card: 0,
        spec: { job: 1, kit_repo: "kit-x", kit_commit: "a".repeat(40) },
        arm: { name: "candidate", dir: "/tmp/elsewhere", manifest: { key: "k" } },
        cell: "small",
      }),
    );
    await assert.rejects(
      s.ask({
        op: "baseline_put",
        run: "js-1",
        job: 1,
        files: [{ path: "../../escape", base64: "" }],
      }),
      DeviceRefusal,
    );
  });

  test("it says what it is", async () => {
    assert.deepEqual(await server().ask({ op: "info" }), {
      type: "cpu",
      separated: false,
      cards: 1,
    });
  });
});

describe("a run's model files, as a follower fetches them (goal 205)", () => {
  test("from the run's accepted assignment, each with its source; none for another run", () => {
    const root = mkdtempSync(join(tmpdir(), "thermite-models-"));
    const ledger = Ledger.open(join(root, "ledger.db"));
    const sha = "a".repeat(64);
    const assign = (id: string, run: string, accepted: boolean) =>
      ledger.commands.record({
        id,
        kind: "assign_campaign",
        envelope: {
          payload: {
            run,
            imports: [
              { kind: "repo_bundle", path: "repos/p.bundle", repo: "proj", commit: "b".repeat(40) },
              {
                kind: "model",
                path: "models/m.gguf",
                name: "m",
                sha256: sha,
                source: { url: "https://models.example.com/m.gguf" },
              },
              { kind: "model", path: "models/n.gguf", name: "n", sha256: "c".repeat(64) },
            ],
          },
        },
        signature: "s",
        accepted,
        result: {},
        actor: "test",
      });
    assign("c-1", "js-1", false);
    assert.deepEqual(ledger.commands.modelsOf("js-1"), [], "a refused assignment names none");
    assign("c-2", "js-1", true);
    assert.deepEqual(ledger.commands.modelsOf("js-1"), [
      { name: "m", path: "models/m.gguf", sha256: sha, url: "https://models.example.com/m.gguf" },
      { name: "n", path: "models/n.gguf", sha256: "c".repeat(64) },
    ]);
    assert.deepEqual(ledger.commands.modelsOf("js-2"), []);
  });
});
