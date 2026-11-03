import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { ResearchFolder } from "../../../src/harness/research/folder.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/**
 * The conversations a harness of an earlier build kept in a run's research folder before it
 * scrubbed them (goal 175): scrubbed by shape, in the harness's state and where the agents read
 * them, before an export takes them and as the harness starts; once for each run.
 */

const RUN = "smoke-1";
const NAME = "t-0123456789abcdef-1.md";

/** A conversation an agent's tools printed into, with values shaped like credentials made now. */
function kept() {
  const values = {
    trial: `trial.${randomBytes(32).toString("hex")}`,
    key: ["sk", "proj", randomBytes(12).toString("hex")].join("-"),
    password: `pw${randomBytes(8).toString("hex")}`,
  };
  const text = [
    "# Trial t-0123456789abcdef: the conversation before compaction 1",
    "",
    `THERMITE_TRIAL_AUTH=${values.trial}`,
    `export OPENAI_API_KEY=${values.key}`,
    `git clone https://deploy:${values.password}@git.example.com/kernels.git`,
    "",
    "The zirconium layout wins.",
  ].join("\n");
  return { values, text };
}

const holdsNone = (text: string, values: Record<string, string>) => {
  for (const [what, value] of Object.entries(values)) assert.ok(!text.includes(value), what);
};

test("an earlier harness's kept conversations are scrubbed before an export, and as the harness starts", async () => {
  const env = makeHarnessEnv();
  await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  const { stateDir, scratchDir } = env.service.paths;
  const stateRoot = join(stateDir, "research-work");
  const folder = new ResearchFolder({
    ledger: env.service.ledger,
    outboxDir: env.service.paths.outboxDir,
    scratchRoot: join(scratchDir, "research"),
    stateRoot,
    runner: new LocalRunner(scratchDir),
  });
  env.service.researchFolder = (run) => folder.exportFiles(run);
  // As the earlier harness left them: its own copy in its state, and the agents' copy.
  const old = kept();
  const state = join(stateRoot, RUN, "compactions", NAME);
  const shown = join(folder.root(RUN), "compactions", NAME);
  for (const at of [state, shown]) {
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, old.text);
  }

  // The run's export takes its folder: every copy is scrubbed first.
  const out = await env.service.export("test", { run: RUN });
  const place = readdirSync(join(out.dir, "research", RUN)).find((f) => f.startsWith("folder-"));
  assert.ok(place, "the run's folder is in its export");
  const exported = readFileSync(join(out.dir, "research", RUN, place, "compactions", NAME), "utf8");
  for (const text of [exported, readFileSync(state, "utf8"), readFileSync(shown, "utf8")]) {
    holdsNone(text, old.values);
    assert.match(text, /THERMITE_TRIAL_AUTH=\*\*\*/);
    assert.match(text, /git clone https:\/\/\*\*\*@git\.example\.com/);
    assert.match(text, /The zirconium layout wins\./);
  }
  // Once: the run's conversations are done.
  assert.equal(folder.scrubKept(RUN), 0);

  // Another run's, left by the earlier harness, with no copy in scratch: scrubbed as the harness
  // starts, which scrubs every run's once.
  const other = kept();
  const otherState = join(stateRoot, "older-run-1", "compactions", NAME);
  mkdirSync(join(otherState, ".."), { recursive: true });
  writeFileSync(otherState, other.text);
  assert.equal(folder.scrubKept(), 1);
  holdsNone(readFileSync(otherState, "utf8"), other.values);
  assert.equal(existsSync(join(folder.root("older-run-1"), "compactions", NAME)), false);
  assert.equal(folder.scrubKept(), 0, "a second start scrubs nothing");
});
