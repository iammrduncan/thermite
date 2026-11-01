// The events stream made again once (control/events/rebuild.ts), and a retention policy's purge
// of it (control/events/days.ts), against the bus check's real server (bus.mjs): what the tests'
// fake bus stands in for, on the pinned NATS server.
//   - An `EVENTS` stream with the settings control gave it before v0.1.1 made it again (today's,
//     and deny_delete and deny_purge), holding a few hundred events of two rigs, on their runs'
//     subjects and their own, with the headers control's writer and its move put on them: it
//     refuses purges, and no update makes it stop, in the words the tests' fake bus gives.
//   - The rebuild, with control's user and BusUsers.whileRebuilding, as main.ts wires it: every
//     message at its place, with its subject, id, headers, data and first time; the copy gone; the
//     new stream without the deny settings; control's user may purge it but not delete it after;
//     a rig's user may do neither.
//   - A retention policy of rig-a's old events, run as control runs one: whole days purged by
//     subject before a place, nothing of rig-b's touched where both rigs' events of one run lie
//     together; each ledger's floor; and control's writer does not store again an event below it.
//   - A second such stream, from a first place past 1 and of several batches, made again with
//     stops part way: during the copy, at a delete the users file does not allow, and during the
//     copy back after a batch stored whose ack was lost. Each start goes on from where the last
//     stopped, and the end is the same: nothing doubled, lost or moved.
// The server stamps each message with its own clock, so the check can't store events on past
// days: the days a policy reads are those of the events' own times, handed to the days' record as
// the time control first stored each (its `Thermite-Received` header, which the rebuild keeps).
import { chmodSync } from "node:fs";
import { JetStreamApiError, jetstreamManager } from "@nats-io/jetstream";

const { BUS_READ_MAX } = await import("../../../src/common/bus/index.ts");
const { BusUsers, reloadBus } = await import("../../../src/control/bus/index.ts");
const { inBatches, onBus, outgoing, publishAfter } = await import(
  "../../../src/control/events/batch.ts"
);
const { EventDays, keepEventDays } = await import("../../../src/control/events/days.ts");
const { EventsRebuild, EventsWriter } = await import("../../../src/control/events/index.ts");
const { createPolicy, runPolicy } = await import("../../../src/control/retention/index.ts");
const { SecretBox } = await import("../../../src/control/secrets.ts");
const {
  COPY_DUPLICATE_WINDOW_NS,
  EVENT_HEADERS,
  EVENT_REBUILD_STREAM,
  EVENT_STREAM,
  EVENT_STREAM_CONFIG,
} = await import("../../../src/core/link/events.ts");
const { reportMessageId } = await import("../../../src/core/link/report.ts");
const { RetentionSpec } = await import("../../../src/core/retention/index.ts");
// What the tests' fake bus says the server answers, which the server's own answers must match.
const fake = await import("../../../tests/helpers/fake-bus.ts");

/** The settings control gave the stream before v0.1.1 made it again: today's, and the two denies. */
const BEFORE_REBUILD = { ...EVENT_STREAM_CONFIG, deny_delete: true, deny_purge: true };
const DAY_MS = 86_400_000;
/** How long a rebuild may take here before the check calls it stuck. */
const REBUILD_WAIT_MS = 120_000;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** `p`, or a failure in words when it takes longer than `ms`. */
const within = (ms, what, p) =>
  Promise.race([
    p,
    pause(ms).then(() => {
      throw new Error(`${what} did not end within ${ms / 1000} seconds`);
    }),
  ]);

/** The server's refusal of a call as its API gave it, or how else the call ended. */
async function refusalOf(fn) {
  try {
    await fn();
    return "allowed";
  } catch (err) {
    return err instanceof JetStreamApiError ? err.apiError() : String(err?.message ?? err);
  }
}

/** Whether the server's refusal is the one the fake bus gives. */
const asTheFakeSays = (refusal, words) => JSON.stringify(refusal) === JSON.stringify(words);

/** The event a message holds: its data, as JSON. */
const eventIn = (data) => JSON.parse(data);

