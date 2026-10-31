import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  answerKbAsk,
  KB_TEXT_LIMITS,
  KbFiles,
  KbText,
  type KbTextLimits,
  ownerKbRead,
  ownerKbSearch,
} from "../../../src/control/kb/index.ts";
import {
  htmlText,
  PDFJS_SHA256,
  pdfjsProblem,
  TEXT_PROGRAM,
  textExecArgv,
} from "../../../src/control/kb/text/index.ts";
import { PDFJS_DIR } from "../../../src/control/kb/text/pdf.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import type { SignedCommand } from "../../../src/core/commands.ts";
import type { KbItemBody } from "../../../src/core/kb.ts";
import type { KbReadAnswer, KbSearchAnswer } from "../../../src/core/link/kb.ts";
import { tinyPdf } from "../../helpers/pdf.ts";

/**
 * The text of the knowledge base's files, extracted on control (goal 175, step 7): Markdown and
 * plain text as they are, a web page with no markup, scripts or styles, and a PDF with the vendored
 * PDF.js, each read once, by its SHA-256, in a child process within its limits; its text goes into
 * the words index, so kb_search finds the file by its words. A file whose text can't be read is
 * kept whole, and the read says why.
 */

const RIG = { rig: "rig-a", ledger: "ledger-a" };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const assignment = (id: string, run: string, campaign: string) =>
  ({
    envelope: {
      v: 1,
      id,
      rig: RIG.rig,
      kind: "assign_campaign",
      issued_by: "owner:api",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { run, contract: { campaign } },
    },
    signature: "not checked by the store",
  }) as unknown as SignedCommand;

/** gemv's run gs-1 on rig-a, which control assigned, with worker-1 writing files into it. */
function setup(limits: Partial<KbTextLimits> = {}) {
  const store = new ControlStore(":memory:");
  store.commands.enqueue(assignment("c-1", "gs-1", "gemv"));
  store.kb().index(RIG, {
    at: "2026-10-30T10:00:00.000Z",
    actor: "harness",
    kind: "run_created",
    subject: "gs-1",
    body: { campaign: "gemv", mode: "research" },
  });
  const files = new KbFiles(mkdtempSync(join(tmpdir(), "thermite-kb-text-")), store);
  const text = new KbText(store, files, limits);
  let item = 0;
  /** Control holds these bytes. */
  const hold = (bytes: Buffer) => {
    const path = files.path(sha(bytes));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    store.kb().files.kept(sha(bytes), bytes.length);
  };
  /** worker-1's next item, a file of this name and type: its address. */
  const write = (
    name: string,
    type: string,
    bytes: Buffer,
    o: { held?: boolean; slot?: string } = {},
  ) => {
    item++;
    const slot = o.slot ?? "worker-1";
    const refused = store.kb().write(
      {
        ...RIG,
        run: "gs-1",
        event: 100 + item,
        at: new Date(Date.parse("2026-10-30T10:01:00Z") + item * 1000).toISOString(),
      },
      {
        slot,
        item,
        version: 1,
        kind: "reference",
        title: name,
        links: [],
        file: { sha256: sha(bytes), name, type, bytes: bytes.length },
      } as KbItemBody,
    );
    if (refused) throw new Error(refused);
    if (o.held !== false) hold(bytes);
    return `gemv/gs-1/${slot}/reference:${item}`;
  };
  const search = (q: string) => {
    const r = ownerKbSearch(store, { q });
    if ("error" in r) throw new Error(String(r.error));
    return r.hits;
  };
  const read = (address: string) => {
    const r = ownerKbRead(store, [], { address });
    if ("error" in r) throw new Error(String(r.error));
    return r.item;
  };
  const agentSearch = (q: string) =>
    answerKbAsk(store, RIG.rig, "search", { run: "gs-1", q }) as KbSearchAnswer;
  const agentRead = (address: string) =>
    answerKbAsk(store, RIG.rig, "read", { run: "gs-1", address }) as KbReadAnswer;
  return { store, files, text, hold, write, search, read, agentSearch, agentRead };
}

const PAGE = `<!doctype html><html><head><title>Wading birds</title>
<style>.heron { color: red } /* stylishword */</style>
<script>var secret = "scriptword"; if (a < b && c > d) { document.write("</p>") }</script>
<script type="module" data-x=">">import "evilword";</script></head>
<body><!-- commentword <script>hidden()</script> -->
<p class="x">The grey <b>heron</b> waits &amp; watches &lt;still&gt;.</p>
<a href="/x" title="a > b">A link</a><template><p>templateword</p></template>
</body></html>`;

