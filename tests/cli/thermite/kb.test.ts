import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { controlOnly } from "../../helpers/control-stack.ts";

/**
 * The owner's search of Thermite's knowledge base, and an item read whole (goal 175): over REST
 * (GET /v1/kb/search and /v1/kb/item) and with `thermite kb`, which prints control's answer.
 */

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");
const TOKENS = { admin: "owner-token-abcdef", rigs: {} };
const RIG = { rig: "rig-a", ledger: "ledger-a" };

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      CLI,
      ...args,
    ]);
    return { code: 0, ...r };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** Control with two collections: the gemv campaign's tried experiments, and sorting's. */
function control() {
  const { store, control: api } = controlOnly({ tokens: TOKENS });
  let n = 0;
  const event = (run: string, kind: string, body: Record<string, unknown>) =>
    store.kb().index(RIG, {
      at: `2026-10-29T10:${String(n++).padStart(2, "0")}:00.000Z`,
      actor: "harness",
      kind,
      subject: run,
      body,
    });
  event("gs-1", "run_created", { campaign: "gemv" });
  event("so-1", "run_created", { campaign: "sorting" });
  event("gs-1", "experiment_added", {
    id: "x-1",
    title: "Vector loads",
    details: "128-bit loads.",
  });
  event("gs-1", "experiment_finished", {
    id: "x-1",
    attempt: "a-1",
    result: "failed to improve speed",
  });
  event("gs-1", "experiment_added", {
    id: "x-2",
    title: "Tile by 32",
    details: "Tiles in shared memory.",
  });
  event("gs-1", "experiment_finished", {
    id: "x-2",
    attempt: "a-2",
    result: "win confirmed (+6.10%)",
  });
  event("so-1", "experiment_added", {
    id: "x-9",
    title: "Radix sort",
    details: "It failed to improve speed.",
  });
  return { store, api };
}

