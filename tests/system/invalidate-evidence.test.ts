import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { serve } from "@hono/node-server";
import { outcome } from "../../src/control/ui/operator/index.ts";
import { attemptHref, runHref } from "../../src/control/ui/urls.ts";
import { rigView } from "../../src/control/views/index.ts";
import { ADMIN, controlStack, mcpClient, signIn } from "../helpers/control-stack.ts";
import type { HarnessEnv } from "../helpers/harness-env.ts";
import { type Answer, RUN, twoChampions } from "../helpers/withdraw-env.ts";

/**
 * Withdrawing evidence end to end (goal 174): the owner's preview and confirmation from the
 * dashboard's attempt page, REST, MCP and the command line, through control and the supervisor's
 * relay to the rig's harness; then what it reached in control's views, the run's History, the
 * attempt's page and the knowledge base.
 */

type Stack = ReturnType<typeof controlStack<HarnessEnv>>;

/** The run as control's views have it, and one of its attempts. */
function runOf(stack: Stack) {
  const run = rigView(stack.store, "rig-a")?.runs.find((r) => r.id === RUN);
  assert.ok(run, "control has the run");
  return run;
}

/** What control shows once the withdrawal of `a` reached it: views, History and the KB. */
function reachedControl(stack: Stack, a: string, b: string, d: string) {
  const run = runOf(stack);
  const [inv] = run.invalidations;
  assert.ok(inv);
  assert.deepEqual(
    [inv.kind, inv.subject, inv.attempts, inv.verdicts, inv.champions, inv.champion],
    ["attempt", a, [a, b, d], 3, [2, 3], { from: 3, to: 1, attempt: null }],
  );
  assert.match(inv.by, /^control:owner:/);
  for (const id of [a, b, d]) {
    const view = run.attempts.find((x) => x.id === id);
    assert.ok(view);
    assert.equal(outcome(run, view).word, "Withdrawn", id);
  }
  assert.deepEqual(
    run.champion.filter((c) => !c.reopened).map((c) => c.seq),
    [1],
  );
  const jobs = rigView(stack.store, "rig-a")?.judge.jobs.filter((j) => j.attempt === d) ?? [];
  assert.deepEqual(
    jobs.map((j) => j.state),
    ["cancelled"],
  );
  const [item] = stack.store
    .kb()
    .search("", ["smoke-matmul"], { kinds: ["attempt"] })
    .filter((x) => x.ref === a);
  assert.match(String(item?.body), /Verdict: invalidated \(withdrawn: /);
}

describe("withdrawing evidence through control (goal 174)", () => {
  test("the dashboard: the attempt's page previews what it reaches, confirms it, and shows what it reached", async () => {
    const { env, a, b, d } = await twoChampions();
    const stack = controlStack({ env });
    await stack.relay();
    const s = await signIn(stack.control);
    const path = attemptHref(runOf(stack), a.attempt);
    const page = await s.page(path);
    assert.match(page, /Withdraw its evidence…/);
    const form = {
      csrf: s.csrfOf(page),
      rig: "rig-a",
      kind: "invalidate_evidence",
      run: RUN,
      attempt: a.attempt,
      subject: "attempt",
      back: path,
    };
    // A reason is asked for first.
    const blank = await s.post("/ui/commands", { ...form, reason: " " });
    assert.equal(blank.status, 400);
    assert.match(await blank.text(), /write why you withdraw it first/);
    const reason = "the card's clock ran slow";
    assert.equal((await s.post("/ui/commands", { ...form, reason })).status, 303);
    await stack.relay(3);
    // The rig's preview, and the confirmation that says what it decides.
    const seen = await s.page(path);
    assert.match(seen, /What withdrawing it decides/);
    assert.match(seen, /and the 2 attempts built on it .* are withdrawn for good/);
    assert.match(seen, /moves back from #3 to #1, the starting point/);
    assert.match(seen, /Withdraw the evidence/);
    // Nothing changed yet.
    assert.equal(runOf(stack).invalidations.length, 0);
    const sha = /name="reach" value="([0-9a-f]{64})"/.exec(seen)?.[1];
    assert.ok(sha);
    const sent = await s.post("/ui/commands", { ...form, reason, reach: sha });
    assert.equal(sent.status, 303);
    await stack.relay(3);
    reachedControl(stack, a.attempt, b.attempt, d.attempt);
    // The attempt's page says what it reached, when, by whom and why.
    const after = await s.page(path);
    assert.match(after, /Its evidence was withdrawn/);
    assert.match(after, /by you\. Why: the card's clock ran slow/);
    assert.match(after, /The run's champion moved back from #3 to #1/);
    assert.doesNotMatch(after, /Withdraw its evidence…/);
    // The run's History tells it.
    const history = await s.page(runHref(runOf(stack), "history"));
    assert.match(history, /You withdrew attempt/);
    assert.match(history, /champion moved back from #3 to #1/);
  });

  test("REST and MCP: a preview, then the confirmation that names its sha", async () => {
    const { env, a, b, d, jobA } = await twoChampions();
    const stack = controlStack({ env });
    await stack.relay();
    // REST: a confirmation without a preview's sha is refused before it is signed.
    const bare = await stack.api("POST", "/v1/commands", {
      kind: "invalidate_evidence",
      payload: { run: RUN, attempt: a.attempt, reason: "r" },
    });
    assert.equal(bare.status, 400);
    assert.match(await bare.text(), /reach: send a preview first/);
    const issued = await stack.api("POST", "/v1/commands", {
      kind: "invalidate_evidence",
      payload: { run: RUN, job: jobA, reason: "throttled", preview: true },
    });
    assert.equal(issued.status, 201);
    const { id } = (await issued.json()) as { id: string };
    await stack.relay(3);
    const status = (await (await stack.api("GET", `/v1/commands/${id}`)).json()) as {
      outcome: { source: string; result: Answer };
    };
    assert.equal(status.outcome.source, "harness");
    assert.equal(status.outcome.result.reach.for_good, false);
    assert.match(status.outcome.result.words.join(" "), /measurements of judge job/);

    // Champion #3 is published: an export carries its patch out of the rig.
    await env.service.export("owner", {});
    await stack.relay();
    assert.equal(runOf(stack).published?.seq, 3);
    // MCP, with the owner's token: the same preview of the attempt, then the confirmation.
    const mcp = await mcpClient(stack.control, ADMIN);
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(
        ((await mcp.callTool({ name, arguments: args })).content as { text: string }[])[0]?.text ??
          "{}",
      ) as Record<string, unknown>;
    const asked = await call("issue_command", {
      kind: "invalidate_evidence",
      payload: { run: RUN, attempt: a.attempt, reason: "slow card", preview: true },
    });
    await stack.relay(3);
    const previewed = (await call("command_status", { id: asked.id })) as {
      outcome: { result: Answer };
    };
    const sha = previewed.outcome.result.sha;
    assert.deepEqual(
      previewed.outcome.result.reach.champions.map((c) => [c.seq, c.published]),
      [
        [2, false],
        [3, true],
      ],
    );
    assert.match(previewed.outcome.result.words.join(" "), /Champion #3 was published already/);
    await call("issue_command", {
      kind: "invalidate_evidence",
      payload: { run: RUN, attempt: a.attempt, reason: "slow card", reach: sha },
    });
    await stack.relay(3);
    reachedControl(stack, a.attempt, b.attempt, d.attempt);
    // The withdrawn champion is no longer the run's published one: none stands but the seed.
    assert.equal(runOf(stack).published, null);
  });

  test("the command line prints what it reaches, and withdraws it with --yes", async () => {
    const { env, a, b, d } = await twoChampions();
    const stack = controlStack({ env });
    await stack.relay();
    const server = serve({ fetch: stack.control.fetch, port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tokenFile = join(mkdtempSync(join(tmpdir(), "thermite-cli-")), "token");
    writeFileSync(tokenFile, ADMIN);
    const cli = join(import.meta.dirname, "../../src/cli/thermite/main.ts");
    let done = false;
    const child = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [
          "--experimental-strip-types",
          "--no-warnings",
          cli,
          "invalidate",
          "--control",
          url,
          "--token-file",
          tokenFile,
          "--run",
          RUN,
          "--attempt",
          a.attempt,
          "--reason",
          "the timer was wrong",
          "--yes",
        ],
        (err, stdout, stderr) => {
          done = true;
          resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr });
        },
      );
    });
    // The supervisor's relay, meanwhile: each command reaches the rig, and its answer control.
    while (!done) {
      await stack.relay();
      await new Promise((r) => setTimeout(r, 300));
    }
    const out = await child;
    server.close();
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /What withdrawing it reaches:/);
    assert.match(out.stdout, /are withdrawn for good/);
    assert.match(out.stdout, new RegExp(`${b.attempt} .*-> {2}withdrawn for good`));
    assert.match(out.stdout, /Withdrawn: invalidation \d+ on the rig\./);
    await stack.relay();
    reachedControl(stack, a.attempt, b.attempt, d.attempt);
  });
});
