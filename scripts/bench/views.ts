#!/usr/bin/env node
// The views' benchmark (goal 125, T12): what control's folds of its rigs' events cost as the
// events grow, on the fake message bus (tests/helpers/fake-bus.ts) with control's real writer and
// apply of the events stream. It is run by hand, not by `npm test`:
//
//   npm run bench:views                    100,000 events over 10 rigs
//   npm run bench:views -- --events 1000000
//
// It seeds the events as rigs' reports, a run's trials with their model calls, attempts, judge
// jobs and verdicts, rig-0 with an earlier ledger before a reset. Then it starts a second control
// on the same store and bus, whose folds are at 0, and prints:
//   - the seeding rate;
//   - the start-up pass: how long that control takes to fold the whole stream (it answers 503
//     until then);
//   - a read of every rig's view, and of one rig's, with nothing new;
//   - a report of 100 new events, and the read after it;
//   - the first look at the earlier ledger, which folds it from the stream;
//   - the heap after a collection, with the events on the fake bus: before the second control
//     starts, and with its folds.
// 1,000,000 events take about 2 GB of heap: run it with nothing else running.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findRunOn, rigView, rigViews } from "../../src/control/views/index.ts";
import { EVENT_STREAM } from "../../src/core/link/events.ts";
import { callUsage } from "../../src/core/usage.ts";
import {
  applied,
  busOf,
  closeBus,
  controlStore,
  ingestReport,
} from "../../tests/helpers/control-store.ts";
import { FakeBus } from "../../tests/helpers/fake-bus.ts";

const { values } = parseArgs({
  options: { events: { type: "string" }, rigs: { type: "string" } },
});
const EVENTS = Number(values.events ?? 100_000);
const RIGS = Number(values.rigs ?? 10);
/** Events in one report, as a rig's supervisor sends a page of its ledger. */
const PAGE = 500;
/** Trials in one run, and events in one trial. */
const TRIALS = 100;
const EARLIER = "ledger-earlier";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with node --expose-gc (npm run bench:views does)");
const heapMiB = () => {
  gc();
  return process.memoryUsage().heapUsed / 2 ** 20;
};
const ms = (from: number) => performance.now() - from;
const time = async <T>(f: () => T | Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await f();
  return [r, ms(t)];
};

interface Ev {
  kind: string;
  subject: string | null;
  run: string | null;
  body: Record<string, unknown>;
}

/** One trial of a run: its model calls, its attempt, the judge's job and verdict. */
function trial(run: string, n: number): Ev[] {
  const t = `${run}-t${n}`;
  const attempt = `${run}-a${n}`;
  const job = `${run}-j${n}`;
  const lane = `lane-${(n % 3) + 1}`;
  const call = (i: number): Ev => ({
    kind: "model_call",
    subject: run,
    run,
    body: {
      trial: t,
      round: null,
      agent: "workers",
      harness: "pi",
      provider: "lab",
      model: "wide-model",
      ...callUsage({ at: Date.UTC(2026, 9, 29, 0, n, i), tokensIn: 1000, tokensOut: 200 }),
    },
  });
  return [
    { kind: "trial_started", subject: run, run, body: { trial: t, lane, family: "f", focus: "x" } },
    call(1),
    call(2),
    call(3),
    { kind: "attempt_recorded", subject: attempt, run, body: { run, lane, lifecycle: "queued" } },
    { kind: "job_queued", subject: job, run, body: { attempt, kind: "screen", run } },
    { kind: "job_leased", subject: job, run, body: {} },
    { kind: "job_finished", subject: job, run, body: { state: "done" } },
    { kind: "verdict", subject: attempt, run, body: { verdict: "regress", delta: -0.01 } },
    { kind: "trial_finished", subject: run, run, body: { trial: t, lane, stopped: "submitted" } },
  ];
}

/** A rig ledger's events: runs of TRIALS trials, opened and closed, `count` events in all. */
function* ledgerEvents(prefix: string, count: number): Generator<Ev> {
  let made = 0;
  for (let r = 0; made < count; r++) {
    const run = `${prefix}-r${r}`;
    const all: Ev[] = [
      { kind: "run_created", subject: run, run, body: { campaign: "speed", mode: "hill_climb" } },
      { kind: "run_status", subject: run, run, body: { status: "running", reason: null } },
    ];
    for (let n = 0; n < TRIALS; n++) all.push(...trial(run, n));
    all.push({ kind: "run_status", subject: run, run, body: { status: "closed", reason: "done" } });
    for (const e of all) {
      if (made++ >= count) return;
      yield e;
    }
  }
}

