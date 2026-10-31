import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseContract } from "../../../src/core/contract.ts";
import { LiveLog } from "../../../src/core/live.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { sameAnswer } from "../../../src/harness/agents/repeats.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { REPEAT_STREAK, TrialWatch, tellStreak } from "../../../src/harness/service/watch.ts";
import { researchFixture } from "../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/**
 * Goal 143: what each open trial is doing, whatever its harness: when it last sent a line, its
 * open model call, and a streak of the same calls with the same answers.
 */

const T = "trial:t-1";
let clock = Date.parse("2026-10-25T19:04:13Z");
/** A line of the trial, a second after the one before. */
const line = (kind: "tool" | "result" | "text" | "status", text: string) => {
  clock += 1000;
  return { source: T, kind, text, at: new Date(clock).toISOString() };
};
const call = (w: TrialWatch, tool: string, answer: string) => [
  w.saw(line("tool", tool)),
  w.saw(line("result", answer)),
];

describe("the harness watches each open trial (goal 143)", () => {
  test("each line of a trial counts; another source's doesn't", () => {
    const w = new TrialWatch();
    assert.equal(w.facts("t-1").last_line_at, null);
    const l = line("text", "thinking about it");
    w.saw(l);
    w.saw({ source: "planner", kind: "text", text: "x", at: "2026-10-25T23:00:00.000Z" });
    w.saw({ source: "trial:t-2", kind: "status", text: "x", at: "2026-10-25T23:00:00.000Z" });
    assert.equal(w.facts("t-1").last_line_at, l.at);
    assert.equal(w.facts("t-1").repeating, null);
  });

  test(`a streak is said at its ${REPEAT_STREAK}th repeated call, once, and when it ends`, () => {
    const w = new TrialWatch();
    const news: unknown[] = [];
    // First answers: not repeats.
    news.push(...call(w, 'search_files {"text":"blockage"}', "search_files (3 ms): 4 lines"));
    news.push(...call(w, 'read_file {"path":"a.md"}', "read_file (0 ms): the file"));
    for (let i = 0; i < 30; i++) {
      // The time in an answer line differs; the answer is the same.
      news.push(...call(w, 'search_files {"text":"blockage"}', `search_files (${i} ms): 4 lines`));
      news.push(...call(w, 'read_file {"path":"a.md"}', "read_file (1 ms): the file"));
    }
    const said = news.filter(Boolean);
    assert.deepEqual(said, [
      {
        kind: "repeating",
        trial: "t-1",
        count: REPEAT_STREAK,
        different: 2,
        calls: [
          { call: 'search_files {"text":"blockage"}', times: 5 },
          { call: 'read_file {"path":"a.md"}', times: 5 },
        ],
      },
    ]);
    const f = w.facts("t-1").repeating;
    assert.equal(f?.count, 60);
    assert.equal(f?.different, 2);
    // A new call ends the streak, and says so.
    assert.deepEqual(call(w, 'read_file {"path":"b.md"}', "read_file (0 ms): another file"), [
      undefined,
      { kind: "stopped_repeating", trial: "t-1", count: 60 },
    ]);
    assert.equal(w.facts("t-1").repeating, null);
  });

  test("a changed answer is no repeat; a Pi worker's short answer is one", () => {
    const w = new TrialWatch();
    call(w, "progress {}", "progress (1 ms): 12 claims");
    call(w, "progress {}", "progress (1 ms): 13 claims");
    assert.equal(w.facts("t-1").repeating, null);
    for (let i = 0; i < REPEAT_STREAK; i++)
      call(w, "progress {}", `progress (0 ms): ${sameAnswer("2026-10-25T19:04:13Z", 1)}`);
    assert.equal(w.facts("t-1").repeating?.count, REPEAT_STREAK);
  });

  test("a streak short of the threshold says nothing, at its end either", () => {
    const w = new TrialWatch();
    call(w, "progress {}", "progress (1 ms): 12 claims");
    for (let i = 0; i < REPEAT_STREAK - 1; i++)
      assert.deepEqual(call(w, "progress {}", "progress (1 ms): 12 claims"), [
        undefined,
        undefined,
      ]);
    assert.equal(w.facts("t-1").repeating, null);
    assert.deepEqual(call(w, "progress {}", "progress (1 ms): 13 claims"), [undefined, undefined]);
  });

  test("after a compaction, asking again is not a repeat", () => {
    const w = new TrialWatch();
    call(w, "progress {}", "progress (1 ms): 12 claims");
    for (let i = 0; i < REPEAT_STREAK; i++) call(w, "progress {}", "progress (1 ms): 12 claims");
    assert.ok(w.facts("t-1").repeating);
    w.compacted("t-1");
    assert.equal(w.facts("t-1").repeating, null);
    call(w, "progress {}", "progress (1 ms): 12 claims");
    assert.equal(w.facts("t-1").repeating, null);
  });

  test("a Pi worker's open model call, until it ends; an ended trial is forgotten", () => {
    const w = new TrialWatch();
    const r = { since: "2026-10-25T15:09:00.000Z", text: 0, thinking: 1840, tool_args: 1_200_000 };
    w.reply("t-1", r, "2026-10-25T19:32:00.000Z");
    assert.deepEqual(w.facts("t-1").reply, { ...r, reported_at: "2026-10-25T19:32:00.000Z" });
    w.reply("t-1", null, "2026-10-25T19:32:30.000Z");
    assert.equal(w.facts("t-1").reply, null);
    w.saw(line("text", "x"));
    w.forget("t-1");
    assert.deepEqual(w.facts("t-1"), { last_line_at: null, reply: null, repeating: null });
  });

  test("tellStreak: a trial_repeating event and a line in Live when it starts; a line when it ends", () => {
    const events: { kind: string; subject: string | null; body: object }[] = [];
    const ledger = {
      appendEvent: (_a: string, kind: string, subject: string | null, body: object) =>
        events.push({ kind, subject, body }),
    };
    const live = new LiveLog();
    const at = { source: T, lane: "lane-1", run: "r-1" };
    tellStreak(
      {
        kind: "repeating",
        trial: "t-1",
        count: 10,
        different: 2,
        calls: [{ call: 'read_file {"path":"a.md"}', times: 5 }],
      },
      at,
      ledger,
      live,
    );
    tellStreak({ kind: "stopped_repeating", trial: "t-1", count: 60 }, at, ledger, live);
    tellStreak(undefined, at, ledger, live);
    assert.deepEqual(events, [
      {
        kind: "trial_repeating",
        subject: "r-1",
        body: {
          trial: "t-1",
          lane: "lane-1",
          count: 10,
          different: 2,
          calls: [{ call: 'read_file {"path":"a.md"}', times: 5 }],
        },
      },
    ]);
    const lines = live.since(0).entries.map((e) => [e.source, e.kind, e.lane, e.run, e.text]);
    assert.deepEqual(lines, [
      [
        T,
        "status",
        "lane-1",
        "r-1",
        'repeats the same calls: 10 in a row, each with the same answer as before, 2 different (read_file {"path":"a.md"} ×5). The trial goes on: stop it from the run\'s page if it is stuck.',
      ],
      [T, "status", "lane-1", "r-1", "stopped repeating the same calls after 60."],
    ]);
  });
});

