import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readKnowledgeAgain } from "../../src/control/events/index.ts";
import { runPrompts } from "../../src/control/prompts.ts";
import { EventsTable } from "../../src/control/store/events.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import { findRunOn, keepFolds, rigView } from "../../src/control/views/index.ts";
import { EVENT_HEADERS, EVENT_STREAM } from "../../src/core/link/events.ts";
import { assigned } from "../helpers/assignments.ts";
import { controlOnly } from "../helpers/control-stack.ts";
import { applied, busOf, closeBus, controlStore, ingestReport } from "../helpers/control-store.ts";
import { keepOldRows, withEventsTable } from "../helpers/old-store.ts";

/**
 * Control's views and its raw reads of events come from the message bus's `EVENTS` stream (goal
 * 168, step 4, part 4.4b): control started again builds its folds in one pass over the stream
 * and applies nothing again; `GET /v1/rigs/<rig>/events` pages a rig's events by their places in
 * the stream, over its ledgers, with no other rig's; a run's prompts are its rig's alone; the
 * knowledge base reads again from the stream what an upgrade of its reading needs, bounded as
 * the apply's own indexing is; and nothing in control but the move reads the events table of a
 * store from before the stream.
 */

type Ev = {
  id: number;
  kind: string;
  subject?: string | null;
  run?: string | null;
  body?: unknown;
};

/** A page of a rig's ledger, taken as a report that passed control's checks is. */
async function page(store: ControlStore, rig: string, ledger: string, events: Ev[]): Promise<void> {
  const first = events[0]?.id ?? 1;
  await ingestReport(store, {
    rig,
    ledger_id: ledger,
    cursor: first - 1,
    next: events.at(-1)?.id ?? first,
    generated_at: new Date().toISOString(),
    summary: {},
    events: events.map((e) => ({
      id: e.id,
      at: new Date(Date.UTC(2026, 9, 29, 6, 0, 0, e.id)).toISOString(),
      actor: "harness",
      kind: e.kind,
      subject: e.subject ?? null,
      body: e.body ?? { n: e.id },
      run: e.run ?? null,
    })),
  });
}

const OPTS = { staleAfterMs: 600_000, now: Date.UTC(2026, 9, 29, 7) };

/**
 * rig-a: r-1 of gemv in ledger l-1, then a full reset and r-3 in l-2; rig-b: r-2, and a run of
 * the name r-1 of its own (named before goal 170). Each with a rig's own event.
 */
async function fill(store: ControlStore): Promise<void> {
  const run = (id: number, kind: string, r: string, body: unknown = { n: id }): Ev => ({
    id,
    kind,
    subject: r,
    run: r,
    body,
  });
  await page(store, "rig-a", "l-1", [
    run(1, "run_created", "r-1", { campaign: "gemv", mode: "goal" }),
    run(2, "run_status", "r-1", { status: "running", reason: null }),
    { id: 3, kind: "rig_check_started", body: { check: "smoke", id: "chk-1" } },
    run(4, "experiment_added", "r-1", { id: "x-1", title: "tile", by: "planner", state: "queued" }),
  ]);
  await page(store, "rig-b", "l-b", [
    run(1, "run_created", "r-2", { campaign: "gemv", mode: "goal" }),
    run(2, "run_created", "r-1", { campaign: "old", mode: "goal" }),
    run(3, "run_status", "r-1", { status: "paused", reason: "rig-b's own" }),
  ]);
  await page(store, "rig-a", "l-1", [
    run(5, "run_status", "r-1", { status: "paused", reason: "a" }),
  ]);
  await page(store, "rig-a", "l-2", [
    run(1, "run_created", "r-3", { campaign: "gemv", mode: "goal" }),
    { id: 2, kind: "rig_check_finished", body: { check: "smoke", id: "chk-2", ok: true } },
    run(3, "run_status", "r-3", { status: "running", reason: null }),
  ]);
}

