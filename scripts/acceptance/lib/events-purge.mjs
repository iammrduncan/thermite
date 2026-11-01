// A retention policy's purge of control's copy of the rigs' events (control/events/days.ts),
// against the bus check's real server (bus.mjs): what the tests' fake bus stands in for, on the
// pinned NATS server.
//   - The `EVENTS` stream, made with today's settings, holds a few hundred events of two rigs, on
//     their runs' subjects (one run both rigs used) and their own, with the headers control's
//     writer and its move put on them.
//   - A retention policy of rig-a's old events, run as control runs one: whole days purged by
//     subject before a place; nothing of rig-b's touched where both rigs' events of one run lie
//     among each other; each ledger's floor; and control's writer does not store again an event
//     below the floor.
//   - Control's user may purge the stream but never delete it; a rig's user may do neither.
// The server stamps each message with its own clock, so the check can't store events on past
// days: the days a policy reads are those of the events' own times, handed to the days' record as
// the time the stream stored each.
import { jetstreamManager } from "@nats-io/jetstream";

const { BUS_READ_MAX } = await import("../../../src/common/bus/index.ts");
const { inBatches, onBus, outgoing, publishAfter } = await import(
  "../../../src/control/events/batch.ts"
);
const { EventDays, keepEventDays } = await import("../../../src/control/events/days.ts");
const { EventsWriter } = await import("../../../src/control/events/index.ts");
const { createPolicy, runPolicy } = await import("../../../src/control/retention/index.ts");
const { EVENT_HEADERS, EVENT_STREAM } = await import("../../../src/core/link/events.ts");
const { reportMessageId } = await import("../../../src/core/link/report.ts");
const { RetentionSpec } = await import("../../../src/core/retention/index.ts");

const DAY_MS = 86_400_000;

/** The event a message holds: its data, as JSON. */
const eventIn = (data) => JSON.parse(data);

/** What a reader of the stream sees of a message: its place, subject, id, headers and data. */
const seen = (m) => ({
  seq: m.seq,
  subject: m.subject,
  id: m.header("Nats-Msg-Id") ?? null,
  rig: m.header(EVENT_HEADERS.rig) ?? null,
  ledger: m.header(EVENT_HEADERS.ledger) ?? null,
  report: m.header(EVENT_HEADERS.report) ?? null,
  row: m.header(EVENT_HEADERS.seq) ?? null,
  at: m.at ?? null,
  data: new TextDecoder().decode(m.data),
});

/** The stream's messages in order, as `seen` gives them. */
async function contents(bus) {
  const out = [];
  for (let from = 1; ; ) {
    const r = await bus.read(EVENT_STREAM, { from, limit: BUS_READ_MAX });
    out.push(...r.messages.map(seen));
    if (r.done || !r.messages.length) return out;
    from = r.next;
  }
}

/** The first place two lists of messages differ at, in words; "" when they are the same. */
function differs(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i]))
      return `at message ${i + 1}: ${JSON.stringify(a[i] ?? null).slice(0, 300)} then ${JSON.stringify(b[i] ?? null).slice(0, 300)}`;
  return "";
}

/**
 * Publishes pages of events as control did: a report's page as its writer does (each event with
 * its id, rig, ledger and report), a page of a store from before the stream as its move did (each
 * row with its place in control's table, and no id); in atomic batches, each naming the last
 * place it expects (batch.ts). Gives the stream's last place.
 */
async function publishPages(bus, pages) {
  let place = await bus.lastSeq(EVENT_STREAM);
  for (const p of pages) {
    const first = p.events[0]?.id ?? 1;
    const page = {
      ledger_id: p.ledger,
      cursor: first - 1,
      next: p.events.at(-1)?.id ?? first,
      events: p.events,
      generated_at: "",
    };
    const report = p.moved ? undefined : reportMessageId(page);
    const messages = p.events.map((event, i) => {
      const seq = p.moved ? p.moved + i : undefined;
      const m = onBus({ rig: p.rig, ledger: p.ledger, event, runIsTheRigs: true, report, seq });
      if ("error" in m) throw new Error(`event ${event.id} of ${p.rig}: ${m.error}`);
      return { out: outgoing(m.message), bytes: m.bytes };
    });
    for (const batch of inBatches(messages)) place = await publishAfter(bus, place, batch);
  }
  return place;
}