describe("a trial's lines, through the harness, reach the report and the teachers (goal 143)", () => {
  test("the watch, the report's open trials, the brief's at_work and one trial_repeating event", async (t) => {
    const env = makeHarnessEnv("rig-w");
    t.after(() => env.service.ledger.close());
    const parsed = parseContract({ ...researchFixture, lanes: { count: 2, trials_per_epoch: 1 } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const out = await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    new Registry(env.service.ledger).startTrial({
      id: "t-1",
      run: "r-1",
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: "p",
      token: "tok-1",
    });
    const api = createHarnessApi(env.service, { supervisor: "s" });
    const post = async (body: object) => {
      const r = await api.request("/v1/trial/live", {
        method: "POST",
        headers: { authorization: "Bearer trial.tok-1", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200, await r.text());
    };
    const entries = [{ kind: "tool", text: "progress {}" }];
    for (let i = 0; i <= REPEAT_STREAK + 2; i++)
      entries.push(
        { kind: "tool", text: "progress {}" },
        { kind: "result", text: "progress (1 ms): 4 claims" },
      );
    await post({ entries: entries.slice(1) });
    const reply = { since: "2026-10-25T15:09:00.000Z", text: 0, thinking: 12, tool_args: 900 };
    await post({ entries: [], reply });

    const facts = env.service.work().open?.find((x) => x.trial === "t-1");
    assert.ok(facts?.last_line_at, "the report says when it last sent a line");
    assert.deepEqual(
      { ...facts?.reply, reported_at: undefined },
      { ...reply, reported_at: undefined },
    );
    assert.equal(facts?.repeating?.count, REPEAT_STREAK + 2);
    const brief = env.service.brief("r-1") as { at_work: { trial: string; repeating: unknown }[] };
    assert.deepEqual(
      brief.at_work.map((x) => x.trial),
      ["t-1"],
    );
    assert.deepEqual(brief.at_work[0]?.repeating, facts?.repeating);
    const events = env.service.ledger.db
      .prepare("select subject, body from event where kind = 'trial_repeating'")
      .all() as { subject: string; body: string }[];
    assert.equal(events.length, 1, "once for the streak");
    assert.equal(events[0]?.subject, "r-1");
    assert.equal(JSON.parse(String(events[0]?.body)).trial, "t-1");
    // Its Live has the harness's line for it.
    assert.ok(
      env.service.live
        .since(0, 500)
        .entries.some(
          (e) => e.source === "trial:t-1" && e.text.startsWith("repeats the same calls"),
        ),
    );
    // A trial that ended is forgotten.
    env.service.trialEnded("t-1", true);
    assert.equal(env.service.watch.facts("t-1").last_line_at, null);
  });
});
