import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readKnowledgeAgain } from "../../src/control/events/index.ts";
import { rowsBehind, sqliteBehind, writeBehind } from "../../src/control/store/behind.ts";
import type { ControlStore } from "../../src/control/store/index.ts";
import { rigView } from "../../src/control/views/index.ts";
import { assigned } from "../helpers/assignments.ts";
import {
  applied,
  busOf,
  closeBus,
  controlStore,
  heldEvents,
  ingestReport,
} from "../helpers/control-store.ts";
import { itemsBySeq } from "../helpers/kb-items.ts";

type Ev = [string, string, string, Record<string, unknown>];

/**
 * A rig's events as control receives them (subject first, then the body), once the apply of the
 * events stream has fed them to the knowledge base.
 */
async function ingest(
  store: ControlStore,
  rig: string,
  events: Ev[],
  from = 0,
  ledger = `ledger-${rig}`,
) {
  await ingestReport(store, {
    rig,
    ledger_id: ledger,
    cursor: from,
    next: from + events.length,
    generated_at: new Date(Date.parse("2026-10-20T01:00:00Z") + from * 1000).toISOString(),
    events: events.map(([actor, kind, subject, body], i) => ({
      id: from + i + 1,
      at: new Date(Date.parse("2026-10-20T01:00:00Z") + (from + i) * 60_000).toISOString(),
      actor,
      kind,
      subject,
      body,
    })),
    summary: {},
  });
}

/** Two rigs: a goal campaign with a run's journal and experiments, and a research campaign. */
async function twoCampaigns(store: ControlStore) {
  await ingest(store, "rig-a", [
    ["harness", "run_created", "gs-3", { campaign: "gemv-speed", mode: "goal" }],
    [
      "planner",
      "experiment_added",
      "gs-3",
      {
        id: "x-1",
        title: "Load int4 weights with vector loads",
        details: "128-bit loads of the packed weights",
        why: "the guide says twice the bandwidth",
        direction: "memory-layout",
        by: "teacher",
      },
    ],
    [
      "lane-1",
      "journal_note",
      "gs-3",
      {
        id: 1,
        by: "lane-1",
        kind: "observation",
        text: "The L2 is 4 MB; the working set is 6.3 MB, so weights stream from memory.",
        about: { type: "trial", id: "t-1" },
      },
    ],
    [
      "harness",
      "attempt_recorded",
      "a-1",
      { run: "gs-3", lane: "lane-1", hypothesis: "vector loads for the weights" },
    ],
    ["judge", "verdict", "a-1", { verdict: "win_confirmed", delta: 0.061 }],
    [
      "harness",
      "experiment_finished",
      "gs-3",
      { id: "x-1", lane: "lane-1", trial: "t-1", attempt: "a-1", result: "submitted" },
    ],
  ]);
  await ingest(store, "rig-b", [
    ["harness", "run_created", "sv-2", { campaign: "survey-study", mode: "research" }],
    [
      "lane-1",
      "source_fetched",
      "sv-2",
      {
        source: "s-1",
        domain: "arxiv.org",
        url: "https://arxiv.org/abs/1",
        title: "Limits of self-training",
      },
    ],
    [
      "lane-1",
      "claim_added",
      "sv-2",
      { claim: "c-1", question: 2, verified: true, text: "gains vanish without a verifier" },
    ],
    [
      "lane-2",
      "finding_added",
      "sv-2",
      {
        finding: "f-1",
        claims: 6,
        supported: true,
        statement: "Self-training helps only where a verifier exists",
      },
    ],
  ]);
}