describe("the text of the knowledge base's files", () => {
  test("Markdown, plain text, a web page and a PDF: each read once, and found by kb_search", async () => {
    const s = setup();
    const md = s.write(
      "notes.md",
      "text/markdown",
      Buffer.from("# Notes\n\nThe marmoset climbs.\n"),
    );
    const txt = s.write("log.txt", "text/plain", Buffer.from("A plover ran along the shore.\n"));
    const html = s.write("birds.html", "text/html", Buffer.from(PAGE));
    const pdf = s.write(
      "raptors.pdf",
      "application/pdf",
      tinyPdf(["The osprey dives", "for fish"]),
    );
    const json = s.write("data.json", "application/json", Buffer.from('{"bird": "kestrel"}'));
    assert.equal(s.read(pdf).file?.text_state, "waiting", "before control extracts it");
    assert.equal(s.search("osprey").length, 0);

    assert.equal(await s.text.look(), 4, "four files of types control reads");
    for (const [word, address] of [
      ["marmoset", md],
      ["plover", txt],
      ["heron", html],
      ["osprey", pdf],
    ] as const) {
      const hits = s.search(word);
      assert.deepEqual(
        hits.map((h) => h.address),
        [address],
        `the owner's kb_search finds ${word}`,
      );
      assert.match(hits[0]?.excerpt ?? "", new RegExp(`\\*\\*${word}\\*\\*`, "i"));
      const agents = s.agentSearch(word);
      assert.deepEqual(
        agents.hits.map((h) => h.address),
        [address],
        `an agent's finds ${word}`,
      );
      const r = s.read(address);
      assert.equal(r.file?.searched, true);
      assert.equal(r.file?.text_state, "searched");
      assert.equal(r.file?.text_why, null, "read whole");
      assert.match(r.text, new RegExp(word, "i"));
    }
    assert.equal(s.read(pdf).text, "The osprey dives\n\nfor fish");
    assert.equal(s.agentRead(pdf).item.text, "The osprey dives\n\nfor fish", "an agent's kb_read");
    // A JSON file is kept whole: control reads no text of its type.
    assert.equal(s.search("kestrel").length, 0);
    const kept = s.read(json).file;
    assert.equal(kept?.text_state, "kept whole");
    assert.match(kept?.text_why ?? "", /not application\/json$/);
    assert.equal(await s.text.look(), 0, "each file is read once");
  });

  test("a web page gives its words only: no markup, script, style, comment or template", async () => {
    const words = htmlText(PAGE);
    assert.equal(
      words,
      "Wading birds\n\nThe grey heron waits & watches <still>.\n\nA link",
      "entities become the characters they name, as text",
    );
    for (const hidden of ["scriptword", "evilword", "stylishword", "commentword", "templateword"])
      assert.ok(!words.includes(hidden), hidden);
    assert.equal(htmlText("<p>open <script>never closed"), "open");
    const s = setup();
    s.write("birds.html", "text/html", Buffer.from(PAGE));
    await s.text.look();
    for (const hidden of ["scriptword", "secret", "stylishword", "commentword"])
      assert.equal(s.search(hidden).length, 0, `${hidden} is not searched`);
  });

  test("a malformed PDF, a huge one, a slow one and a greedy one each end within the limits", async () => {
    const s = setup({ pages: 20, readBytes: 512 * 1024 });
    const started = Date.now();
    const bad = s.write(
      "bad.pdf",
      "application/pdf",
      Buffer.from("%PDF-1.4\nnot a PDF at all\n%%EOF\n"),
    );
    const big = s.write(
      "big.pdf",
      "application/pdf",
      tinyPdf(Array.from({ length: 300 }, (_, i) => `page ${i + 1} words`)),
    );
    const huge = s.write(
      "huge.pdf",
      "application/pdf",
      Buffer.concat([tinyPdf(["x"]), Buffer.alloc(1024 * 1024)]),
    );
    const binary = s.write(
      "blob.txt",
      "text/plain",
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0x14]),
    );
    const empty = s.write("scanned.pdf", "application/pdf", tinyPdf([""]));
    assert.equal(await s.text.look(), 5);
    const why = (address: string) => s.read(address).file;
    assert.deepEqual(
      [why(bad)?.text_state, why(bad)?.text_why],
      ["kept whole", "PDF.js could not read it: Invalid PDF structure."],
    );
    assert.deepEqual(
      [why(big)?.text_state, why(big)?.text_why],
      ["searched", "the first 20 of its 300 pages"],
    );
    assert.match(s.read(big).text, /page 20 words$/);
    const phrase = (words: string) => {
      const r = ownerKbSearch(s.store, { q: `"${words}"`, mode: "exact" });
      if ("error" in r) throw new Error(String(r.error));
      return r.hits.length;
    };
    assert.deepEqual(
      [phrase("page 20 words"), phrase("page 21 words")],
      [1, 0],
      "its first 20 pages are searched, and only they",
    );
    assert.equal(
      why(huge)?.text_why,
      "it has 1 MiB, more than the 0.5 MiB control reads to extract a PDF's text",
    );
    assert.equal(why(binary)?.text_why, "it holds binary data, not text");
    assert.match(why(empty)?.text_why ?? "", /^it holds no text/);

    // Past its time the child is killed; over its memory it ends itself.
    const slow = setup({ timeoutMs: 1 });
    const one = slow.write("big.pdf", "application/pdf", tinyPdf(["late"]));
    await slow.text.look();
    assert.equal(slow.read(one).file?.text_why, "reading its text took longer than 0.001 seconds");
    const greedy = setup({ memoryMb: 16 });
    const two = greedy.write("big.pdf", "application/pdf", tinyPdf(["greedy"]));
    await greedy.text.look();
    assert.equal(
      greedy.read(two).file?.text_why,
      "reading its text needed more than 16 MiB of memory",
    );
    // A long text is cut at the limit on characters.
    const long = setup({ chars: 1000 });
    const three = long.write("long.txt", "text/plain", Buffer.from("tern ".repeat(1000)));
    await long.text.look();
    assert.equal(long.read(three).file?.text_why, "its first 1,000 characters");
    assert.equal(long.read(three).chars, 1000);
    assert.ok(Date.now() - started < 60_000, "every file ended well within the limits");
  });

  test("the files kept before control read text are read by its first look; a file after its item at the next", async () => {
    const s = setup();
    // Items and their files, as a store holds them before this version.
    const before = [
      s.write("a.md", "text/markdown", Buffer.from("The avocet sweeps.")),
      s.write("b.pdf", "application/pdf", tinyPdf(["The bittern booms"])),
    ];
    const later = s.write("c.md", "text/markdown", Buffer.from("The curlew calls."), {
      held: false,
    });
    assert.equal(await s.text.look(), 2, "the backfill: every file held, none waiting after");
    assert.equal(s.search("avocet")[0]?.address, before[0]);
    assert.equal(s.search("bittern")[0]?.address, before[1]);
    assert.equal(s.read(later).file?.text_state, "waiting");
    assert.match(s.read(later).file?.text_why ?? "", /once it holds the file/);
    s.hold(Buffer.from("The curlew calls."));
    assert.equal(await s.text.look(), 1);
    assert.equal(s.search("curlew")[0]?.address, later);
    // An item that names a file whose text control has is searched at once, with no look.
    const again = s.write("copy.md", "text/markdown", Buffer.from("The avocet sweeps."), {
      slot: "worker-2",
    });
    assert.deepEqual(
      s
        .search("avocet")
        .map((h) => h.address)
        .sort(),
      [before[0], again].sort(),
      "each file is read once by its SHA-256, and every item that names it is found",
    );
    assert.equal(await s.text.look(), 0);
    const rows = s.store.db.prepare("select count(*) as n from kb_file_text").get() as {
      n: number;
    };
    assert.equal(rows.n, 3, "one text for each file");
  });

  test("an orphan file's text goes with it", async () => {
    const s = setup();
    const bytes = Buffer.from("The dunlin probes.");
    s.write("d.md", "text/markdown", bytes);
    await s.text.look();
    s.store.kb().files.removed(sha(bytes));
    const rows = s.store.db.prepare("select count(*) as n from kb_file_text").get() as {
      n: number;
    };
    assert.equal(rows.n, 0);
  });

  test("the child loads no native module, and only the pinned PDF.js", () => {
    assert.deepEqual(textExecArgv(KB_TEXT_LIMITS).slice(0, 2), [
      "--no-addons",
      "--max-old-space-size=1024",
    ]);
    assert.match(TEXT_PROGRAM, /kb\/text\/main\.ts$/);
    assert.equal(pdfjsProblem(), undefined, "vendor/pdfjs/ is PDF.js 6.4.299's");
    const readme = readFileSync(join(PDFJS_DIR, "README.md"), "utf8");
    for (const [name, want] of Object.entries(PDFJS_SHA256))
      assert.ok(
        readme.includes(`\`${name}\``) && readme.includes(want),
        `README names ${name}'s SHA-256`,
      );
    // A copy whose worker is changed is not loaded.
    const dir = `${mkdtempSync(join(tmpdir(), "thermite-pdfjs-"))}/`;
    copyFileSync(join(PDFJS_DIR, "pdf.mjs"), `${dir}pdf.mjs`);
    writeFileSync(`${dir}pdf.worker.mjs`, "export const WorkerMessageHandler = null;\n");
    assert.equal(
      pdfjsProblem(dir),
      "vendor/pdfjs/pdf.worker.mjs is not PDF.js 6.4.299's: not loaded",
    );
  });
});
