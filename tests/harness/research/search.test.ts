import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { passagesOf } from "../../../src/common/search/index.ts";
import { parseContract } from "../../../src/core/contract.ts";
import {
  normalizedWithPlaces,
  normalizeQuote,
  quotePlaces,
} from "../../../src/harness/research/checks.ts";
import { SAVED_LANES_DIR } from "../../../src/harness/research/folder.ts";
import { Research } from "../../../src/harness/research/research/index.ts";
import { researchFixture } from "../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/**
 * The run's own searches on the rig (goal 175): search_research ranks the run's research by its
 * words on an index of its own, and search_corpus finds an exact phrase in the archived sources, as
 * add_claim checks a quote, with its exact place. The index follows what is archived and written.
 */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A research run r-1 on a fresh harness, with its research service on the service's index. */
async function setup() {
  const env = makeHarnessEnv("rig-r");
  const parsed = parseContract(researchFixture);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  await env.service.applyCommand(
    env.sign("assign_campaign", {
      run: "r-1",
      contract: parsed.contract,
      contract_sha: parsed.sha,
      imports: [],
    }),
  );
  const research = new Research(env.service.ledger, env.service.paths.stateDir, {
    outboxDir: env.service.paths.outboxDir,
    search: env.service.runSearch,
    allowPrivate: true,
  });
  let n = 0;
  /** A source archived as the fetcher archives one: its text in a file, its row in the ledger. */
  const archive = (text: string, title = "A page") => {
    const id = `s-${String(++n).padStart(12, "0")}`;
    const path = join(env.service.paths.stateDir, "test-archive", `${id}.txt`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    env.service.ledger.sources.add({
      id,
      run: "r-1",
      url: `https://site${n}.example.org/page`,
      finalUrl: `https://site${n}.example.org/page`,
      domain: `site${n}.example.org`,
      status: 200,
      contentType: "text/html",
      bytes: text.length,
      sha256: sha(text),
      title,
      rawPath: path,
      textPath: path,
      by: "lane-1",
    });
    return id;
  };
  /** A lane's file as the research folder saves it when its trial ends. */
  const laneFile = (path: string, text: string, trial: string) => {
    const at = join(env.service.paths.stateDir, SAVED_LANES_DIR, "r-1", "lane-1", path);
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, text);
    env.service.ledger.laneFiles.record("r-1", "lane-1", trial, [
      { path, change: "written", bytes: Buffer.byteLength(text), sha256: sha(text) },
    ]);
  };
  const search = (q: string, o: Parameters<typeof env.service.runResearch.search>[2] = {}) =>
    env.service.runResearch.search("r-1", q, o) as {
      matched: number;
      items: {
        kind: string;
        id: string;
        excerpt: string;
        why: string;
        passage: { from: number; to: number } | null;
      }[];
    };
  return { env, research, archive, laneFile, search };
}

/** A sentence of filler, so that pages are alike in length. */
const FILLER = "The kernel reads its inputs and writes its outputs in order. ";

describe("search_research: the run's research ranked by its words", () => {
  test("by relevance: the page that says it most first, and none that does not say it", async () => {
    const s = await setup();
    const once = s.archive(`${FILLER.repeat(6)}Tiling helps.`);
    const often = s.archive(`${FILLER.repeat(3)}Tiling, tiling and more tiling: tiling wins.`);
    const twice = s.archive(`${FILLER.repeat(5)}Tiling helps; tiling again.`);
    s.archive(FILLER.repeat(7));
    const r = s.search("tiling");
    assert.deepEqual(
      r.items.map((x) => x.id),
      [often, twice, once],
    );
    assert.equal(r.matched, 3);
    assert.match(r.items[0]?.why ?? "", /the text has tiling/);
  });

  test("words in a long source past its 20,000th character, and in a lane's file", async () => {
    const s = await setup();
    const long = `${FILLER.repeat(500)}The loads swizzle their addresses to spread the banks.`;
    assert.ok(long.indexOf("swizzle") > 20_000);
    const id = s.archive(long);
    s.laneFile("notes/banks.md", "# Banks\n\nA swizzle spreads the shared memory banks.\n", "t-1");
    const r = s.search("swizzle banks");
    assert.deepEqual(r.items.map((x) => x.id).sort(), [id, "lanes/lane-1/notes/banks.md"].sort());
    const hit = r.items.find((x) => x.id === id);
    assert.match(hit?.excerpt ?? "", /\*\*swizzle\*\*/);
    // Its passage is where read_source reads it.
    const from = hit?.passage?.from ?? 0;
    assert.ok(from > 20_000, JSON.stringify(hit?.passage));
    assert.match(
      String(s.research.read("r-1", id, from, 6000).text),
      /loads swizzle their addresses/,
    );
    // Only the files, or only the sources.
    assert.deepEqual(
      s.search("swizzle", { kinds: ["file"] }).items.map((x) => x.id),
      ["lanes/lane-1/notes/banks.md"],
    );
  });

  test("the index stays current: a source archived, a file changed, a claim added", async () => {
    const s = await setup();
    assert.equal(s.search("zircon").matched, 0);
    const id = s.archive(`${FILLER}Zircon crystals hold the record.`);
    assert.deepEqual(
      s.search("zircon").items.map((x) => x.id),
      [id],
    );
    s.laneFile("draft.md", "Zircon first.\n", "t-1");
    assert.equal(s.search("zircon", { kinds: ["file"] }).matched, 1);
    // The lane changes its file: its new words are found, its old ones no longer.
    s.laneFile("draft.md", "Garnet now.\n", "t-2");
    assert.equal(s.search("zircon", { kinds: ["file"] }).matched, 0);
    assert.equal(s.search("garnet", { kinds: ["file"] }).matched, 1);
    const c = s.research.addClaim("r-1", "lane-1", {
      text: "Zircon crystals hold the record.",
      quotes: [{ source: id, quote: "Zircon crystals hold the record." }],
      question: 0,
    });
    assert.equal(c.verified, true);
    assert.deepEqual(
      s.search("zircon", { kinds: ["claim"] }).items.map((x) => [x.id, x.kind]),
      [[c.claim, "claim"]],
    );
  });
});

