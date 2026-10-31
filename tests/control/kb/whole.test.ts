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
  const event = (actor: string, kind: string, body: Record<string, unknown>, subject = "gs-1") =>
    store.kb().index(RIG, {
      at: `2026-10-31T10:${String(t++).padStart(2, "0")}:00.000Z`,
      actor,
      kind,
      subject,
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
    const own = "https://docs.example.com/old\ndocs.example.com\n\n";
    assert.equal(
      r.item.chars,
      own.length + start.length,
      "its address, then the start it came with",
    );
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

  test("the paper and each report are their files whole, after a line of their figures", async () => {
    const k = setup();
    const paper = Buffer.from(
      `# Loads first\n\n${"The loads bound the kernel. ".repeat(1500)}Bank swizzle helps.`,
    );
    assert.ok(paper.length > 40_000);
    k.event("writer:teacher-1", "research_paper_accepted", {
      review: 1,
      writer: "teacher-1",
      cited_claims: 4,
      references: 3,
      experiments: [],
      chars: paper.length,
      paper: paper.toString(),
      file: { sha256: sha(paper), name: "paper.md", type: "text/markdown", bytes: paper.length },
    });
    // A report longer than its event's 60,000 characters: the event carries its cut start.
    const report = Buffer.from(
      `# Final report\n\n${"Sources say the loads bound it. ".repeat(2500)}The swizzle closes it.`,
    );
    assert.ok(report.length > 60_000);
    const figures = { sources: 12, domains: 5, verified: 30, findings: 4 };
    k.event("research", "research_final", {
      ...figures,
      report: `${report.toString().slice(0, 59_000)}…`,
      file: {
        sha256: sha(report),
        name: "final-report.md",
        type: "text/markdown",
        bytes: report.length,
      },
    });
    k.hold(paper);
    k.hold(report);
    assert.equal(await k.text.look(), 2);
    const p = k.read("gemv/gs-1/records/report:paper");
    const pHead = `${paper.length.toLocaleString("en-US")} characters, 4 claims cited, 3 references.`;
    assert.equal(
      p.item.chars,
      pHead.length + 2 + paper.length,
      "its figures, then the paper whole",
    );
    assert.ok(p.item.text.startsWith(`${pHead}\n\n# Loads first`));
    const f = k.read("gemv/gs-1/records/report:final");
    const fHead = "12 sources from 5 domains; 30 verified claims, 4 findings.";
    assert.equal(f.item.chars, fHead.length + 2 + report.length, "whole, past its event's cut");
    // Words past the 20,000th character, and past the report event's 60,000th, are found.
    const hits = k.search("swizzle").hits.map((h) => h.address);
    assert.ok(hits.includes("gemv/gs-1/records/report:paper"), JSON.stringify(hits));
    assert.ok(hits.includes("gemv/gs-1/records/report:final"), JSON.stringify(hits));
    const r = ownerKbRead(k.store, [], { address: "gemv/gs-1/records/report:final" });
    assert.ok(!("error" in r));
    assert.equal(r.item.head, fHead);
    assert.equal(r.item.file?.name, "final-report.md");
    // Each digest is the item's next version, with a file of its own; the older ones stay.
    for (const [i, words] of ["First digest.", "Second digest."].entries()) {
      const body = Buffer.from(`# Digest\n\n${words}`);
      k.event("research", "research_digest", {
        ...figures,
        report: body.toString(),
        file: { sha256: sha(body), name: "digest.md", type: "text/markdown", bytes: body.length },
      });
      k.hold(body);
      await k.text.look();
      const d = k.read("gemv/gs-1/records/report:digest");
      assert.equal(d.item.version, i + 1);
      assert.match(d.item.text, new RegExp(words));
    }
  });

  test("an attempt's text is whole: a record is never cut to an item's length", () => {
    const k = setup();
    const flaws = Array.from(
      { length: 50 },
      (_, i) => `Flaw ${i}: ${"it may not hold on every shape. ".repeat(30)}`,
    );
    flaws[49] = `${flaws[49]}The last flaw names the swizzle.`;
    k.event(
      "lane-1",
      "attempt_recorded",
      {
        run: "gs-1",
        lane: "lane-1",
        lifecycle: "queued",
        commit: "c".repeat(40),
        parent: "p".repeat(40),
        hypothesis: "Wider loads",
        known_flaws: flaws,
      },
      "a-1",
    );
    const a = k.read("gemv/gs-1/records/attempt:a-1");
    assert.ok(a.item.chars > 20_000, `${a.item.chars}`);
    assert.equal(k.search("swizzle").hits[0]?.address, "gemv/gs-1/records/attempt:a-1");
  });

  test("a paper and a report a rig sent before keep the cut their events carried", () => {
    const k = setup();
    const long = "The loads bound the kernel. ".repeat(1500);
    k.event("writer:teacher-1", "research_paper_accepted", {
      writer: "teacher-1",
      chars: long.length,
      paper: long,
    });
    k.event("research", "research_final", { report: long });
    for (const ref of ["paper", "final"]) {
      const x = k.read(`gemv/gs-1/records/report:${ref}`);
      assert.equal(x.item.file, null);
      assert.ok(x.item.chars <= 20_000, `${ref}: ${x.item.chars}`);
      const end = k.read(`gemv/gs-1/records/report:${ref}`, x.item.chars - 200);
      assert.match(
        end.item.text,
        /\(Cut: the (paper|report) has [\d,]+ characters; the run's research folder keeps it whole\.\)$/,
      );
    }
  });
});
