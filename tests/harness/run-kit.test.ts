import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ownersKit } from "../../src/harness/service/index.ts";
import { makeJudgeEnv } from "../helpers/judge-env.ts";

/**
 * A running run moved onto a later commit of its kit (goal 233): from the judge's next job, the
 * contract unchanged; refused for a commit that does not come after the run's, or a kit that does
 * not fit the contract.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();

test("the owner moves a running run onto a later commit of its kit, and the judge measures with it", async () => {
  const env = makeJudgeEnv();
  const out = await env.service.applyCommand(env.assign);
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const kitRepo = join(env.root, "kit");
  /** A new commit of the kit, with kit.json changed by `edit`, as a bundle in the inbox. */
  const commit = (name: string, edit: (k: Record<string, unknown>) => void = () => {}) => {
    const k = JSON.parse(readFileSync(join(kitRepo, "kit.json"), "utf8")) as Record<
      string,
      unknown
    >;
    edit(k);
    writeFileSync(join(kitRepo, "kit.json"), JSON.stringify(k, null, 2));
    writeFileSync(join(kitRepo, "notes.txt"), `${name}\n`);
    git(kitRepo, "add", "-A");
    git(kitRepo, "commit", "--quiet", "-m", name);
    git(
      kitRepo,
      "bundle",
      "create",
      "--quiet",
      join(env.paths.inboxDir, "repos", `${name}.bundle`),
      "--all",
    );
    return git(kitRepo, "rev-parse", "HEAD");
  };
  const send = async (name: string, sha: string, preview?: true) =>
    (await env.service.applyCommand(
      env.sign("kit_commit", {
        run: "js-1",
        imports: [
          { kind: "kit_bundle", path: `repos/${name}.bundle`, repo: "js-kit", commit: sha },
        ],
        reason: "the probe runs once a job",
        ...(preview ? { preview } : {}),
      }),
    )) as { accepted: boolean; result: Record<string, unknown> };

  const next = commit("k2");
  const preview = await send("k2", next, true);
  assert.ok(preview.accepted, JSON.stringify(preview));
  assert.match(
    String(preview.result.words),
    new RegExp(
      `would measure with kit js-kit at ${next.slice(0, 12)} \\(now ${env.kitCommit.slice(0, 12)}\\)`,
    ),
  );
  assert.equal(ownersKit(env.ledger, "js-1"), undefined, "nothing changed");
  const moved = await send("k2", next);
  assert.ok(moved.accepted, JSON.stringify(moved));
  assert.equal(ownersKit(env.ledger, "js-1"), next);
  assert.deepEqual(env.ledger.latestEventBody("kit_set", "js-1"), {
    repo: "js-kit",
    commit: next,
    from: env.kitCommit,
    reason: "the probe runs once a job",
  });
  assert.equal(
    env.service.contractFor("js-1").mode === "hill_climb" &&
      env.service.contractFor("js-1").project.kit?.commit,
    env.kitCommit,
    "the contract keeps its own",
  );

  // The same commit again, an older one, and one that does not fit the contract: refused in words.
  assert.match(
    String((await send("k2", next)).result.error),
    /measures with kit commit .* already/,
  );
  assert.match(
    String((await send("k2", env.kitCommit)).result.error),
    /does not come after .*: a run moves only onto a later commit of its kit/,
  );
  const unfit = commit("k3", (k) => {
    k.target = "cuda-gpu";
  });
  assert.match(
    String((await send("k3", unfit)).result.error),
    /the kit at .* does not fit the contract/,
  );
  assert.equal(ownersKit(env.ledger, "js-1"), next, "a refusal moves nothing");
});
