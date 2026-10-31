import assert from "node:assert/strict";
import { test } from "node:test";
import { experimentsTab, plannerTab } from "../../../src/control/ui/campaigns/queue/index.ts";
import { rigView } from "../../../src/control/views/index.ts";
import { controlStore, ingestReport } from "../../helpers/control-store.ts";

/** A rig whose run "r-1" reported these events (subject: the run), in order. */
async function rigWith(events: [string, string, Record<string, unknown>][]) {
  const store = controlStore();
  const all: [string, string, Record<string, unknown>][] = [
    ["harness", "run_created", { campaign: "c", mode: "hill_climb", version: 1, agents: true }],
    ...events,
  ];
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: 0,
    next: all.length,
    generated_at: new Date().toISOString(),
    events: all.map(([actor, kind, body], i) => ({
      id: i + 1,
      at: new Date(Date.parse("2026-10-20T01:00:00Z") + i * 60_000).toISOString(),
      actor,
      kind,
      subject: "r-1",
      body,
    })),
    summary: {},
  });
  const u = rigView(store, "rig-a", { staleAfterMs: 600_000 });
  assert.ok(u);
  const r = u.runs.find((x) => x.id === "r-1");
  assert.ok(r);
  return { u, r };
}

test("the queue view keeps the order the events give it, and where each experiment went", async () => {
  const { r } = await rigWith([
    [
      "planner",
      "experiment_added",
      {
        id: "x-1",
        title: "fuse the dequantize step",
        family: "dequant-fusion",
        why: "it won on long",
        by: "planner",
      },
    ],
    [
      "supervisor",
      "experiment_added",
      { id: "x-2", title: "vector loads", family: "memory-layout", by: "teacher", position: 0 },
    ],
    [
      "control:owner:ui",
      "experiment_added",
      { id: "x-3", title: "warp shuffle", by: "owner", position: "end" },
    ],
    [
      "harness",
      "experiment_added",
      { id: "x-4", title: "unit test at 3 sizes", by: "lane-2", state: "proposed" },
    ],
    ["control:owner:ui", "experiment_moved", { id: "x-3", position: "top", by: "owner" }],
    ["planner", "experiment_assigned", { id: "x-2", lane: "lane-1", trial: "t-1", by: "planner" }],
    ["planner", "experiment_dropped", { id: "x-1", by: "planner", why: "a rule avoids it" }],
    [
      "harness",
      "experiment_finished",
      { id: "x-2", lane: "lane-1", trial: "t-1", result: "no_attempt" },
    ],
    ["control:owner:ui", "experiment_accepted", { id: "x-4", by: "owner" }],
    ["planner", "experiment_added", { id: "x-5", title: "read the survey", by: "planner" }],
    ["planner", "experiment_assigned", { id: "x-5", lane: "lane-2", trial: "t-2", by: "planner" }],
    [
      "harness",
      "experiment_finished",
      { id: "x-5", lane: "lane-2", trial: "t-2", result: "finished" },
    ],
    [
      "planner",
      "planner_handout",
      {
        round: 9,
        assignments: [
          { lane: "lane-1", experiment: "x-2", why: "it has the fusion code in context" },
        ],
        notes: "kept fusion on lane-1",
      },
    ],
    [
      "control:owner:ui",
      "directive",
      { id: 7, body: { kind: "avoid", family: "gemv-tiling", rationale: "measured slower twice" } },
    ],
    [
      "control:owner:ui",
      "directive",
      {
        id: 8,
        body: { kind: "try", match: "anything with vector loads", rationale: "the guide says so" },
      },
    ],
    ["control:owner:ui", "directive_dropped", { id: 7 }],
    // A rule for a new direction (goal 066), then the planner designs it.
    [
      "control:owner:ui",
      "directive",
      { id: 9, body: { kind: "mandate", family: "split-k", rationale: "won elsewhere" } },
    ],
    [
      "planner:planner",
      "family_added",
      { family: "split-k", description: "split the reduction over k", for_rules: [9] },
    ],
  ]);
  const up = r.queue
    .filter((x) => x.state === "queued")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  assert.deepEqual(
    up.map((x) => x.id),
    ["x-3", "x-4"],
  );
  assert.equal(r.queue.find((x) => x.id === "x-2")?.state, "done");
  assert.equal(r.queue.find((x) => x.id === "x-1")?.dropped_why, "a rule avoids it");
  assert.equal(r.handouts.length, 1);
  assert.deepEqual(
    r.rules.map((x) => [x.id, x.legacy]),
    [
      [8, true],
      [9, false],
    ],
  );
  // The run's directions: each experiment's, and the one the planner designed for rule 9.
  assert.deepEqual(r.directions, [
    {
      name: "dequant-fusion",
      description: null,
      tried: 0,
      wins: 0,
      queued: 0,
      lanes: [],
      rules: [],
      to_design: false,
    },
    {
      name: "memory-layout",
      description: null,
      tried: 1,
      wins: 0,
      queued: 0,
      lanes: [],
      rules: [],
      to_design: false,
    },
    {
      name: "split-k",
      description: "split the reduction over k",
      tried: 0,
      wins: 0,
      queued: 0,
      lanes: [],
      rules: [{ id: 9, kind: "mandate" }],
      to_design: false,
    },
  ]);
  // The tabs: up next in order with who added each; tried with its result; rules with who set them.
  const cmd = (f: { kind: string; label: string }) =>
    `<form data-kind="${f.kind}">${f.label}</form>`;
  const { u } = await rigWith([]);
  const exp = experimentsTab({
    u,
    r,
    now: Date.parse("2026-10-20T02:00:00Z"),
    csrf: "x",
    back: "/b",
    cmd,
    families: ["dequant-fusion"],
  });
  assert.match(exp, /<span class="qn">1<\/span><div class="qmain"><div class="qt">warp shuffle/);
  assert.match(
    exp,
    /<span class="qn">2<\/span><div class="qmain"><div class="qt">unit test at 3 sizes/,
  );
  assert.match(exp, /lane-2&#39;s idea|lane-2's idea/);
  assert.match(exp, /dropped by planner: a rule avoids it/);
  assert.match(exp, /<span class="qres none">no attempt<\/span>/);
  // A research trial's experiment ends "finished": its result is its research, not a missing attempt.
  assert.match(exp, /<span class="qres done">finished: its research is in the run's notes<\/span>/);
  assert.match(exp, /data-qf="done">Research finished <span class="n">1<\/span>/);
  assert.match(exp, /data-kind="queue_move"/);
  const plan = plannerTab({
    u,
    r,
    now: Date.parse("2026-10-20T02:00:00Z"),
    csrf: "x",
    back: "/b",
    cmd,
    model: "m",
    figures: "",
    propagate: "",
  });
  // An old rule in words shows as such, with Remove: it converts at the planner's next round,
  // on its own. A rule names its direction as :name:, which code keeps.
  assert.match(
    plan,
    /<div class="qrule legacy"><span class="qkind words">words<\/span><div><b>Try “anything with vector loads”<\/b>/,
  );
  assert.match(
    plan,
    /An old rule in words, from before rules named directions\. It converts at the planner's next round: round 10\. The planner names its direction, and code keeps the new rule\. Until then, only the planner's model reads it\.<\/div><\/div><form data-kind="drop_directive">Remove<\/form><\/div>/,
  );
  assert.doesNotMatch(plan, /Name a direction|data-fill|fix=/);
  assert.match(
    plan,
    /<b>Always <span class="dtok"><i>:<\/i>split-k<i>:<\/i><\/span><\/b>[\s\S]*?Code keeps it at every hand-out\. One lane works on it at every hand-out\.<\/div>/,
  );
  assert.doesNotMatch(plan, /gemv-tiling/);
  // The run's directions, each with its figures and the rules that name it.
  assert.deepEqual(
    [...plan.matchAll(/<div class="dlrow[^"]*"[^>]*>([\s\S]*?)<\/span><\/div>/g)].map((m) =>
      (m[1] ?? "").replace(/<[^>]+>/g, ""),
    ),
    [":memory-layout:1 tried", ":dequant-fusion:not tried yet", ":split-k:not tried yet · always"],
  );
  assert.match(
    plan,
    /<b>Round 9<\/b>: <ul><li><b>lane-1<\/b>: vector loads <span class="muted">· it has the fusion code in context/,
  );
  // The planner's own changes to the queue, newest first, each with its reason; the owner's
  // changes and the hand-outs' assignments are not repeated as changes.
  assert.deepEqual(
    [
      ...plan.matchAll(
        /<div class="qhand"><span class="tm">[^<]*<\/span><div>([\s\S]*?)<\/div><\/div>/g,
      ),
    ]
      .map((m) => (m[1] ?? "").replace(/<[^>]+>/g, ""))
      .filter((s) => !s.startsWith("Round")),
    [
      "Designed the direction :split-k: for rule 9 · split the reduction over k",
      "Added “read the survey” to the queue",
      "Dropped “fuse the dequantize step” · a rule avoids it",
      "Added “fuse the dequantize step” to the queue · it won on long",
    ],
  );
  // No Add a rule: rules come from Tell the planner, whose box offers the run's directions.
  assert.doesNotMatch(plan, /Add a rule|Add the rule|name="direction"|name="match"/);
  assert.match(plan, /<h3>Tell the planner<\/h3>/);
  const dirs = JSON.parse(
    (/data-dirs="([^"]*)"/.exec(plan)?.[1] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
  ) as { name: string; rules: string[] }[];
  assert.deepEqual(
    dirs.map((d) => [d.name, d.rules]),
    [
      ["memory-layout", []],
      ["dequant-fusion", []],
      ["split-k", ["always"]],
    ],
  );
});

test("a message to the planner waits for its round, then shows its answer: the rules it made and the directions it designed", async () => {
  const { u, r } = await rigWith([
    [
      "planner",
      "experiment_added",
      { id: "x-1", title: "wider loads", family: "vector-loads", by: "planner" },
    ],
    ["control:owner:ui", "agent_message", { id: 1, to: "planner", text: "stop :vector loads:" }],
    ["control:owner:ui", "agent_message", { id: 2, to: "planner", text: "never touch the timer" }],
    ["control:owner:ui", "agent_message", { id: 3, to: "all", text: "keep it simple" }],
    [
      "control:owner:ui",
      "agent_message",
      {
        id: 4,
        to: "planner",
        text: "try :split k: first, then :a direction whose name is far too long to be one:",
      },
    ],
    // Round 3 reads messages 1 to 3. A read from an older harness names no round.
    ["planner", "agent_message_read", { message: 1, by: "planner", round: 3 }],
    ["planner", "agent_message_read", { message: 2, by: "planner", round: 3 }],
    ["planner", "agent_message_read", { message: 3, by: "planner" }],
    ["planner", "agent_message_read", { message: 3, by: "lane-1", trial: "t-1" }],
    [
      "planner:planner",
      "family_added",
      { family: "timer-code", description: "any change to the timing code" },
    ],
    [
      "planner",
      "directive",
      {
        id: 5,
        body: { kind: "avoid", family: "vector-loads", rationale: "you asked", from_message: 1 },
      },
    ],
    [
      "planner",
      "directive",
      {
        id: 6,
        body: { kind: "avoid", family: "timer-code", rationale: "you asked", from_message: 2 },
      },
    ],
    // A rule the planner made from message 3 that the owner had removed: left out.
    [
      "planner",
      "directives_left_out",
      {
        rules: [{ kind: "avoid", family: "gemv-tiling", rationale: "r", from_message: 3 }],
        why: "the owner removed these rules",
      },
    ],
    ["planner", "planner_handout", { round: 3, assignments: [], notes: "kept the loads off" }],
    ["control:owner:ui", "directive_dropped", { id: 5 }],
  ]);
  // The view: each message's rules (in force or not), those left out, and the round that read it.
  assert.deepEqual(
    r.messages.map((m) => [
      m.id,
      m.rules.map((x) => [x.id, x.kind, x.family, x.by]),
      m.left_out.map((x) => [x.kind, x.family]),
      m.reads.map((x) => [x.by, x.round]),
    ]),
    [
      [1, [[5, "avoid", "vector-loads", "planner"]], [], [["planner", 3]]],
      [2, [[6, "avoid", "timer-code", "planner"]], [], [["planner", 3]]],
      [
        3,
        [],
        [["avoid", "gemv-tiling"]],
        [
          ["planner", null],
          ["lane-1", null],
        ],
      ],
      [4, [], [], []],
    ],
  );
  const plan = plannerTab({
    u,
    r,
    now: Date.parse("2026-10-20T02:00:00Z"),
    csrf: "x",
    back: "/b",
    cmd: (f: { kind: string; label: string }) => `<form data-kind="${f.kind}">${f.label}</form>`,
    model: "m",
    figures: "",
    propagate: "",
  });
  /** Each message in Tell the planner, newest first, and what follows it, without markup. */
  const turns = [
    ...plan.matchAll(
      /<div class="qturn" data-msg="(\d+)">([\s\S]*?)<\/div><\/div>(?=<div class="qturn"|<\/div>)/g,
    ),
  ].map((m) => [
    Number(m[1]),
    (m[2] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ]);
  assert.deepEqual(
    turns.map(([id]) => id),
    [4, 3, 2, 1],
  );
  const said = Object.fromEntries(turns) as Record<number, string>;
  // Not read yet: it waits for the next round.
  assert.match(
    said[4] ?? "",
    /try : split-k : first, then :a direction whose name is far too long to be one: Sent\. The planner reads it when it next gives out work: round 4\. Its answer shows here\./,
  );
  // A direction the run doesn't have is dashed; a :name: too long to be one is marked, with why.
  assert.match(plan, /<span class="dtok new"><i>:<\/i>split-k<i>:<\/i><\/span>/);
  assert.match(
    plan,
    /<span class="dtok bad" title="[^"]*is too long for a direction[^"]*">:a direction whose name is far too long to be one:<\/span>/,
  );
  // To everyone working, read without a round: the hand-out after the read gives it.
  assert.match(
    said[3] ?? "",
    /to everyone working keep it simple planner round 3 · \d\d:\d\d Read your message\. Left out a rule you removed: Avoid : gemv-tiling : You removed this rule\. Only your own redirect sets it again\. Its notes for the round: kept the loads off/,
  );
  // A rule for a direction the model designed in that round, and one removed since.
  assert.match(
    said[2] ?? "",
    /Read your message\. Made 1 rule: Avoid : timer-code : new direction · you asked The run had none for it, so the planner designed it: any change to the timing code\. No lane gets it\./,
  );
  assert.match(
    said[1] ?? "",
    /Read your message\. Made 1 rule: Avoid : vector-loads : · you asked It is no longer in force\./,
  );
  // What the planner did lists the reads too.
  assert.match(plan, /Read your message “stop :vector loads:” in round 3: made 1 rule from it/);
  assert.match(plan, /It reads your message when it next gives out work: round 4\./);
});

test("an old rule in words says what its conversion waits for: the planner's round, the planner, a model", async () => {
  const { u, r } = await rigWith([
    [
      "control:owner:ui",
      "directive",
      { id: 4, body: { kind: "avoid", match: "anything slow", rationale: "old" } },
    ],
  ]);
  const note = (o: { u?: typeof u; r?: typeof r; noModel?: boolean }) =>
    /<div class="xs warn"[^>]*>(?:<svg[\s\S]*?<\/svg>)? ([^<]*)<\/div>/.exec(
      plannerTab({
        u: o.u ?? u,
        r: o.r ?? r,
        now: Date.parse("2026-10-20T02:00:00Z"),
        csrf: "x",
        back: "/b",
        cmd: (f: { kind: string; label: string }) =>
          `<form data-kind="${f.kind}">${f.label}</form>`,
        model: "m",
        figures: "",
        propagate: "",
        noModel: o.noModel,
      }),
    )?.[1];
  assert.equal(
    note({}),
    "An old rule in words, from before rules named directions. It converts at the planner's next round: round 1. The planner names its direction, and code keeps the new rule. Until then, only the planner's model reads it.",
  );
  assert.equal(
    note({ noModel: true }),
    "An old rule in words, from before rules named directions. Code can't keep it. It converts at the planner's next round with a model, and this rig has no model for the planner now. Give the planner a model in Edit rig, or remove it.",
  );
  assert.equal(
    note({ u: { ...u, settings: { ...u.settings, planner: false } as typeof u.settings } }),
    "An old rule in words, from before rules named directions. Code can't keep it. It converts at the planner's next round, and the planner is off on this rig. Switch the planner on in Edit rig, or remove it.",
  );
  assert.equal(
    note({ r: { ...r, mode: "research" } }),
    "An old rule in words, from before rules named directions. Code can't keep it, and a research run's planner converts no rule in words. Remove it. To steer the run, send a rule for a task kind, or tell the planner.",
  );
});

test("an old rule in words the planner converted shows as a normal rule, with the words it replaced", async () => {
  const { u, r } = await rigWith([
    [
      "planner",
      "experiment_added",
      { id: "x-1", title: "wider loads", family: "vector-loads", by: "planner" },
    ],
    ["control:owner:ui", "agent_message", { id: 1, to: "planner", text: "loads first" }],
    // Before rules named directions: the owner's rule in words, and the planner's from a message.
    [
      "control:owner:ui",
      "directive",
      {
        id: 4,
        body: { kind: "avoid", match: "anything that uses shared memory", rationale: "slow" },
      },
    ],
    [
      "planner",
      "directive",
      {
        id: 5,
        body: { kind: "try", match: "vector loads", rationale: "you asked", from_message: 1 },
      },
    ],
    ["planner", "agent_message_read", { message: 1, by: "planner", round: 1 }],
    // Round 2 converts both: one to a direction it designs for it, one to a direction it has.
    [
      "planner:planner",
      "family_added",
      {
        family: "shared-memory",
        description: "kernels that stage data in shared memory",
        for_rules: [4],
      },
    ],
    [
      "control:owner:ui",
      "directive",
      {
        id: 10,
        body: {
          kind: "avoid",
          family: "shared-memory",
          rationale: "slow",
          converted_from: { rule: 4, words: "anything that uses shared memory" },
        },
      },
    ],
    [
      "planner",
      "directive_converted",
      {
        id: 4,
        to: 10,
        kind: "avoid",
        family: "shared-memory",
        words: "anything that uses shared memory",
      },
    ],
    [
      "planner",
      "directive",
      {
        id: 11,
        body: {
          kind: "try",
          family: "vector-loads",
          rationale: "you asked",
          from_message: 1,
          converted_from: { rule: 5, words: "vector loads" },
        },
      },
    ],
    [
      "planner",
      "directive_converted",
      { id: 5, to: 11, kind: "try", family: "vector-loads", words: "vector loads" },
    ],
    ["planner", "planner_handout", { round: 2, assignments: [], notes: "the planner's plan" }],
  ]);
  // The new rules in place of the old ones, by their authors; no rule in words is left.
  assert.deepEqual(
    r.rules.map((x) => [x.id, x.author, x.legacy, x.body.family]),
    [
      [10, "control:owner:ui", false, "shared-memory"],
      [11, "planner", false, "vector-loads"],
    ],
  );
  assert.equal(r.directives, 2);
  // The planner's answer to the message names the rule in force now, once.
  assert.deepEqual(
    r.messages[0]?.rules.map((x) => [x.id, x.kind, x.family]),
    [[11, "try", "vector-loads"]],
  );
  const plan = plannerTab({
    u,
    r,
    now: Date.parse("2026-10-20T02:00:00Z"),
    csrf: "x",
    back: "/b",
    cmd: (f: { kind: string; label: string }) => `<form data-kind="${f.kind}">${f.label}</form>`,
    model: "m",
    figures: "",
    propagate: "",
  });
  assert.doesNotMatch(plan, /class="qrule legacy"/);
  assert.match(
    plan,
    /<div class="qrule"><span class="qkind avoid">avoid<\/span><div><b>Avoid <span class="dtok"><i>:<\/i>shared-memory<i>:<\/i><\/span><\/b> <span class="muted small">· set by<\/span> <span class="qsrc you">you<\/span>[\s\S]*?<div class="muted small">slow<\/div><div class="muted xs">converted from: “anything that uses shared memory”<\/div><div class="xs ok"[^>]*>[\s\S]*?Code keeps it at every hand-out\. No lane gets it\.<\/div>/,
  );
  assert.match(
    plan,
    /<b>Try <span class="dtok"><i>:<\/i>vector-loads<i>:<\/i><\/span><\/b> <span class="muted small">· set by<\/span> <span class="qsrc planner">planner<\/span>[\s\S]*?\(from your message: “loads first”\)<\/span><\/div><div class="muted xs">converted from: “vector loads”<\/div>/,
  );
  // What the planner did: each conversion once, and the direction it designed for the old rule.
  const did = [
    ...plan.matchAll(
      /<div class="qhand"><span class="tm">[^<]*<\/span><div>([\s\S]*?)<\/div><\/div>/g,
    ),
  ]
    .map((m) => (m[1] ?? "").replace(/<[^>]+>/g, ""))
    .filter((s) => !s.startsWith("Round"));
  assert.deepEqual(did, [
    "Converted the old rule in words “vector loads” (rule 5) to Try :vector-loads: (rule 11)",
    "Converted the old rule in words “anything that uses shared memory” (rule 4) to Avoid :shared-memory: (rule 10)",
    "Designed the direction :shared-memory: for rule 4 · kernels that stage data in shared memory",
    "Read your message “loads first” in round 1: made 1 rule from it",
    "Set the rule try “vector loads” · you asked (from your message: “loads first”)",
    "Added “wider loads” to the queue",
  ]);
});

test("a change that became the champion no longer waits: only pending promotions keep their why", async () => {
  const store = controlStore();
  const events: [string, string, string, Record<string, unknown>][] = [
    ["harness", "run_created", "r-1", { campaign: "c", mode: "hill_climb", version: 1 }],
    [
      "harness",
      "promotion_pending",
      "a-1",
      { run: "r-1", expected_seq: 1, reason: "the auditor asked for the owner" },
    ],
    [
      "harness",
      "promotion_pending",
      "a-2",
      { run: "r-1", expected_seq: 2, reason: "the auditor asked for the owner" },
    ],
    ["control:owner:ui", "champion_promoted", "r-1", { seq: 2, attempt: "a-1", commit: "c1" }],
  ];
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: "ledger-a",
    cursor: 0,
    next: events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([actor, kind, subject, body], i) => ({
      id: i + 1,
      at: new Date(Date.parse("2026-10-20T01:00:00Z") + i * 60_000).toISOString(),
      actor,
      kind,
      subject,
      body,
    })),
    summary: {},
  });
  const r = rigView(store, "rig-a", { staleAfterMs: 600_000 })?.runs.find((x) => x.id === "r-1");
  assert.ok(r);
  assert.deepEqual(r.pending_promotions, ["a-2"]);
  assert.deepEqual(Object.keys(r.promotion_waits), ["a-2"]);
});
