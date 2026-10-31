import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KbFiles, safeFileType } from "../../../src/control/kb/index.ts";
import { controlOnly, mcpClient } from "../../helpers/control-stack.ts";
import { FINDING, fillReader, HTML_PAGE, WITHDRAWN_WHY } from "../../helpers/kb-reader.ts";

/**
 * The owner's read of one item (goal 176), as REST, MCP and the Knowledge page's reader give it:
 * every version, its writer and program, withdrawn evidence, links both ways across a grant, its
 * file's facts and download, and which running runs' agents can read it, and why.
 */

const READER = "read-token-abcdef";

async function control() {
  const dir = mkdtempSync(join(tmpdir(), "thermite-kb-files-"));
  let files: KbFiles | undefined;
  const made = controlOnly({
    tokens: { read: READER, rigs: { "rig-a": "rig-a-token-abcd", "rig-b": "rig-b-token-abcd" } },
    options: (store) => {
      files = new KbFiles(dir, store);
      return { staleAfterMs: 600_000, kbFiles: files };
    },
  });
  await fillReader(made.store, files);
  const read = async (address: string, more = "") => {
    const r = await made.api("GET", `/v1/kb/item?address=${encodeURIComponent(address)}${more}`);
    return { status: r.status, body: (await r.json()) as { item: Item; error?: string } };
  };
  return { ...made, read };
}

interface Item {
  title: string;
  text: string;
  version: number;
  versions: number;
  type: string;
  history: { version: number; title: string; by: string }[];
  writer: { role: string | null; program: string | null; words: string };
  withdrawn: string | null;
  outcome: string | null;
  links: { rel: string; to: string; title: string | null }[];
  linked_from: { rel: string; address: string; title: string }[];
  readers: { run: string; collection: string; can: boolean; why: string }[];
  file: { name: string; held: boolean; searched: boolean; from: string; sha256: string } | null;
}