test("each campaign's collection is built from its runs' events; collections are read only where granted", async () => {
  const store = controlStore();
  await twoCampaigns(store);
  const kb = store.kb();
  const collections = await kb.collections();
  const pn = collections.find((f) => f.campaign === "gemv-speed");
  assert.deepEqual(pn?.counts, { attempt: 1, experiment: 1, note: 1, run: 1 });
  assert.equal(pn?.journal, 1, "the observation is a field note");
  assert.equal(pn?.runs, 1);
  // The experiment carries its result, the attempt its verdict, the note its kind; each the lane
  // and the trial its events name.
  const [exp] = await kb.search("vector", ["gemv-speed"], { kinds: ["experiment"] });
  assert.match(
    String(exp?.body),
    /Why: the guide says twice the bandwidth[\s\S]*Result: attempt a-1 \(submitted\)/,
  );
  assert.deepEqual(exp?.meta, {
    details: "128-bit loads of the packed weights",
    why: "the guide says twice the bandwidth",
    direction: "memory-layout",
    result: "Result: attempt a-1 (submitted)",
    lane: "lane-1",
    trial: "t-1",
  });
  assert.equal(
    exp && (await kb.resultOf(exp)),
    "tried: attempt a-1 (submitted), win confirmed (+6.10%)",
  );
  const [att] = await kb.search("vector", ["gemv-speed"], { kinds: ["attempt"] });
  assert.match(String(att?.body), /Verdict: win_confirmed \(\+6\.10%\)/);
  const [note] = await kb.search("working set", ["gemv-speed"]);
  assert.equal(note?.kind, "note");
  assert.equal(note?.sub, "observation");
  assert.equal(note?.by, "lane-1");
  assert.equal(note?.rig, "rig-a");
  assert.equal(note?.run, "gs-3");
  // Search stays inside the collections given; a grant adds another campaign's collection.
  assert.deepEqual(await kb.search("verifier", ["gemv-speed"]), []);
  assert.equal((await kb.search("verifier", ["survey-study"])).length, 2);
  assert.equal(await kb.grant("gemv-speed", "survey-study", "owner:ui"), true);
  assert.equal(await kb.grant("gemv-speed", "survey-study", "owner:ui"), false, "granted already");
  assert.deepEqual(await kb.reads("gemv-speed"), ["survey-study"]);
  assert.deepEqual(await kb.readBy("survey-study"), ["gemv-speed"]);
  assert.deepEqual(await kb.readable("gemv-speed"), ["gemv-speed", "survey-study"]);
  assert.equal((await kb.search("verifier", await kb.readable("gemv-speed"))).length, 2);
  assert.equal(await kb.revoke("gemv-speed", "survey-study"), true);
  assert.equal(await kb.revoke("gemv-speed", "survey-study"), false);
  assert.deepEqual(await kb.reads("gemv-speed"), []);
  // A campaign never reads itself as a grant.
  assert.equal(await kb.grant("gemv-speed", "gemv-speed", "owner:ui"), false);
  assert.deepEqual(await kb.reads("gemv-speed"), []);
  // Later events update the same items, and new ones are added.
  await ingest(
    store,
    "rig-a",
    [
      [
        "planner",
        "experiment_dropped",
        "gs-3",
        { id: "x-1", by: "planner", why: "a rule avoids it" },
      ],
    ],
    6,
  );
  const [dropped] = await store.kb().search("vector", ["gemv-speed"], { kinds: ["experiment"] });
  assert.match(String(dropped?.body), /Dropped: a rule avoids it/);
  assert.doesNotMatch(String(dropped?.body), /Result:/);
  assert.ok(Number(dropped?.seq) > Number(exp?.seq), "an update gives the item a new seq");
});

test("the knowledge base carries on after a restart of control: its cursor and seqs are kept", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "thermite-kb-")), "control.db");
  const first = controlStore(path);
  await twoCampaigns(first);
  const before = await first.kb().collections();
  const top = Math.max(
    ...(await itemsBySeq(first, ["gemv-speed", "survey-study"])).map((x) => x.seq),
  );
  // Control restarts: a new store on the same file, on the same bus, goes on from the stream's
  // place it applied, and indexes nothing twice.
  closeBus(first);
  const second = controlStore(path, busOf(first).bus);
  await applied(second);
  assert.equal(busOf(second).apply.applied, 0);
  const kb = second.kb();
  assert.deepEqual(await kb.collections(), before);
  await ingest(
    second,
    "rig-a",
    [
      [
        "lane-2",
        "journal_note",
        "gs-3",
        { id: 2, by: "lane-2", kind: "lesson", text: "tiling lost" },
      ],
    ],
    6,
  );
  const [lesson] = await second.kb().search("tiling", ["gemv-speed"]);
  assert.ok(Number(lesson?.seq) > top, "seqs go on from where they were");
});

