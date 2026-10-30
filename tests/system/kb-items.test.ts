import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { answerKbAsk, followKbFiles, KbFiles } from "../../src/control/kb/index.ts";
import type { SignedCommand } from "../../src/core/commands.ts";
import { KB_OUTBOX_FILES, type KbItemBody } from "../../src/core/kb.ts";
import type { KbSearchAnswer } from "../../src/core/link/kb.ts";
import { KB_FILES_STREAM, KB_FILES_STREAM_CONFIG } from "../../src/core/link/kb-files.ts";
import { writeKbItem } from "../../src/harness/kb/index.ts";
import { putKbFiles } from "../../src/supervisor/kb/index.ts";
import { controlOnly, RIG_TOKEN } from "../helpers/control-stack.ts";
import { busOf } from "../helpers/control-store.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

/**
 * A write to the knowledge base, from the harness to control (goal 175, step 2): the harness
 * records a `kb_item` event, signed in the rig's reports, and keeps the item's file in the outbox;
 * the supervisor puts the file on the `KB_FILES` stream; control takes the report through its
 * checks, stores the item in its writer's slot, and keeps the file once. The two meet by the
 * file's SHA-256, whichever comes first. An item for another writer's slot is refused and recorded,
 * and the rest of the page goes on. A write made while control is away arrives once when it is
 * back.
 */

const RUN = "smoke-1";
const COLLECTION = "smoke-matmul";

