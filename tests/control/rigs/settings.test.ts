import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  programModeField,
  quietField,
  rigSettingsChange,
} from "../../../src/control/rigs/settings.ts";
import {
  ADMIN,
  controlOnly,
  controlStack,
  mcpClient,
  RIG_TOKEN,
} from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * The rest of Edit rig over REST and MCP (goal 029): POST /v1/rigs/<rig>/settings and
 * set_rig_settings change a rig's parts, workers at a time, limits, promotion rule and GPU split
 * as Save changes does, sending only what differs from what the rig reports as one signed
 * rig_settings command; GET of the same route and rig_settings read what the rig reports.
 */

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "read-token-abcdef",
  rigs: {
    "rig-a": RIG_TOKEN,
    "rig-b": "rig-token-bbbbbb",
    "rig-old": "rig-token-oooooo",
  },
};

/** What a harness reports by default (Edit rig's settings). */
const DEFAULTS = {
  judge: true,
  workers: true,
  lanes: 1,
  planner: true,
  auditor: true,
  teachers: true,
  review: true,
  exports: true,
  trial_minutes: 20,
  max_turns: null,
  quiet_minutes: null,
  program_mode: "headless",
  promotion: "owner_approval",
  judge_gpus: null,
} as const;

/**
 * Control with three rigs reporting: rig-a with a set of 4 GPUs (2 for the judge), rig-b with no
 * GPU set, and rig-old, whose older harness reports no settings.
 */
async function stack() {
  const { store, control: api } = controlOnly({
    tokens: TOKENS,
    options: { staleAfterMs: 600_000 },
  });
  const report = async (rig: string, summary: Record<string, unknown>) =>
    await ingestReport(store, {
      rig,
      ledger_id: `ledger-${rig}`,
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary,
    });
  await report("rig-a", { settings: DEFAULTS, gpu_split: { set: 4, judge: 2 } });
  await report("rig-b", { settings: DEFAULTS });
  await report("rig-old", {});
  const call =
    (token: string) =>
    async (method: "GET" | "POST", body?: unknown, rig = "rig-a") => {
      const r = await api.request(`/v1/rigs/${rig}/settings`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
  const owner = call(TOKENS.admin);
  const set = (body: unknown, rig = "rig-a") => owner("POST", body, rig);
  /** The rig_settings commands waiting for a rig, oldest first. */
  const sent = (rig = "rig-a") =>
    store.commands
      .pending(rig)
      .filter((c) => c.envelope.kind === "rig_settings")
      .map((c) => ({ payload: c.envelope.payload, by: c.envelope.issued_by, id: c.envelope.id }));
  return { store, api, call, owner, set, sent, report };
}

const text = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]?.text ?? "{}") as Record<
    string,
    unknown
  >;
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

/** Each field, a value that differs from DEFAULTS, and its setting's count in Edit rig's words. */
const FIELDS: [string, unknown][] = [
  ["judge", false],
  ["workers", false],
  ["lanes", 4],
  ["planner", false],
  ["teachers", false],
  ["auditor", false],
  ["review", false],
  ["exports", false],
  ["trial_minutes", 45],
  ["max_turns", 120],
  ["quiet_minutes", 30],
  ["program_mode", "terminal"],
  ["promotion", "auto"],
  ["judge_gpus", 3],
];