test("a rig's new ledger never mixes its runs' items with the old ledger's", async () => {
  const store = controlStore();
  await ingest(store, "rig-a", [
    ["harness", "run_created", "r-1", { campaign: "old-campaign", mode: "goal" }],
    ["planner", "experiment_added", "r-1", { id: "x-1", title: "the old idea", by: "planner" }],
    ["harness", "attempt_recorded", "a-1", { run: "r-1", lane: "lane-1", hypothesis: "old try" }],
  ]);
  store.kb();
  // A reset: the rig reports a new ledger that starts again at event 1, with the same names.
  await ingest(
    store,
    "rig-a",
    [
      ["harness", "run_created", "r-1", { campaign: "new-campaign", mode: "goal" }],
      ["planner", "experiment_added", "r-1", { id: "x-1", title: "the new idea", by: "planner" }],
      ["judge", "verdict", "a-1", { verdict: "regress", delta: -0.05 }],
    ],
    0,
    "ledger-rig-a-2",
  );
  const kb = store.kb();
  const [old] = await kb.search("idea", ["old-campaign"]);
  const [neu] = await kb.search("idea", ["new-campaign"]);
  assert.equal(old?.title, "the old idea");
  assert.equal(neu?.title, "the new idea");
  assert.notEqual(old?.ledger, neu?.ledger);
  // The new ledger's verdict names an attempt the new ledger never recorded: the old one keeps
  // no verdict from it.
  const [att] = await kb.search("old try", ["old-campaign"], { kinds: ["attempt"] });
  assert.doesNotMatch(String(att?.body), /Verdict/);
  // A rig's run is known in its current ledger only.
  assert.equal(await kb.runCampaign("rig-a", "r-1"), "new-campaign");
});

test("a source note is a note of its own in the collection and in the run's journal", async () => {
  const store = controlStore();
  await ingest(store, "rig-c", [
    ["harness", "run_created", "g-1", { campaign: "gemv-speed", mode: "goal" }],
    [
      "lane-1",
      "journal_note",
      "g-1",
      { id: 1, by: "lane-1", kind: "observation", text: "the kernel is memory bound" },
    ],
    [
      "lane-1",
      "source_note",
      "g-1",
      {
        note: 1,
        by: "lane-1",
        text: "The vendor guide says 128-bit loads double the bandwidth",
        sources: ["s-1"],
        url: "https://example.com/guide",
      },
    ],
    // A rig on v0.1.0 recorded a source note as research_note, and a field note of no other
    // kind as note: both are read under the public names (core/names.ts).
    [
      "lane-2",
      "research_note",
      "g-1",
      { note: 2, by: "lane-2", text: "An older note on prefetch distance", sources: ["s-2"] },
    ],
    ["lane-2", "journal_note", "g-1", { id: 2, by: "lane-2", kind: "note", text: "a plain aside" }],
  ]);
  const kb = store.kb();
  const notes = await kb.search("bandwidth", ["gemv-speed"], { kinds: ["note"] });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.ref, "rn-1", "never the field note's id");
  assert.equal(notes[0]?.sub, "source_note");
  const older = await kb.search("prefetch distance", ["gemv-speed"], { kinds: ["note"] });
  assert.deepEqual(
    older.map((x) => [x.ref, x.sub]),
    [["rn-2", "source_note"]],
  );
  assert.equal((await kb.search("plain aside", ["gemv-speed"]))[0]?.sub, "other");
  assert.equal(notes[0]?.url, "https://example.com/guide");
  assert.match(String(notes[0]?.body), /Sources: s-1/);
  assert.equal((await kb.search("memory bound", ["gemv-speed"]))[0]?.sub, "observation");
  const run = (await rigView(store, "rig-c", { staleAfterMs: 600_000 }))?.runs.find(
    (r) => r.id === "g-1",
  );
  assert.deepEqual(
    run?.journal.map((n) => [n.id, n.kind, n.about?.type ?? null]),
    [
      [1, "observation", "run"],
      [-1, "source_note", "source"],
      [-2, "source_note", "source"],
      [2, "other", "run"],
    ],
  );
  assert.ok(!run?.timeline.some((e) => e.kind === "source_note"));
});

