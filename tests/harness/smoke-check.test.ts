import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NOISY_TIMING_NOTE,
  type SmokeResult,
  seedSmokeRepos,
  smokeCheck,
  smokeReport,
} from "../../src/harness/smoke-check.ts";
import { makeJudgeEnv } from "../helpers/judge-env.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the smoke rig check", () => {
  test("it builds the smoke campaign itself, gets each candidate's expected verdict, and resumes the rig's runs", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign); // a running run: paused for the smoke, resumed after
    let stop = false;
    const judging = (async () => {
      while (!stop) if (!(await env.judge.tick())) await new Promise((r) => setTimeout(r, 50));
    })();
    // Candidates whose verdicts do not depend on timing, so a busy test host cannot change them.
    // The kit's build needs GNU ld (the Linux image): elsewhere, only the ones refused unbuilt.
    const only =
      process.platform === "linux"
        ? ["timer", "ref-edit", "broken", "nobuild"]
        : ["timer", "ref-edit"];
    const r = await smokeCheck({
      service: env.service,
      targetType: "cpu",
      targetClass: "test",
      checksDir: repoRoot,
      scratchDir: env.paths.scratchDir,
      only,
      pollMs: 100,
      timeoutMs: 600_000,
    }).finally(() => {
      stop = true;
    });
    await judging;
    assert.equal(r.ok, true, r.summary);
    assert.match(
      r.summary,
      new RegExp(`smoke on smoke-cpu: all ${only.length} candidates were judged as expected`),
    );
    const got = (r.detail?.candidates ?? {}) as Record<string, { got: string }>;
    assert.equal(got.timer?.got, "rejected_v0");
    assert.equal(got["ref-edit"]?.got, "rejected_v0");
    if (only.includes("broken")) assert.equal(got.broken?.got, "invalid");
    const smokeRun = String(r.detail?.run);
    assert.equal(env.ledger.runs.get(smokeRun)?.status, "closed");
    assert.equal(env.ledger.runs.get("js-1")?.status, "running", "the rig's run is resumed");
    // A second smoke reuses the same deterministic repositories and contract.
    const again = await smokeCheck({
      service: env.service,
      targetType: "cpu",
      targetClass: "test",
      checksDir: repoRoot,
      scratchDir: env.paths.scratchDir,
      only: ["timer"],
      pollMs: 100,
    });
    assert.equal(again.ok, true, again.summary);
  });

  test("the smoke kit's goal contract names the smoke check's own project and kit commits", async () => {
    const file = "examples/contracts/smoke-cpu-goal.json";
    const contract = JSON.parse(readFileSync(join(repoRoot, file), "utf8")) as {
      project: { repo: string; commit: string; kit: { repo: string; commit: string } };
    };
    const s = await seedSmokeRepos(
      repoRoot,
      "smoke-cpu",
      mkdtempSync(join(tmpdir(), "thermite-smoke-")),
    );
    const named = [
      ["project.repo", contract.project.repo, s.projectRepo, "project's repository name"],
      ["project.commit", contract.project.commit, s.project, "commit of examples/smoke-project"],
      ["project.kit.repo", contract.project.kit.repo, s.kitRepo, "kit's repository name"],
      ["project.kit.commit", contract.project.kit.commit, s.kit, "commit of kits/smoke-cpu"],
    ];
    for (const [field, got, want, what] of named)
      assert.equal(
        got,
        want,
        `${file}: set ${field} to ${want}, the smoke check's ${what} (it is ${got})`,
      );
  });

  test("a target without a smoke kit is reported, not attempted", async () => {
    const env = makeJudgeEnv();
    const r = await smokeCheck({
      service: env.service,
      targetType: "tpu",
      targetClass: "x",
      checksDir: repoRoot,
      scratchDir: env.paths.scratchDir,
    });
    assert.equal(r.ok, false);
    assert.match(r.summary, /no smoke kit for a tpu target/);
  });
});

