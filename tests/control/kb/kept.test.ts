import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { answerKbAsk, ownerKbRead, scrubKeptConversations } from "../../../src/control/kb/index.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import { keepVersion } from "../../../src/control/store/kb/items.ts";
import type { SignedCommand } from "../../../src/core/commands.ts";
import type { KbReadAnswer, KbSearchAnswer } from "../../../src/core/link/kb.ts";

/**
 * Kept conversations control stored before the scrubbing (goal 175): each gets a new version,
 * scrubbed by shape, once, as control starts; the version before stays, and the owner reads it;
 * an agent reads the scrubbed one, and its search finds nothing only the older one holds. The same
 * event read again, or sent now by a rig of an earlier build, is kept scrubbed.
 */

const RIG = { rig: "rig-a", ledger: "ledger-a" };
const RUN = "gs-1";
const CAMPAIGN = "gemv";
const AT = "2026-10-29T10:00:00.000Z";

const assignment = {
  envelope: {
    v: 1,
    id: "c-1",
    rig: RIG.rig,
    kind: "assign_campaign",
    issued_by: "owner:api",
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    payload: { run: RUN, contract: { campaign: CAMPAIGN } },
  },
  signature: "not checked by the store",
} as unknown as SignedCommand;

/** Values shaped like credentials, made as the test runs: no key-shaped text in the repository. */
function secrets() {
  return {
    trial: `trial.${randomBytes(32).toString("hex")}`,
    bearer: `zqxv${randomBytes(12).toString("hex")}`,
    key: ["sk", "proj", randomBytes(12).toString("hex")].join("-"),
  };
}

/** A conversation as an agent's tools printed it, and as an earlier harness sent its start. */
function conversation(s: ReturnType<typeof secrets>, n: number): string {
  return [
    `# Trial t-0123456789abcdef: the conversation before compaction ${n}`,
    "",
    "```text",
    `THERMITE_TRIAL_AUTH=${s.trial}`,
    `curl -H "Authorization: Bearer ${s.bearer}" https://api.example.com`,
    `export OPENAI_API_KEY=${s.key}`,
    "```",
    "",
    "The zirconium layout wins.",
  ].join("\n");
}

const snapshot = (n: number) => `compactions/t-0123456789abcdef-${n}.md`;
const addressOf = (n: number) => `${CAMPAIGN}/${RUN}/records/doc:${snapshot(n)}`;

/** The event a rig of an earlier build sent for compaction n: the conversation's start as text. */
const oldEvent = (n: number, text: string) => ({
  at: AT,
  actor: "harness",
  kind: "context_compacted",
  subject: RUN,
  body: {
    trial: "t-0123456789abcdef",
    lane: "lane-1",
    harness: "pi",
    number: n,
    tokens_before: 41_000,
    tokens_after: 4_000,
    how: "summary",
    snapshot: snapshot(n),
    bytes: text.length,
    text,
    summary: null,
    error: null,
  },
});

/** A store with gemv's run on rig-a, assigned by control. */
function setup(): ControlStore {
  const s = new ControlStore(":memory:");
  s.commands.enqueue(assignment);
  s.kb().index(RIG, {
    at: AT,
    actor: "harness",
    kind: "run_created",
    subject: RUN,
    body: { campaign: CAMPAIGN, mode: "hill_climb" },
  });
  return s;
}

/** A kept conversation as the control of an earlier build stored it: its text as it came. */
function storeAsBefore(s: ControlStore, n: number, text: string): void {
  const seq = Number(
    (
      s.db
        .prepare("update kb_cursor set item_seq = item_seq + 1 where id = 1 returning item_seq")
        .get() as { item_seq: number }
    ).item_seq,
  );
  keepVersion(
    s.db,
    seq,
    { campaign: CAMPAIGN, ...RIG, run: RUN, slot: "records", kind: "doc", ref: snapshot(n) },
    {
      title: `trial t-0123456789abcdef: the conversation before compaction ${n}`,
      body: text,
      by: "lane-1",
      url: null,
      sub: null,
      meta: JSON.stringify({ lane: "lane-1", trial: "t-0123456789abcdef" }),
    },
    { at: AT },
  );
}

const agentRead = (s: ControlStore, address: string, version?: number) =>
  answerKbAsk(s, RIG.rig, "read", {
    run: RUN,
    address,
    ...(version ? { version } : {}),
  }) as KbReadAnswer;
const agentSearch = (s: ControlStore, q: string) =>
  answerKbAsk(s, RIG.rig, "search", { run: RUN, q }) as KbSearchAnswer;

const holdsNone = (text: string, s: ReturnType<typeof secrets>) => {
  for (const [what, value] of Object.entries(s)) assert.ok(!text.includes(value), what);
};

