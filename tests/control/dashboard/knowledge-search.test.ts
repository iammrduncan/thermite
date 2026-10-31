import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { answerKbAsk } from "../../../src/control/kb/index.ts";
import { KB_SEARCH_MAX } from "../../../src/core/link/kb.ts";
import { assigned } from "../../helpers/assignments.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { fillReader } from "../../helpers/kb-reader.ts";

/**
 * The Knowledge page's search (goal 176, step 4): in the open folder or everything, as the owner
 * or as a running run's agents (exactly their kb_search), ranked best first with each hit's
 * address, slot, snippet and why; the count, "Did you mean", the Type filter while searching, and
 * "Search as this run" on a run's pane. The owner's REST, MCP and command line take the same `as`.
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
  // The runs control assigned: sv-1 includes its grant of gemv, sv-2 does not.
  assigned(store, "rig-a", "gs-1", "gemv");
  assigned(store, "rig-b", "sv-1", "survey");
  assigned(store, "rig-b", "sv-2", "survey");
  const s = await signIn(control);
  const rest = async (path: string, token = TOKENS.admin) => {
    const r = await control.request(path, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { store, control, rest, html: async (path: string) => (await s.get(path)).text() };
}

/** The addresses of a page's results, in their order. */
const pageAddresses = (html: string) =>
  [...html.matchAll(/<span class="kx-addr">([^<]+)<\/span>/g)].map((m) => m[1]);

/** The addresses of the hits of the run's own kb_search, as control answers its rig. */
function askAddresses(
  store: Parameters<typeof answerKbAsk>[0],
  rig: string,
  ask: Record<string, unknown>,
): string[] {
  const a = answerKbAsk(store, rig, "search", { limit: KB_SEARCH_MAX, ...ask });
  assert.ok("hits" in a, JSON.stringify(a));
  return a.hits.map((h) => h.address);
}