describe("control's views and raw reads from the events stream", () => {
  test("control started again builds its views in one pass over the stream, and applies nothing again", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-views-")), "control.db");
    const first = controlStore(path);
    await fill(first);
    await applied(first);
    const views = (s: ControlStore) => ["rig-a", "rig-b"].map((r) => rigView(s, r, OPTS));
    const before = views(first);
    assert.deepEqual(
      before.map((v) => [v?.id, v?.ledger_id, v?.runs.map((r) => r.id)]),
      [
        ["rig-a", "l-2", ["r-3"]],
        ["rig-b", "l-b", ["r-2", "r-1"]],
      ],
    );
    const { bus } = busOf(first);
    closeBus(first);
    // Control starts again on the same store and stream: its folds come from the stream's first
    // message, while the store's records stay as they were.
    const second = controlStore(path, bus);
    await applied(second);
    assert.equal(busOf(second).apply.applied, 0, "no record applied again");
    assert.equal(keepFolds(second).through, await bus.lastSeq(EVENT_STREAM));
    assert.deepStrictEqual(views(second), before);
    assert.deepEqual(
      keepFolds(second)
        .held()
        .map((h) => [h.rig, h.ledger])
        .sort(),
      [
        ["rig-a", "l-2"],
        ["rig-b", "l-b"],
      ],
    );
    // An earlier ledger's run is read from the stream when its page needs it.
    const earlier = await findRunOn(second, "rig-a", "r-1", OPTS);
    assert.deepEqual([earlier?.earlier, earlier?.run.status], ["reset", "paused"]);
    // New events reach the views of the control started again.
    await page(second, "rig-b", "l-b", [
      {
        id: 4,
        kind: "run_status",
        subject: "r-2",
        run: "r-2",
        body: { status: "paused", reason: "b" },
      },
    ]);
    await applied(second);
    assert.equal(
      rigView(second, "rig-b", OPTS)?.runs.find((r) => r.id === "r-2")?.status,
      "paused",
    );
  });

  test("a retired rig's fold is read from the stream after control starts again, and kept when it is brought back", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-views-")), "control.db");
    const first = controlStore(path);
    await fill(first);
    await applied(first);
    const before = rigView(first, "rig-b", OPTS);
    first.retired.add("rig-b", "owner:test");
    const { bus } = busOf(first);
    closeBus(first);
    const second = controlStore(path, bus);
    await applied(second);
    // The start pass made no fold of the retired rig: its run is read from the stream.
    assert.deepEqual(
      keepFolds(second)
        .held()
        .map((h) => h.rig),
      ["rig-a"],
    );
    const r2 = await findRunOn(second, "rig-b", "r-2", OPTS);
    assert.deepEqual([r2?.earlier, r2?.run.id], ["retired", "r-2"]);
    // Brought back: its fold is ready first, and its view is whole.
    await keepFolds(second).restore("rig-b");
    second.retired.bringBack("rig-b", "owner:test");
    assert.deepStrictEqual(rigView(second, "rig-b", OPTS), before);
  });

  test("GET /v1/rigs/<rig>/events pages a rig's events by their places in the stream, over its ledgers, with no other rig's", async () => {
    const { store, api } = controlOnly();
    await fill(store);
    await applied(store);
    const { bus } = busOf(store);
    type Raw = { seq: number; ledger_id: string; id: number; kind: string; run: string | null };
    const pages = async (rig: string, limit: number) => {
      const all: Raw[][] = [];
      for (let after = 0; ; ) {
        const r = await api("GET", `/v1/rigs/${rig}/events?after=${after}&limit=${limit}`);
        assert.equal(r.status, 200);
        const { events } = (await r.json()) as { events: Raw[] };
        all.push(events);
        if (events.length < limit) return all;
        after = (events.at(-1) as Raw).seq;
      }
    };
    const a = await pages("rig-a", 2);
    assert.deepEqual(
      a.map((p) => p.length),
      [2, 2, 2, 2, 0],
    );
    const events = a.flat();
    assert.deepEqual(
      events.map((e) => [e.ledger_id, e.id, e.kind, e.run]),
      [
        ["l-1", 1, "run_created", "r-1"],
        ["l-1", 2, "run_status", "r-1"],
        ["l-1", 3, "rig_check_started", null],
        ["l-1", 4, "experiment_added", "r-1"],
        ["l-1", 5, "run_status", "r-1"],
        ["l-2", 1, "run_created", "r-3"],
        ["l-2", 2, "rig_check_finished", null],
        ["l-2", 3, "run_status", "r-3"],
      ],
    );
    // Each one's seq is its place in the stream, where its message names the rig and the event.
    for (const e of events) {
      const m = await bus.message(EVENT_STREAM, e.seq);
      assert.equal(m?.header(EVENT_HEADERS.rig), "rig-a");
      assert.equal(m?.header(EVENT_HEADERS.ledger), e.ledger_id);
      assert.equal((JSON.parse(new TextDecoder().decode(m?.data)) as { id: number }).id, e.id);
    }
    assert.ok(events.every((e, i) => i === 0 || e.seq > (events[i - 1] as Raw).seq));
    // Its answer's shape is as before, with when control took each event: when the stream stored it.
    assert.deepEqual(Object.keys(events[0] as Raw), [
      "seq",
      "ledger_id",
      "id",
      "at",
      "actor",
      "kind",
      "subject",
      "body",
      "run",
      "received_at",
    ]);
    assert.ok(
      events.every((e) => typeof (e as { received_at?: unknown }).received_at === "string"),
    );
    // rig-b's: its own runs, r-1 of its own among them, and nothing of rig-a's.
    assert.deepEqual(
      (await pages("rig-b", 500)).flat().map((e) => [e.id, e.kind, e.run]),
      [
        [1, "run_created", "r-2"],
        [2, "run_created", "r-1"],
        [3, "run_status", "r-1"],
      ],
    );
    // One page of all; none after the end; none for a rig with no events or a name no rig has.
    assert.equal((await pages("rig-a", 5000)).flat().length, 8);
    const end = (events.at(-1) as Raw).seq;
    const after = await api("GET", `/v1/rigs/rig-a/events?after=${end}`);
    assert.deepEqual(await after.json(), { events: [] });
    for (const rig of ["rig-c", "Not_A_Rig"]) {
      const r = await api("GET", `/v1/rigs/${rig}/events`);
      assert.deepEqual(await r.json(), { events: [] });
    }
  });

  test("a run's prompts are read from the stream, its rig's alone", async () => {
    const store = controlStore();
    const prompt = (id: number, text: string) => ({
      id,
      role: "worker",
      program: "pi",
      turn: 0,
      lane: "lane-1",
      trial: null,
      call: null,
      version: "0123456789ab",
      chars: text.length,
      sections: [
        { id: "task", source: "assignment", part: "user", chars: text.length, sha256: "x", text },
      ],
    });
    // rig-a's p-1, and rig-b's run of the same name (named before goal 170).
    await page(store, "rig-a", "l-1", [
      { id: 1, kind: "run_created", subject: "p-1", run: "p-1", body: { campaign: "c" } },
      { id: 2, kind: "agent_prompt", subject: "p-1", run: "p-1", body: prompt(2, "rig-a's first") },
      {
        id: 3,
        kind: "agent_prompt",
        subject: "p-1",
        run: "p-1",
        body: prompt(3, "rig-a's second"),
      },
    ]);
    await page(store, "rig-b", "l-b", [
      { id: 1, kind: "run_created", subject: "p-1", run: "p-1", body: { campaign: "c" } },
      { id: 2, kind: "agent_prompt", subject: "p-1", run: "p-1", body: prompt(2, "rig-b's") },
    ]);
    await applied(store);
    const a = await findRunOn(store, "rig-a", "p-1", OPTS);
    const b = await findRunOn(store, "rig-b", "p-1", OPTS);
    assert.ok(a && b);
    assert.deepEqual(
      (await runPrompts(store, a)).map((p) => [p.id, p.chars]),
      [
        [2, "rig-a's first".length],
        [3, "rig-a's second".length],
      ],
    );
    assert.deepEqual(
      (await runPrompts(store, b)).map((p) => [p.id, p.chars]),
      [[2, "rig-b's".length]],
    );
  });

  test("the knowledge base reads again what it read before an upgrade: to the store's place, and to the hand-over mark", async () => {
    // A store from before the stream, its five events in its events table, moved at the start.
    const path = join(mkdtempSync(join(tmpdir(), "thermite-views-")), "control.db");
    const old = new ControlStore(path);
    assigned(old, "rig-a", "r-1", "gemv");
    withEventsTable(old.db);
    const added = (id: number, x: string) => ({
      rig: "rig-a",
      ledger: "l-1",
      id,
      kind: "experiment_added",
      subject: "r-1",
      run: "r-1",
      body: { id: x, title: `try ${x}`, by: "planner", state: "queued" },
    });
    keepOldRows(old.db, [
      {
        rig: "rig-a",
        ledger: "l-1",
        id: 1,
        kind: "run_created",
        subject: "r-1",
        run: "r-1",
        body: { campaign: "gemv" },
      },
      added(2, "x-1"),
      added(3, "x-2"),
      added(4, "x-3"),
      added(5, "x-4"),
    ]);
    old.db.close();
    const store = controlStore(path);
    await applied(store);
    assert.equal(store.eventsTable.exists(), false, "moved, and dropped");
    const experiments = () =>
      store
        .kb()
        .search("", ["gemv"], { kinds: ["experiment"] })
        .map((x) => x.ref)
        .sort();
    assert.deepEqual(experiments(), ["x-1", "x-2", "x-3", "x-4"]);
    // As a store before reading 3 holds it: no experiment items; applied to place 2, and indexed
    // from control's events table to its seq 4 (the hand-over mark).
    closeBus(store);
    store.db.exec("delete from kb_item where kind = 'experiment'");
    store.db.exec("update kb_meta set value = '2' where key = 'reading'");
    store.db.exec("update kb_cursor set seq = 4");
    store.busPositions.set(EVENT_STREAM, 2);
    const again = await readKnowledgeAgain(store, busOf(store).bus);
    // Places 1 and 2 were applied; seqs 3 and 4 indexed from the table: x-1 to x-3. The apply
    // indexes x-4 when it comes to it.
    assert.equal(again, 3);
    assert.deepEqual(experiments(), ["x-1", "x-2", "x-3"]);
    assert.equal(await readKnowledgeAgain(store, busOf(store).bus), 0, "once only");
  });

  test("nothing in control reads the events table but the move and the store's migrations", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
      });
    const naming = files("src").filter((f) => /\brig_event\b/.test(readFileSync(f, "utf8")));
    assert.deepEqual(naming.sort(), [
      "src/control/store/events.ts",
      "src/control/store/runs.ts",
      "src/control/store/schema.ts",
    ]);
    // The store's part keeps no event: it reads an old store's table for the move alone.
    const methods = Object.getOwnPropertyNames(EventsTable.prototype).filter(
      (m) => m !== "constructor",
    );
    assert.deepEqual(methods.sort(), ["at", "countAfter", "exists", "inOrder", "size"]);
    for (const read of methods) {
      const callers = files("src").filter((f) =>
        new RegExp(`eventsTable\\.${read}\\(`).test(readFileSync(f, "utf8")),
      );
      assert.deepEqual(callers, ["src/control/events/move.ts"], read);
    }
  });
});