describe("kept conversations stored before the scrubbing", () => {
  test("each gets a scrubbed new version by shape, once; the version before stays for the owner", async () => {
    const s = setup();
    const one = secrets();
    const two = secrets();
    storeAsBefore(s, 1, conversation(one, 1));
    storeAsBefore(s, 2, conversation(two, 2));
    // One the scrub leaves as it is: it gets no new version.
    storeAsBefore(s, 3, "# The conversation before compaction 3\n\nThe zirconium layout wins.");
    const kb = s.kb();

    // A page of two: the pass reads on past its first page.
    assert.equal(await scrubKeptConversations(s, 2), 2);
    for (const [n, values] of [
      [1, one],
      [2, two],
    ] as const) {
      const x = kb.at(addressOf(n));
      assert.ok(x);
      assert.equal(x.version, 2);
      assert.equal(x.by, "harness", "written by Thermite's code");
      assert.equal(x.meta.scrubbed, "Thermite's code scrubbed this text by shape");
      assert.equal(x.meta.lane, "lane-1", "its other fields stay");
      const [before, after] = kb.versions(x.id);
      assert.equal(before?.body, conversation(values, n), "the version before is kept as it came");
      holdsNone(after?.body ?? "", values);
      assert.match(after?.body ?? "", /THERMITE_TRIAL_AUTH=\*\*\*/);
      assert.match(after?.body ?? "", /Authorization: \*\*\* https/);
      assert.match(after?.body ?? "", /The zirconium layout wins\./);
      // The owner reads every version: the newest by default, and the one before.
      const owner = ownerKbRead(s, [], { address: addressOf(n) });
      assert.ok(!("error" in owner));
      assert.equal(owner.item.version, 2);
      holdsNone(owner.item.text, values);
      const old = ownerKbRead(s, [], { address: addressOf(n), version: 1 });
      assert.ok(!("error" in old));
      assert.equal(old.item.text, conversation(values, n));
    }
    assert.equal(kb.at(addressOf(3))?.version, 1);

    // A second start finds none left: no version, no seq moves.
    const seqs = [1, 2, 3].map((n) => kb.at(addressOf(n))?.seq);
    assert.equal(await scrubKeptConversations(s), 0);
    assert.deepEqual(
      [1, 2, 3].map((n) => kb.at(addressOf(n))?.seq),
      seqs,
    );
    assert.equal(kb.versions(kb.at(addressOf(1))?.id ?? 0).length, 2);
  });

  test("an agent reads the scrubbed version, never the one before; the owner still does", async () => {
    const s = setup();
    const values = secrets();
    storeAsBefore(s, 1, conversation(values, 1));
    await scrubKeptConversations(s);

    const newest = agentRead(s, addressOf(1));
    assert.ok(!("refused" in newest), JSON.stringify(newest));
    assert.equal(newest.item.version, 2);
    assert.equal(newest.item.versions, 2);
    holdsNone(newest.item.text, values);
    const named = agentRead(s, addressOf(1), 2);
    assert.ok(!("refused" in named), JSON.stringify(named));
    holdsNone(named.item.text, values);

    const older = agentRead(s, addressOf(1), 1) as { refused?: string };
    assert.match(
      older.refused ?? "",
      /^version 1 of gemv\/gs-1\/records\/doc:compactions\/t-0123456789abcdef-1\.md is not read by agents: Thermite's code scrubbed it into version 2/,
    );
    assert.ok(!JSON.stringify(older).includes(values.bearer));
    const owner = ownerKbRead(s, [], { address: addressOf(1), version: 1 });
    assert.ok(!("error" in owner));
    assert.match(owner.item.text, new RegExp(values.bearer));
  });

  test("a search finds no word only the version before holds", async () => {
    const s = setup();
    const values = secrets();
    storeAsBefore(s, 1, conversation(values, 1));
    // Before: the words index holds the text as it came.
    assert.equal(agentSearch(s, values.bearer).matched, 1);
    await scrubKeptConversations(s);

    const gone = agentSearch(s, values.bearer);
    assert.equal(gone.matched, 0);
    assert.deepEqual(gone.hits, []);
    // No item holds the word, and none is offered in its place.
    assert.deepEqual(
      gone.words.map((w) => w.items),
      [0],
    );
    assert.ok(!JSON.stringify(gone.did_you_mean).includes(values.bearer.slice(4)));
    assert.equal(s.kb().find(values.bearer, [{ campaign: CAMPAIGN }]).matched, 0, "the owner's");
    // The words both versions hold find the item, at its scrubbed version.
    const kept = agentSearch(s, "zirconium");
    assert.equal(kept.matched, 1);
    assert.equal(kept.hits[0]?.version, 2);
    assert.ok(!JSON.stringify(kept).includes(values.bearer));
  });

  test("the same event read again, or sent now by a rig of an earlier build, is kept scrubbed", async () => {
    const s = setup();
    const kb = s.kb();
    const values = secrets();
    storeAsBefore(s, 1, conversation(values, 1));
    await scrubKeptConversations(s);
    // Read again, after an upgrade of the reading: the item stays at its scrubbed version.
    kb.index(RIG, oldEvent(1, conversation(values, 1)), { again: true });
    kb.index(RIG, oldEvent(1, conversation(values, 1)));
    assert.equal(kb.at(addressOf(1))?.version, 2);

    // Compaction 2 from a rig of an earlier build: scrubbed as it is stored, its first version.
    const later = secrets();
    kb.index(RIG, oldEvent(2, conversation(later, 2)));
    const x = kb.at(addressOf(2));
    assert.ok(x);
    assert.equal(x.version, 1);
    assert.equal(x.meta.scrubbed, "Thermite's code scrubbed this text by shape");
    holdsNone(x.body, later);
    assert.match(x.body, /The zirconium layout wins\./);
    const read = agentRead(s, addressOf(2), 1);
    assert.ok(!("refused" in read), JSON.stringify(read));
    holdsNone(read.item.text, later);
    assert.equal(await scrubKeptConversations(s), 0);
  });
});
