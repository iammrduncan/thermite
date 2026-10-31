import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { KB_REFUSED_PAGE, kbStored } from "../../../src/control/kb/index.ts";
import { sizeWords } from "../../../src/control/ui/exports.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { KB_RIG } from "../../helpers/kb-places.ts";
import { fillReader } from "../../helpers/kb-reader.ts";

/**
 * What's stored (goal 176, step 5): a page of its own at /ui/kb/stored, linked from the explorer's
 * toolbar, and the same read on REST, MCP and the command line. Its counts and sizes are the
 * store's own (the goal's Done when).
 */

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "read-token-abcdef",
  rigs: { "rig-a": "rig-a-token-abcd", "rig-b": "rig-b-token-abcd" },
};

async function stack() {
  const { store, control } = controlOnly({ tokens: TOKENS, options: { staleAfterMs: 600_000 } });
  await fillReader(store);
  // More refused writes than a page holds; the newest names a <tag>.
  for (let i = 0; i < KB_REFUSED_PAGE + 2; i++)
    store.auditLog.add("control", "kb_item_refused", {
      ...KB_RIG,
      event: 100 + i,
      run: "gs-1",
      writer: "worker-1",
      slot: "worker-1",
      why: `the campaign lets worker-1 write journal, note in run gs-1: not a <paper> ${i}`,
    });
  const s = await signIn(control);
  const rest = async (path: string, token = TOKENS.admin) => {
    const r = await control.request(path, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { store, control, rest, html: async (path: string) => (await s.get(path)).text() };
}

type Stored = {
  totals: Record<string, number>;
  collections: (Record<string, number> & { campaign: string; read_by: string[] })[];
  indexes: { words: { state: string; items: number }; meaning: { state: string } };
  largest_files: { bytes: number; address: string; searched: boolean }[];
  file_types: { type: string; files: number; searched: number }[];
  waiting: { bus: string; last_item: { address: string } | null };
  refused: { total: number; next_offset: number | null; rows: { why: string }[] };
};

describe("What's stored", () => {
  test("its counts and sizes are the store's own, on the page and over REST", async () => {
    const s = await stack();
    const kb = s.store.kb();
    const all = kb.totals({});
    const items = Number(
      (s.store.db.prepare("select count(*) as n from kb_item").get() as { n: number }).n,
    );
    const r = await s.rest("/v1/kb/stored");
    assert.equal(r.status, 200);
    const b = r.body as unknown as Stored;
    assert.equal(b.totals.stored_bytes, all.stored_bytes);
    assert.equal(b.totals.older_versions, all.older_versions);
    assert.equal(b.totals.items, items);
    assert.equal(b.totals.files, all.types.file ?? 0);
    assert.equal(b.totals.records, all.types.record ?? 0);
    assert.equal(b.totals.blurbs, all.types.blurb ?? 0);
    for (const c of b.collections) {
      const own = kb.totals({ campaign: c.campaign });
      assert.equal(c.stored_bytes, own.stored_bytes, c.campaign);
      assert.equal(c.older_versions, own.older_versions, c.campaign);
      assert.equal(c.records, own.types.record ?? 0, c.campaign);
      assert.equal(c.blurbs, own.types.blurb ?? 0, c.campaign);
      assert.equal(c.files, own.types.file ?? 0, c.campaign);
    }
    assert.deepEqual(b.collections.find((c) => c.campaign === "gemv")?.read_by, ["survey"]);
    // The words index holds every item; meaning is not installed.
    const words = Number(
      (
        s.store.db.prepare("select count(distinct item) as n from kb_passage").get() as {
          n: number;
        }
      ).n,
    );
    assert.deepEqual(b.indexes, {
      words: { state: "current", items: words },
      meaning: { state: "not installed" },
    });
    // The largest files first; each type says how many are searched.
    const sizes = b.largest_files.map((f) => f.bytes);
    assert.ok(sizes.length > 0);
    assert.deepEqual(
      sizes,
      [...sizes].sort((x, y) => y - x),
    );
    assert.equal(
      b.file_types.reduce((n, t) => n + t.files, 0),
      all.types.file ?? 0,
    );
    // No bus in this control: nothing can be said to wait, and the last insert stored is named.
    assert.equal(b.waiting.bus, "off");
    assert.match(String(b.waiting.last_item?.address), /^survey\/sv-1\/worker-1\/finding:1$/);
    // The refused writes, newest first, a page at a time.
    assert.equal(b.refused.total, KB_REFUSED_PAGE + 2);
    assert.equal(b.refused.rows.length, KB_REFUSED_PAGE);
    assert.match(String(b.refused.rows[0]?.why), / 51$/);
    assert.equal(b.refused.next_offset, KB_REFUSED_PAGE);
    const next = (await s.rest(`/v1/kb/stored?offset=${KB_REFUSED_PAGE}`))
      .body as unknown as Stored;
    assert.equal(next.refused.rows.length, 2);
    assert.equal(next.refused.next_offset, null);
    assert.equal((await s.rest("/v1/kb/stored?offset=-1")).status, 400);
    // The page: the tiles and each collection's row say the same figures.
    const page = await s.html("/ui/kb/stored");
    assert.match(
      page,
      new RegExp(
        `<div class="k">Stored in all</div><div class="v ">${sizeWords(all.stored_bytes)}</div>`,
      ),
    );
    assert.match(page, new RegExp(`<div class="k">Items</div><div class="v ">${items}</div>`));
    assert.match(
      page,
      new RegExp(`<div class="k">Older versions</div><div class="v ">${all.older_versions}</div>`),
    );
    const gemv = kb.totals({ campaign: "gemv" });
    assert.match(
      page,
      new RegExp(
        `<a href="/ui/knowledge/gemv">gemv</a></td><td class="num">\\d+</td><td class="num">${gemv.types.record ?? 0}</td><td class="num">${gemv.types.blurb ?? 0}</td><td class="num">${gemv.types.file ?? 0}</td><td class="num">[^<]+</td><td class="num">${gemv.older_versions}</td><td class="num">${sizeWords(gemv.stored_bytes)}</td>`,
      ),
    );
    // Collapsible sections, each with its ⓘ; Meaning is not installed, with nothing to rebuild.
    for (const id of ["collections", "indexes", "files", "waiting", "refused"])
      assert.match(
        page,
        new RegExp(
          `<details class="kx-sec" id="${id}" open><summary><span class="kx-sech"><span class="lb">[^<]+<i class="ii"`,
        ),
      );
    assert.match(page, /<td>Meaning<\/td><td><span class="chip">Not installed<\/span><\/td>/);
    assert.doesNotMatch(page, /Rebuild/);
    // Agents' words are escaped; the refused writes page on.
    assert.match(page, /not a &lt;paper&gt; 51/);
    assert.ok(!page.includes("not a <paper>"));
    assert.match(page, /href="\/ui\/kb\/stored\?offset=50#refused">Older ›<\/a>/);
    // The explorer's toolbar links here.
    assert.match(
      await s.html("/ui/knowledge"),
      /<a class="btn sm ghost kx-storedbtn" href="\/ui\/kb\/stored">What&#39;s stored<\/a>|<a class="btn sm ghost kx-storedbtn" href="\/ui\/kb\/stored">What's stored<\/a>/,
    );
  });

  test("what waits on the bus: the events after control's place and the file chunks not taken; away in words", async () => {
    const s = await stack();
    const place = s.store.busPositions.of("EVENTS");
    const view = (bus: Record<string, unknown>) =>
      ({ bus }) as unknown as Parameters<typeof kbStored>[1];
    const on = await kbStored(
      s.store,
      view({
        lastSeq: async () => place + 7,
        streams: async () => [{ name: "KB_FILES", messages: 3 }],
      }),
    );
    assert.equal(on.waiting.bus, "on");
    assert.equal(on.waiting.events, 7);
    assert.equal(on.waiting.file_chunks, 3);
    const away = await kbStored(
      s.store,
      view({
        lastSeq: async () => {
          throw new Error("no server");
        },
        streams: async () => [],
      }),
    );
    assert.deepEqual(
      [away.waiting.bus, away.waiting.events, away.waiting.error],
      ["away", null, "no server"],
    );
    const page = await s.html("/ui/kb/stored");
    assert.match(page, /<span class="chip warn">Bus off<\/span>/);
  });

  test("one read over MCP for the owner and an operator; REST for the owner alone; none for agents", async () => {
    const s = await stack();
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read])
      assert.notEqual((await s.rest("/v1/kb/stored", token)).status, 200);
    const op = await mcpClient(s.control, TOKENS.operator);
    const out = (await op.callTool({ name: "kb_stored", arguments: { offset: 50 } })) as {
      content: { text: string }[];
    };
    const b = JSON.parse(String(out.content[0]?.text)) as Stored;
    assert.equal(b.totals.stored_bytes, s.store.kb().totals({}).stored_bytes);
    assert.equal(b.refused.rows.length, 2);
    const agent = await mcpClient(s.control, TOKENS.agent);
    assert.ok(!(await agent.listTools()).tools.some((t) => t.name === "kb_stored"));
  });
});
