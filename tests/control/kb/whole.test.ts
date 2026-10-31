import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { answerKbAsk, KbFiles, KbText, ownerKbRead } from "../../../src/control/kb/index.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import { readerHtml } from "../../../src/control/ui/knowledge/item.ts";
import type { SignedCommand } from "../../../src/core/commands.ts";
import type { KbReadAnswer, KbSearchAnswer } from "../../../src/core/link/kb.ts";

/**
 * A source's archived text and a lane's document reach the knowledge base whole (goal 175): each
 * is its item's file, kept once by its SHA-256, its text extracted and searched in passages, and
 * read whole with kb_read's offsets; the item's own words (a source's address) come first. A
 * source a rig sent before keeps the start its event carried.
 */

const RIG = { rig: "rig-a", ledger: "ledger-a" };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const assignment = (run: string, campaign: string) =>
  ({
    envelope: {
      v: 1,
      id: "c-1",
      rig: RIG.rig,
      kind: "assign_campaign",
      issued_by: "owner:api",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { run, contract: { campaign } },
    },
    signature: "not checked by the store",
  }) as unknown as SignedCommand;

/** gemv's research run gs-1 on rig-a, and control's files and text extractor. */
function setup() {
  const store = new ControlStore(":memory:");
  store.commands.enqueue(assignment("gs-1", "gemv"));
  let t = 0;
  const event = (actor: string, kind: string, body: Record<string, unknown>) =>
    store.kb().index(RIG, {
      at: `2026-10-31T10:${String(t++).padStart(2, "0")}:00.000Z`,
      actor,
      kind,
      subject: "gs-1",
      body,
    });
  event("harness", "run_created", { campaign: "gemv", mode: "research" });
  const files = new KbFiles(mkdtempSync(join(tmpdir(), "thermite-kb-whole-")), store);
  const text = new KbText(store, files);
  /** Control holds these bytes, as if the rig's supervisor had put them on the bus. */
  const hold = (bytes: Buffer) => {
    const path = files.path(sha(bytes));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    store.kb().files.kept(sha(bytes), bytes.length);
  };
  const search = (q: string) =>
    answerKbAsk(store, RIG.rig, "search", { run: "gs-1", q }) as KbSearchAnswer;
  const read = (address: string, offset?: number) =>
    answerKbAsk(store, RIG.rig, "read", { run: "gs-1", address, offset }) as KbReadAnswer;
  return { store, event, hold, text, search, read };
}

/** A page of 30,000 characters whose last part alone holds the word "swizzle". */
const LONG = `${"The weights stream from memory, one tile at a time. ".repeat(500)}The loads swizzle their addresses to spread the banks.`;

