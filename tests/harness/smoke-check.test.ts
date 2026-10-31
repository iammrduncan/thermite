import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { IDS } from "../../src/harness/broker/index.ts";
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

describe("the smoke check's kits and projects in the harness image", () => {
  const file = readFileSync(join(repoRoot, "containers", "harness", "Containerfile"), "utf8");
  const final = file.slice(file.lastIndexOf("\nFROM "));
  // The copies of kits/ and examples/, then one step that closes them and checks that it did.
  const step =
    /\nCOPY kits \.\/checks\/kits\nCOPY examples \.\/checks\/examples\nRUN chown -R 0:(\d+) checks \\\n && chmod -R (\S+) checks \\\n && test -z "\$\(find checks -perm \/o=rwx -print -quit\)"\n/.exec(
      final,
    );

  test("only the harness reads them: root's, with the controller's group, closed to every other user, and the build fails on one left open", () => {
    assert.ok(step, "the copies, then the step that gives them their owner and modes and checks");
    // In /opt/thermite, where the smoke check looks for them in the image (checksDir).
    assert.match(final.slice(0, step.index), /\nWORKDIR \/opt\/thermite\n/);
    // The controller runs as `thermite`, with that group (broker/runner.ts); no role has it.
    assert.equal(Number(step[1]), IDS.thermite.gid);
    assert.match(file, new RegExp(`groupadd -g ${IDS.thermite.gid} thermite `));
    assert.equal(step[2], "u=rwX,g=rX,o=");
    // No later step names the folder, so none opens it again.
    const later = final
      .slice(step.index + step[0].length)
      .split("\n")
      .filter((line) => !line.startsWith("#"));
    assert.doesNotMatch(later.join("\n"), /checks/);
  });

  test("the step's modes: folders and the executable scripts 0750, other files 0640, and the smoke kit's commits stay the goal contract's", async () => {
    // The step's own modes, on a copy here: chmod takes the same symbolic modes on every system.
    const checks = join(mkdtempSync(join(tmpdir(), "thermite-checks-")), "checks");
    for (const d of ["kits", "examples"])
      cpSync(join(repoRoot, d), join(checks, d), { recursive: true });
    execFileSync("chmod", ["-R", String(step?.[2]), checks]);
    const wrong: string[] = [];
    const look = (rel: string) => {
      const st = statSync(join(checks, rel));
      const executable = (statSync(join(repoRoot, rel)).mode & 0o100) !== 0;
      const want = st.isDirectory() || executable ? 0o750 : 0o640;
      if ((st.mode & 0o7777) !== want) wrong.push(`${rel}: ${(st.mode & 0o7777).toString(8)}`);
      if (st.isDirectory()) for (const n of readdirSync(join(checks, rel))) look(join(rel, n));
    };
    for (const d of ["kits", "examples"]) look(d);
    assert.deepEqual(wrong, []);
    // Git records the execute bit alone: the commits the smoke check makes from them are the ones
    // the goal contract names.
    const contract = JSON.parse(
      readFileSync(join(repoRoot, "examples/contracts/smoke-cpu-goal.json"), "utf8"),
    ) as { project: { commit: string; kit: { commit: string } } };
    const s = await seedSmokeRepos(
      checks,
      "smoke-cpu",
      mkdtempSync(join(tmpdir(), "thermite-smoke-")),
    );
    assert.deepEqual(
      { project: s.project, kit: s.kit },
      { project: contract.project.commit, kit: contract.project.kit.commit },
    );
  });
});