describe("the smoke check's report", () => {
  // Each CPU candidate with its expected result, as the kit lists them; `got` is set per test.
  const expected = JSON.parse(
    readFileSync(join(repoRoot, "kits/smoke-cpu/candidates/candidates.json"), "utf8"),
  ) as Record<string, { expect: string; accept?: string[] }>;
  const results = (got: Record<string, string> = {}): Record<string, SmokeResult> =>
    Object.fromEntries(
      Object.entries(expected).map(([n, c], i) => {
        const want = c.accept ?? [c.expect];
        const g = got[n] ?? (want[0] as string);
        return [n, { expect: want.join("|"), got: g, ok: want.includes(g), attempt: `a-${i}` }];
      }),
    );

  test("every expected result passes, with no note", () => {
    const r = smokeReport("smoke-cpu", "check-smoke-1", results());
    assert.equal(r.ok, true);
    assert.equal(
      r.summary,
      "smoke on smoke-cpu: all 13 candidates were judged as expected (run check-smoke-1)",
    );
    assert.equal(r.note, undefined);
    assert.equal(r.detail?.noisy_timing, undefined);
  });

  test("a no-op that is inconclusive, as the only wrong result, passes with the note on noisy timing", () => {
    const r = smokeReport("smoke-cpu", "check-smoke-1", results({ noop: "inconclusive" }));
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.note, NOISY_TIMING_NOTE);
    assert.equal(
      r.summary,
      "smoke on smoke-cpu: 12 of 13 candidates were judged as expected; the no-op came out inconclusive, not neutral (run check-smoke-1). Note: The timing on this machine is noisy. Results here need more repeats.",
    );
    assert.equal(r.detail?.noisy_timing, true);
    assert.equal(r.detail?.note, NOISY_TIMING_NOTE);
    const noop = (r.detail?.candidates as Record<string, SmokeResult> | undefined)?.noop;
    assert.deepEqual(noop, { expect: "neutral", got: "inconclusive", ok: false, attempt: "a-1" });
    // The CUDA kit's no-op is judged the same way.
    const cuda = smokeReport("smoke-cuda", "check-smoke-2", {
      good: { expect: "win_confirmed", got: "win_confirmed", ok: true, attempt: "g" },
      noop: { expect: "neutral", got: "inconclusive", ok: false, attempt: "n" },
    });
    assert.equal(cuda.ok, true, cuda.summary);
    assert.match(cuda.summary, /^smoke on smoke-cuda: 1 of 2 candidates were judged as expected;/);
  });

  test("a no-op that is inconclusive beside another wrong result still fails, with no note", () => {
    const others: Record<string, string>[] = [
      { good: "neutral" },
      { good: "inconclusive" },
      { broken: "neutral" },
      { overwrite: "win_confirmed" },
    ];
    for (const other of others) {
      const r = smokeReport(
        "smoke-cpu",
        "check-smoke-1",
        results({ noop: "inconclusive", ...other }),
      );
      assert.equal(r.ok, false, JSON.stringify(other));
      assert.equal(r.note, undefined);
      assert.equal(r.detail?.noisy_timing, undefined);
      assert.match(r.summary, /^smoke on smoke-cpu: 2 of 13 candidates were judged otherwise: /);
      assert.match(r.summary, /noop expected neutral, got inconclusive/);
    }
  });

  test("any other wrong result fails: a no-op with another verdict, or another candidate inconclusive", () => {
    const wrong: Record<string, string>[] = [
      { noop: "regress" },
      { noop: "win_confirmed" },
      { noop: "" },
      { good: "inconclusive" },
      { broken: "inconclusive" },
    ];
    for (const got of wrong) {
      const r = smokeReport("smoke-cpu", "check-smoke-1", results(got));
      assert.equal(r.ok, false, JSON.stringify(got));
      assert.equal(r.note, undefined);
      assert.match(r.summary, /^smoke on smoke-cpu: 1 of 13 candidates were judged otherwise: /);
    }
    const none = smokeReport("smoke-cpu", "check-smoke-1", results({ noop: "" }));
    assert.match(none.summary, /noop expected neutral, got nothing$/);
  });
});
