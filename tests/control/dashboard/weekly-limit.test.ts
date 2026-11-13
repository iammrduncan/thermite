import assert from "node:assert/strict";
import { test } from "node:test";
import { WEEKLY_MODEL_STEP, WEEKLY_WAIT_STEP } from "../../../src/control/rigs/index.ts";
import { mcpClient } from "../../helpers/control-stack.ts";
import { stack } from "./stack.ts";

/**
 * A rig whose subscription's weekly limit is full, under Needs you (goal 169; the owner's decision
 * of 2026-11-01, from a mockup): what happened, what waits and until when, and two choices, each
 * a step in the rig's history and an entry in the audit log: wait for the reset, which leaves the
 * rig's page saying so; or give the rig's workers another model, as Edit rig does, which ends its
 * runs' waits. The harness marks the wait `weekly` (src/harness/agents/scheduler/provider.ts).
 */

test("a weekly limit under Needs you: what waits until when, wait for the reset, or another model for new trials", async () => {
  const s = await stack();
  await s.env.service.applyCommand(s.env.assign);
  const run = (s.env.assign.envelope.payload as { run: string }).run;
  await s.relay();
  /** A trial of the run met a weekly window that resets at `until`. */
  const meet = async (until: string) => {
    s.env.ledger.appendEvent("scheduler", "agents_wait_for_limit", run, {
      until,
      trial: "t-0123456789abcdef",
      reason: `Claude Code's usage window is full until ${until}, more than a day away`,
      weekly: true,
    });
    await s.relay();
  };
  const reset = new Date(Date.now() + 2 * 86_400_000 + 4 * 3_600_000).toISOString();
  const at = `${reset.slice(0, 16).replace("T", " ")} UTC`;
  await meet(reset);

  let needs = (await (await s.get("/ui")).text()) as string;
  assert.match(
    needs,
    /rig-a waits for its subscription&#39;s weekly limit|rig-a waits for its subscription's weekly limit/,
  );
  assert.ok(needs.includes(`waits until ${at}`), "the chip says until when");
  assert.match(
    needs,
    /<dt>What happened<\/dt><dd>The subscription reached its weekly usage limit\. A trial of <b><a [^>]*>/,
  );
  assert.match(
    needs,
    /ended, and its experiment went back to the top of the queue\. Thermite never answers the program's own menu at the limit\./,
  );
  assert.ok(
    needs.includes(
      `New trials on rig-a, its planner and its advisors, until the limit resets: <b>${at}</b> (in 2 days`,
    ),
  );
  assert.match(needs, /Thermite never switches a model by itself\./);
  // No other provider yet: the card says to add one first.
  assert.match(needs, /Add a provider first/);
  assert.match(needs, /action="\/ui\/rigs\/rig-a\/weekly-limit\/wait"/);
  // REST and MCP give the same state.
  const view = (await (
    await s.control.request("/v1/rigs/rig-a/view", {
      headers: { authorization: "Bearer admin-token-abcdef" },
    })
  ).json()) as { weekly_limit: { until: string; chose: unknown; runs: { run: string }[] } };
  assert.equal(view.weekly_limit.until, reset);
  assert.equal(view.weekly_limit.chose, null);
  assert.deepEqual(
    view.weekly_limit.runs.map((r) => r.run),
    [run],
  );
  const mcp = await mcpClient(s.control);
  const listed = JSON.parse(
    ((await mcp.callTool({ name: "list_rigs", arguments: {} })) as { content: { text: string }[] })
      .content[0]?.text ?? "[]",
  ) as { rig: string; weekly_limit: { until: string } | null }[];
  assert.equal(listed.find((r) => r.rig === "rig-a")?.weekly_limit?.until, reset);
  await mcp.close();
  // The rig's page says so, and that Needs you asks.
  let rig = (await (await s.get("/ui/rigs/rig-a")).text()) as string;
  assert.ok(rig.includes(`waits for its subscription's weekly limit to reset, ${at}`));
  assert.match(rig, /Needs you asks what to do meanwhile\./);

  // Wait for the reset: the card leaves Needs you, the rig's page keeps the note.
  const csrf = s.csrfFrom(needs);
  const waited = await s.post("/ui/rigs/rig-a/weekly-limit/wait", { csrf });
  assert.ok(
    decodeURIComponent(waited.headers.get("location") ?? "").includes(
      `rig-a waits for the reset, ${at}.`,
    ),
  );
  needs = (await (await s.get("/ui")).text()) as string;
  assert.doesNotMatch(needs, /waits for its subscription's weekly limit/);
  rig = (await (await s.get("/ui/rigs/rig-a")).text()) as string;
  assert.ok(rig.includes(`waits for its subscription's weekly limit to reset, ${at}`));
  assert.doesNotMatch(rig, /Needs you asks what to do meanwhile/);
  assert.equal((await s.store.rigHistory.latest("rig-a", [WEEKLY_WAIT_STEP], 1))[0]?.detail, reset);
  assert.ok((await s.store.auditLog.list(50)).some((a) => a.action === "weekly_limit_wait"));

  // The limit met again later: the card is back. Another model, for new trials.
  await new Promise((r) => setTimeout(r, 5));
  await meet(reset);
  needs = (await (await s.get("/ui")).text()) as string;
  assert.match(needs, /waits for its subscription's weekly limit/);
  await s.store.modelProviders.put({
    name: "zen",
    type: "opencode",
    base_url: "https://opencode.ai/zen/v1",
  });
  await s.store.modelProviders.setModels("zen", [{ id: "deepseek-v4.1-flash-free" }]);
  needs = (await (await s.get("/ui")).text()) as string;
  assert.match(needs, /<summary class="btn primary">Give rig-a another model…<\/summary>/);
  assert.match(
    needs,
    /<option value="zen\|deepseek-v4\.1-flash-free">zen · deepseek-v4\.1-flash-free<\/option>/,
  );
  // Nothing chosen: refused in words.
  const none = await s.post("/ui/rigs/rig-a/weekly-limit/model", { csrf, model: "" });
  assert.match(
    decodeURIComponent(none.headers.get("location") ?? ""),
    /Choose a provider's model first\./,
  );
  const given = await s.post("/ui/rigs/rig-a/weekly-limit/model", {
    csrf,
    model: "zen|deepseek-v4.1-flash-free",
  });
  assert.ok(
    decodeURIComponent(given.headers.get("location") ?? "").includes(
      `rig-a takes zen · deepseek-v4.1-flash-free for new trials within a minute; Edit rig shows it. Written to the audit log. The subscription's weekly limit still resets ${at}.`,
    ),
  );
  assert.deepEqual((await s.store.agentModels.byRig())["rig-a"], {
    provider: "zen",
    model: "deepseek-v4.1-flash-free",
    harness: "opencode",
  });
  const audit = (await s.store.auditLog.list(50)).map((a) => a.action);
  assert.ok(audit.includes("weekly_limit_model") && audit.includes("rig_model_given"));
  assert.equal(
    (await s.store.rigHistory.latest("rig-a", [WEEKLY_MODEL_STEP], 1))[0]?.detail,
    "zen · deepseek-v4.1-flash-free",
  );
  needs = (await (await s.get("/ui")).text()) as string;
  assert.doesNotMatch(needs, /waits for its subscription's weekly limit/);
  // The run's wait ends on the rig: its end_wait, signed as the owner's, then the rig's report.
  const ended = await s.store.commands.latest("rig-a", "end_wait", 5);
  assert.equal(ended.length, 1);
  assert.equal(ended[0]?.issued_by, "owner:ui");
  await s.relay();
  rig = (await (await s.get("/ui/rigs/rig-a")).text()) as string;
  assert.doesNotMatch(rig, /waits for its subscription's weekly limit to reset/);

  // A weekly wait whose reset has passed shows nowhere.
  await meet(new Date(Date.now() - 60_000).toISOString());
  needs = (await (await s.get("/ui")).text()) as string;
  assert.doesNotMatch(needs, /waits for its subscription's weekly limit/);
});
