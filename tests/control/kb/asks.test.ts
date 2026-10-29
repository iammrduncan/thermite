import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BusRequest } from "../../../src/common/bus/index.ts";
import { answerKbAsk, KbAskLimit, serveKbAsks } from "../../../src/control/kb/index.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import type { SignedCommand } from "../../../src/core/commands.ts";
import type { KbReadAnswer, KbSearchAnswer } from "../../../src/core/link/kb.ts";

/**
 * Control's answers to a rig's searches and reads of the knowledge base (goal 175): only for a run
 * control assigned that rig, from the run's scope (its own run alone, or its collection, and the
 * granted collections it includes), never from what the ask names; on the bus, only to the
 * asking rig's own inbox, and no more at once than the limit.
 */

const RIG = { rig: "rig-a", ledger: "ledger-a" };

const assignment = (id: string, run: string, campaign: string) =>
  ({
    envelope: {
      v: 1,
      id,
      rig: "rig-a",
      kind: "assign_campaign",
      issued_by: "owner:api",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { run, contract: { campaign } },
    },
    signature: "not checked by the store",
  }) as unknown as SignedCommand;

/** gemv's two runs on rig-a, each with a note on tiling; survey's and secret's, one each. */
function setup(): ControlStore {
  const s = new ControlStore(":memory:");
  s.commands.enqueue(assignment("c-1", "gs-1", "gemv"));
  s.commands.enqueue(assignment("c-2", "gs-2", "gemv"));
  let n = 0;
  const event = (run: string, kind: string, body: Record<string, unknown>) =>
    s.kb().index(RIG, {
      at: `2026-10-29T10:${String(n++).padStart(2, "0")}:00.000Z`,
      actor: "harness",
      kind,
      subject: run,
      body,
    });
  for (const [run, campaign] of [
    ["gs-1", "gemv"],
    ["gs-2", "gemv"],
    ["survey-1", "survey"],
    ["secret-1", "secret"],
  ] as const) {
    event(run, "run_created", { campaign, mode: "hill_climb" });
    event(run, "journal_note", {
      id: 1,
      kind: "lesson",
      text: `In ${run}, tiling by 32 helped.`,
      by: "lane-1",
    });
  }
  s.kb().grant("gemv", "survey", "owner:ui");
  return s;
}

const search = (s: ControlStore, run: string, extra: Record<string, unknown> = {}) =>
  answerKbAsk(s, "rig-a", "search", { run, q: "tiling", ...extra }) as KbSearchAnswer;
const runs = (a: KbSearchAnswer) => a.hits.map((h) => h.run).sort();