describe("search_corpus: an exact phrase, where it is", () => {
  test("an exact phrase is found with its place, and its quote verifies; a near miss is not a match", async () => {
    const s = await setup();
    const text = `${FILLER.repeat(3)}The “dequantize” step runs once per tile, in shared memory.`;
    const id = s.archive(text);
    s.archive(`${FILLER.repeat(3)}A dequantize stage runs twice.`);
    const page = s.research.searchCorpus("r-1", 'The "dequantize" step runs once');
    assert.equal(page.matches.length, 1);
    const [m] = page.matches;
    assert.equal(m?.source, id);
    assert.equal(m?.at, text.indexOf("The “dequantize”"));
    assert.equal(m?.quote, "The “dequantize” step runs once");
    assert.equal(m?.places, 1);
    // The place is where read_source reads, and the quote is one add_claim verifies.
    assert.match(String(s.research.read("r-1", id, m?.at, 40).text), /^The “dequantize” step/);
    const claim = s.research.addClaim("r-1", "lane-1", {
      text: "The dequantize step runs once per tile.",
      quotes: [{ source: id, quote: m?.quote ?? "" }],
      question: 0,
    });
    assert.equal(claim.verified, true);
    // Other case, or other word endings: the words in this order, not these characters.
    for (const near of ["The dequantize Step runs once", "the dequantize steps run once"]) {
      const r = s.research.searchCorpus("r-1", near);
      assert.deepEqual(r.matches, [], near);
      assert.equal(r.near?.[0]?.source, id, near);
      assert.equal(r.near?.[0]?.quote, "The “dequantize” step runs once", near);
      assert.equal(r.near?.[0]?.at, m?.at, near);
      assert.match(r.near_note ?? "", /not these exact characters/);
    }
    // Another word: nothing at all.
    const none = s.research.searchCorpus("r-1", "dequantize step runs thrice");
    assert.deepEqual(none.matches, []);
    assert.equal(none.near, undefined);
    assert.match(String(s.research.searchCorpus("r-1", "… —").note), /finds words/);
  });

  test("a phrase across two of the index's passages is found", async () => {
    const s = await setup();
    // Words with no sentence's end among them around the 2,000th character: a passage ends at a space there.
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const text = `${FILLER.repeat(25)}${words} ${FILLER.repeat(30)}`;
    const [first] = passagesOf(text);
    const end = first?.end ?? 0;
    assert.ok(end > text.indexOf("word0") && end < text.indexOf("word199"), `${end}`);
    // Three words before the cut and three after it.
    const before = text.slice(0, end).trimEnd().split(" ").slice(-3).join(" ");
    const after = text.slice(end).trimStart().split(" ").slice(0, 3).join(" ");
    const id = s.archive(text);
    const page = s.research.searchCorpus("r-1", `${before} ${after}`);
    assert.equal(page.matches[0]?.source, id);
    assert.equal(page.matches[0]?.quote, `${before} ${after}`);
  });
});

describe("a quote's place, as add_claim compares a quote", () => {
  test("the same rules as normalizeQuote, one character at a time, with where each came from", () => {
    const texts = [
      "  Plain words.  ",
      "Tabs\tand\n\nlines\r\n  here",
      "“Curly” ‘quotes’ — dashes – and\u00a0spaces",
      "",
      "   ",
      "émigré naïve 𝔘nicode ✓",
    ];
    for (const t of texts) {
      const n = normalizedWithPlaces(t);
      assert.equal(n.text, normalizeQuote(t), JSON.stringify(t));
      assert.equal(n.at.length, n.text.length);
    }
    const text = "Its  “first”\nrun archived pages; its first run archived more.";
    // Case counts: "its" is not "Its".
    assert.deepEqual(quotePlaces(text, 'its "first" run archived', 5), []);
    assert.deepEqual(
      quotePlaces(text, "first run archived", 5).map((p) => text.slice(p.start, p.end)),
      ["first run archived"],
    );
    assert.deepEqual(
      quotePlaces(text, 'Its "first" run', 5).map((p) => text.slice(p.start, p.end)),
      ["Its  “first”\nrun"],
    );
  });
});