describe("Edit rig's settings over REST and MCP", () => {
  test("the change: only what differs, in the payload's order, with Edit rig's refusals", () => {
    const now = { ...DEFAULTS, promotion: "owner_approval" as const };
    const split = { set: 4, judge: 2 };
    assert.deepEqual(rigSettingsChange("rig-a", now, split, { ...now, judge_gpus: 2 }), {
      change: undefined,
    });
    const out = rigSettingsChange("rig-a", now, split, {
      promotion: "auto",
      lanes: 3,
      planner: false,
      max_turns: null,
    });
    assert.ok("change" in out);
    // In the payload's order, as Edit rig has always sent them.
    assert.deepEqual(Object.keys(out.change ?? {}), ["lanes", "planner", "promotion"]);
    // An empty One trial lasts is no limit (goal 079): a change only while the rig has one.
    assert.deepEqual(rigSettingsChange("rig-a", now, split, { trial_minutes: null }), {
      change: { trial_minutes: null },
    });
    assert.deepEqual(
      rigSettingsChange("rig-a", { ...now, trial_minutes: null }, split, { trial_minutes: null }),
      { change: undefined },
    );
    // null for judge_gpus: the rig's default again, only when the rig keeps a share of its own.
    assert.deepEqual(rigSettingsChange("rig-a", now, split, { judge_gpus: null }), {
      change: undefined,
    });
    assert.deepEqual(
      rigSettingsChange(
        "rig-a",
        { ...now, judge_gpus: 3 },
        { set: 4, judge: 3 },
        {
          judge_gpus: null,
        },
      ),
      { change: { judge_gpus: null } },
    );
    for (const judge of [0, 4, 2.5])
      assert.deepEqual(rigSettingsChange("rig-a", now, split, { judge_gpus: judge }), {
        error: "Not saved: with 4 GPUs the judge takes 1 to 3 of them, and the agents at most 8.",
      });
    // Twelve cards: the agents take at most 8, so the judge at least 4.
    assert.deepEqual(rigSettingsChange("rig-a", now, { set: 12, judge: 6 }, { judge_gpus: 3 }), {
      error: "Not saved: with 12 GPUs the judge takes 1 to 8 of them, and the agents at most 8.",
    });
    assert.deepEqual(rigSettingsChange("rig-b", now, null, { judge_gpus: 2 }), {
      error: "Not saved: rig-b has no GPU set to split: its GPUs are set where it is deployed.",
    });
    assert.deepEqual(rigSettingsChange("rig-b", now, null, { judge_gpus: null }), {
      change: undefined,
    });
    assert.deepEqual(rigSettingsChange("rig-a", now, split, { lanes: 17 }), {
      error: "Not saved: lanes: at most 16: a rig has users for lanes 1 to 16 only",
    });
  });

  test("REST: each field sent alone, signed for owner:api, with Edit rig's words", async () => {
    const s = await stack();
    for (const [field, value] of FIELDS) {
      const r = await s.set({ [field]: value });
      assert.equal(r.status, 200, field);
      const restarts = field === "judge_gpus";
      assert.deepEqual(
        { ...r.body, id: typeof r.body.id },
        {
          rig: "rig-a",
          id: "string",
          sent: { [field]: value },
          restarts,
          said: `Control sent 1 setting to rig-a. The rig takes the change in less than one minute.${restarts ? " A new split restarts the rig's harness to regroup the GPUs: running trials and judge jobs start again." : ""}`,
        },
        field,
      );
      const last = s.sent().at(-1);
      assert.deepEqual(last?.payload, { [field]: value }, field);
      assert.equal(last?.by, "owner:api");
      assert.equal(last?.id, r.body.id);
    }
    // No limit on a trial's length (goal 079) or its turns, and the rig's default split, are null.
    await s.report("rig-a", {
      settings: { ...DEFAULTS, trial_minutes: 30, max_turns: 50, judge_gpus: 3 },
      gpu_split: { set: 4, judge: 3 },
    });
    const none = await s.set({ trial_minutes: null, max_turns: null, judge_gpus: null });
    assert.deepEqual(none.body.sent, { trial_minutes: null, max_turns: null, judge_gpus: null });
    assert.match(String(none.body.said), /^Control sent 3 settings to rig-a\./);
    // Several fields: those that differ.
    const many = await s.set({
      ...DEFAULTS,
      trial_minutes: 30,
      judge_gpus: 3,
      max_turns: 50,
      lanes: 2,
      auditor: false,
    });
    assert.deepEqual(many.body.sent, { auditor: false, lanes: 2 });
    assert.equal(many.body.restarts, false);
  });

  test("REST: nothing differing sends nothing", async () => {
    const s = await stack();
    const before = s.store.commands.list(100).length;
    for (const body of [
      {},
      { ...DEFAULTS, judge_gpus: 2 },
      { lanes: 1, promotion: "owner_approval" },
    ]) {
      const r = await s.set(body);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        rig: "rig-a",
        id: null,
        sent: {},
        restarts: false,
        said: "Nothing changed.",
      });
    }
    assert.equal(s.store.commands.list(100).length, before, "no command");
  });

  test("REST: every refusal in words, in the audit log, and nothing sent", async () => {
    const s = await stack();
    const cases: [unknown, string, number, string][] = [
      [{ lanes: 2 }, "rig-9", 404, "no rig rig-9"],
      [
        { lanes: 2 },
        "rig-old",
        409,
        "rig-old's harness is older: it does not report its settings and cannot take them. They work after its next roll.",
      ],
      [
        { judge_gpus: 4 },
        "rig-a",
        400,
        "Not saved: with 4 GPUs the judge takes 1 to 3 of them, and the agents at most 8.",
      ],
      [
        { judge_gpus: 1 },
        "rig-b",
        400,
        "Not saved: rig-b has no GPU set to split: its GPUs are set where it is deployed.",
      ],
      [
        { lanes: 17 },
        "rig-a",
        400,
        "Not saved: lanes: at most 16: a rig has users for lanes 1 to 16 only",
      ],
    ];
    for (const [body, rig, status, error] of cases) {
      const r = await s.set(body, rig);
      assert.deepEqual({ status: r.status, body: r.body }, { status, body: { error } }, error);
    }
    // A value the rig_settings command refuses, in its words.
    for (const [body, field] of [
      [{ lanes: 0 }, "lanes"],
      [{ trial_minutes: 0 }, "trial_minutes"],
      [{ trial_minutes: 1_441 }, "trial_minutes"],
      [{ max_turns: 0 }, "max_turns"],
    ] as const) {
      const r = await s.set(body);
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), new RegExp(`^Not saved: ${field}: `), field);
    }
    // A body that is not the payload's fields: another field, a wrong type, a wrong rule.
    for (const body of [
      { gpus: 4 },
      { judge: "yes" },
      { promotion: "sometimes" },
      { program_mode: "tui" },
      "lanes",
    ]) {
      const r = await s.set(body);
      assert.equal(r.status, 400);
      assert.match(String(r.body.error), /^bad request: /);
    }
    // A rig control refuses for its version gets no command.
    s.store.refusals.set("rig-b", "Its protocol is older than control's oldest.");
    assert.deepEqual(await s.set({ lanes: 2 }, "rig-b"), {
      status: 409,
      body: {
        error: "Control sends no commands to rig-b. Its protocol is older than control's oldest.",
      },
    });
    assert.deepEqual(s.sent(), [], "a refusal sends nothing");
    assert.deepEqual(s.sent("rig-b"), []);
    const refused = s.store.auditLog
      .page(100, { action: "refused" })
      .entries.filter((e) => JSON.stringify(e.body).includes("/settings"));
    assert.ok(refused.length >= cases.length + 8);
    assert.ok(refused.every((e) => e.actor === "owner:api"));
    // The owner's token only, as every REST route.
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read]) {
      const r = await s.call(token)("POST", { lanes: 2 });
      assert.equal(r.status, 401);
    }
  });

  test("REST: GET reads the settings the rig reports and its GPU split", async () => {
    const s = await stack();
    assert.deepEqual((await s.owner("GET")).body, {
      rig: "rig-a",
      settings: DEFAULTS,
      gpu_split: { set: 4, judge: 2 },
    });
    assert.deepEqual((await s.owner("GET", undefined, "rig-b")).body, {
      rig: "rig-b",
      settings: DEFAULTS,
      gpu_split: null,
    });
    assert.deepEqual((await s.owner("GET", undefined, "rig-old")).body, {
      rig: "rig-old",
      settings: null,
      gpu_split: null,
    });
    const none = await s.owner("GET", undefined, "rig-9");
    assert.deepEqual(none, { status: 404, body: { error: "no rig rig-9" } });
    assert.equal((await s.call(TOKENS.read)("GET")).status, 401);
  });

  test("MCP: the owner sets each field; refusals are errors in the same words", async () => {
    const s = await stack();
    const owner = await mcpClient(s.api, TOKENS.admin);
    const call = (args: Record<string, unknown>) =>
      owner.callTool({ name: "set_rig_settings", arguments: { rig: "rig-a", ...args } });
    for (const [field, value] of FIELDS) {
      const r = text(await call({ [field]: value }));
      assert.deepEqual(r.sent, { [field]: value }, field);
      assert.equal(r.restarts, field === "judge_gpus");
      assert.match(String(r.said), /^Control sent 1 setting to rig-a\./);
      assert.deepEqual(s.sent().at(-1), { payload: { [field]: value }, by: "owner:mcp", id: r.id });
    }
    assert.deepEqual(text(await call({ lanes: 1, judge_gpus: 2 })), {
      rig: "rig-a",
      id: null,
      sent: {},
      restarts: false,
      said: "Nothing changed.",
    });
    const errors: [Record<string, unknown>, string][] = [
      [{ rig: "rig-9", lanes: 2 }, "no rig rig-9"],
      [
        { rig: "rig-old", lanes: 2 },
        "rig-old's harness is older: it does not report its settings and cannot take them. They work after its next roll.",
      ],
      [
        { judge_gpus: 4 },
        "Not saved: with 4 GPUs the judge takes 1 to 3 of them, and the agents at most 8.",
      ],
      [
        { rig: "rig-b", judge_gpus: 1 },
        "Not saved: rig-b has no GPU set to split: its GPUs are set where it is deployed.",
      ],
      [{ lanes: 17 }, "Not saved: lanes: at most 16: a rig has users for lanes 1 to 16 only"],
    ];
    const before = s.sent().length;
    for (const [args, error] of errors) {
      const r = await call(args);
      assert.ok(isError(r), error);
      assert.deepEqual(text(r), { error });
    }
    const zero = await call({ trial_minutes: 0 });
    assert.ok(isError(zero));
    assert.match(String(text(zero).error), /^Not saved: trial_minutes: /);
    // A wrong type is not the tool's input.
    const wrong = await call({ judge: "yes" });
    assert.ok(isError(wrong));
    assert.match(JSON.stringify(wrong), /Input validation error/);
    assert.equal(s.sent().length, before, "a refusal sends nothing");
    const audit = s.store.auditLog.page(200, { mcp: true }).entries;
    assert.ok(audit.some((e) => e.action === "mcp:set_rig_settings"));
    assert.ok(
      audit.some(
        (e) =>
          e.action === "refused" &&
          e.actor === "owner:mcp" &&
          JSON.stringify(e.body).includes("mcp:set_rig_settings"),
      ),
    );
    // The read.
    assert.deepEqual(
      text(await owner.callTool({ name: "rig_settings", arguments: { rig: "rig-a" } })),
      {
        rig: "rig-a",
        settings: DEFAULTS,
        gpu_split: { set: 4, judge: 2 },
      },
    );
    const none = await owner.callTool({ name: "rig_settings", arguments: { rig: "rig-9" } });
    assert.ok(isError(none));
    assert.deepEqual(text(none), { error: "no rig rig-9" });
    await owner.close();
  });

  test("MCP tokens: an operator changes all but the promotion rule and the GPU split; the agent and the reader change nothing", async () => {
    const s = await stack();
    const operator = await mcpClient(s.api, TOKENS.operator);
    const agent = await mcpClient(s.api, TOKENS.agent);
    const reader = await mcpClient(s.api, TOKENS.read);
    const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
    const op = await names(operator);
    assert.ok(op.includes("set_rig_settings") && op.includes("rig_settings"));
    const ag = await names(agent);
    assert.ok(!ag.includes("set_rig_settings") && !ag.includes("rig_settings"));
    const rd = await names(reader);
    assert.ok(!rd.includes("set_rig_settings") && rd.includes("rig_settings"));
    const call = (c: Client, args: Record<string, unknown>) =>
      c.callTool({ name: "set_rig_settings", arguments: { rig: "rig-a", ...args } });

    // The parts, workers at a time and the limits: as the owner, signed owner:operator.
    const parts = text(
      await call(operator, { planner: false, lanes: 3, trial_minutes: 30, max_turns: 80 }),
    );
    assert.deepEqual(parts.sent, { planner: false, lanes: 3, trial_minutes: 30, max_turns: 80 });
    assert.equal(s.sent().at(-1)?.by, "owner:operator");
    const before = s.sent().length;
    // The promotion rule and the GPU split are the owner's.
    for (const [args, error] of [
      [
        { promotion: "auto" },
        "Only the owner's token changes a rig's promotion rule: leave out promotion.",
      ],
      [
        { judge_gpus: 3 },
        "Only the owner's token changes a rig's GPU split: leave out judge_gpus.",
      ],
      [
        { lanes: 2, promotion: "auto" },
        "Only the owner's token changes a rig's promotion rule: leave out promotion.",
      ],
    ] as const) {
      const r = await call(operator, args);
      assert.ok(isError(r));
      assert.deepEqual(text(r), { error });
    }
    assert.equal(s.sent().length, before, "nothing sent");
    // The same rule and split as the rig has are no change, so an operator may send them back.
    const same = text(await call(operator, { ...DEFAULTS, judge_gpus: 2, workers: false }));
    assert.deepEqual(same.sent, { workers: false });
    // The agent's and the reader's tokens have no such tool.
    for (const c of [agent, reader]) {
      const r = await call(c, { lanes: 2 });
      assert.ok(isError(r));
      assert.match(JSON.stringify(r), /Tool set_rig_settings not found/);
    }
    assert.match(
      JSON.stringify(await agent.callTool({ name: "rig_settings", arguments: { rig: "rig-a" } })),
      /Tool rig_settings not found/,
    );
    assert.deepEqual(
      text(await reader.callTool({ name: "rig_settings", arguments: { rig: "rig-b" } })).gpu_split,
      null,
    );
    // rig_settings stays out of issue_command for every token.
    const issued = await operator.callTool({
      name: "issue_command",
      arguments: { rig: "rig-a", kind: "rig_settings", payload: { lanes: 2 } },
    });
    assert.ok(isError(issued));
    await Promise.all([operator.close(), agent.close(), reader.close()]);
  });

  test("the rig's harness takes the change: an operator's lanes and the owner's promotion rule, then reports them", async () => {
    const { env, store, control, relay, api } = controlStack({
      env: makeJudgeEnv({ promotion: "owner_approval" }),
      tokens: { operator: TOKENS.operator },
    });
    env.service.gpuSplit = { set: 4, judge: 2 };
    await relay();
    const operator = await mcpClient(control, TOKENS.operator);
    const r = text(
      await operator.callTool({
        name: "set_rig_settings",
        arguments: { rig: "rig-a", lanes: 3, review: false, program_mode: "headless" },
      }),
    );
    assert.deepEqual(r.sent, { lanes: 3, review: false, program_mode: "headless" });
    await relay();
    // The harness's owner-only gate passes the operator, who acts for the owner.
    assert.equal(env.service.settings.get().lanes, 3);
    assert.equal(env.service.settings.get().review, false);
    // Its next trials run their program headless, not in its own terminal (goal 169).
    assert.equal(env.service.settings.get().program_mode, "headless");
    assert.equal(
      store.commands.list(10).find((c) => c.id === r.id)?.status,
      "delivered",
      "applied",
    );
    // The rig reports its new settings at its next report: the same lanes are then no change.
    await relay();
    const owner = (method: "GET" | "POST", body?: unknown) =>
      api(method, "/v1/rigs/rig-a/settings", body);
    const promote = (await (await owner("POST", { promotion: "auto", lanes: 3 })).json()) as {
      sent: unknown;
    };
    assert.deepEqual(promote.sent, { promotion: "auto" });
    await relay();
    assert.equal(env.service.settings.get().promotion, "auto");
    await relay();
    const read = (await (await owner("GET")).json()) as {
      settings: Record<string, unknown>;
      gpu_split: unknown;
    };
    assert.deepEqual(
      {
        lanes: read.settings.lanes,
        review: read.settings.review,
        promotion: read.settings.promotion,
      },
      { lanes: 3, review: false, promotion: "auto" },
    );
    assert.deepEqual(read.gpu_split, { set: 4, judge: 2 });
    await operator.close();
  });
});