test("a collection holds everything a run produces: the run, its trials, its documents, the sources' text", async () => {
  const store = controlStore();
  const text = `The weights stream from memory. ${"More words. ".repeat(40)}`;
  await ingest(store, "rig-r", [
    [
      "control:owner",
      "run_created",
      "rs-1",
      {
        campaign: "kernel-survey",
        version: 2,
        mode: "research",
        seed: { repo: "https://git.example.com/kernels.git", commit: "c".repeat(40) },
        direction: "memory first",
        agents: true,
        briefing: 2,
      },
    ],
    [
      "scheduler",
      "trial_started",
      "rs-1",
      { trial: "t-1", lane: "lane-1", epoch: 3, direction: "survey", focus: "read the guide" },
    ],
    [
      "lane-1",
      "source_fetched",
      "rs-1",
      {
        source: "s-1",
        domain: "docs.example.com",
        url: "https://docs.example.com/guide",
        title: "The guide",
        text,
      },
    ],
    [
      "lane-1",
      "research_doc",
      "rs-1",
      {
        lane: "lane-1",
        trial: "t-1",
        path: "synthesis/outline.md",
        change: "written",
        bytes: 40,
        sha256: "a".repeat(64),
        text: "# Outline\nLoads first, then tiling.",
      },
    ],
    [
      "lane-1",
      "trial_finished",
      "rs-1",
      {
        trial: "t-1",
        lane: "lane-1",
        epoch: 3,
        attempt: null,
        stopped: "no_submission",
        turns: 12,
        tokens_in: 120000,
        tokens_out: 8000,
        error: null,
      },
    ],
    ["control:owner", "run_status", "rs-1", { status: "paused", reason: "the owner paused it" }],
    [
      "lane-1",
      "research_doc",
      "rs-1",
      { lane: "lane-1", trial: "t-2", path: "synthesis/outline.md", change: "removed" },
    ],
    // A document never recorded as one: its removal adds nothing.
    ["lane-1", "research_doc", "rs-1", { lane: "lane-1", path: "data.bin", change: "removed" }],
    [
      "lane-1",
      "hypothesis_added",
      "rs-1",
      { hypothesis: "h-1", lane: "lane-1", text: "Loads bound the kernel.", supporting: ["c-1"] },
    ],
  ]);
  const kb = store.kb();
  const f = await kb.collection("kernel-survey");
  assert.deepEqual(f.counts, { doc: 1, hypothesis: 1, run: 1, source: 1, trial: 1 });
  const one = async (kind: "run" | "trial" | "doc" | "source" | "hypothesis") => {
    const [x] = await kb.search("", ["kernel-survey"], { kinds: [kind] });
    assert.ok(x, kind);
    return x;
  };
  // The run: its campaign and version, mode, seed, note, agents and briefing, then status.
  const run = await one("run");
  assert.equal(run.ref, "rs-1");
  assert.equal(run.title, "Run rs-1: research, kernel-survey");
  assert.equal(run.by, "control:owner");
  assert.equal(
    run.body,
    [
      "Campaign: kernel-survey, version 2",
      "Mode: research",
      `Seed: https://git.example.com/kernels.git at ${"c".repeat(12)}`,
      "Note: memory first",
      "Agents: on",
      "Briefing: 2 items from past research",
      "Status: paused (the owner paused it)",
    ].join("\n"),
  );
  // The trial: its lane, round, direction and focus, then how it ended; written by its lane.
  const trial = await one("trial");
  assert.equal(trial.ref, "t-1");
  assert.equal(trial.by, "lane-1");
  assert.equal(trial.title, "lane-1, round 3: read the guide");
  assert.equal(
    trial.body,
    [
      "Lane: lane-1",
      "Round: 3",
      "Direction: survey",
      "Focus: read the guide",
      "Ended: no submission; 12 turns; 120,000 tokens in, 8,000 out",
    ].join("\n"),
  );
  // The source holds the text that was read, after its address.
  const source = await one("source");
  assert.equal(source.body, `https://docs.example.com/guide\ndocs.example.com\n\n${text}`);
  assert.equal((await kb.search("weights stream", ["kernel-survey"]))[0]?.kind, "source");
  // The document: its path, its text and its lane; then that the lane took it out.
  const doc = await one("doc");
  assert.equal(doc.ref, "lane-1/synthesis/outline.md");
  assert.equal(doc.title, "synthesis/outline.md");
  assert.equal(doc.by, "lane-1");
  assert.equal(
    doc.body,
    "# Outline\nLoads first, then tiling.\nRemoved: lane-1 took it out of its working area in trial t-2.",
  );
  // A hypothesis, with the verified claims for it.
  const hypothesis = await one("hypothesis");
  assert.equal(hypothesis.ref, "h-1");
  assert.equal(hypothesis.by, "lane-1");
  assert.equal(hypothesis.body, "Loads bound the kernel.\nSupporting claims: c-1");
  // Each item keeps its origin: the rig and run, who wrote it, and when.
  for (const x of [run, trial, source, doc, hypothesis]) {
    assert.equal(x.rig, "rig-r");
    assert.equal(x.run, "rs-1");
    assert.equal(x.campaign, "kernel-survey");
    assert.match(x.at, /^2026-10-20T01:0\d:00\.000Z$/);
  }
  // The pages are built without the text a source's or a document's event carries.
  const events = (await rigView(store, "rig-r", { staleAfterMs: 600_000 }))?.recent ?? [];
  assert.equal(events.find((e) => e.kind === "source_fetched")?.body.text, undefined);
  assert.equal(events.find((e) => e.kind === "research_doc")?.body.text, undefined);
  assert.equal(
    events.find((e) => e.kind === "source_fetched")?.body.url,
    "https://docs.example.com/guide",
  );
  const full = (await heldEvents(store, "rig-r")) as { kind: string; body: { text?: string } }[];
  assert.equal(full.find((e) => e.kind === "source_fetched")?.body.text, text);
});

