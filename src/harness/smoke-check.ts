import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git as gitRun, gitText } from "../common/git.ts";
import { RIG_CHECK_PREFIX } from "../core/ids.ts";
import { JUDGED_LIFECYCLES } from "../core/verdicts.ts";
import type { RigCheckReport } from "./agents/index.ts";
import type { HarnessService } from "./service/index.ts";

/**
 * The smoke check: a judge-only campaign on the rig's own target, from the smoke kit and project
 * the harness image carries, with candidates whose verdicts are known (a real win, a no-op, a
 * broken change, a fallback to the reference, and, on a CPU, more ways to cheat or crash). Each
 * must get its expected verdict. The rig's running runs are paused for it and resumed after.
 */

/** Where the image keeps the smoke kits and projects (kits/ and examples/), or this checkout. */
export function checksDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.THERMITE_CHECKS_DIR) return env.THERMITE_CHECKS_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  const image = join(here, "..", "..", "checks");
  return existsSync(join(image, "kits")) ? image : join(here, "..", "..");
}

interface Candidate {
  hypothesis: string;
  expect: string;
  accept?: string[];
}

/** The same files always make the same commit, so repeated smokes reuse their repositories. */
const FIXED = {
  GIT_AUTHOR_NAME: "thermite",
  GIT_AUTHOR_EMAIL: "thermite@localhost",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "thermite",
  GIT_COMMITTER_EMAIL: "thermite@localhost",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_NOSYSTEM: "1",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await gitText(["-c", "commit.gpgsign=false", ...args], { cwd, env: FIXED });
  return out.trim();
}

async function seedRepo(from: string, to: string, skip: string[]): Promise<string> {
  cpSync(from, to, {
    recursive: true,
    filter: (src) =>
      !skip.some((s) => src === join(from, s) || src.startsWith(`${join(from, s)}/`)),
  });
  await git(to, "init", "--quiet", "-b", "main");
  await git(to, "add", "-A");
  await git(to, "commit", "--quiet", "-m", "smoke seed");
  return git(to, "rev-parse", "HEAD");
}

/**
 * The smoke project's and kit's repositories, seeded in `work` (project/ and kit/, the kit
 * without its candidates), with their names and commits. The same files always give the same
 * commits: a contract may name them (examples/contracts/smoke-cpu-goal.json does).
 */
export async function seedSmokeRepos(
  checksDir: string,
  kitName: "smoke-cpu" | "smoke-cuda",
  work: string,
): Promise<{ projectRepo: string; project: string; kitRepo: string; kit: string }> {
  const kitDir = join(checksDir, "kits", kitName);
  const projectDir = join(
    checksDir,
    "examples",
    kitName === "smoke-cuda" ? "smoke-cuda-project" : "smoke-project",
  );
  const project = await seedRepo(projectDir, join(work, "project"), []);
  const kit = await seedRepo(kitDir, join(work, "kit"), ["candidates"]);
  return { projectRepo: `${kitName}-project`, project, kitRepo: `${kitName}-kit`, kit };
}