test("Edit rig's quiet field is off on a rig whose harness can't take it (goal 143)", () => {
  const older = quietField({ summary: { settings: { lanes: 1, max_turns: null } } }, null);
  assert.match(older, /placeholder="update the rig first"[^>]* disabled>/);
  const newer = quietField({ summary: { settings: { lanes: 1, quiet_minutes: null } } }, null);
  assert.match(newer, /value="" placeholder="never"/);
  assert.doesNotMatch(newer, /disabled/);
  assert.match(quietField({ summary: { settings: { quiet_minutes: 20 } } }, 20), /value="20"/);
});

test("Edit rig's choice of how agent programs run is off on a rig whose harness can't take it (goal 169)", () => {
  const older = programModeField({ summary: { settings: { lanes: 1 } } }, "headless");
  assert.match(
    older,
    /<select name="program_mode" disabled><option>update the rig first<\/option>/,
  );
  const newer = programModeField(
    { summary: { settings: { lanes: 1, program_mode: "headless" } } },
    "headless",
  );
  assert.doesNotMatch(newer, /disabled/);
  // The default first.
  assert.match(
    newer,
    /<option value="terminal">In their own terminal<\/option><option value="headless" selected>Headless<\/option>/,
  );
  assert.match(
    programModeField({ summary: { settings: { program_mode: "terminal" } } }, "terminal"),
    /<option value="terminal" selected>In their own terminal<\/option>/,
  );
});