describe("the owner's search of the knowledge base", () => {
  test("REST: ranked hits with their ids, addresses, excerpts and why; one item whole; refusals in words", async () => {
    const { api } = control();
    const get = async (path: string, token = TOKENS.admin) => {
      const r = await api.request(path, { headers: { authorization: `Bearer ${token}` } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const all = await get(
      `/v1/kb/search?q=${encodeURIComponent("which approaches failed to improve speed")}`,
    );
    assert.equal(all.status, 200);
    const hits = all.body.hits as {
      id: number;
      address: string;
      excerpt: string;
      why: string;
      result: string | null;
    }[];
    assert.deepEqual(hits.map((h) => h.address).sort(), [
      "gemv/gs-1/records/experiment:x-1",
      "sorting/so-1/records/experiment:x-9",
    ]);
    assert.ok(
      hits.every((h) => typeof h.id === "number" && /\*\*failed\*\*/.test(h.excerpt) && h.why),
    );
    // One collection, with commas for lists.
    const one = await get("/v1/kb/search?q=speed&collection=gemv&kind=experiment,note");
    assert.deepEqual(
      (one.body.hits as { address: string }[]).map((h) => h.address),
      ["gemv/gs-1/records/experiment:x-1"],
    );
    assert.match(String((one.body.hits as { result: string }[])[0]?.result), /^tried: attempt a-1/);
    const item = await get("/v1/kb/item?address=gemv/gs-1/records/experiment:x-1");
    assert.equal(item.status, 200);
    const it = item.body.item as { text: string; versions: number; title: string };
    assert.equal(it.title, "Vector loads");
    assert.match(it.text, /Result: attempt a-1 \(failed to improve speed\)/);
    assert.equal(it.versions, 2, "the result made its second version");
    assert.equal((await get("/v1/kb/item?address=gemv/gs-1/records/experiment:nope")).status, 404);
    const bad = await get("/v1/kb/search?q=x&kind=nonsense");
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /^bad request: kinds\.0:/);
    assert.equal((await get("/v1/kb/search?q=x", "not-the-owner")).status, 401);
  });

  test("REST: the agents' options: more queries, outcomes, exact mode, pages, and a read from an offset", async () => {
    const { api } = control();
    const get = async (path: string) => {
      const r = await api.request(path, { headers: { authorization: `Bearer ${TOKENS.admin}` } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const addresses = (b: Record<string, unknown>) =>
      (b.hits as { address: string }[]).map((h) => h.address).sort();
    // Two queries, each its own repeated parameter, fused.
    const two = await get("/v1/kb/search?q=vector&query=tile&collection=gemv&kind=experiment");
    assert.deepEqual(addresses(two.body), [
      "gemv/gs-1/records/experiment:x-1",
      "gemv/gs-1/records/experiment:x-2",
    ]);
    assert.deepEqual(two.body.counts && (two.body.counts as { kind: unknown }).kind, {
      experiment: 2,
    });
    const open = await get("/v1/kb/search?q=&collection=gemv&outcome=open,won&limit=1");
    assert.equal(open.body.matched, 2);
    assert.equal(open.body.next_offset, 1);
    const exact = await get(`/v1/kb/search?mode=exact&q=${encodeURIComponent('"tiles in" NOT x')}`);
    assert.deepEqual(addresses(exact.body), ["gemv/gs-1/records/experiment:x-2"]);
    const bad = await get(`/v1/kb/search?mode=exact&q=${encodeURIComponent("tiles AND (")}`);
    assert.equal(bad.status, 400);
    assert.match(String(bad.body.error), /^the exact search is not FTS5's query syntax/);
    const from = await get("/v1/kb/item?address=gemv/gs-1/records/experiment:x-1&offset=4");
    const it = from.body.item as { text: string; offset: number; chars: number; next_offset: null };
    assert.equal(it.offset, 4);
    assert.ok(it.text.startsWith("bit loads."), it.text);
    assert.equal(it.chars, it.text.length + 4);
    assert.equal(it.next_offset, null);
  });

  test("thermite kb search and read print control's answer; a wrong use is refused", async () => {
    const { api } = control();
    const server = serve({ fetch: api.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-kb-"));
    const tokenFile = join(dir, "token");
    writeFileSync(tokenFile, `${TOKENS.admin}\n`);
    try {
      const s = await cli(
        "kb",
        "search",
        "failed",
        "speed",
        "--collection",
        "gemv",
        "--control",
        url,
        "--token-file",
        tokenFile,
      );
      assert.equal(s.code, 0, s.stderr);
      const found = JSON.parse(s.stdout) as { matched: number; hits: { address: string }[] };
      assert.equal(found.matched, 1);
      assert.equal(found.hits[0]?.address, "gemv/gs-1/records/experiment:x-1");
      // More queries, an outcome and a page, as flags.
      const more = await cli(
        "kb",
        "search",
        "vector",
        "--query",
        "radix sort",
        "--outcome",
        "open",
        "--offset",
        "0",
        "--control",
        url,
        "--token-file",
        tokenFile,
      );
      assert.equal(more.code, 0, more.stderr);
      const fused = JSON.parse(more.stdout) as { hits: { address: string }[] };
      assert.deepEqual(fused.hits.map((h) => h.address).sort(), [
        "gemv/gs-1/records/experiment:x-1",
        "sorting/so-1/records/experiment:x-9",
      ]);
      const mixed = await cli(
        "kb",
        "read",
        "gemv/gs-1/records/experiment:x-1",
        "--outcome",
        "won",
        "--control",
        url,
        "--token-file",
        tokenFile,
      );
      assert.notEqual(mixed.code, 0);
      assert.match(mixed.stderr, /kb read takes only an address, --version and --offset/);
      const r = await cli(
        "kb",
        "read",
        "gemv/gs-1/records/experiment:x-1",
        "--version",
        "1",
        "--control",
        url,
        "--token-file",
        tokenFile,
      );
      assert.equal(r.code, 0, r.stderr);
      const read = JSON.parse(r.stdout) as { item: { version: number; versions: number } };
      assert.deepEqual([read.item.version, read.item.versions], [1, 2]);
      const wrong = await cli("kb", "read", "--control", url, "--token-file", tokenFile);
      assert.notEqual(wrong.code, 0);
      assert.match(wrong.stderr, /kb read takes one item's address/);
    } finally {
      server.close();
    }
  });
});
