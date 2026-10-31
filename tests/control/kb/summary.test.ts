import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { KbFiles } from "../../../src/control/kb/index.ts";
import { ADMIN, controlOnly, mcpClient } from "../../helpers/control-stack.ts";
import { KB_RIG } from "../../helpers/kb-places.ts";
import { fillReader, HTML_PAGE, SVG_IMAGE } from "../../helpers/kb-reader.ts";

/**
 * A place's summary in the owner's list of it (goal 176), the same over REST, MCP and the command
 * line: a collection's campaign, mode, runs, slots and grants both ways; a run's state and what
 * its agents search; a slot's writer, the kinds it may write, what it holds and the writes control
 * refused it. And grants given and ended over REST and the command line, with the same words.
 */

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");

async function control() {
  const dir = mkdtempSync(join(tmpdir(), "thermite-kb-files-"));
  let files: KbFiles | undefined;
  const made = controlOnly({
    tokens: { rigs: { "rig-a": "rig-a-token-abcd", "rig-b": "rig-b-token-abcd" } },
    options: (store) => {
      files = new KbFiles(dir, store);
      return { staleAfterMs: 600_000, kbFiles: files };
    },
  });
  await fillReader(made.store, files);
  // A write control refused worker-1 of gs-1.
  made.store.auditLog.add("control", "kb_item_refused", {
    ...KB_RIG,
    event: 77,
    run: "gs-1",
    writer: "worker-1",
    slot: "worker-1",
    why: "the campaign lets worker-1 write journal, surprise, note, finding, doc, reference in run gs-1: not a paper",
  });
  const summary = async (at: string) => {
    const r = await made.api("GET", `/v1/kb/list?limit=0&at=${encodeURIComponent(at)}`);
    return ((await r.json()) as { summary: Record<string, unknown> }).summary;
  };
  return { ...made, summary };
}