/** What a reader of the stream sees of a message: each part a rebuild must keep as it was. */
const seen = (m) => ({
  seq: m.seq,
  subject: m.subject,
  id: m.header("Nats-Msg-Id") ?? null,
  rig: m.header(EVENT_HEADERS.rig) ?? null,
  ledger: m.header(EVENT_HEADERS.ledger) ?? null,
  report: m.header(EVENT_HEADERS.report) ?? null,
  row: m.header(EVENT_HEADERS.seq) ?? null,
  received: m.header(EVENT_HEADERS.received) ?? m.at ?? null,
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
 * The first stream's events, page by page, in the order control took them: on each of four days
 * (45, 44 and 43 days ago, and yesterday), three rounds, each rig's page after the other's, so
 * that their pages of the run both use, r-s, lie between each other's. rig-a has r-a1 (closed on
 * the third day), r-a2 (open) and r-s (closed on the third day), and its own events; rig-b has
 * r-b1 (open), r-s, and its own. Rig-a's first page came from a store from before the stream.
 */
function firstStreamPages(now) {
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

/** The second stream's events: 2,600, in pages of 100 of each rig in turn, the first page moved. */
function secondStreamPages(now) {
  const pages = [];
  const ids = { "rig-a": 0, "rig-b": 0 };
  for (let p = 0; p < 26; p++) {
    const rig = p % 2 ? "rig-b" : "rig-a";
    const events = [];
    for (let j = 0; j < 100; j++) {
      const id = ++ids[rig];
      const run = j % 4 ? `run-${rig}` : null;
      const at = new Date(now - (26 - p) * 3_600_000 + j * 1000).toISOString();
      const kind = run ? "verdict" : "rig_check_started";
      events.push({ id, at, actor: "harness", kind, subject: run ?? rig, run, body: { n: id } });
    }
    pages.push({ rig, ledger: `${rig}-second`, events, moved: p === 0 ? 1 : undefined });
  }
  return pages;
}

/**
 * The checks. `ctx` is the bus check's: `check`, `tried` and `deniedBy` (bus.mjs), control's connection
 * (`control`) and its bus (`bus`), rig-a's connection (`rigA`), the check's keys and control's
 * store with both rigs enrolled (rig-b retired already from the server), the users file
 * (`usersFile`), `copyUsers` that puts it on the server, and the server's `url` and `trust`.
 */
export async function eventsRebuildChecks(ctx) {
  const { check, tried, deniedBy, control, bus, rigA, keys, store, usersFile, copyUsers } = ctx;
  const { url, trust } = ctx;
  const now = Date.now();
  const jsm = await jetstreamManager(control);
  const aJsm = await jetstreamManager(rigA, { checkAPI: false });

  // Control's bus users, as main.ts makes them, with the check's keys for control's own: the
  // users file as control writes it, put on the server and reloaded, as compose shares it.
  const secrets = SecretBox.ephemeral();
  for (const name of ["control", "system"])
    store.busKeys.addIdentity(
      name,
      keys[name].publicKey,
      secrets.seal(new TextDecoder().decode(keys[name].seed)),
    );
  store.retired.add("rig-b", "check");
  const busUsers = new BusUsers({
    store,
    secrets,
    file: usersFile,
    reload: async (seed) => {
      chmodSync(usersFile, 0o644);
      copyUsers();
      await reloadBus(url, seed, trust);
    },
  });
  await busUsers.sync();
  check(
    "control's user may delete the events stream while BusUsers says it makes it again",
    (await tried(() => busUsers.whileRebuilding(() => bus.deleteStream(EVENT_STREAM)))) ===
      "allowed",
  );
  check(
    "and may not once it is done: the users file reloaded again",
    (await tried(() => jsm.streams.delete(EVENT_STREAM))) === "denied",
  );

  // ---------------------------------------------------------------- the first stream

  await jsm.streams.add(BEFORE_REBUILD);
  const last = await publishPages(bus, firstStreamPages(now));
  const before = await contents(bus);
  check(
    "a stream as control made it before v0.1.1 holds both rigs' events, with their headers",
    before.length === last &&
      before.some((m) => m.row !== null && m.id === null) &&
      before.every((m) => m.rig && m.ledger && (m.report || m.row)),
    { messages: before.length, last },
  );
  const refused = await refusalOf(() =>
    jsm.streams.purge(EVENT_STREAM, { filter: "thermite.rig.rig-a.ev.*" }),
  );
  check("it refuses a purge, as the fake bus says", asTheFakeSays(refused, fake.NO_PURGE), refused);
  const update = (deny) =>
    refusalOf(() => jsm.streams.update(EVENT_STREAM, { ...EVENT_STREAM_CONFIG, ...deny }));
  const both = await update({ deny_delete: false, deny_purge: false });
  const purges = await update({ deny_delete: true, deny_purge: false });
  check(
    "the server refuses an update that would let it take deletes or purges, as the fake bus says",
    asTheFakeSays(both, fake.NO_DENY_DELETE_CHANGE) &&
      asTheFakeSays(purges, fake.NO_DENY_PURGE_CHANGE),
    { both, purges },
  );
  // As control's makeStream puts today's settings on a stream (common/bus/streams.ts): the
  // library keeps what they do not name, the two denies among them.
  const put = await tried(() => jsm.streams.update(EVENT_STREAM, EVENT_STREAM_CONFIG));
  const still = (await jsm.streams.info(EVENT_STREAM)).config;
  check(
    "today's settings put on it as makeStream does leave it refusing purges",
    put === "allowed" && still.deny_purge === true && still.deny_delete === true,
    { update: put, deny_purge: still.deny_purge, deny_delete: still.deny_delete },
  );

  let deletes = 0;
  const asMain = () =>
    new EventsRebuild({
      bus,
      allowDelete: (work) => {
        deletes++;
        return busUsers.whileRebuilding(work);
      },
    });
  const rebuild = asMain();
  const started = performance.now();
  await within(REBUILD_WAIT_MS, "the rebuild", rebuild.run());
  const seconds = Math.round(performance.now() - started) / 1000;
  check(
    "control makes the stream again once, deleting the old one at its first try",
    rebuild.done === "rebuilt" && rebuild.stopped === null && deletes === 1,
    { done: rebuild.done, stopped: rebuild.stopped, deletes, copied: rebuild.copied, seconds },
  );
  const after = await contents(bus);
  const moved = differs(before, after);
  check(
    "every message is at its place, with its subject, id, headers, data and first time",
    !moved && after.length === before.length,
    moved || `${after.length} messages`,
  );
  const raw = (await bus.read(EVENT_STREAM, { limit: BUS_READ_MAX })).messages;
  check(
    "the time control first stored each is in its header now; the server's own is the copy's",
    raw.length === before.length &&
      raw.every((m, i) => {
        const first = before[i]?.received ?? "";
        return m.header(EVENT_HEADERS.received) === first && String(m.at) > first;
      }),
    { first: before[0]?.received, header: raw[0]?.header(EVENT_HEADERS.received), at: raw[0]?.at },
  );
  const info = await jsm.streams.info(EVENT_STREAM);
  check("the copy is gone", (await bus.streamInfo(EVENT_REBUILD_STREAM)) === undefined);
  check(
    "the stream made again has today's settings, and starts where it started",
    !info.config.deny_purge &&
      !info.config.deny_delete &&
      info.config.duplicate_window === EVENT_STREAM_CONFIG.duplicate_window &&
      info.state.first_seq === before[0]?.seq &&
      info.state.last_seq === last,
    {
      deny_purge: info.config.deny_purge ?? null,
      duplicate_window: info.config.duplicate_window,
      first_seq: info.state.first_seq,
      last_seq: info.state.last_seq,
    },
  );
  check(
    "control's user may purge it now",
    (await tried(() =>
      jsm.streams.purge(EVENT_STREAM, { filter: "thermite.rig.rig-none.ev.*" }),
    )) === "allowed",
  );
  check(
    "and may not delete it",
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
  const again = asMain();
  await within(REBUILD_WAIT_MS, "the rebuild", again.run());
  check("started again, control finds nothing to make again", again.done === "current");

  // ---------------------------------------------------------------- a retention policy of it

  // The days' record a retention policy reads, as control's apply fills it (apply.ts), with each
  // message's first time that of its event (above), and purges on control's real bus.
  const days = new EventDays();
  const stamped = [];
  for (let from = 1; ; ) {
    const r = await bus.read(EVENT_STREAM, { from, limit: BUS_READ_MAX });
    for (const m of r.messages) {
      const at = eventIn(new TextDecoder().decode(m.data)).at;
      stamped.push({ ...m, at, header: (k) => (k === EVENT_HEADERS.received ? at : m.header(k)) });
    }
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
  const gone = after.filter(mine);
  const left = await contents(bus);
  const kept = after.filter((m) => !mine(m));
  check(
    "the policy purges rig-a's old days of r-a1 and its own, whole, and nothing else",
    !differs(kept, left) && ran.removed?.count === gone.length && gone.length > 0,
    differs(kept, left) || { removed: ran.removed?.count, expected: gone.length, said: ran.said },
  );
  check(
    "no event of rig-b is gone, on the run both rigs used too",
    after.filter((m) => m.rig === "rig-b").every((m) => left.some((x) => x.seq === m.seq)),
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
    ...after.filter((m) => m.ledger === "ledger-a").map((m) => eventIn(m.data).id),
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
  const now2 = await contents(bus);
  const added = now2.slice(left.length);
  check(
    "an event below the floor sent again is not stored again; the new one goes after the last place",
    written.added === 1 &&
      added.length === 1 &&
      added[0]?.seq === last + 1 &&
      added[0]?.id === `rig-a:ledger-a:${fresh.id}`,
    { written, added: added.map((m) => ({ seq: m.seq, id: m.id })) },
  );

  // ---------------------------------------------------------------- the second stream, stopped

  await busUsers.whileRebuilding(() => bus.deleteStream(EVENT_STREAM));
  await jsm.streams.add({ ...BEFORE_REBUILD, first_seq: 1001 });
  const secondLast = await publishPages(bus, secondStreamPages(now));
  const second = await contents(bus);
  check(
    "a second such stream starts at place 1001, and holds 2,600 events",
    second.length === 2600 && second[0]?.seq === 1001 && secondLast === 3600,
    { first: second[0]?.seq, last: secondLast, messages: second.length },
  );
  const state = async () => {
    const [ev, copy] = [
      await bus.streamInfo(EVENT_STREAM),
      await bus.streamInfo(EVENT_REBUILD_STREAM),
    ];
    const of = (s) =>
      s && {
        first: s.first_seq,
        last: s.last_seq,
        messages: s.messages,
        refuses: Boolean(s.config.deny_purge),
        window: s.config.duplicate_window,
      };
    return { events: of(ev), copy: of(copy) };
  };
  /** The bus with its next batches failing once `n` passed, `lost`: stored, its ack lost. */
  const stopping = (n, lost, rebuild) => ({
    ...bus,
    async publishBatch(batch) {
      if (n-- > 0) return bus.publishBatch(batch);
      if (lost) await bus.publishBatch(batch);
      rebuild.r.close();
      throw new Error("the check stopped the rebuild here");
    },
  });

  // Stopped during the copy: one batch in, the next failing.
  const one = {};
  one.r = new EventsRebuild({ bus: stopping(1, false, one), retryMs: 10 });
  await within(REBUILD_WAIT_MS, "the rebuild", one.r.run());
  let s = await state();
  check(
    "stopped during the copy: the copy holds its first batch, from place 1001; the stream refuses purges still",
    s.copy?.first === 1001 &&
      s.copy?.messages === 1000 &&
      s.copy?.window === COPY_DUPLICATE_WINDOW_NS &&
      s.events?.refuses === true &&
      s.events?.messages === 2600,
    s,
  );

  // Started again, without the users file's leave to delete: the copy goes on, and the server
  // refuses the delete.
  let refusal;
  const two = new EventsRebuild({
    bus,
    retryMs: 10,
    allowDelete: async (work) => {
      try {
        return await work();
      } catch (err) {
        refusal = err;
        throw err;
      } finally {
        two.close();
      }
    },
  });
  await within(REBUILD_WAIT_MS, "the rebuild", two.run());
  s = await state();
  check(
    "started again, the copy goes on to the end; without leave the server refuses the delete",
    deniedBy(refusal) &&
      s.copy?.messages === 2600 &&
      s.copy?.last === 3600 &&
      s.events?.refuses === true &&
      s.events?.messages === 2600,
    { waiting: two.waiting, ...s },
  );

  // Started again as main.ts does, and stopped during the copy back: a batch stored, its ack lost.
  const deletesBefore = deletes;
  const three = {};
  three.r = new EventsRebuild({
    bus: stopping(1, true, three),
    retryMs: 10,
    allowDelete: (work) => {
      deletes++;
      return busUsers.whileRebuilding(work);
    },
  });
  await within(REBUILD_WAIT_MS, "the rebuild", three.r.run());
  s = await state();
  check(
    "started again: the old stream deleted, made anew from place 1001, two batches copied back",
    deletes === deletesBefore + 1 &&
      s.events?.first === 1001 &&
      s.events?.messages === 2000 &&
      s.events?.refuses === false &&
      s.events?.window === COPY_DUPLICATE_WINDOW_NS &&
      s.copy?.messages === 2600,
    s,
  );
  check(
    "control's user may not delete the new stream: the leave went with the delete",
    (await tried(() => jsm.streams.delete(EVENT_STREAM))) === "denied",
  );

  // Started again as main.ts does: it goes on after the batch whose ack was lost, to the end.
  const four = asMain();
  await within(REBUILD_WAIT_MS, "the rebuild", four.run());
  const rebuilt = await contents(bus);
  s = await state();
  check(
    "started again, it ends as one run would have: nothing doubled, lost or moved",
    four.done === "rebuilt" &&
      deletes === deletesBefore + 1 &&
      !differs(second, rebuilt) &&
      s.copy === undefined &&
      s.events?.first === 1001 &&
      s.events?.last === 3600 &&
      s.events?.window === EVENT_STREAM_CONFIG.duplicate_window,
    differs(second, rebuilt) || { done: four.done, copied: four.copied, ...s },
  );
}
