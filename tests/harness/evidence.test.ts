import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseContract } from "../../src/core/contract.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { GitError, patchBytes, readableDiff, treeFile, treeFiles } from "../../src/harness/git.ts";
import { researchFixture } from "../helpers/fixtures.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { FAST_KERNEL, makeJudgeEnv, WRONG_KERNEL } from "../helpers/judge-env.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** A run with a judged win (a held-out cell when `heldOut`) and a wrong attempt, both judged. */
async function judged(o: { heldOut?: boolean } = {}) {
  const env = makeJudgeEnv(o.heldOut ? { heldOut: true } : {});
  await env.service.applyCommand(env.assign);
  const submit = async (kernel: string, hypothesis: string) =>
    (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(kernel), hypothesis, known_flaws: [] },
        "test",
      )
    ).attempt;
  const wrong = await submit(WRONG_KERNEL, "return n * 3: no loop at all");
  await env.drain();
  const fast = await submit(FAST_KERNEL, "drop the idle wait: the seed sleeps for nothing");
  await env.drain();
  const api = createHarnessApi(env.service, tokens);
  const get = async (path: string, token = tokens.supervisor) => {
    const r = await api.request(path, { headers: auth(token) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { env, wrong, fast, get };
}

describe("the teachers' reads of a run's code and evidence (goal 081)", () => {
  test("the champion's tree, a file by lines, an attempt's diff, and the judge's findings", async () => {
    const { env, wrong, fast, get } = await judged();
    const files = await get("/v1/code/files?run=js-1");
    assert.equal(files.status, 200);
    const champion = env.ledger.champions.current("js-1");
    assert.equal(files.body.commit, champion.commit_sha);
    assert.deepEqual(
      (files.body.files as string[]).map((f) => f.replace(/ \(\d+ bytes\)$/, "")).sort(),
      ["README.md", "src/kernel/work.mjs"],
    );
    // The champion is the fast kernel now: its file, by lines.
    const file = await get("/v1/code/file?run=js-1&path=src/kernel/work.mjs&offset=2&limit=2");
    assert.equal(file.status, 200);
    assert.equal(file.body.from, 2);
    assert.equal(file.body.to, 3);
    assert.match(String(file.body.content), /^2\t {2}let s = 0;\n3\t {2}for \(let i = 0/);
    const folder = await get("/v1/code/files?run=js-1&path=src");
    assert.deepEqual(folder.body.files, [
      `src/kernel/work.mjs (${Buffer.byteLength(FAST_KERNEL)} bytes)`,
    ]);
    // An attempt's diff, in parts.
    const diff = await get(`/v1/code/diff?run=js-1&attempt=${wrong}`);
    assert.equal(diff.status, 200);
    assert.match(String(diff.body.diff), /\+ {2}return n \* 3;/);
    assert.equal(diff.body.next, null);
    const part = await get(`/v1/code/diff?run=js-1&attempt=${wrong}&offset=10`);
    assert.equal(part.body.from, 10);
    assert.equal(String(part.body.diff), String(diff.body.diff).slice(10));
    // The judge's findings: the wrong attempt's reasons, the experiment it came from, and the
    // newest attempts and tried experiments with their causes.
    const one = await get(`/v1/evidence?run=js-1&attempt=${wrong}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.hypothesis, "return n * 3: no loop at all");
    assert.match(String(one.body.reasons), /wrong result/);
    assert.deepEqual(one.body.known_flaws, []);
    const all = await get("/v1/evidence?run=js-1");
    const attempts = all.body.attempts as { attempt: string; verdict: string | null }[];
    assert.deepEqual(
      attempts.map((a) => a.attempt),
      [fast, wrong],
    );
    assert.ok(attempts.every((a) => a.verdict));
    // The brief carries the evidence (with the judge's reasons), the champion's commit, the
    // queue's target and what the teachers proposed before.
    const brief = await get("/v1/brief?run=js-1");
    const b = brief.body as {
      champion: { commit: string };
      evidence: { attempt: string; reasons: string | null }[];
      queue_target: { target: number; ready: number; below: boolean; wanted: number };
      teacher_ideas: unknown[];
      causes: unknown[];
    };
    assert.equal(b.champion.commit, champion.commit_sha);
    assert.match(String(b.evidence.find((e) => e.attempt === wrong)?.reasons), /wrong result/);
    assert.deepEqual(b.queue_target, { target: 4, lanes: 2, ready: 0, below: true, wanted: 4 });
    assert.deepEqual(b.teacher_ideas, []);
    assert.deepEqual(b.causes, []);
  });

  test("a tried experiment's cause: the judge's reasons, the trial's error, or who dropped it", async () => {
    const { env, wrong, get } = await judged();
    const q = env.service.queue;
    const a = q.add("js-1", { title: "drop the loop", by: "owner" }, "o");
    q.assign("js-1", a.id, { lane: "lane-1", trial: "t-a", by: "planner" }, "p");
    env.ledger.db.prepare("update experiment set attempt = ? where id = ?").run(wrong, a.id);
    q.finish("t-a", { result: "submitted", attempt: wrong }, "p");
    const b = q.add("js-1", { title: "use the GPU", by: "owner" }, "o");
    q.drop("js-1", b.id, { by: "owner", why: "no GPU on this rig" }, "o");
    // A trial that failed on the model's provider: no attempt, and the trial's error as cause.
    const c = q.add("js-1", { title: "unroll by 4", by: "teacher" }, "o");
    q.assign("js-1", c.id, { lane: "lane-2", trial: "t-c", by: "planner" }, "p");
    env.ledger.db
      .prepare(
        "insert into trial (id, run, lane, epoch, parent_commit, stopped, error, started_at, ended_at) values ('t-c', 'js-1', 'lane-2', 1, 'x', 'error', 'the provider said 429: rate limited', ?, ?)",
      )
      .run(new Date().toISOString(), new Date().toISOString());
    q.finish("t-c", { result: "error" }, "p");
    const all = await get("/v1/evidence?run=js-1");
    const tried = all.body.tried as { id: string; cause: string; verdict?: string }[];
    assert.match(String(tried.find((t) => t.id === a.id)?.cause), /wrong result/);
    assert.equal(tried.find((t) => t.id === b.id)?.cause, "dropped by owner: no GPU on this rig");
    assert.equal(
      tried.find((t) => t.id === c.id)?.cause,
      "no attempt: the trial ended error (the provider said 429: rate limited)",
    );
    // The brief's causes say the same, shorter.
    const brief = await get("/v1/brief?run=js-1");
    assert.deepEqual(
      (brief.body.causes as { id: string }[]).map((x) => x.id).sort(),
      [a.id, b.id, c.id].sort(),
    );
  });

  test("held-out content stays out: no held-out result, no kit file, no path outside the tree", async () => {
    const { env, fast, get } = await judged({ heldOut: true });
    // The judge measured the held-out cell for the confirmation: only in its held_out table. A
    // marker there must never reach a teacher.
    const held = env.ledger.db.prepare("select count(*) as n from held_out").get() as {
      n: number;
    };
    assert.ok(held.n > 0, "the held-out cell was measured");
    const job = env.ledger.db.prepare("select id from job order by id limit 1").get() as {
      id: number;
    };
    env.ledger.db
      .prepare(
        "insert into held_out (job, fence, attempt, pass, detail, created_at) values (?, 0, ?, 0, ?, ?)",
      )
      .run(job.id, fast, JSON.stringify({ secret: "HELD-OUT-MARKER" }), new Date().toISOString());
    const reads = [
      await get("/v1/brief?run=js-1"),
      await get("/v1/evidence?run=js-1"),
      await get(`/v1/evidence?run=js-1&attempt=${fast}`),
      await get(`/v1/code/diff?run=js-1&attempt=${fast}`),
      await get("/v1/code/files?run=js-1"),
    ];
    for (const r of reads) {
      assert.equal(r.status, 200);
      const text = JSON.stringify(r.body);
      assert.ok(!text.includes("HELD-OUT-MARKER"), "no held-out detail");
      assert.ok(!text.includes('"held"'), "no held-out cell");
    }
    // Of that failed held-out check, the teachers get only its kind in fixed words (goal 082),
    // in the same shape as the planner's evidence.
    assert.equal(reads[2]?.body.held_out, "a held-out check failed");
    const attempts = (reads[1]?.body.attempts ?? []) as { attempt: string; held_out?: string }[];
    const listed = attempts.find((a) => a.attempt === fast);
    assert.equal(listed?.held_out, "a held-out check failed");
    // The kit is another repository: its files are not in the champion's tree.
    for (const path of ["kit.json", "check.mjs", "bench/run.mjs"])
      assert.equal((await get(`/v1/code/file?run=js-1&path=${path}`)).status, 404, path);
    for (const path of ["../kit/kit.json", "/etc/passwd", "src/../../x"]) {
      const r = await get(`/v1/code/file?run=js-1&path=${encodeURIComponent(path)}`);
      assert.equal(r.status, 400, path);
      assert.match(String(r.body.error), /not a path in the tree/);
    }
    assert.equal((await get("/v1/code/files?run=js-1&path=..")).status, 400);
  });

  test("only the supervisor reads them; an attempt of another run is not found", async () => {
    const { wrong, get } = await judged();
    for (const path of [
      "/v1/code/files?run=js-1",
      "/v1/code/file?run=js-1&path=README.md",
      `/v1/code/diff?run=js-1&attempt=${wrong}`,
      "/v1/evidence?run=js-1",
    ])
      assert.equal((await get(path, tokens.proposer)).status, 401, path);
    assert.equal((await get("/v1/code/diff?run=js-1&attempt=a-nope")).status, 404);
    assert.equal((await get("/v1/evidence?run=js-1&attempt=a-nope")).status, 404);
    assert.equal((await get("/v1/code/file?run=js-1&path=nope.md")).status, 404);
  });

  test("a research run has no code: the reads say so, and Git is never started in a folder that is not there", async () => {
    // A research run's seed is a placeholder: no repository of it is on the rig. Git was started
    // in that missing folder, and Node said only `spawn git ENOENT`.
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract(researchFixture);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const out = await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    const api = createHarnessApi(env.service, tokens);
    for (const path of [
      "/v1/code/files?run=r-1",
      "/v1/code/file?run=r-1&path=README.md",
      "/v1/code/diff?run=r-1&attempt=a-0123456789abcdef",
    ]) {
      const r = await api.request(path, { headers: auth(tokens.supervisor) });
      const body = (await r.json()) as { error?: string };
      assert.equal(r.status, 400, path);
      assert.equal(
        body.error,
        "run r-1 is a research run: it has no code to read. Its work is the sources, claims and notes in its research folder",
        path,
      );
    }
    // The judged reads of a research run still answer: they read no repository.
    assert.equal(
      (await api.request("/v1/evidence?run=r-1", { headers: auth(tokens.supervisor) })).status,
      200,
    );
    // Any read of a repository that is not on the rig says so, never `spawn git ENOENT`.
    const missing = env.service.mirrorFor("research");
    const commit = "0".repeat(40);
    for (const read of [
      () => treeFiles(missing, commit),
      () => treeFile(missing, commit, "README.md", 1000),
      () => readableDiff(missing, commit, commit),
      () => patchBytes(missing, commit, commit),
    ])
      await assert.rejects(read(), (err: Error) => {
        assert.ok(err instanceof GitError);
        assert.match(
          err.message,
          /^git [a-z-]+ failed: there is no repository research\.git on this rig$/,
        );
        assert.doesNotMatch(err.message, /spawn|ENOENT/);
        return true;
      });
  });
});