describe("sources and documents reach the knowledge base whole", () => {
  test("a source longer than 20,000 characters: found by words past its 20,000th, and read there", async () => {
    const k = setup();
    const bytes = Buffer.from(LONG);
    assert.ok(LONG.length > 25_000 && LONG.indexOf("swizzle") > 20_000);
    k.event("lane-1", "source_fetched", {
      source: "s-1",
      domain: "docs.example.com",
      status: 200,
      bytes: 90_000,
      url: "https://docs.example.com/guide",
      title: "The guide",
      file: { sha256: sha(bytes), name: "s-1.txt", type: "text/plain", bytes: bytes.length },
    });
    // Before its file comes: the item's own words, its address, which a search finds.
    assert.equal(k.search("swizzle").hits.length, 0);
    assert.equal(k.search("docs.example.com").hits[0]?.address, "gemv/gs-1/records/source:s-1");
    const waiting = ownerKbRead(k.store, [], { address: "gemv/gs-1/records/source:s-1" });
    assert.ok(!("error" in waiting));
    assert.equal(waiting.item.text, "https://docs.example.com/guide\ndocs.example.com");
    assert.equal(waiting.item.file?.text_state, "waiting");
    // Its file comes, and control reads its text: the whole of it is searched and read.
    k.hold(bytes);
    assert.equal(await k.text.look(), 1);
    const [hit] = k.search("swizzle").hits;
    assert.equal(hit?.address, "gemv/gs-1/records/source:s-1");
    assert.equal(hit?.kind, "source");
    assert.match(hit?.excerpt ?? "", /\*\*swizzle\*\*/);
    assert.ok((hit?.passage?.from ?? 0) > 20_000, JSON.stringify(hit?.passage));
    const at = k.read(hit?.address ?? "", hit?.passage?.from);
    assert.match(at.item.text, /The loads swizzle their addresses/);
    const whole = k.read(hit?.address ?? "");
    const own = "https://docs.example.com/guide\ndocs.example.com\n\n";
    assert.equal(whole.item.chars, own.length + LONG.length, "its address, then its text whole");
    assert.equal(whole.item.text.slice(0, own.length), own);
    // The reader: the item's own words at its head, and its file, searched, to download.
    const r = ownerKbRead(k.store, [], { address: "gemv/gs-1/records/source:s-1" });
    assert.ok(!("error" in r));
    assert.equal(r.item.type, "file");
    assert.equal(r.item.head, "https://docs.example.com/guide\ndocs.example.com");
    assert.equal(r.item.file?.text_state, "searched");
    assert.equal(r.item.file?.name, "s-1.txt");
    assert.equal(r.item.versions, 1);
    const page = readerHtml(
      r.item,
      { mode: "page", version: () => "/v", item: () => "/i" },
      Date.parse("2026-10-31T11:00:00.000Z"),
    );
    assert.match(
      page,
      /<div class="kx-text">https:\/\/docs\.example\.com\/guide\ndocs\.example\.com<\/div><div class="kx-file">/,
    );
  });

  test("a source a rig sent before keeps the start its event carried", () => {
    const k = setup();
    const start = `${LONG.slice(0, 19_999)}…`;
    k.event("lane-1", "source_fetched", {
      source: "s-old",
      domain: "docs.example.com",
      status: 200,
      bytes: 90_000,
      url: "https://docs.example.com/old",
      title: "An old guide",
      text: start,
    });
    const r = k.read("gemv/gs-1/records/source:s-old");
    assert.equal(r.item.file, null);
    assert.ok(r.item.chars <= 20_000, `${r.item.chars}`);
    const end = k.read("gemv/gs-1/records/source:s-old", r.item.chars - 10);
    assert.ok(end.item.text.endsWith("…"), end.item.text);
    assert.equal(k.search("swizzle").hits.length, 0, "control has no more of its text");
  });

  test("a lane's document is its file whole; its removal is said before its text", async () => {
    const k = setup();
    const doc = Buffer.from(
      `# Outline\n\n${"Loads first, then tiling. ".repeat(1000)}Then swizzle.`,
    );
    k.event("lane-1", "research_doc", {
      lane: "lane-1",
      trial: "t-1",
      path: "synthesis/outline.md",
      change: "written",
      bytes: doc.length,
      sha256: sha(doc),
      file: { sha256: sha(doc), name: "outline.md", type: "text/markdown", bytes: doc.length },
    });
    k.hold(doc);
    await k.text.look();
    const address = "gemv/gs-1/records/doc:lane-1/synthesis/outline.md";
    assert.equal(k.search("swizzle").hits[0]?.address, address);
    assert.equal(k.read(address).item.chars, doc.length, "a document's text is its file's");
    k.event("lane-1", "research_doc", {
      lane: "lane-1",
      trial: "t-2",
      path: "synthesis/outline.md",
      change: "removed",
    });
    const gone = k.read(address);
    assert.equal(gone.item.version, 2);
    assert.match(
      gone.item.text,
      /^Removed: lane-1 took it out of its working area in trial t-2\.\n\n# Outline/,
    );
    assert.equal(gone.item.file?.sha256, sha(doc), "it keeps its file");
    assert.equal(k.search("swizzle").hits[0]?.address, address);
  });
});