async function setup() {
  const env = makeHarnessEnv("rig-a");
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const { store, control } = controlOnly({ keys: env.keys });
  const { bus } = busOf(store);
  // Control makes the files' stream as it starts (followKbFiles).
  await bus.makeStream(KB_FILES_STREAM_CONFIG);
  const files = new KbFiles(mkdtempSync(join(tmpdir(), "thermite-kb-files-")), store);
  const home = mkdtempSync(join(tmpdir(), "thermite-supervisor-"));
  const outbox = env.service.paths.outboxDir;
  let cursor = 0;
  return {
    env,
    store,
    bus,
    files,
    write: (w: Omit<Parameters<typeof writeKbItem>[2], "run">) =>
      writeKbItem(env.service.ledger, outbox, { run: RUN, ...w }),
    /** The rig's next report, posted as its supervisor posts it: the status control answers. */
    report: async (from = cursor) => {
      const page = env.service.snapshot(from, 500) as { next: number };
      const r = await control.request("/v1/rigs/rig-a/ingest", {
        method: "POST",
        headers: { authorization: `Bearer ${RIG_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(page),
      });
      if (r.status === 200) cursor = page.next;
      return r.status;
    },
    /** The supervisor's round of puts. */
    put: () => putKbFiles({ rig: "rig-a", outboxDir: outbox, home, bus }),
    /** Control's follow of the files' stream, one pass. */
    take: () => followKbFiles(bus, files),
    items: () =>
      store.db
        .prepare(
          "select slot, kind, ref, version, title, body, file_sha256 from kb_item where slot != 'records' order by id",
        )
        .all()
        .map((r) => ({ ...r })),
    refusals: () =>
      store.auditLog
        .list(100)
        .filter((a) => a.action === "kb_item_refused")
        .map((a) => (a.body as { why: string }).why),
  };
}

const paper = Buffer.from("%PDF-1.7 Vector loads of packed int4 weights\n");
const sha = createHash("sha256").update(paper).digest("hex");

describe("a write to the knowledge base, from the harness to control", () => {
  test("the item goes into its writer's slot, its versions and links kept; its file meets it by its SHA-256", async () => {
    const s = await setup();
    const note = s.write({
      writer: "worker-1",
      kind: "finding",
      title: "Vector loads",
      text: "Twice the bandwidth",
    });
    s.write({
      writer: "worker-1",
      kind: "reference",
      title: "The paper",
      file: { bytes: paper, name: "paper.pdf", type: "application/pdf" },
      links: [{ rel: "supports", to: note.address }],
    });
    s.write({
      writer: "worker-1",
      of: 1,
      kind: "finding",
      title: "Vector loads",
      text: "Twice, on the A100 too",
    });
    // The report first: the item names a file control does not have yet.
    assert.equal(await s.report(), 200);
    assert.deepEqual(s.items(), [
      {
        slot: "worker-1",
        kind: "finding",
        ref: "1",
        version: 2,
        title: "Vector loads",
        body: "Twice, on the A100 too",
        file_sha256: null,
      },
      {
        slot: "worker-1",
        kind: "reference",
        ref: "2",
        version: 1,
        title: "The paper",
        body: "",
        file_sha256: sha,
      },
    ]);
    assert.equal(s.store.kb().files.has(sha), false);
    // In the run's collection, in its writer's slot; each version kept, with its links.
    const [finding, reference] = s.store
      .kb()
      .search("", [COLLECTION])
      .filter((i) => i.slot === "worker-1")
      .sort((a, b) => a.id - b.id);
    assert.equal(finding?.campaign, COLLECTION);
    assert.deepEqual(
      s.store
        .kb()
        .versions(finding?.id ?? 0)
        .map((v) => v.body),
      ["Twice the bandwidth", "Twice, on the A100 too"],
    );
    assert.deepEqual(s.store.kb().versions(reference?.id ?? 0)[0]?.links, [
      { rel: "supports", to: `${COLLECTION}/${RUN}/worker-1/finding:1` },
    ]);
    // Then the file: the supervisor puts it, control keeps it, and the item has it.
    const put = await s.put();
    assert.deepEqual([put.put, put.waiting, put.error], [1, 0, undefined]);
    await s.take();
    assert.equal(s.store.kb().files.has(sha), true);
    assert.ok(existsSync(s.files.path(sha)));
    // The other way round: the file first, then its item.
    s.write({
      writer: "teacher",
      kind: "doc",
      title: "The same paper",
      file: { bytes: paper, name: "p.pdf", type: "application/pdf" },
    });
    const again = Buffer.from("A second reference\n");
    s.write({
      writer: "teacher",
      kind: "doc",
      title: "Notes",
      file: { bytes: again, name: "notes.md", type: "text/markdown" },
    });
    assert.equal((await s.put()).put, 1, "the paper was put already: only the new file goes");
    await s.take();
    const againSha = createHash("sha256").update(again).digest("hex");
    assert.equal(s.store.kb().files.has(againSha), true);
    assert.equal(await s.report(), 200);
    assert.deepEqual(
      s
        .items()
        .filter((i) => i.slot === "teacher")
        .map((i) => i.file_sha256),
      [sha, againSha],
    );
  });

  test("an item for another writer's slot, by a writer with none, of a kind its role may not write, or of another rig's run, is refused and recorded; the rest of the page goes on", async () => {
    const s = await setup();
    const body = (slot: string, item = 1): KbItemBody => ({
      slot,
      item,
      version: 1,
      kind: "note",
      title: "Mine",
      text: "x",
      links: [],
    });
    const ledger = s.env.service.ledger;
    ledger.appendEvent("worker-2", "kb_item", RUN, body("worker-1"));
    ledger.appendEvent("worker-1", "kb_item", RUN, body("records"));
    ledger.appendEvent("lane-1", "kb_item", RUN, body("lane-1"));
    ledger.appendEvent("worker-1", "kb_item", "someone-elses-run", body("worker-1"));
    ledger.appendEvent("worker-3", "kb_item", RUN, { ...body("worker-3"), title: "" });
    s.write({ writer: "worker-1", kind: "note", title: "Mine", text: "Kept" });
    ledger.appendEvent("worker-1", "kb_item", RUN, body("worker-1", 1));
    // A kind the campaign does not let the role write (the default: the planner writes no finding).
    ledger.appendEvent("planner", "kb_item", RUN, { ...body("planner"), kind: "finding" });
    assert.equal(await s.report(), 200);
    assert.deepEqual(s.refusals().reverse(), [
      "worker-2 writes only in its own slot, worker-2: not in worker-1, another writer's",
      "worker-1 writes only in its own slot, worker-1: not in records, another writer's",
      "not an item: slot: a slot is records, worker-<lane> or one of planner, teacher, merged-by, auditor, review-panel, synthesizer, final-writer",
      "run someone-elses-run is not this rig's: control's run registry has no such run of this ledger",
      "not an item: title: Too small: expected string to have >=1 characters",
      "item 1 of slot worker-1 exists already: a new version of it is version 2",
      "the campaign lets planner write decision, surprise, note in run smoke-1: not a finding",
    ]);
    assert.deepEqual(
      s.items().map((i) => [i.slot, i.ref, i.version, i.body]),
      [["worker-1", "1", 1, "Kept"]],
    );
    // The page went on to its end: control holds every event of it.
    assert.equal(
      s.store.reportedRigs.heldCursor("rig-a", ledger.ledgerId()),
      ledger.latestEventId(),
    );
  });

  test("a write while control is away arrives once when it is back: the event waits in the ledger, the file in the outbox and then on the bus", async () => {
    const s = await setup();
    s.write({
      writer: "worker-1",
      kind: "reference",
      title: "The paper",
      file: { bytes: paper, name: "paper.pdf", type: "application/pdf" },
    });
    // Control's bus is away: the report is refused for now, the file is not put.
    s.bus.failing = true;
    assert.equal(await s.report(), 503);
    const away = await s.put();
    assert.deepEqual([away.put, away.waiting], [0, 1]);
    assert.match(String(away.error), /no ack/);
    assert.deepEqual(readdirSync(join(s.env.service.paths.outboxDir, KB_OUTBOX_FILES)), [sha]);
    assert.deepEqual(s.items(), []);
    // The bus is back, and control not yet taking files: the file waits on the stream.
    s.bus.failing = false;
    assert.equal((await s.put()).put, 1);
    assert.equal(s.bus.kept.filter((m) => m.stream === KB_FILES_STREAM).length, 1);
    assert.equal(await s.report(), 200);
    await s.take();
    assert.equal(s.bus.kept.filter((m) => m.stream === KB_FILES_STREAM).length, 0);
    // Once: the item, its one version, the file.
    const once = () => ({
      items: s.items().length,
      versions: Number(
        s.store.db.prepare("select count(*) as n from kb_version where event is not null").get()?.n,
      ),
      files: Number(s.store.db.prepare("select count(*) as n from kb_file").get()?.n),
    });
    assert.deepEqual(once(), { items: 1, versions: 1, files: 1 });
    assert.equal(s.store.kb().files.has(sha), true);
    // Sent again, the report and the file change nothing.
    assert.equal(await s.report(0), 200);
    assert.equal((await s.put()).put, 0, "the supervisor put it once");
    assert.deepEqual(once(), { items: 1, versions: 1, files: 1 });
  });
});

describe("an agent's item, written over its tools, found by an agent of another run", () => {
  test("a worker's kb_write lands in its own slot, reaches control with the report, and another run of the campaign finds it", async () => {
    const s = await setup();
    // The worker's tool, as the harness runs it for lane-1's trial: the slot is the trial's.
    const kept = await s.env.service.kbTools.call({ run: RUN, slot: "worker-1" }, "kb_write", {
      kind: "finding",
      title: "Unrolling gave nothing",
      text: "Unrolling the inner loop by 4 failed to improve speed on every cell.",
    });
    assert.equal(kept.isError, undefined, kept.text);
    assert.equal(await s.report(), 200);
    // Another run of the same campaign, which control assigned the rig.
    s.store.commands.enqueue({
      envelope: {
        v: 1,
        id: "c-other",
        rig: "rig-a",
        kind: "assign_campaign",
        issued_by: "owner:api",
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload: { run: "smoke-2", contract: { campaign: COLLECTION } },
      },
      signature: "not checked by the store",
    } as unknown as SignedCommand);
    const found = answerKbAsk(s.store, "rig-a", "search", {
      run: "smoke-2",
      q: "which approaches failed to improve speed",
    }) as KbSearchAnswer;
    const hit = found.hits.find((h) => h.slot === "worker-1");
    assert.equal(hit?.address, `${COLLECTION}/${RUN}/worker-1/finding:1`);
    assert.match(hit?.excerpt ?? "", /\*\*failed\*\* to \*\*improve\*\* \*\*speed\*\*/);
    // Started fresh, that run would read only its own items: none of these.
    s.store.kb().setScope(COLLECTION, "smoke-2", { fresh: true, granted: [] }, "owner:api");
    const fresh = answerKbAsk(s.store, "rig-a", "search", {
      run: "smoke-2",
      q: "speed",
    }) as KbSearchAnswer;
    assert.deepEqual(fresh.hits, []);
  });
});