/** A rig ledger's events sent as its reports, PAGE at a time, after its event `from`. */
async function send(
  store: ReturnType<typeof controlStore>,
  rig: string,
  ledger: string,
  events: Iterable<Ev>,
  from = 0,
): Promise<number> {
  let id = from;
  let page: Ev[] = [];
  const flush = async () => {
    if (!page.length) return;
    const first = id - page.length + 1;
    await ingestReport(store, {
      rig,
      ledger_id: ledger,
      cursor: first - 1,
      next: id,
      generated_at: new Date().toISOString(),
      summary: {},
      events: page.map((e, i) => ({
        id: first + i,
        at: new Date(Date.UTC(2026, 9, 29) + (first + i) * 1000).toISOString(),
        actor: "harness",
        ...e,
      })),
    });
    page = [];
  };
  for (const e of events) {
    id++;
    page.push(e);
    if (page.length === PAGE) await flush();
  }
  await flush();
  return id;
}

const dir = mkdtempSync(join(tmpdir(), "thermite-bench-"));
const path = join(dir, "control.db");
const bus = new FakeBus();
const rows: [string, string][] = [];
const say = (what: string, value: string) => {
  rows.push([what, value]);
  console.log(`${what}: ${value}`);
};
try {
  const seeding = controlStore(path, bus);
  const perRig = Math.floor(EVENTS / RIGS);
  const earlier = Math.min(1_000, Math.floor(perRig / 10));
  const seedStart = performance.now();
  const last = new Map<string, number>();
  await send(seeding, "rig-0", EARLIER, ledgerEvents("rig-0-old", earlier));
  for (let i = 0; i < RIGS; i++) {
    const rig = `rig-${i}`;
    const count = i === 0 ? perRig - earlier : perRig;
    last.set(rig, await send(seeding, rig, `ledger-${i}`, ledgerEvents(rig, count)));
  }
  const seeded = ms(seedStart);
  const total = await bus.lastSeq(EVENT_STREAM);
  say("events", `${total.toLocaleString("en-US")} over ${RIGS} rigs`);
  say(
    "seeding",
    `${(seeded / 1000).toFixed(1)} s, ${Math.round(total / (seeded / 1000))} events/s`,
  );
  closeBus(seeding);
  seeding.db.close();
  const heapBefore = heapMiB();

  // A control started on the same store and stream: its folds are at 0.
  const store = controlStore(path, bus);
  const [, startup] = await time(() => applied(store));
  say("start-up pass", `${(startup / 1000).toFixed(2)} s`);
  const folds = busOf(store).apply.folds;
  if (folds.through !== total) throw new Error(`the folds reached ${folds.through} of ${total}`);

  rigViews(store);
  const [all, nothingNew] = await time(() => rigViews(store));
  say("every rig's view, nothing new", `${nothingNew.toFixed(2)} ms (${all.length} rigs)`);
  const [, one] = await time(() => rigView(store, "rig-1"));
  say("one rig's view, nothing new", `${one.toFixed(2)} ms`);

  const extra = [...ledgerEvents("rig-1-more", 100)];
  const [, report] = await time(() =>
    send(store, "rig-1", "ledger-1", extra, last.get("rig-1") ?? 0),
  );
  say("a report of 100 new events, applied", `${report.toFixed(1)} ms`);
  const [, after] = await time(() => rigViews(store));
  say("every rig's view after it", `${after.toFixed(2)} ms`);

  const [found, earlierMs] = await time(() => findRunOn(store, "rig-0", "rig-0-old-r0"));
  if (!found) throw new Error("the earlier ledger's run was not found");
  say(
    "the earlier ledger's first look",
    `${earlierMs.toFixed(1)} ms (${earlier.toLocaleString("en-US")} events)`,
  );
  const [, again] = await time(() => findRunOn(store, "rig-0", "rig-0-old-r0"));
  say("the earlier ledger again", `${again.toFixed(2)} ms`);

  const heapAfter = heapMiB();
  say("heap with the events on the bus", `${heapBefore.toFixed(1)} MiB`);
  say(
    "heap with the folds",
    `${heapAfter.toFixed(1)} MiB (+${(heapAfter - heapBefore).toFixed(1)})`,
  );
  closeBus(store);
  store.db.close();
  console.log(
    `\n| What | ${EVENTS.toLocaleString("en-US")} events |\n| --- | --- |\n${rows.map(([w, v]) => `| ${w} | ${v} |`).join("\n")}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