describe("a place's summary", () => {
  test("a collection: its campaign, mode, runs, what it holds, its slots and its grants both ways", async () => {
    const s = await control();
    const gemv = await s.summary("gemv");
    assert.deepEqual(
      [gemv.level, gemv.campaign, gemv.mode, gemv.archived, gemv.runs],
      ["collection", "gemv", "goal", false, 2],
    );
    // gs-1's run, two experiments, two attempts and a field note; gs-2's run.
    assert.deepEqual([gemv.records, gemv.blurbs, gemv.files], [7, 2, 3]);
    assert.ok(Number(gemv.older_versions) >= 5, "every change of an item is a version kept");
    assert.ok(
      Number(gemv.stored_bytes) > Buffer.byteLength(HTML_PAGE) + Buffer.byteLength(SVG_IMAGE),
      "the texts, and the files control holds",
    );
    assert.deepEqual(gemv.slots, [
      { name: "records", items: 7 },
      { name: "worker-1", items: 4 },
      { name: "planner", items: 1 },
    ]);
    assert.deepEqual([gemv.reads, gemv.read_by], [[], ["survey"]]);
    assert.deepEqual(
      [(await s.summary("survey")).reads, (await s.summary("attic")).archived],
      [["gemv"], true],
    );
  });

  test("a run: its state, and what its agents search", async () => {
    const s = await control();
    const gs1 = await s.summary("gemv/gs-1");
    assert.deepEqual([gs1.level, gs1.status, gs1.rig], ["run", "running", "rig-a"]);
    assert.deepEqual(gs1.searches, { collection: "gemv", own_run_only: false, granted: [] });
    assert.deepEqual((await s.summary("gemv/gs-2")).searches, {
      collection: "gemv",
      own_run_only: true,
      granted: [],
    });
    assert.deepEqual((await s.summary("survey/sv-1")).searches, {
      collection: "survey",
      own_run_only: false,
      granted: ["gemv"],
    });
  });

  test("a slot: its writer, the kinds it may write, what it holds, and the writes control refused it", async () => {
    const s = await control();
    const w1 = await s.summary("gemv/gs-1/worker-1");
    assert.equal(w1.level, "slot");
    assert.deepEqual(w1.writer, {
      role: "worker",
      program: "Claude Code",
      words: "worker · Claude Code",
    });
    assert.deepEqual(w1.writes, ["journal", "surprise", "note", "finding", "doc", "reference"]);
    assert.deepEqual(w1.kinds, { reference: 3, finding: 1 });
    const refused = w1.refused as { total: number; newest: { why: string; event: number }[] };
    assert.equal(refused.total, 1);
    assert.deepEqual(
      [refused.newest[0]?.event, refused.newest[0]?.why],
      [
        77,
        "the campaign lets worker-1 write journal, surprise, note, finding, doc, reference in run gs-1: not a paper",
      ],
    );
    const records = await s.summary("gemv/gs-1/records");
    assert.deepEqual(
      [records.writes, (records.writer as { words: string }).words],
      [null, "Thermite's code"],
    );
    assert.deepEqual((records.refused as { total: number }).total, 0);
    // The slot folders of a run say who writes each.
    const list = (await (
      await s.api("GET", "/v1/kb/list?limit=0&at=gemv/gs-1&sort=name")
    ).json()) as {
      folders: { name: string; writer: string }[];
    };
    assert.deepEqual(
      list.folders.map((f) => [f.name, f.writer]),
      [
        ["planner", "planner"],
        ["records", "Thermite's code"],
        ["worker-1", "worker · Claude Code"],
      ],
    );
    // MCP gives the same summary.
    const mcp = await mcpClient(s.control);
    const r = (await mcp.callTool({
      name: "kb_list",
      arguments: { at: "gemv/gs-1/worker-1", limit: 0 },
    })) as {
      content: { text: string }[];
    };
    assert.deepEqual((JSON.parse(r.content[0]?.text ?? "{}") as { summary: unknown }).summary, w1);
  });

  test("grants over REST and the command line: the same code and words as the Knowledge page", async () => {
    const s = await control();
    const grant = await s.api("POST", "/v1/campaigns/attic/kb-grants", { reads: "gemv" });
    assert.equal(grant.status, 201);
    assert.deepEqual(await grant.json(), {
      campaign: "attic",
      changed: true,
      reads: ["gemv"],
      read_by: [],
      said: "attic's agents may now read gemv's collection. Runs started from now can include it in their search; runs at work keep their search as it started, and their research folders get it at the next sync.",
    });
    const again = await s.api("POST", "/v1/campaigns/attic/kb-grants", { reads: "gemv" });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { said: string }).said, "attic reads gemv already.");
    const self = await s.api("POST", "/v1/campaigns/attic/kb-grants", { reads: "attic" });
    assert.equal(self.status, 400);
    assert.deepEqual(await self.json(), {
      error: "A campaign always reads its own collection: choose another campaign's.",
    });
    assert.equal(
      (await s.api("POST", "/v1/campaigns/nope/kb-grants", { reads: "gemv" })).status,
      404,
    );
    assert.equal(
      s.store.auditLog.list(50).filter((a) => a.action === "kb_grant" && a.actor === "owner:api")
        .length,
      1,
    );
    // The command line, through the same routes.
    const server = serve({ fetch: s.control.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tokenFile = join(mkdtempSync(join(tmpdir(), "thermite-cli-grant-")), "token");
    writeFileSync(tokenFile, `${ADMIN}\n`);
    const cli = async (...args: string[]) => {
      try {
        const r = await run(process.execPath, [
          "--experimental-strip-types",
          "--no-warnings",
          CLI,
          ...args,
          "--control",
          url,
          "--token-file",
          tokenFile,
        ]);
        return { code: 0, ...r };
      } catch (err) {
        return { code: 1, ...(err as { stdout: string; stderr: string }) };
      }
    };
    try {
      const revoked = await cli("kb", "revoke", "attic", "gemv");
      assert.equal(revoked.code, 0, revoked.stderr);
      assert.match(
        JSON.parse(revoked.stdout).said,
        /^attic's agents no longer read gemv's collection/,
      );
      assert.deepEqual(s.store.kb().reads("attic"), []);
      const once = await cli("kb", "revoke", "attic", "gemv");
      assert.notEqual(once.code, 0);
      assert.match(once.stderr, /attic does not read gemv\./);
      const given = await cli("kb", "grant", "attic", "survey");
      assert.equal(given.code, 0, given.stderr);
      assert.deepEqual(JSON.parse(given.stdout).reads, ["survey"]);
      const wrong = await cli("kb", "grant", "attic");
      assert.match(
        wrong.stderr,
        /kb grant takes a campaign and the other campaign whose collection it reads/,
      );
    } finally {
      server.close();
    }
  });
});