/**
 * The events, page by page, in the order control took them: on each of four days
 * (45, 44 and 43 days ago, and yesterday), three rounds, each rig's page after the other's, so
 * that their pages of the run both use, r-s, lie between each other's. rig-a has r-a1 (closed on
 * the third day), r-a2 (open) and r-s (closed on the third day), and its own events; rig-b has
 * r-b1 (open), r-s, and its own. Rig-a's first page came from a store from before the stream.
 */
function pagesOf(now) {
  const rigs = {
    "rig-a": { ledger: "ledger-a", runs: ["r-a1", "r-a2", "r-s"], closes: ["r-a1", "r-s"], id: 0 },
    "rig-b": { ledger: "ledger-b", runs: ["r-b1", "r-s"], closes: ["r-s"], id: 0 },
  };
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const daysAgo = [45, 44, 43, 1];
  const perPage = 12;
  const pages = [];
  for (const [day, ago] of daysAgo.entries())
    for (let round = 0; round < 3; round++)
      for (const [rig, r] of Object.entries(rigs)) {
        const live =
          day === daysAgo.length - 1 ? r.runs.filter((x) => !r.closes.includes(x)) : r.runs;
        const targets = [...live, null];
        const events = [];
        for (let j = 0; j < perPage; j++) {
          const at = new Date(today - ago * DAY_MS + (6 + 4 * round) * 3_600_000 + j * 60_000);
          const id = ++r.id;
          const base = { id, at: at.toISOString(), actor: "harness" };
          const closing = day === 2 && round === 2 ? perPage - r.closes.length : perPage;
          if (day === 0 && round === 0 && j < r.runs.length) {
            const run = r.runs[j];
            const body = { campaign: "speed", mode: "hill_climb" };
            events.push({ ...base, kind: "run_created", subject: run, run, body });
          } else if (j >= closing) {
            const run = r.closes[j - closing];
            const body = { status: "closed", reason: "done" };
            events.push({ ...base, kind: "run_status", subject: run, run, body });
          } else {
            const run = targets[j % targets.length];
            const kind =
              run === null ? "rig_check_started" : j % 3 ? "verdict" : "experiment_added";
            // Words beyond ASCII too: the copy keeps each message's bytes.
            const body = { n: id, note: "naïve — “kept”" };
            events.push({ ...base, kind, subject: run ?? `${rig}-check`, run, body });
          }
        }
        // The first page, moved from a store from before the stream, before any report.
        const moved = pages.length === 0 ? 1 : undefined;
        pages.push({ rig, ledger: r.ledger, events, moved });
      }
  return pages;
}

/**
 * The checks. `ctx` is the bus check's: `check` and `tried` (bus.mjs), control's connection
 * (`control`) and its bus (`bus`), rig-a's connection (`rigA`), and control's store with both
 * rigs enrolled. The events stream is there, with today's settings, and holds nothing yet.
 */