describe("the owner's read of an item", () => {
  test("every version, the newest first; one picked; one it has not, refused in words", async () => {
    const s = await control();
    const { body } = await s.read(FINDING);
    assert.deepEqual(
      [body.item.version, body.item.versions, body.item.title],
      [2, 2, "Vector loads double the bandwidth, measured twice"],
    );
    assert.deepEqual(
      body.item.history.map((v) => [v.version, v.by]),
      [
        [2, "worker-1"],
        [1, "worker-1"],
      ],
    );
    const first = await s.read(FINDING, "&version=1");
    assert.equal(first.body.item.version, 1);
    assert.match(first.body.item.title, /^<script>alert\(1\)<\/script> Vector loads/);
    assert.match(first.body.item.text, /^128-bit loads doubled the measured bandwidth/);
    const none = await s.read(FINDING, "&version=9");
    assert.equal(none.status, 404);
    assert.equal(none.body.error, `${FINDING} has versions 1 to 2, not 9`);
  });

  test("the writer: Thermite's code for records, else the slot's role and the program its calls ran in", async () => {
    const s = await control();
    assert.deepEqual((await s.read(FINDING)).body.item.writer, {
      role: "worker",
      program: "Claude Code",
      words: "worker · Claude Code",
    });
    assert.deepEqual((await s.read("gemv/gs-1/planner/decision:1")).body.item.writer, {
      role: "planner",
      program: null,
      words: "planner",
    });
    assert.deepEqual((await s.read("gemv/gs-1/records/experiment:x-1")).body.item.writer, {
      role: null,
      program: null,
      words: "Thermite's code",
    });
  });

  test("withdrawn evidence: an attempt's reason from Thermite's records, in the read and the list", async () => {
    const s = await control();
    const a2 = (await s.read("gemv/gs-1/records/attempt:a-2")).body.item;
    assert.deepEqual([a2.withdrawn, a2.outcome], [WITHDRAWN_WHY, "unclear"]);
    assert.equal((await s.read("gemv/gs-1/records/attempt:a-1")).body.item.withdrawn, null);
    const list = (await (
      await s.api("GET", "/v1/kb/list?at=gemv/gs-1/records&kind=attempt")
    ).json()) as {
      items: { address: string; withdrawn: string | null }[];
    };
    assert.deepEqual(list.items.map((x) => [x.address, x.withdrawn]).sort(), [
      ["gemv/gs-1/records/attempt:a-1", null],
      ["gemv/gs-1/records/attempt:a-2", WITHDRAWN_WHY],
    ]);
  });

  test("links both ways, across a grant: its own, each with its target's title, and the items that link to it", async () => {
    const s = await control();
    const finding = (await s.read(FINDING)).body.item;
    assert.deepEqual(finding.links, []);
    assert.deepEqual(
      finding.linked_from.map((l) => [l.rel, l.address, l.title]),
      [
        ["follows", "gemv/gs-1/planner/decision:1", "Tile next"],
        [
          "supports",
          "survey/sv-1/worker-1/finding:1",
          "The bandwidth gain holds on another device",
        ],
      ],
    );
    const other = (await s.read("survey/sv-1/worker-1/finding:1")).body.item;
    assert.deepEqual(other.links, [
      { rel: "follows", to: "gemv/gs-1/worker-1/finding:9", title: null },
      {
        rel: "supports",
        to: FINDING,
        title: "Vector loads double the bandwidth, measured twice",
      },
    ]);
  });

  test("who can read it: each running run, from its scope, with why", async () => {
    const s = await control();
    const readers = (await s.read(FINDING)).body.item.readers;
    assert.deepEqual(
      readers.map((r) => [r.run, r.collection, r.can, r.why]),
      [
        ["at-1", "attic", false, "no grant"],
        ["gs-1", "gemv", true, "its collection"],
        ["gs-2", "gemv", false, "started fresh"],
        ["sv-1", "survey", true, "granted and included"],
        ["sv-2", "survey", false, "grant not included"],
      ],
    );
    const own = (await s.read("gemv/gs-2/records/run:gs-2")).body.item.readers;
    assert.deepEqual(
      own.find((r) => r.run === "gs-2"),
      { run: "gs-2", collection: "gemv", rig: "rig-a", can: true, why: "its own run" },
    );
  });

  test("a file's facts: held or not, its text not searched before control has it, where it came from", async () => {
    const s = await control();
    const html = (await s.read("gemv/gs-1/worker-1/reference:3")).body.item;
    assert.equal(html.type, "file");
    assert.deepEqual(
      html.file && [html.file.name, html.file.held, html.file.searched, html.file.from],
      ["loads.html", true, false, "worker-1 wrote it in gs-1, on rig-a"],
    );
    assert.equal(html.text, "");
    const pdf = (await s.read("gemv/gs-1/worker-1/reference:2")).body.item;
    assert.equal(pdf.file?.held, false, "a file whose bytes control does not hold yet");
  });

  test("a file downloads over REST as an attachment no browser runs; MCP and REST read alike", async () => {
    const s = await control();
    const r = await s.api("GET", "/v1/kb/file?address=gemv/gs-1/worker-1/reference:3");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/octet-stream");
    assert.equal(
      r.headers.get("content-disposition"),
      `attachment; filename="loads.html"; filename*=UTF-8''loads.html`,
    );
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.equal(await r.text(), HTML_PAGE);
    const missing = await s.api("GET", "/v1/kb/file?address=gemv/gs-1/worker-1/reference:2");
    assert.equal(missing.status, 409);
    assert.match(
      ((await missing.json()) as { error: string }).error,
      /^control does not hold loads\.pdf yet/,
    );
    const text = await s.api("GET", `/v1/kb/file?address=${encodeURIComponent(FINDING)}`);
    assert.equal(text.status, 404);
    assert.equal(
      (await s.api("GET", "/v1/kb/file?address=gemv/gs-1/worker-1/reference:3", undefined, READER))
        .status,
      401,
    );
    // Only passive types keep their own.
    assert.deepEqual(
      [
        "application/pdf",
        "text/plain",
        "text/html",
        "image/svg+xml",
        "application/xhtml+xml",
        "text/javascript",
      ].map(safeFileType),
      [
        "application/pdf",
        "text/plain",
        "application/octet-stream",
        "application/octet-stream",
        "application/octet-stream",
        "application/octet-stream",
      ],
    );
    const mcp = await mcpClient(s.control);
    const viaMcp = (await mcp.callTool({ name: "kb_read", arguments: { address: FINDING } })) as {
      content: { text: string }[];
    };
    assert.deepEqual(JSON.parse(viaMcp.content[0]?.text ?? "{}"), (await s.read(FINDING)).body);
  });
});
