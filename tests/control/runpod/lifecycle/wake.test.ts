import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { issueCommand } from "../../../../src/control/issue/index.ts";
import { saveRunpodRig } from "../../../../src/control/runpod/index.ts";
import type { ControlStore } from "../../../../src/control/store/index.ts";
import { mcpClient, signIn } from "../../../helpers/control-stack.ts";
import {
  exportName,
  exportOnControl,
  harnessApplies,
  pendingOf,
} from "../../../helpers/rig-results.ts";
import { json, setup, TOKENS, text, working } from "./setup.ts";

/**
 * A run assigned or resumed on a stopped pod starts the pod first: over REST, MCP, Start a run's
 * twins and the dashboard, with the refusals that queue nothing.
 */

/** A rig that reported a run, then stopped by the owner once its results left: its pod EXITED. */
async function stoppedRig(s: ReturnType<typeof setup>, o: { spend_limit_usd?: number } = {}) {
  const rig = await working(s, o);
  await s.rigs.stop(rig, "owner:api");
  harnessApplies(s.store, rig, exportName(1));
  exportOnControl(s.store, rig, exportName(1));
  await s.advance();
  assert.equal(s.view(rig).status, "EXITED");
  return rig;
}

/** A run's assignment, as small as the harness's schema takes it. */
const assignment = (run: string) => ({
  run,
  contract: { campaign: "camp", mode: "hill_climb" },
  contract_sha: "b".repeat(64),
  imports: [],
});

/** The owner signed in on the dashboard: a page's form token, and a form post. */
async function signedIn(s: ReturnType<typeof setup>, path: string) {
  const { page, csrfOf, post } = await signIn(s.api, TOKENS.admin);
  const csrf = csrfOf(await page(path));
  return (to: string, form: Record<string, string>) => post(to, { csrf, ...form });
}

const starts = (s: ReturnType<typeof setup>) =>
  s.cloud.actions().filter((a) => a.action === "start");