test("after an upgrade, the runs indexed before get their run and trial items, once, in their collection", async () => {
  const store = controlStore();
  await assigned(store, "rig-a", "gs-3", "gemv-speed");
  await ingest(store, "rig-a", [
    ["harness", "run_created", "gs-3", { campaign: "gemv-speed", mode: "goal" }],
    [
      "scheduler",
      "trial_started",
      "gs-3",
      { trial: "t-1", lane: "lane-1", epoch: 1, direction: "loads" },
    ],
    ["lane-1", "journal_note", "gs-3", { id: 1, by: "lane-1", kind: "lesson", text: "kept" }],
    ["control:owner", "run_status", "gs-3", { status: "paused", reason: "a pause" }],
  ]);
  const kb = store.kb();
  // As an earlier reading left the store: no run or trial items, and no reading's version.
  sqliteBehind(store).db.exec(
    "delete from kb_item where kind in ('run', 'trial'); delete from kb_meta;",
  );
  const note = (await kb.search("kept", ["gemv-speed"]))[0];
  // Control starts again: the knowledge base reads those events again from the events stream.
  await readKnowledgeAgain(store, busOf(store).bus);
  assert.deepEqual((await kb.collection("gemv-speed")).counts, { note: 1, run: 1, trial: 1 });
  const [run] = await kb.search("", ["gemv-speed"], { kinds: ["run"] });
  assert.match(String(run?.body), /Status: paused \(a pause\)$/);
  assert.equal(run?.campaign, "gemv-speed");
  assert.equal(
    (await kb.search("kept", ["gemv-speed"]))[0]?.seq,
    note?.seq,
    "an item it had stays as it was",
  );
  // Once only: a later call reads nothing again.
  sqliteBehind(store).db.exec("delete from kb_item where kind = 'trial'");
  assert.equal(await readKnowledgeAgain(store, busOf(store).bus), 0);
  assert.equal((await kb.collection("gemv-speed")).counts.trial, undefined);
});

