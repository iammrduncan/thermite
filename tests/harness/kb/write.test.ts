import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KB_OUTBOX_FILES, KB_TEXT_MAX } from "../../../src/core/kb.ts";
import { writeKbItem } from "../../../src/harness/kb/index.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/**
 * The harness's write to the knowledge base (goal 175, step 2): one version of one item in its
 * writer's slot, recorded signed in the run's ledger as a `kb_item` event, the writer its actor;
 * a file kept once by its SHA-256 in the outbox for the supervisor.
 */

const RUN = "smoke-1";

async function setup() {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const outbox = env.service.paths.outboxDir;
  const write = (w: Omit<Parameters<typeof writeKbItem>[2], "run"> & { run?: string }) =>
    writeKbItem(env.service.ledger, outbox, { run: RUN, ...w });
  return { env, outbox, write };
}

describe("a write to the knowledge base, recorded in the run's ledger", () => {
  test("each writer numbers its own items; a new version is the next of its own item, the kind kept", async () => {
    const { env, write } = await setup();
    const a = write({
      writer: "worker-1",
      kind: "finding",
      title: "Vector loads",
      text: "Twice the bandwidth",
    });
    assert.deepEqual(
      { ...a, event: undefined },
      { event: undefined, item: 1, version: 1, address: "smoke-matmul/smoke-1/worker-1/finding:1" },
    );
    const b = write({
      writer: "planner",
      kind: "decision",
      title: "Vector loads first",
      text: "Fewest changes",
    });
    assert.equal(b.address, "smoke-matmul/smoke-1/planner/decision:1", "the planner's own item 1");
    const c = write({ writer: "worker-1", kind: "note", title: "L2", text: "4 MB" });
    assert.equal(c.item, 2);
    const v2 = write({
      writer: "worker-1",
      of: 1,
      kind: "finding",
      title: "Vector loads",
      text: "Twice the bandwidth, on the A100 too",
      links: [{ rel: "follows", to: "smoke-matmul/smoke-1/planner/decision:1" }],
    });
    assert.deepEqual([v2.item, v2.version], [1, 2]);
    // The events: the writer is the actor, the run the subject, the slot in the body.
    const events = env.service.ledger.events.list("kb_item", { subject: RUN });
    assert.deepEqual(
      events.map((e) => [e.actor, e.body.slot, e.body.item, e.body.version, e.body.kind]),
      [
        ["worker-1", "worker-1", 1, 1, "finding"],
        ["planner", "planner", 1, 1, "decision"],
        ["worker-1", "worker-1", 2, 1, "note"],
        ["worker-1", "worker-1", 1, 2, "finding"],
      ],
    );
    assert.deepEqual(events[3]?.body.links, [
      { rel: "follows", to: "smoke-matmul/smoke-1/planner/decision:1" },
    ]);
    assert.equal(events[3]?.run, RUN);
    // Thermite's code writes the records slot as the harness, with ids of their own.
    const r = write({ writer: "records", kind: "doc", title: "Run notes", text: "From code" });
    assert.equal(r.address, "smoke-matmul/smoke-1/records/doc:w1");
    assert.equal(env.service.ledger.events.newest("kb_item")?.actor, "harness");
  });

  test("refused, in words, with nothing recorded: another's item, another kind, a run the ledger lacks, a bad body", async () => {
    const { env, write } = await setup();
    write({ writer: "worker-1", kind: "finding", title: "Vector loads", text: "Twice" });
    const before = env.service.ledger.events.count("kb_item");
    assert.throws(
      () => write({ writer: "worker-2", of: 1, kind: "finding", title: "Mine now", text: "x" }),
      /worker-2 has no item 1 in run smoke-1/,
    );
    assert.throws(
      () => write({ writer: "worker-1", of: 1, kind: "note", title: "x", text: "x" }),
      /item 1 is a finding: a new version keeps its kind, not note/,
    );
    assert.throws(
      () => write({ run: "nowhere", writer: "worker-1", kind: "note", title: "x", text: "x" }),
      /no run nowhere/,
    );
    assert.throws(
      () => write({ writer: "worker-1", kind: "note", title: "x" }),
      /an item holds a text or a file/,
    );
    assert.throws(
      () => write({ writer: "worker-99", kind: "note", title: "x", text: "x" }),
      /a slot is records, owner, worker-<lane> or one of/,
    );
    assert.throws(
      () =>
        write({ writer: "worker-1", kind: "note", title: "x", text: "x".repeat(KB_TEXT_MAX + 1) }),
      /text/,
    );
    assert.throws(
      () =>
        write({
          writer: "worker-1",
          kind: "note",
          title: "x",
          text: "x",
          links: [{ rel: "supports", to: "not an address" }],
        }),
      /an item's address is <campaign>\/<run>\/<slot>\/<kind>:<id>/,
    );
    assert.equal(env.service.ledger.events.count("kb_item"), before);
  });

  test("a file is kept once in the outbox by its SHA-256, and its event names it", async () => {
    const { env, outbox, write } = await setup();
    const bytes = Buffer.from("%PDF-1.7 a paper about vector loads\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const one = write({
      writer: "worker-1",
      kind: "reference",
      title: "The paper",
      file: { bytes, name: "paper.pdf", type: "application/pdf" },
    });
    const path = join(outbox, KB_OUTBOX_FILES, sha256);
    assert.deepEqual(readFileSync(path), bytes);
    const at = statSync(path).mtimeMs;
    write({
      writer: "teacher",
      kind: "reference",
      title: "The same paper",
      file: { bytes, name: "same.pdf", type: "application/pdf" },
    });
    assert.deepEqual(readdirSync(join(outbox, KB_OUTBOX_FILES)), [sha256]);
    assert.equal(statSync(path).mtimeMs, at, "not written again");
    assert.equal(env.service.ledger.events.list("kb_item", { subject: RUN })[0]?.id, one.event);
    assert.deepEqual(
      env.service.ledger.events.newest("kb_item", { actor: "worker-1" })?.body.file,
      {
        sha256,
        name: "paper.pdf",
        type: "application/pdf",
        bytes: bytes.length,
      },
    );
    assert.ok(!existsSync(join(outbox, sha256)), "not among the exports");
  });
});