describe("RunPod rigs: a run assigned or resumed on a stopped pod starts it first", () => {
  test("REST: the pod starts, then the command is queued and waits for it; the answer says so", async () => {
    const seen: string[][] = [];
    const hook = { rig: "", store: undefined as ControlStore | undefined };
    const s = setup({
      // What waits for the rig when RunPod starts the pod: not the new run yet.
      onStart: () => {
        if (hook.store) seen.push(pendingOf(hook.store, hook.rig).map((c) => c.kind));
      },
    });
    const rig = await stoppedRig(s);
    Object.assign(hook, { rig, store: s.store });
    const r = await s.call("/v1/commands", {
      rig,
      kind: "assign_campaign",
      payload: assignment("camp-2"),
    });
    assert.equal(r.status, 201);
    const out = await json<{ id: string; status: string; woke?: string }>(r);
    assert.equal(out.status, "pending");
    assert.equal(
      out.woke,
      `${rig}'s pod was stopped: control started it. The run starts once the pod runs.`,
    );
    assert.deepEqual(s.cloud.actions().at(-1), { action: "start" });
    assert.deepEqual(seen, [[]], "the pod started before the run was queued");
    const pending = pendingOf(s.store, rig);
    assert.ok(pending.some((c) => c.id === out.id && c.kind === "assign_campaign"));
    // The start's own resume of the run its stop paused waits with it.
    assert.ok(pending.some((c) => c.kind === "resume_run"));
    const starting = s.store.rigHistory.list(rig).find((e) => e.step === "runpod_starting");
    assert.match(String(starting?.detail), /asked by owner:api to assign run camp-2/);
    const audit = s.store.auditLog.list(30).find((a) => a.action === "runpod_rig_start");
    assert.deepEqual(audit?.body, { rig, pod: "pod1", note: "to assign run camp-2" });
  });

  test("a resume starts the pod too; a running pod, and other kinds, start nothing", async () => {
    const s = setup();
    const rig = await stoppedRig(s);
    // A pause or an export waits for the pod: it does not start it.
    for (const [kind, payload] of [
      ["pause_run", { run: "run-1", reason: "later" }],
      ["export_now", {}],
    ] as const) {
      const r = await s.call("/v1/commands", { rig, kind, payload });
      assert.equal(r.status, 201);
      assert.deepEqual(Object.keys(await json<object>(r)), ["id", "status"], "no woke");
    }
    assert.deepEqual(starts(s), []);
    const resumed = await s.call("/v1/commands", {
      rig,
      kind: "resume_run",
      payload: { run: "run-1" },
    });
    assert.equal(resumed.status, 201);
    assert.match(
      String((await json<{ woke?: string }>(resumed)).woke),
      /pod was stopped: control started it/,
    );
    assert.equal(s.view(rig).status, "RUNNING");
    // Now it runs: a new run is queued with no start.
    const again = await s.call("/v1/commands", {
      rig,
      kind: "assign_campaign",
      payload: assignment("camp-3"),
    });
    assert.deepEqual(Object.keys(await json<object>(again)), ["id", "status"], "no woke");
    assert.equal(starts(s).length, 1);
  });

  test("a start RunPod refuses, or the spend limit, refuses the command: nothing is queued", async () => {
    const s = setup({ noGpuOnStart: true });
    const rig = await stoppedRig(s);
    const r = await s.call("/v1/commands", {
      rig,
      kind: "resume_run",
      payload: { run: "run-1" },
    });
    assert.equal(r.status, 409);
    const { error } = await json<{ error: string }>(r);
    assert.match(error, /^Not sent: control could not start .*'s pod on RunPod for it\./);
    assert.match(error, /RunPod has no free GPU for pod pod1 now, so the pod stays stopped/);
    assert.deepEqual(pendingOf(s.store, rig), []);
    assert.equal(s.view(rig).status, "EXITED");

    const t = setup();
    const limited = await stoppedRig(t, { spend_limit_usd: 1 });
    const stored = t.store.runpod.rig(limited);
    assert.ok(stored);
    saveRunpodRig(t.store, limited, { ...(stored.state as object), spent_usd: 1.5 }, true);
    const capped = await t.call("/v1/commands", {
      rig: limited,
      kind: "assign_campaign",
      payload: assignment("camp-2"),
    });
    assert.equal(capped.status, 409);
    assert.match((await json<{ error: string }>(capped)).error, /at its spend limit/);
    assert.deepEqual(pendingOf(t.store, limited), []);
    assert.deepEqual(starts(t), []);
  });

  test("a bad payload starts nothing; a stop under way refuses until it ends", async () => {
    const s = setup();
    const rig = await stoppedRig(s);
    const bad = await s.call("/v1/commands", {
      rig,
      kind: "assign_campaign",
      payload: { run: "camp-2" },
    });
    assert.equal(bad.status, 400);
    assert.match((await json<{ error: string }>(bad)).error, /bad assign_campaign payload/);
    assert.deepEqual(starts(s), []);

    const t = setup();
    const other = await working(t);
    await t.rigs.stop(other, "owner:api");
    const during = await t.call("/v1/commands", {
      rig: other,
      kind: "assign_campaign",
      payload: assignment("camp-2"),
    });
    assert.equal(during.status, 409);
    assert.match(
      (await json<{ error: string }>(during)).error,
      /a stop of .*'s pod is under way: wait until it has stopped, then start the run again/,
    );
    assert.ok(!pendingOf(t.store, other).some((c) => c.kind === "assign_campaign"));
  });

  test("MCP: the owner's issue_command starts the pod; an operator's is refused and starts nothing", async () => {
    const s = setup();
    const rig = await stoppedRig(s);
    const operator = await mcpClient(s.api, TOKENS.operator);
    const refused = await operator.callTool({
      name: "issue_command",
      arguments: { rig, kind: "resume_run", payload: { run: "run-1" } },
    });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /pod on RunPod is stopped, and only the owner can start it/);
    assert.deepEqual(starts(s), []);
    assert.deepEqual(pendingOf(s.store, rig), []);
    const owner = await mcpClient(s.api, TOKENS.admin);
    const r = JSON.parse(
      text(
        await owner.callTool({
          name: "issue_command",
          arguments: { rig, kind: "assign_campaign", payload: assignment("camp-2") },
        }),
      ),
    ) as { id: string; woke?: string };
    assert.match(String(r.woke), /pod was stopped: control started it/);
    assert.ok(pendingOf(s.store, rig).some((c) => c.id === r.id));
    assert.match(
      String(s.store.rigHistory.list(rig).find((e) => e.step === "runpod_starting")?.detail),
      /asked by owner:mcp to assign run camp-2/,
    );
  });

  test("Start a run's twins: REST and the owner's start_run start the stopped pod first; an operator's is refused", async () => {
    const s = setup();
    const rig = await stoppedRig(s);
    // The campaign was assigned before, over the API: Start a run assigns it again.
    issueCommand(s.store, s.control.privateKeyPem, {
      rig,
      kind: "assign_campaign",
      payload: assignment("camp-1"),
      issuedBy: "owner:api",
    });
    const before = pendingOf(s.store, rig).length;
    const operator = await mcpClient(s.api, TOKENS.operator);
    const refused = await operator.callTool({
      name: "start_run",
      arguments: { campaign: "camp", rig, agents: false },
    });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /pod on RunPod is stopped, and only the owner can start it/);
    assert.deepEqual(starts(s), []);
    assert.equal(pendingOf(s.store, rig).length, before, "nothing was queued");
    const r = await s.call("/v1/campaigns/camp/runs", { rig, agents: false });
    assert.equal(r.status, 201);
    const out = await json<{ run: string; command: string; woke?: string }>(r);
    assert.equal(
      out.woke,
      `${rig}'s pod was stopped: control started it. The run starts once the pod runs.`,
    );
    assert.deepEqual(starts(s), [{ action: "start" }]);
    assert.ok(pendingOf(s.store, rig).some((c) => c.id === out.command));
    assert.match(
      String(s.store.rigHistory.list(rig).find((e) => e.step === "runpod_starting")?.detail),
      new RegExp(`asked by owner:api to assign run ${out.run}`),
    );

    // Another stopped pod: the owner's start_run starts it the same way.
    const t = setup();
    const other = await stoppedRig(t);
    issueCommand(t.store, t.control.privateKeyPem, {
      rig: other,
      kind: "assign_campaign",
      payload: assignment("camp-1"),
      issuedBy: "owner:api",
    });
    const owner = await mcpClient(t.api, TOKENS.admin);
    const o = JSON.parse(
      text(
        await owner.callTool({
          name: "start_run",
          arguments: { campaign: "camp", rig: other, agents: false },
        }),
      ),
    ) as { run: string; woke?: string };
    assert.match(String(o.woke), /pod was stopped: control started it/);
    assert.match(
      String(t.store.rigHistory.list(other).find((e) => e.step === "runpod_starting")?.detail),
      new RegExp(`asked by owner:mcp to assign run ${o.run}`),
    );
  });

  test("the dashboard: Start a run and a resume start the stopped pod first, and the page says so", async () => {
    const s = setup();
    const rig = await stoppedRig(s);
    // The campaign was assigned before, over the API: Start a run assigns it again.
    issueCommand(s.store, s.control.privateKeyPem, {
      rig,
      kind: "assign_campaign",
      payload: assignment("camp-1"),
      issuedBy: "owner:api",
    });
    const post = await signedIn(s, "/ui/campaigns/camp");
    const started = await post("/ui/campaigns/camp/runs", { rig, agents: "off" });
    assert.equal(started.status, 303);
    assert.match(
      decodeURIComponent(started.headers.get("location") ?? ""),
      /pod was stopped: control started it\. The run starts once the pod runs\./,
    );
    assert.deepEqual(starts(s), [{ action: "start" }]);
    assert.ok(pendingOf(s.store, rig).some((c) => c.kind === "assign_campaign"));

    // Another stopped pod: a resume from the dashboard starts it the same way.
    const t = setup();
    const other = await stoppedRig(t);
    const tPost = await signedIn(t, `/ui/rigs/${other}`);
    const resumed = await tPost("/ui/commands", { rig: other, kind: "resume_run", run: "run-1" });
    assert.equal(resumed.status, 303);
    assert.match(
      decodeURIComponent(resumed.headers.get("location") ?? ""),
      /pod was stopped: control started it\. The run starts once the pod runs\. Sent to rp-\w+ at \d\d:\d\d UTC\./,
    );
    assert.equal(t.view(other).status, "RUNNING");
  });
});