test("a rig files a run's items only under a campaign control gave it", async () => {
  const store = controlStore();
  // Control assigned gemv-speed to rig-a's g-1.
  await assigned(store, "rig-a", "g-1", "gemv-speed");
  await ingest(store, "rig-a", [
    ["harness", "run_created", "g-1", { campaign: "gemv-speed", mode: "goal" }],
    ["lane-1", "journal_note", "g-1", { id: 1, by: "lane-1", kind: "lesson", text: "real lesson" }],
  ]);
  // rig-b names gemv-speed for a run control never assigned it: nothing goes in that collection.
  await ingest(store, "rig-b", [
    ["harness", "run_created", "g-9", { campaign: "gemv-speed", mode: "goal" }],
    ["lane-1", "journal_note", "g-9", { id: 1, by: "lane-1", kind: "lesson", text: "planted" }],
    // A campaign control never assigned anywhere (a local run) is still filed as named.
    ["harness", "run_created", "l-1", { campaign: "local-try", mode: "goal" }],
    ["lane-1", "journal_note", "l-1", { id: 2, by: "lane-1", kind: "lesson", text: "local" }],
  ]);
  // Nor under a campaign control saved or a grant names, nor for a run of a name control
  // assigned another rig, whatever campaign it names.
  await store.campaigns.put({
    campaign: "saved-only",
    version: 1,
    contract: { campaign: "saved-only" },
    sha: "0".repeat(64),
    by: "owner:ui",
  });
  await store.kb().grant("granted-reader", "granted-only", "owner:api");
  await ingest(store, "rig-c", [
    ["harness", "run_created", "s-1", { campaign: "saved-only", mode: "goal" }],
    ["lane-1", "journal_note", "s-1", { id: 1, by: "lane-1", kind: "lesson", text: "into saved" }],
    ["harness", "run_created", "s-2", { campaign: "granted-only", mode: "goal" }],
    ["lane-1", "journal_note", "s-2", { id: 2, by: "lane-1", kind: "lesson", text: "into grant" }],
    ["harness", "run_created", "g-1", { campaign: "its-own-name", mode: "goal" }],
    ["lane-1", "journal_note", "g-1", { id: 3, by: "lane-1", kind: "lesson", text: "a copy" }],
  ]);
  const kb = store.kb();
  assert.deepEqual(
    (await kb.search("lesson", ["gemv-speed"])).map((x) => x.body),
    ["real lesson\nAbout: run g-1"],
  );
  assert.equal((await kb.search("planted", ["gemv-speed"])).length, 0);
  assert.equal((await kb.search("local", ["local-try"], { kinds: ["note"] })).length, 1);
  assert.equal((await kb.search("saved", ["saved-only"])).length, 0);
  assert.equal((await kb.search("grant", ["granted-only"])).length, 0);
  assert.equal((await kb.search("copy", ["its-own-name"])).length, 0);
});

test("a store built by an earlier reading rebuilds its experiments and attempts once (goal 162)", async () => {
  const store = controlStore();
  await twoCampaigns(store);
  const kb = store.kb();
  const [exp] = await kb.search("vector", ["gemv-speed"], { kinds: ["experiment"] });
  const whole = exp?.body;
  // As reading 2 left an item whose details held "Result: ": cut, and its state in its text.
  await writeBehind(
    store,
    "update kb_item set body = 'cut', meta = '{}' where kind = 'experiment'",
  );
  await writeBehind(store, "update kb_meta set value = '2' where key = 'reading'");
  await readKnowledgeAgain(store, busOf(store).bus);
  const [again] = await kb.search("vector", ["gemv-speed"], { kinds: ["experiment"] });
  assert.equal(again?.body, whole);
  assert.equal(again?.meta.result, "Result: attempt a-1 (submitted)");
  const reading = (
    await rowsBehind(store, "select value from kb_meta where key = 'reading'")
  )[0] as {
    value: string;
  };
  assert.equal(reading.value, "4");
});

test("control reads a run recorded under its names from before 2026-10-15, as the harness does (goal 162)", async () => {
  const store = controlStore();
  await ingest(store, "rig-a", [
    ["harness", "instance_created", "old-1", { campaign: "old-speed", mode: "goal" }],
    ["harness", "instance_status", "old-1", { status: "paused", reason: "the owner paused it" }],
  ]);
  const [run] = await store.kb().search("", ["old-speed"], { kinds: ["run"] });
  assert.equal(run?.run, "old-1");
  assert.match(String(run?.body), /Mode: goal[\s\S]*Status: paused \(the owner paused it\)/);
});