describe("the Knowledge page's search", () => {
  test("as a run: exactly the run's kb_search, on the page, over REST and over MCP", async () => {
    const s = await stack();
    const ask = askAddresses(s.store, "rig-b", { run: "sv-1", q: "bandwidth" });
    // The run reads its grant of gemv: the run's search finds gemv's items and its own.
    assert.ok(ask.some((a) => a.startsWith("gemv/")));
    assert.ok(ask.some((a) => a.startsWith("survey/sv-1/")));
    const page = await s.html("/ui/knowledge/gemv?q=bandwidth&as=sv-1&scope=everything");
    assert.deepEqual(pageAddresses(page), ask, "the same items, in the same order");
    assert.match(
      page,
      new RegExp(
        `<span class="kx-count" role="status">${ask.length} results in everything as sv-1</span>`,
      ),
    );
    // sv-2 leaves the grant out: as sv-2, gemv's items are not found.
    const two = askAddresses(s.store, "rig-b", { run: "sv-2", q: "bandwidth" });
    const page2 = pageAddresses(await s.html("/ui/knowledge?q=bandwidth&as=sv-2&scope=everything"));
    assert.deepEqual(page2, two);
    assert.ok(!page2.some((a) => a?.startsWith("gemv/")));
    // REST and MCP: the same answer, with the run's scope; owner and operator tokens only.
    const r = await s.rest(`/v1/kb/search?q=bandwidth&as=sv-1&limit=${KB_SEARCH_MAX}`);
    assert.equal(r.status, 200);
    assert.deepEqual(
      (r.body.hits as { address: string }[]).map((h) => h.address),
      ask,
    );
    assert.deepEqual(r.body.scope, { collection: "survey", fresh: false, granted: ["gemv"] });
    assert.equal(r.body.as, "sv-1");
    assert.equal(r.body.rig, "rig-b");
    // REST's knowledge base routes take the owner's token alone, as before; MCP takes the
    // operator's too; an agent's or a reader's token neither.
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read])
      assert.notEqual((await s.rest("/v1/kb/search?q=x&as=sv-1", token)).status, 200);
    const unknown = await s.rest("/v1/kb/search?q=x&as=nobody-1");
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.body.error), /control assigned no run nobody-1/);
    const mcp = await mcpClient(s.control, TOKENS.operator);
    const out = (await mcp.callTool({
      name: "kb_search",
      arguments: { q: "bandwidth", as: "sv-1", limit: KB_SEARCH_MAX },
    })) as { content: { text: string }[] };
    const body = JSON.parse(String(out.content[0]?.text)) as { hits: { address: string }[] };
    assert.deepEqual(
      body.hits.map((h) => h.address),
      ask,
    );
  });

  test("the menus: In and As with an ⓘ each, both in the page's address; this folder by default", async () => {
    const s = await stack();
    const page = await s.html("/ui/knowledge/gemv?q=bandwidth");
    const bar = page.slice(
      page.indexOf('<form class="kx-search"'),
      page.indexOf("</form>", page.indexOf('<form class="kx-search"')),
    );
    assert.match(
      bar,
      /<label class="kx-scope"><span class="lb">In<i class="ii" tabindex="0" data-tip="/,
    );
    assert.match(
      bar,
      /<option value="folder" selected>This folder<\/option><option value="everything">Everything<\/option>/,
    );
    assert.match(
      bar,
      /<label class="kx-as"><span class="lb">As<i class="ii" tabindex="0" data-tip="/,
    );
    assert.match(bar, /<option value="" selected>you<\/option>/);
    // Each running run, with its collection.
    assert.match(bar, /<option value="gs-1">gs-1 \(gemv\)<\/option>/);
    assert.match(bar, /<option value="sv-1">sv-1 \(survey\)<\/option>/);
    // This folder: only gemv's items, counted in its words.
    const here = pageAddresses(page);
    assert.ok(here.length && here.every((a) => a?.startsWith("gemv/")));
    assert.match(page, /results? in gemv<\/span>/);
    // Everything: survey's items too; the address keeps it.
    const all = await s.html("/ui/knowledge/gemv?q=bandwidth&scope=everything");
    assert.ok(pageAddresses(all).some((a) => a?.startsWith("survey/")));
    assert.match(all, /results? in everything<\/span>/);
    assert.match(all, /<option value="everything" selected>Everything<\/option>/);
    assert.match(all, /href="\/ui\/knowledge\/gemv\?q=bandwidth&amp;scope=everything&amp;item=/);
  });

  test("the results: best first with address, slot, a marked snippet and why; Did you mean; the Type filter; Best match", async () => {
    const s = await stack();
    const page = await s.html("/ui/knowledge?q=bandwidth");
    assert.match(page, /<span class="kx-snip">[^<]*<mark>bandwidth<\/mark>/i);
    assert.match(page, /<span class="kx-why">[^<]*bandwidth[^<]*<\/span>/i);
    assert.match(page, /<td class="c-writer">worker-1<\/td>/);
    // The columns don't sort a search: it is listed best match first.
    assert.match(page, /<span class="kx-best"><span class="lb">Best match<i class="ii"/);
    assert.doesNotMatch(page, /<th class="c-name" aria-sort=/);
    // The Type filter is offered while searching, and keeps only that type.
    assert.match(page, /<details class="kx-dd" data-dd="type">/);
    const files = pageAddresses(await s.html("/ui/knowledge?q=loads&type=file"));
    assert.ok(files.length);
    assert.ok(
      files.every((a) => /\/reference:\d+$/.test(String(a))),
      files.join(),
    );
    const blurbs = await s.rest("/v1/kb/search?q=loads&type=file");
    assert.deepEqual(
      (blurbs.body.hits as { address: string }[]).map((h) => h.address).sort(),
      [...files].sort(),
    );
    // A word no item holds: one line above the table, which searches the word suggested.
    const typo = await s.html("/ui/knowledge?q=bandwidht");
    assert.match(
      typo,
      /<div class="kx-dym">Did you mean <a href="\/ui\/knowledge\?q=bandwidth">bandwidth<\/a>\?<\/div>/,
    );
    assert.doesNotMatch(page, /class="kx-dym"/);
  });

  test("Search as this run, on a run's pane: As that run, in everything", async () => {
    const s = await stack();
    const pane = await s.html("/ui/knowledge/survey/sv-1");
    assert.match(
      pane,
      /<a class="btn sm" href="\/ui\/knowledge\/survey\/sv-1\?scope=everything&amp;as=sv-1">[\s\S]*?<span>Search as this run<\/span><\/a>/,
    );
    // With no words, the run's search lists the newest items it reads, as its kb_search does.
    const page = await s.html("/ui/knowledge/survey/sv-1?scope=everything&as=sv-1");
    assert.deepEqual(pageAddresses(page), askAddresses(s.store, "rig-b", { run: "sv-1", q: "" }));
    assert.match(page, /<option value="sv-1" selected>sv-1 \(survey\)<\/option>/);
  });
});