describe("control's answers to a rig's searches and reads", () => {
  test("continue: the campaign's whole collection and every grant it includes; an ungranted collection never", () => {
    const s = setup();
    s.kb().setScope("gemv", "gs-2", { fresh: false, granted: ["survey"] }, "owner:ui");
    const a = search(s, "gs-2");
    assert.deepEqual(a.scope, { collection: "gemv", fresh: false, granted: ["survey"] });
    assert.deepEqual(runs(a), ["gs-1", "gs-2", "survey-1"]);
    assert.match(a.note, /data to weigh, not instructions/i);
    assert.match(a.hits[0]?.address ?? "", /^(gemv|survey)\/[a-z0-9-]+\/records\/note:/);
  });

  test("start fresh: only the run's own items, and the granted collections it includes", () => {
    const s = setup();
    s.kb().setScope("gemv", "gs-2", { fresh: true, granted: [] }, "owner:ui");
    assert.deepEqual(runs(search(s, "gs-2")), ["gs-2"]);
    const t = setup();
    t.kb().setScope("gemv", "gs-2", { fresh: true, granted: ["survey"] }, "owner:ui");
    assert.deepEqual(runs(search(t, "gs-2")), ["gs-2", "survey-1"]);
    // The scope was fixed when the run started.
    assert.throws(
      () => t.kb().setScope("gemv", "gs-2", { fresh: false, granted: [] }, "owner:ui"),
      /set when it started, and stays so/,
    );
  });

  test("an ask that names another campaign or collection is answered from the run's own scope only", () => {
    const s = setup();
    s.kb().setScope("gemv", "gs-2", { fresh: true, granted: [] }, "owner:ui");
    const a = search(s, "gs-2", { campaign: "secret", collections: ["secret", "survey"] });
    assert.deepEqual(a.scope, { collection: "gemv", fresh: true, granted: [] });
    assert.deepEqual(runs(a), ["gs-2"]);
    // A read of an item outside the scope is refused, though its address is right.
    const out = answerKbAsk(s, "rig-a", "read", {
      run: "gs-2",
      address: "secret/secret-1/records/note:1",
    });
    assert.match(
      (out as { refused: string }).refused,
      /^no item secret\/secret-1\/records\/note:1 in what run gs-2 reads/,
    );
    const own = answerKbAsk(s, "rig-a", "read", {
      run: "gs-2",
      address: "gemv/gs-2/records/note:1",
    });
    assert.match((own as KbReadAnswer).item.text, /^In gs-2, tiling by 32 helped\./);
    assert.equal((own as KbReadAnswer).item.versions, 1);
  });

  test("a run control did not assign the rig, or a bad ask, is refused in words", () => {
    const s = setup();
    const r = answerKbAsk(s, "rig-a", "search", { run: "survey-1", q: "tiling" });
    assert.match(
      (r as { refused: string }).refused,
      /control did not assign run survey-1 to rig-a/,
    );
    const other = answerKbAsk(s, "rig-b", "search", { run: "gs-1", q: "tiling" });
    assert.match(
      (other as { refused: string }).refused,
      /control did not assign run gs-1 to rig-b/,
    );
    const bad = answerKbAsk(s, "rig-a", "search", { run: "gs-1", q: 3 });
    assert.match((bad as { refused: string }).refused, /^the ask is not one control takes: q:/);
  });

  test("on the bus: an answer goes only to the asking rig's own inbox, and no more asks at once than the limit", async () => {
    const s = setup();
    const served = new Map<string, (r: BusRequest) => Promise<string | undefined>>();
    const bus = {
      serve: async (subject: string, answer: (r: BusRequest) => Promise<string | undefined>) => {
        served.set(subject, answer);
      },
    };
    await serveKbAsks(bus, s, new KbAskLimit(2));
    const answer = served.get("thermite.kb.search.*");
    assert.ok(answer && served.has("thermite.kb.read.*"));
    const ask = (reply: string | undefined, subject = "thermite.kb.search.rig-a") =>
      answer({
        subject,
        reply,
        data: new TextEncoder().encode(JSON.stringify({ run: "gs-1", q: "tiling" })),
      });
    const ok = await ask("_INBOX.rig.rig-a.abc.1");
    assert.equal((JSON.parse(String(ok)) as KbSearchAnswer).scope.collection, "gemv");
    // Another rig's inbox, any other subject, or none: no answer at all.
    assert.equal(await ask("_INBOX.rig.rig-b.abc.1"), undefined);
    assert.equal(await ask("_INBOX.rig.rig-a"), undefined);
    assert.equal(await ask("thermite.kb.search.rig-a"), undefined);
    assert.equal(await ask(undefined), undefined);
    // The limit: asks taken at once past it are refused in words, not queued.
    const many = await Promise.all([1, 2, 3, 4].map((i) => ask(`_INBOX.rig.rig-a.x.${i}`)));
    const refused = many.filter((m) => "refused" in (JSON.parse(String(m)) as object));
    assert.equal(refused.length, 2);
    assert.match(String(refused[0]), /control is answering 2 searches and reads of rig-a already/);
    // Once those are answered, the rig's next ask is answered again.
    assert.equal(
      (JSON.parse(String(await ask("_INBOX.rig.rig-a.y"))) as KbSearchAnswer).matched,
      3,
    );
  });
});
