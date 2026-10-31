import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { LenientNotes } from "../../src/core/journal.ts";
import { Registry } from "../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import type { LedgerEvent } from "../../src/harness/ledger/rows.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

const RUN = "smoke-1";
const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

async function setup(over: Record<string, unknown> = {}) {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload(over)));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const events = (kind?: string): LedgerEvent[] =>
    env.service.ledger.eventsAfter(0, 100_000).events.filter((e) => !kind || e.kind === kind);
  const api = createHarnessApi(env.service, tokens);
  return { env, s: env.service, events, api };
}

/** An open trial of a lane, with its token. */
function openTrial(s: Awaited<ReturnType<typeof setup>>, lane: string, id: string) {
  const token = randomBytes(16).toString("hex");
  new Registry(s.s.ledger).startTrial({
    id,
    run: RUN,
    lane,
    epoch: 1,
    family: "f",
    parent: s.env.seedCommit,
    token,
  });
  return token;
}

const writer = { by: "lane-1", actor: "trial:t-1", source: "trial:t-1", lane: "lane-1" };

describe("field notes", () => {
  test("a note is its row and one event in the run, with a line in the live view", async () => {
    const s = await setup();
    const n = s.s.journal.write(
      RUN,
      { kind: "observation", text: "  The working set is 6 MB, larger than L2.  " },
      { ...writer, trial: "t-1" },
    );
    assert.equal(n.text, "The working set is 6 MB, larger than L2.", "trimmed");
    assert.equal(n.by, "lane-1");
    const e = s.events("journal_note");
    assert.equal(e.length, 1);
    assert.equal(e[0]?.subject, RUN);
    assert.equal(e[0]?.actor, "trial:t-1");
    assert.deepEqual(e[0]?.body, {
      id: n.id,
      by: "lane-1",
      kind: "observation",
      text: "The working set is 6 MB, larger than L2.",
      about: { type: "run", id: RUN },
      lane: "lane-1",
      trial: "t-1",
    });
    // A note that names nothing is about its run: its row and its event say so.
    assert.deepEqual(n.about, { type: "run", id: RUN });
    assert.deepEqual(
      {
        ...s.s.ledger.db
          .prepare("select about_type, about_id from journal_note where id = ?")
          .get(n.id),
      },
      { about_type: "run", about_id: RUN },
    );
    const line = s.s.live.since(0, 100).entries.at(-1);
    assert.equal(line?.source, "trial:t-1");
    assert.equal(line?.lane, "lane-1");
    assert.equal(line?.text, "noted (observation): The working set is 6 MB, larger than L2.");
    // A long note's live line is clipped to 300 characters; the note itself is whole.
    const long = s.s.journal.write(RUN, { kind: "lesson", text: "x".repeat(1999) }, writer);
    assert.equal(long.text.length, 1999);
    const clipped = s.s.live.since(0, 100).entries.at(-1)?.text ?? "";
    assert.equal(clipped.length, "noted (lesson): ".length + 300);
  });

  test("a note's kind, text and what it is about are checked; nothing is written for a refusal", async () => {
    const s = await setup();
    const refuse = (input: unknown, re: RegExp) =>
      assert.throws(() => s.s.journal.write(RUN, input, writer), re);
    refuse({ kind: "rumour", text: "t" }, /kind/);
    refuse({ kind: "note", text: "   " }, /text/);
    refuse({ kind: "note", text: "y".repeat(2001) }, /text/);
    refuse({ kind: "note", text: "t", by: "planner" }, /by/);
    refuse({ kind: "note", text: "t", about: { type: "attempt", id: "a-none" } }, /no attempt/);
    refuse({ kind: "note", text: "t", about: { type: "round", id: "one" } }, /its number/);
    refuse({ kind: "note", text: "t", about: { type: "page", id: "p" } }, /about/);
    refuse(
      { kind: "note", text: "t", about: { type: "run", id: "smoke-9" } },
      /about its own run \(smoke-1\), not run smoke-9/,
    );
    // An experiment of another run is not this run's.
    const second = await s.s.applyCommand(
      s.env.sign("assign_campaign", s.env.assignPayload({ run: "smoke-2" })),
    );
    assert.ok(second.status === "applied" && second.accepted, JSON.stringify(second));
    const theirs = s.s.queue.add("smoke-2", { title: "theirs", by: "owner" }, "t");
    refuse(
      { kind: "note", text: "t", about: { type: "experiment", id: theirs.id } },
      /no experiment .* in run smoke-1/,
    );
    const mine = s.s.queue.add(RUN, { title: "mine", by: "owner" }, "t");
    const ok = s.s.journal.write(
      RUN,
      { kind: "decision", text: "kept it", about: { type: "experiment", id: mine.id } },
      writer,
    );
    assert.deepEqual(ok.about, { type: "experiment", id: mine.id });
    const run = s.s.journal.write(
      RUN,
      { kind: "lesson", text: "about the run", about: { type: "run", id: RUN } },
      writer,
    );
    assert.deepEqual(run.about, { type: "run", id: RUN }, "a note may name its run itself");
    assert.equal(s.events("journal_note").length, 2, "only the accepted notes");
    assert.throws(() => s.s.journal.write("no-run", { kind: "note", text: "t" }, writer), /no run/);
  });

  test("notes are append-only: no one edits or deletes one", async () => {
    const s = await setup();
    const n = s.s.journal.write(RUN, { kind: "note", text: "keep me" }, writer);
    assert.throws(
      () =>
        s.s.ledger.db.prepare("update journal_note set text = 'changed' where id = ?").run(n.id),
      /append-only/,
    );
    assert.throws(
      () => s.s.ledger.db.prepare("delete from journal_note where id = ?").run(n.id),
      /append-only/,
    );
    assert.equal(s.s.journal.get(n.id)?.text, "keep me");
  });

  test("a worker's note through the API: its trial decides the run, the lane and who wrote it", async () => {
    const s = await setup();
    const token = openTrial(s, "lane-2", "t-0123456789abcdef");
    const note = (body: unknown, t = token) =>
      s.api.request("/v1/trial/note", {
        method: "POST",
        headers: auth(`trial.${t}`),
        body: JSON.stringify(body),
      });
    assert.equal(
      (await note({ kind: "surprise", text: "slower", by: "planner" })).status,
      400,
      "a worker names nothing but its note",
    );
    assert.equal((await note({ kind: "surprise", text: "slower", lane: "lane-1" })).status, 400);
    const r = await note({ kind: "surprise", text: "Tiling was slower, not faster." });
    assert.equal(r.status, 201, await r.clone().text());
    const { note: id } = (await r.json()) as { note: number };
    const n = s.s.journal.get(id);
    assert.equal(n?.by, "lane-2");
    assert.equal(n?.lane, "lane-2");
    assert.equal(n?.trial, "t-0123456789abcdef");
    assert.equal(n?.run, RUN);
    assert.equal(s.events("journal_note").at(-1)?.actor, "trial:t-0123456789abcdef");
    const bad = await note({ kind: "note", text: "t", about: { type: "attempt", id: "a-x" } });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /no attempt a-x/);
    new Registry(s.s.ledger).finishTrial(
      "t-0123456789abcdef",
      { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 },
      "s",
    );
    assert.equal((await note({ kind: "note", text: "after" })).status, 409, "a trial that ended");
    assert.equal((await note({ kind: "note", text: "x" }, "unknown")).status, 401);
    assert.equal(s.s.journal.newest(RUN, 50).length, 1);
  });

  test("an advisor's notes are recorded as <role>:<name>, each on its own and leniently", async () => {
    const s = await setup();
    const post = (body: unknown, t = tokens.supervisor) =>
      s.api.request("/v1/journal", {
        method: "POST",
        headers: auth(t),
        body: JSON.stringify(body),
      });
    const r = await post({
      run: RUN,
      role: "teachers",
      by: "teacher-a",
      notes: [
        { kind: "observation", text: "Nothing queued uses vector loads." },
        { kind: "rumour", text: "left out" },
        {
          kind: "question",
          text: "Is the tolerance fixed?",
          about: { type: "attempt", id: "a-0" },
        },
      ],
    });
    assert.equal(r.status, 200, await r.clone().text());
    const out = (await r.json()) as { recorded: number[]; problems: string[] };
    assert.equal(out.recorded.length, 2, "a note about a record the run lacks keeps its words");
    assert.equal(out.problems.length, 2);
    assert.match(out.problems[0] ?? "", /^note 2: not recorded: /);
    assert.match(out.problems[1] ?? "", /^note 3: recorded as about the run .*a-0/);
    const [first, third] = out.recorded.map((id) => s.s.journal.get(id));
    assert.equal(first?.by, "teachers:teacher-a");
    assert.equal(third?.text, "Is the tolerance fixed?");
    assert.deepEqual(third?.about, { type: "run", id: RUN }, "never left empty");
    assert.deepEqual(first?.about, { type: "run", id: RUN }, "it named nothing: the run");
    assert.equal(s.events("journal_note").at(-1)?.actor, "supervisor");
    assert.match(
      s.s.live.since(0, 100).entries.at(-2)?.text ?? "",
      /^teachers:teacher-a noted \(observation\): Nothing queued/,
    );
    assert.equal(
      (await post({ run: RUN, role: "owner", by: "x", notes: [] })).status,
      400,
      "only an advisor role",
    );
    assert.equal(
      (await post({ run: RUN, role: "review_panel", by: "p", notes: [] }, "trial.x")).status,
      401,
    );
    assert.equal(
      (await post({ run: "none", role: "review_panel", by: "p", notes: [] })).status,
      404,
    );
  });

  test("a worker's brief window: its lane's newest 10, and the newest 5 decisions and lessons of others", async () => {
    const s = await setup();
    for (let i = 1; i <= 12; i++)
      s.s.journal.write(RUN, { kind: "observation", text: `mine ${i}` }, writer);
    for (let i = 1; i <= 7; i++)
      s.s.journal.write(
        RUN,
        { kind: i % 2 ? "decision" : "lesson", text: `theirs ${i}` },
        { ...writer, by: "lane-2", lane: "lane-2" },
      );
    s.s.journal.write(RUN, { kind: "question", text: "a question" }, { ...writer, by: "planner" });
    const w = s.s.journal.forLane(RUN, "lane-1");
    assert.deepEqual(
      w.mine.map((n) => n.text),
      Array.from({ length: 10 }, (_, i) => `mine ${12 - i}`),
    );
    assert.deepEqual(
      w.others.map((n) => n.text),
      ["theirs 7", "theirs 6", "theirs 5", "theirs 4", "theirs 3"],
    );
  });

  test("a model's notes are read leniently: a bad one is left out, never the answer", () => {
    assert.deepEqual(LenientNotes.parse("not a list"), []);
    assert.deepEqual(
      LenientNotes.parse([
        { kind: "Decision", text: " keep lane-1 on fusion " },
        { kind: "rumour", text: "x" },
        { kind: "lesson", text: "" },
        { kind: "note", text: "z".repeat(3000) },
        { kind: "question", text: "q", about: { type: "nowhere", id: "1" } },
        null,
      ]),
      [
        { kind: "decision", text: "keep lane-1 on fusion" },
        { kind: "note", text: "z".repeat(2000) },
        { kind: "question", text: "q" },
      ],
    );
  });

  test("a run keeps the background the owner picked from past research, in order", async () => {
    const briefing = [
      {
        text: "Vector loads need 16-byte aligned pointers.",
        from: { campaign: "kernels", run: "kernels-7", kind: "note", ref: "12" },
      },
      {
        text: "Fusing dequantize with a size switch won 6% on long inputs.",
        from: { campaign: "kernels", run: "kernels-7", kind: "experiment", ref: "x-0123456789ab" },
      },
    ];
    const s = await setup({ briefing });
    assert.deepEqual(s.s.ledger.runs.briefing(RUN), briefing);
    const created = s.events("run_created")[0]?.body as { briefing?: number } | undefined;
    assert.equal(created?.briefing, 2);
    assert.throws(
      () => s.s.ledger.db.prepare("delete from run_briefing where run = ?").run(RUN),
      /fixed/,
    );
    const plain = await setup();
    assert.deepEqual(plain.s.ledger.runs.briefing(RUN), []);
    // A run without agents has no briefs: its background is refused, and no run is made.
    const tryEnv = makeHarnessEnv();
    const refused = await tryEnv.service.applyCommand(
      tryEnv.sign("assign_campaign", tryEnv.assignPayload({ briefing, agents: false })),
    );
    assert.ok(refused.status === "applied" && !refused.accepted, JSON.stringify(refused));
    assert.match(
      String((refused.result as { error?: string }).error),
      /a run without agents has no briefs: leave out the background from past research/,
    );
    assert.equal(tryEnv.service.ledger.runs.get(RUN), undefined);
  });
});
