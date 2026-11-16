import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GEMINI_OPEN_CALLS,
  GeminiLedger,
} from "../../../../src/control/providers/gemini-api/ledger.ts";
import { ControlStore } from "../../../../src/control/store/index.ts";

const CAP = 10_000_000;
const LEDGER_KEY = "gemini_api_ledger";

function fixture(start = "2026-11-16T12:00:00Z") {
  const store = new ControlStore(":memory:");
  const clock = { now: new Date(start) };
  const open = () => new GeminiLedger(store, () => clock.now);
  return { store, clock, open, ledger: open() };
}
const call = (micros: number, provider = "gemini-api") => ({
  provider,
  model: "gemini-3.5-flash-lite",
  micros,
});
const viewOf = (ledger: GeminiLedger) => {
  const v = ledger.view();
  assert.ok(v, "the ledger reads");
  return v;
};

test("a reservation is taken up to the cap exactly, and refused one micro-dollar over it", () => {
  const f = fixture();
  const first = f.ledger.reserve(call(6_000_000), CAP);
  assert.ok(first.ok);
  // Exactly at the cap: taken.
  const second = f.ledger.reserve(call(4_000_000), CAP);
  assert.ok(second.ok);
  // One more is held off by the two open reservations, not by anything spent: busy, to wait.
  assert.deepEqual(f.ledger.reserve(call(1), CAP), { ok: false, why: "busy" });
  // A call the cap could never take is refused for the cap, whatever is open.
  assert.deepEqual(f.ledger.reserve(call(CAP + 1), CAP), { ok: false, why: "cap" });
  // What a call cost stays counted after it is settled.
  f.ledger.settle(first.id, 5_999_999);
  f.ledger.settle(second.id, 4_000_000);
  assert.ok(f.ledger.reserve(call(1), CAP).ok);
  assert.deepEqual(f.ledger.reserve(call(2), CAP), { ok: false, why: "cap" });
  assert.deepEqual(f.ledger.reserve(call(1), CAP), { ok: false, why: "busy" });
  const v = viewOf(f.ledger);
  assert.equal(v.spent, 9_999_999);
  assert.equal(v.reserved, 1);
  f.store.db.close();
});

test("at the cap nothing more is reserved, and a cap of 0 reserves nothing at all", () => {
  const f = fixture();
  const all = f.ledger.reserve(call(CAP), CAP);
  assert.ok(all.ok);
  f.ledger.settle(all.id, CAP);
  assert.deepEqual(f.ledger.reserve(call(1), CAP), { ok: false, why: "cap" });
  assert.deepEqual(f.ledger.reserve(call(0), CAP).ok, true);
  const zero = fixture();
  assert.deepEqual(zero.ledger.reserve(call(1), 0), { ok: false, why: "cap" });
  f.store.db.close();
  zero.store.db.close();
});

test("reservations made at once cannot together pass the cap", async () => {
  const f = fixture();
  // Twelve calls of $1 start in the same turn; the cap is $10.
  const taken = await Promise.all(
    Array.from({ length: 12 }, async () => f.ledger.reserve(call(1_000_000), CAP)),
  );
  assert.equal(taken.filter((r) => r.ok).length, 10);
  // The two over the cap are held off by reservations, which may settle under what they hold.
  assert.ok(taken.filter((r) => !r.ok).every((r) => !r.ok && r.why === "busy"));
  const v = viewOf(f.ledger);
  assert.equal(v.spent + v.reserved, CAP);
  // Settling under the reservation frees only the difference.
  for (const r of taken) if (r.ok) f.ledger.settle(r.id, 900_000);
  assert.equal(viewOf(f.ledger).spent, 9_000_000);
  assert.ok(f.ledger.reserve(call(1_000_000), CAP).ok);
  assert.deepEqual(f.ledger.reserve(call(1), CAP), { ok: false, why: "busy" });
  assert.deepEqual(f.ledger.reserve(call(1_000_001), CAP), { ok: false, why: "cap" });
  f.store.db.close();
});

test("a reservation settled with no known cost is charged whole, and only once", () => {
  const f = fixture();
  const r = f.ledger.reserve(call(700_000), CAP);
  assert.ok(r.ok);
  f.ledger.settle(r.id);
  f.ledger.settle(r.id);
  f.ledger.settle(r.id, 0);
  const v = viewOf(f.ledger);
  assert.deepEqual([v.spent, v.reserved, v.calls, v.uncertain], [700_000, 0, 1, 1]);
  f.store.db.close();
});

test("the ledger survives a restart, and a reservation a stopped control left open is charged whole", () => {
  const f = fixture();
  const done = f.ledger.reserve(call(2_000_000), CAP);
  assert.ok(done.ok);
  f.ledger.settle(done.id, 1_500_000);
  assert.ok(f.ledger.reserve(call(3_000_000), CAP).ok);
  // Control stops with a call open, and starts again on the same store.
  const again = f.open();
  const v = viewOf(again);
  assert.deepEqual([v.spent, v.reserved, v.open, v.uncertain], [4_500_000, 0, 0, 1]);
  assert.deepEqual(again.reserve(call(5_500_001), CAP), { ok: false, why: "cap" });
  assert.ok(again.reserve(call(5_500_000), CAP).ok);
  const kept = f.store.auditLog.list(50).find((a) => a.action === "gemini_api_reservations_kept");
  assert.ok(kept, "the audit log says what was kept");
  f.store.db.close();
});

