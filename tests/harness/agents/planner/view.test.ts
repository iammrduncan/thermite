import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelConfig } from "../../../../src/agents/model/index.ts";
import { renderPlanner } from "../../../../src/agents/roles/index.ts";
import type { TerminalCallLink } from "../../../../src/harness/agents/cli/index.ts";
import {
  PLAN_SPEC,
  PLANNER_SPEC_FILE,
  PlannerCallError,
  plannerInView,
} from "../../../../src/harness/agents/planner/index.ts";
import type { Runner, RunOutcome, RunRequest } from "../../../../src/harness/broker/index.ts";

/**
 * The harness's side of a planner in Pi in its own process (goal 169): its folder and its spec
 * (its credential, its call, its prompt) are its own user's, the harness's group may enter the
 * folder for the terminal host's socket, its console is registered with its Pi view's side and
 * removed at its end, and a host that can't start ends the try with why, in words. The process
 * itself runs only under the real broker: the agents acceptance check runs it.
 */

const model: ModelConfig = {
  baseUrl: "http://127.0.0.1:9/v1",
  model: "planner-model",
  apiKey: "planner-key",
  contextWindow: 0,
  maxTokens: 0,
};

test("a planner whose terminal can't start ends its try with why; its folder and spec were its own", async (t) => {
  // A short path, so the host's socket fits a socket's longest path (the Mac's own temporary
  // folder is too long for it).
  const scratch = mkdtempSync(join("/tmp", "thermite-pv-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const handed: unknown[] = [];
  const runs: RunRequest[] = [];
  const runner: Runner = {
    separated: true,
    run: async (req) => {
      runs.push(req);
      return {
        stdout: '{"level":"error","msg":"the host could not run","error":"listen EACCES"}',
        stderr: "",
        exitCode: 0,
      } as unknown as RunOutcome;
    },
    handOver: async (dir, role, o) => {
      handed.push({ dir, role, o });
    },
    reclaim: async () => {},
    remove: async () => {},
    killRole: async () => 0,
    runPair: async () => {
      throw new Error("not in this test");
    },
  };
  const consoles: string[] = [];
  const link = {
    id: "planner-r-1-3",
    auth: "call.0123",
    title: "The planner",
    console: (c: unknown, piView?: unknown) =>
      consoles.push(c ? (piView ? "with its Pi view" : "without") : "ended"),
  } as unknown as TerminalCallLink;
  const sent = renderPlanner({ program: "pi", context: "{}", mcpServers: [] });
  const err = await plannerInView(
    {
      runner,
      scratchDir: scratch,
      port: 9,
      model,
      link,
      mcpServers: ["docs"],
      kbWrites: ["note"],
      heading: "Thermite's view of the planner in Pi",
      answer: () => undefined,
    },
    sent,
    PLAN_SPEC,
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof PlannerCallError, String(err));
  assert.equal(err.planCause, "provider_error");
  assert.match(err.message, /^the planner could not start in its terminal: /);
  assert.deepEqual(consoles, ["with its Pi view", "ended"]);

  const parent = join(scratch, "lanes", "pi-ask");
  const [dir] = readdirSync(parent);
  assert.ok(dir);
  assert.deepEqual(handed, [
    { dir: join(parent, dir), role: "planner", o: { harnessReads: true } },
  ]);
  const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
  assert.equal(mode(parent), "711", "passed through, never listed");
  const file = join(parent, dir, PLANNER_SPEC_FILE);
  assert.equal(mode(file), "600");
  const spec = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(
    { auth: spec.auth, spec: spec.spec, role: spec.sent.role, servers: spec.mcpServers },
    { auth: "call.0123", spec: "plan", role: "planner", servers: ["docs"] },
  );
  // The host ran as the planner's user, its process in its Pi view, with its route.
  assert.equal(runs.length, 1);
  const [r] = runs;
  assert.equal(r?.role, "planner");
  assert.match(String(r?.stdin), /planner-main\.(ts|js)","call\.json","--view"/);
  assert.equal(r?.env?.THERMITE_MODEL_API_KEY, "planner-key");
  assert.equal(r?.env?.THERMITE_HARNESS_URL, "http://127.0.0.1:9");
});