export async function eventsPurgeChecks(ctx) {
  const { check, tried, control, bus, rigA, store } = ctx;
  const now = Date.now();
  const jsm = await jetstreamManager(control);
  const aJsm = await jetstreamManager(rigA, { checkAPI: false });

  const last = await publishPages(bus, pagesOf(now));
  const before = await contents(bus);
  check(
    "the events stream holds both rigs' events, with the headers control's writer and move put on them",
    before.length === last &&
      before.some((m) => m.row !== null && m.id === null) &&
      before.every((m) => m.rig && m.ledger && (m.report || m.row)),
    { messages: before.length, last },
  );

  // The days' record a retention policy reads, as control's apply fills it (apply.ts), with each
  // message stored on its event's day (above), and purges on control's real bus.
  const days = new EventDays();
  const stamped = [];
  for (let from = 1; ; ) {
    const r = await bus.read(EVENT_STREAM, { from, limit: BUS_READ_MAX });
    for (const m of r.messages)
      stamped.push({ ...m, at: eventIn(new TextDecoder().decode(m.data)).at });
    if (r.done || !r.messages.length) break;
    from = r.next;
  }
  days.take(stamped);
  keepEventDays(store, days, bus);
  const spec = RetentionSpec.parse({
    name: "Rig-a's old events",
    kind: "events",
    rule: "older",
    older_n: 30,
    where: "rigs",
    rigs: ["rig-a"],
    when: "hand",
  });
  const policy = createPolicy(store, spec, false, "owner:check");
  const ran = await runPolicy({ store, privateKeyPem: "" }, policy.id, "hand", "owner:check");
  // What it must remove: rig-a's events of more than 30 days ago on r-a1's subjects and its own;
  // not r-a2's (open), and not r-s's, where rig-b's events, which it keeps, lie between rig-a's.
  const cut = now - 30 * DAY_MS;
  const old = (m) => Date.parse(eventIn(m.data).at) < cut;
  const mine = (m) =>
    m.rig === "rig-a" &&
    old(m) &&
    (m.subject.startsWith("thermite.run.r-a1.") || m.subject.startsWith("thermite.rig.rig-a."));
  const gone = before.filter(mine);
  const left = await contents(bus);
  const kept = before.filter((m) => !mine(m));
  check(
    "the policy purges rig-a's old days of r-a1 and its own, whole, and nothing else",
    !differs(kept, left) && ran.removed?.count === gone.length && gone.length > 0,
    differs(kept, left) || { removed: ran.removed?.count, expected: gone.length, said: ran.said },
  );
  check(
    "no event of rig-b is gone, on the run both rigs used too",
    before.filter((m) => m.rig === "rig-b").every((m) => left.some((x) => x.seq === m.seq)),
  );
  const ids = gone.filter((m) => m.ledger === "ledger-a").map((m) => eventIn(m.data).id);
  const floor = store.retention.floor("rig-a", "ledger-a");
  check(
    "rig-a's ledger's floor is its last event removed; rig-b's has none",
    floor === Math.max(...ids) && store.retention.floor("rig-b", "ledger-b") === 0,
    { floor, last_removed: Math.max(...ids) },
  );
  // Rig-a sends events the policy removed again, and a new one, as after a restore of an older
  // store: control's writer stores the new one alone, after the stream's last place.
  const writer = new EventsWriter({ store, bus, apply: { reach: async () => true } });
  const removedAgain = gone.slice(0, 5).map((m) => eventIn(m.data));
  const lastId = Math.max(
    ...before.filter((m) => m.ledger === "ledger-a").map((m) => eventIn(m.data).id),
  );
  const fresh = {
    id: lastId + 1,
    at: new Date().toISOString(),
    actor: "harness",
    kind: "rig_check_started",
    subject: "rig-a-check",
    run: null,
    body: {},
  };
  const written = await writer.turn(() =>
    writer.publish({
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: 0,
      next: fresh.id,
      events: [...removedAgain, fresh],
      summary: {},
    }),
  );
  const added = (await contents(bus)).slice(left.length);
  check(
    "an event below the floor sent again is not stored again; the new one goes after the last place",
    written.added === 1 &&
      added.length === 1 &&
      added[0]?.seq === last + 1 &&
      added[0]?.id === `rig-a:ledger-a:${fresh.id}`,
    { written, added: added.map((m) => ({ seq: m.seq, id: m.id })) },
  );

  // Who may do what to it, with its events in it.
  check(
    "control's user may not delete the events stream",
    (await tried(() => jsm.streams.delete(EVENT_STREAM))) === "denied",
  );
  const rigPurge = await tried(() =>
    aJsm.streams.purge(EVENT_STREAM, { filter: "thermite.rig.rig-a.ev.*" }),
  );
  const rigDelete = await tried(() => aJsm.streams.delete(EVENT_STREAM));
  check(
    "a rig's user may neither purge it nor delete it",
    rigPurge === "denied" && rigDelete === "denied",
    { purge: rigPurge, delete: rigDelete },
  );
}