test("a new month opens the cap again and keeps the month before on the record", () => {
  const f = fixture("2026-11-30T23:59:00Z");
  const r = f.ledger.reserve(call(CAP), CAP);
  assert.ok(r.ok);
  f.ledger.settle(r.id, CAP);
  assert.deepEqual(f.ledger.reserve(call(1), CAP), { ok: false, why: "cap" });
  f.clock.now = new Date("2026-12-01T00:00:00Z");
  const next = f.ledger.reserve(call(1_000_000), CAP);
  assert.ok(next.ok);
  const v = viewOf(f.ledger);
  assert.deepEqual([v.month, v.spent, v.reserved], ["2026-12", 0, 1_000_000]);
  assert.deepEqual(
    v.closed.map((m) => [m.month, m.spent, m.carried]),
    [["2026-11", CAP, 0]],
  );
  f.store.db.close();
});

test("a call open when the month turns stays reserved in the new month and is charged there", () => {
  const f = fixture("2026-11-30T23:59:00Z");
  const open = f.ledger.reserve(call(4_000_000), CAP);
  assert.ok(open.ok);
  f.clock.now = new Date("2026-12-01T00:01:00Z");
  // The new month is not a fresh $10 while November's call is unresolved: a call that needs
  // part of what it holds waits for it.
  assert.deepEqual(f.ledger.reserve(call(6_000_001), CAP), { ok: false, why: "busy" });
  let v = viewOf(f.ledger);
  assert.deepEqual([v.month, v.spent, v.reserved], ["2026-12", 0, 4_000_000]);
  assert.equal(v.closed[0]?.carried, 4_000_000);
  // Its cost never becomes known: December carries the whole reservation.
  f.ledger.settle(open.id);
  v = viewOf(f.ledger);
  assert.deepEqual([v.spent, v.reserved, v.uncertain], [4_000_000, 0, 1]);
  // Also across a restart in the new month.
  const g = fixture("2026-11-30T23:59:00Z");
  assert.ok(g.ledger.reserve(call(4_000_000), CAP).ok);
  g.clock.now = new Date("2026-12-01T00:01:00Z");
  const w = viewOf(g.open());
  assert.deepEqual([w.month, w.spent, w.reserved], ["2026-12", 4_000_000, 0]);
  f.store.db.close();
  g.store.db.close();
});

test("a clock set back opens no new month and gives nothing back", () => {
  const f = fixture("2026-12-02T00:00:00Z");
  const r = f.ledger.reserve(call(CAP), CAP);
  assert.ok(r.ok);
  f.ledger.settle(r.id, CAP);
  f.clock.now = new Date("2026-11-15T00:00:00Z");
  assert.deepEqual(f.ledger.reserve(call(1), CAP), { ok: false, why: "cap" });
  assert.equal(viewOf(f.ledger).month, "2026-12");
  f.store.db.close();
});

test("a ledger that can't be read refuses every call and is not replaced by an empty one", () => {
  for (const damaged of ["not json", "{}", JSON.stringify({ v: 1, month: "2026-11", spent: -5 })]) {
    const f = fixture();
    const r = f.ledger.reserve(call(9_000_000), CAP);
    assert.ok(r.ok);
    f.ledger.settle(r.id, 9_000_000);
    f.store.ownSettings.set(LEDGER_KEY, damaged, "test");
    assert.deepEqual(f.ledger.reserve(call(1), CAP), { ok: false, why: "unreadable" });
    assert.equal(f.ledger.view(), undefined);
    assert.equal(f.open().view(), undefined);
    assert.equal(f.store.ownSettings.get(LEDGER_KEY)?.value, damaged);
    f.store.db.close();
  }
});

test("open calls have a limit, and a call past it is refused as busy, not charged", () => {
  const f = fixture();
  const ids: string[] = [];
  for (let i = 0; i < GEMINI_OPEN_CALLS; i++) {
    const r = f.ledger.reserve(call(1), CAP);
    assert.ok(r.ok);
    ids.push(r.id);
  }
  assert.deepEqual(f.ledger.reserve(call(1), CAP), { ok: false, why: "busy" });
  f.ledger.settle(ids[0] ?? "", 1);
  assert.ok(f.ledger.reserve(call(1), CAP).ok);
  f.store.db.close();
});

test("spend is kept by provider name and counts toward one cap for all of them", () => {
  const f = fixture();
  const a = f.ledger.reserve(call(6_000_000, "key-a"), CAP);
  const b = f.ledger.reserve(call(4_000_000, "key-b"), CAP);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(f.ledger.reserve(call(1, "key-c"), CAP), { ok: false, why: "busy" });
  f.ledger.settle(a.id, 6_000_000);
  f.ledger.settle(b.id, 4_000_000);
  assert.deepEqual(f.ledger.reserve(call(1, "key-c"), CAP), { ok: false, why: "cap" });
  assert.deepEqual(viewOf(f.ledger).by, [
    { provider: "key-a", spent: 6_000_000 },
    { provider: "key-b", spent: 4_000_000 },
  ]);
  f.store.db.close();
});

test("a provider named as a property every object has is counted as a number, and the ledger reads again", () => {
  const f = fixture();
  for (const name of ["constructor", "tostring", "valueof", "key-a", "constructor"]) {
    const r = f.ledger.reserve(call(1_000, name), CAP);
    assert.ok(r.ok, name);
    f.ledger.settle(r.id, 1_000);
  }
  assert.deepEqual(viewOf(f.ledger).by, [
    { provider: "constructor", spent: 2_000 },
    { provider: "key-a", spent: 1_000 },
    { provider: "tostring", spent: 1_000 },
    { provider: "valueof", spent: 1_000 },
  ]);
  // What was stored parses again: nothing but numbers went into it.
  assert.equal(viewOf(f.open()).spent, 5_000);
  f.store.db.close();
});