export async function smokeCheck(o: {
  service: HarnessService;
  targetType: string;
  targetClass: string;
  checksDir: string;
  scratchDir: string;
  /** Only these candidates (tests); all by default. */
  only?: string[] | undefined;
  pollMs?: number | undefined;
  timeoutMs?: number | undefined;
}): Promise<RigCheckReport> {
  const kitName =
    o.targetType === "cuda-gpu" ? "smoke-cuda" : o.targetType === "cpu" ? "smoke-cpu" : undefined;
  if (!kitName) return { ok: false, summary: `there is no smoke kit for a ${o.targetType} target` };
  const kitDir = join(o.checksDir, "kits", kitName);
  if (!existsSync(join(kitDir, "kit.json")))
    return { ok: false, summary: `the smoke kit is not in this image (${kitDir})` };
  const ledger = o.service.ledger;
  const by = "rig-check";
  const work = join(o.scratchDir, "thermite", "rig-check-smoke");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "repos"), { recursive: true });
  const { projectRepo, project, kitRepo, kit } = await seedSmokeRepos(o.checksDir, kitName, work);
  for (const [dir, name] of [
    ["project", projectRepo],
    ["kit", kitRepo],
  ] as const) {
    await git(
      join(work, dir),
      "bundle",
      "create",
      "--quiet",
      join(work, "repos", `${name}.bundle`),
      "--all",
    );
  }

  const contract = JSON.parse(
    readFileSync(join(o.checksDir, "examples", "contracts", "smoke-cpu.json"), "utf8"),
  ) as Record<string, unknown>;
  // A campaign per kit commit: a newer image's smoke never collides with an older contract.
  contract.campaign = `${RIG_CHECK_PREFIX}${kitName}-${kit.slice(0, 8)}`;
  contract.version = 1;
  contract.title = `Rig check: smoke (${kitName})`;
  contract.project = {
    repo: projectRepo,
    commit: project,
    kit: { repo: kitRepo, commit: kit },
  };
  contract.target = { type: o.targetType, class: o.targetClass };
  if (kitName === "smoke-cuda") contract.editable_paths = ["src/kernel/**"];

  const runId = `check-smoke-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  // Assigning pauses the rig's other runs; the ones running now are resumed afterwards.
  const wereRunning = ledger.runs
    .list()
    .filter((r) => r.status === "running")
    .map((r) => r.id);
  await o.service.assignLocal(
    {
      run: runId,
      contract,
      seed: { repo: projectRepo, commit: project },
      bundles: [
        {
          kind: "repo_bundle",
          path: `repos/${projectRepo}.bundle`,
          repo: projectRepo,
          commit: project,
        },
        { kind: "kit_bundle", path: `repos/${kitRepo}.bundle`, repo: kitRepo, commit: kit },
      ],
      dir: work,
    },
    by,
  );

  const all = JSON.parse(
    readFileSync(join(kitDir, "candidates", "candidates.json"), "utf8"),
  ) as Record<string, Candidate>;
  const names = Object.keys(all).filter((n) => !o.only || o.only.includes(n));
  const ids: Record<string, string> = {};
  const submit = async (name: string) => {
    const wt = join(work, `candidate-${name}`);
    await git(work, "clone", "--quiet", join(work, "project"), wt);
    cpSync(join(kitDir, "candidates", name), wt, { recursive: true });
    await git(wt, "add", "-A");
    const stdout = await gitRun(["diff", "--cached", "--binary"], { cwd: wt });
    rmSync(wt, { recursive: true, force: true });
    const r = await o.service.submitAttempt(
      {
        run: runId,
        patch_base64: stdout.toString("base64"),
        hypothesis: all[name]?.hypothesis ?? name,
        known_flaws: [],
      },
      by,
    );
    ids[name] = r.attempt;
  };
  const settled = (id: string) =>
    JUDGED_LIFECYCLES.has(String(ledger.attempts.get(id)?.lifecycle ?? ""));
  const timeoutMs = o.timeoutMs ?? 3 * 3_600_000;
  const deadline = Date.now() + timeoutMs;
  const waitFor = async (which: string[]) => {
    while (!which.every((n) => settled(ids[n] as string))) {
      if (Date.now() > deadline)
        throw new Error(
          `the judge did not settle ${which.join(", ")} within ${timeoutMs / 60_000} min`,
        );
      await new Promise((r) => setTimeout(r, o.pollMs ?? 3000));
    }
  };
  try {
    // Each candidate is judged against the seed: the known win last, once the others settled.
    const first = names.filter((n) => n !== "good");
    for (const n of first) await submit(n);
    await waitFor(first);
    if (names.includes("good")) {
      await submit("good");
      await waitFor(["good"]);
    }
  } finally {
    ledger.runs.setStatus(runId, "closed", "the smoke check is done", by);
    for (const r of wereRunning)
      if (ledger.runs.get(r)?.status === "paused")
        ledger.runs.setStatus(r, "running", "resumed after the smoke check", by);
  }

  const results = Object.fromEntries(
    names.map((n) => {
      const c = all[n] as Candidate;
      const id = ids[n] as string;
      const got =
        c.expect === "rejected_v0"
          ? String(ledger.attempts.get(id)?.lifecycle ?? "")
          : String(
              ledger.verdicts.current(id)?.verdict ?? ledger.attempts.get(id)?.lifecycle ?? "",
            );
      const ok = c.accept ? c.accept.includes(got) : got === c.expect;
      return [n, { expect: c.accept ? c.accept.join("|") : c.expect, got, ok, attempt: id }];
    }),
  );
  return smokeReport(kitName, runId, results);
}

/** One candidate's expected and actual result. */
export interface SmokeResult {
  expect: string;
  got: string;
  ok: boolean;
  attempt: string;
}

/** The note of a smoke check that passed although its no-op's timing was unclear. */
export const NOISY_TIMING_NOTE =
  "The timing on this machine is noisy. Results here need more repeats.";

/**
 * The check's report from each candidate's result. Every candidate must get its expected
 * result, with one exception (the owner, 2026-10-21): when the only wrong result is the no-op's
 * `inconclusive` instead of `neutral`, the check passes with a note that the machine's timing
 * is noisy. The judge works there; it could not tell a change that does nothing from the noise.
 * Any other wrong result, alone or beside that one, fails the check.
 */
export function smokeReport(
  kit: string,
  run: string,
  results: Record<string, SmokeResult>,
): RigCheckReport {
  const n = Object.keys(results).length;
  const wrong = Object.entries(results).filter(([, r]) => !r.ok);
  const noisy =
    wrong.length === 1 &&
    wrong[0]?.[0] === "noop" &&
    wrong[0][1].expect === "neutral" &&
    wrong[0][1].got === "inconclusive";
  const detail = {
    kit,
    run,
    candidates: results,
    ...(noisy ? { noisy_timing: true, note: NOISY_TIMING_NOTE } : {}),
  };
  if (noisy)
    return {
      ok: true,
      summary: `smoke on ${kit}: ${n - 1} of ${n} candidates were judged as expected; the no-op came out inconclusive, not neutral (run ${run}). Note: ${NOISY_TIMING_NOTE}`,
      note: NOISY_TIMING_NOTE,
      detail,
    };
  return wrong.length
    ? {
        ok: false,
        summary: `smoke on ${kit}: ${wrong.length} of ${n} candidates were judged otherwise: ${wrong.map(([name, r]) => `${name} expected ${r.expect}, got ${r.got || "nothing"}`).join("; ")}`,
        detail,
      }
    : {
        ok: true,
        summary: `smoke on ${kit}: all ${n} candidates were judged as expected (run ${run})`,
        detail,
      };
}
