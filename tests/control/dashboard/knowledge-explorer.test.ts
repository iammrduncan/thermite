import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";
import { fillKnowledge, KB_RIG } from "../../helpers/kb-places.ts";

/**
 * The Knowledge page (goal 176): an explorer of the knowledge base at its addresses, with the tree,
 * the table, its filters, its pages and the toolbar's search; an item's own page; what the page
 * shows is kb_list's, as REST and MCP give it; and the left navigation, which collapses on every
 * page and stays so in the browser.
 */

const OPERATOR = "operator-token-abcdef";
const AGENT = "agent-token-abcdef";
const READER = "read-token-abcdef";

/** Control with the places of kb-places.ts; rig-a reports gs-1 at work. Signed in. */
async function stack(o: { notes?: number } = {}) {
  const { store, control, api } = controlOnly({
    tokens: { operator: OPERATOR, agent: AGENT, read: READER },
    options: { staleAfterMs: 600_000 },
  });
  fillKnowledge(store);
  for (let i = 0; i < (o.notes ?? 0); i++)
    store.kb().index(KB_RIG, {
      at: new Date(Date.parse("2026-10-30T12:00:00Z") + i * 1000).toISOString(),
      actor: "harness",
      kind: "journal_note",
      subject: "gs-1",
      body: { id: 100 + i, by: "lane-1", kind: "observation", text: `Observation ${i}` },
    });
  await ingestReport(store, {
    rig: "rig-a",
    ledger_id: KB_RIG.ledger,
    cursor: 0,
    next: 1,
    generated_at: new Date().toISOString(),
    events: [
      {
        id: 1,
        at: "2026-10-30T10:00:00.000Z",
        actor: "harness",
        kind: "run_created",
        subject: "gs-1",
        body: { campaign: "gemv", mode: "goal" },
      },
    ],
    summary: {},
  });
  const s = await signIn(control);
  const page = async (path: string) => {
    const r = await s.get(path);
    return { status: r.status, html: await r.text() };
  };
  return { store, control, api, page, cookie: s.cookie };
}

/** The page's main part, the open folder's contents, or an item. */
const main = (html: string) =>
  html.slice(html.indexOf('<section class="kx-main"'), html.indexOf("</section>"));
const tree = (html: string) =>
  html.slice(html.indexOf('<nav class="kx-tree"'), html.indexOf('<section class="kx-main"'));
/** The rows' addresses: a folder's page, or the item a row opens in the pane, as its page's. */
const rows = (html: string) =>
  [...main(html).matchAll(/<tr data-(item-)?href="([^"]+)"/g)].map((m) => {
    const href = (m[2] ?? "").replace(/&amp;/g, "&");
    const item = new URL(href, "http://control").searchParams.get("item");
    return item ? `/ui/knowledge/${item}` : decodeURIComponent(href);
  });
const count = (html: string) =>
  /<span class="kx-count" role="status">([^<]*)<\/span>/.exec(html)?.[1];

describe("the knowledge explorer", () => {
  test("each address opens on a fresh load: the root, a collection, a run, a slot and an item", async () => {
    const s = await stack();
    const root = await s.page("/ui/knowledge");
    assert.equal(root.status, 200);
    assert.match(root.html, /<a href="\/ui\/knowledge" class="on">/, "the sidebar's Knowledge");
    assert.match(root.html, /<span class="summary">3 collections · 10 items<\/span>/);
    assert.match(
      root.html,
      /<div class="content flush" id="content"><div class="kx" data-folders="closed">/,
    );
    assert.match(
      root.html,
      /<nav class="kx-crumbs" aria-label="Folder path"><a href="\/ui\/knowledge" aria-current="page">Knowledge<\/a><\/nav>/,
    );
    assert.deepEqual(rows(root.html), [
      "/ui/knowledge/attic",
      "/ui/knowledge/gemv",
      "/ui/knowledge/empty",
    ]);
    assert.equal(count(root.html), "3 collections · 10 items");
    const gemv = await s.page("/ui/knowledge/gemv");
    assert.match(
      gemv.html,
      /<a href="\/ui\/knowledge">Knowledge<\/a><span class="kx-sep" aria-hidden="true">›<\/span><a href="\/ui\/knowledge\/gemv" aria-current="page">gemv<\/a>/,
    );
    assert.deepEqual(rows(gemv.html), ["/ui/knowledge/gemv/gs-2", "/ui/knowledge/gemv/gs-1"]);
    assert.equal(count(gemv.html), "2 runs · 9 items");
    assert.match(main(gemv.html), /<td class="c-kind">Run<\/td>/);
    const run = await s.page("/ui/knowledge/gemv/gs-1?sort=name");
    assert.deepEqual(rows(run.html), [
      "/ui/knowledge/gemv/gs-1/planner",
      "/ui/knowledge/gemv/gs-1/records",
      "/ui/knowledge/gemv/gs-1/worker-1",
    ]);
    assert.equal(count(run.html), "3 slots · 8 items");
    // A slot lists its items: each title links to its page, its address under it.
    const slot = await s.page("/ui/knowledge/gemv/gs-1/worker-1");
    assert.deepEqual(rows(slot.html), [
      "/ui/knowledge/gemv/gs-1/worker-1/reference:2",
      "/ui/knowledge/gemv/gs-1/worker-1/finding:1",
    ]);
    assert.match(
      main(slot.html),
      /<a href="\/ui\/knowledge\/gemv\/gs-1\/worker-1\?item=gemv%2Fgs-1%2Fworker-1%2Freference%3A2" data-item>A paper on wide loads<\/a><\/span><span class="kx-addr">gemv\/gs-1\/worker-1\/reference:2<\/span>/,
    );
    assert.match(main(slot.html), /<td class="c-size num">50\.8 KiB<\/td>/);
    assert.match(main(slot.html), /<td class="c-writer">worker-1<\/td>/);
    assert.equal(count(slot.html), "2 items");
    // An item's own page: its facts and its text, the tree still open down to its slot.
    const item = await s.page("/ui/knowledge/gemv/gs-1/planner/decision:1");
    assert.equal(item.status, 200);
    assert.match(item.html, /<h2>Tile next<\/h2>/);
    assert.match(
      item.html,
      /<span class="chip">decision<\/span><span class="mono">planner<\/span><span aria-hidden="true">·<\/span><span>planner<\/span>/,
    );
    assert.match(
      item.html,
      /<code>gemv\/gs-1\/planner\/decision:1<\/code><button type="button" class="ghost sm" data-copy="gemv\/gs-1\/planner\/decision:1" aria-label="Copy the address">/,
    );
    assert.match(item.html, /<summary class="kx-ddb">Version 1 of 1<svg/);
    assert.match(item.html, /<div class="kx-text">Tiling comes after the loads\.<\/div>/);
    assert.match(
      item.html,
      /<a class="kx-link" href="\/ui\/knowledge\/gemv\/gs-1\/worker-1\/finding:1"><span class="chip ">follows<\/span>[\s\S]*?<span class="kx-addr">gemv\/gs-1\/worker-1\/finding:1<\/span>/,
    );
    assert.match(
      item.html,
      /<a href="\/ui\/knowledge\/gemv\/gs-1\/planner\/decision:1" aria-current="page">Tile next<\/a>/,
    );
    assert.match(
      tree(item.html),
      /<div class="kx-row on">[\s\S]*?aria-current="page"><svg[\s\S]*?<span class="nm">planner<\/span>/,
    );
    // A records item says Thermite's code wrote it, and gives its result.
    const exp = await s.page("/ui/knowledge/gemv/gs-1/records/experiment:x-1");
    assert.match(
      exp.html,
      /<span class="mono">records<\/span><span aria-hidden="true">·<\/span><span>Thermite's code<\/span>/,
    );
    assert.match(exp.html, /<span class="chip ok">won<\/span>/);
    assert.match(
      exp.html,
      /<span class="muted">Result:<\/span> tried: attempt a-1 \(submitted\), win confirmed/,
    );
    // An address the knowledge base has not: said, with the tree.
    for (const [path, words] of [
      ["/ui/knowledge/nope", "the knowledge base has no collection nope"],
      ["/ui/knowledge/gemv/gs-9", "gemv has no run gs-9"],
      [
        "/ui/knowledge/gemv/gs-1/worker-1/finding:9",
        "the knowledge base has no item gemv/gs-1/worker-1/finding:9",
      ],
      ["/ui/knowledge/gemv/gs-1/nobody", "This is not an address in the knowledge base."],
    ]) {
      const r = await s.page(path ?? "");
      assert.equal(r.status, 404, path);
      assert.match(r.html, new RegExp(`<b>Not found\\.</b> ${words}`), path);
      assert.match(r.html, /<nav class="kx-tree"/);
    }
  });

  test("an item whose id holds slashes, such as a lane's document, has its page at its address", async () => {
    const s = await stack();
    s.store.kb().index(KB_RIG, {
      at: "2026-10-30T13:00:00.000Z",
      actor: "harness",
      kind: "research_doc",
      subject: "gs-1",
      body: { lane: "lane-1", path: "drafts/outline.md", text: "An outline of the loads." },
    });
    const records = await s.page("/ui/knowledge/gemv/gs-1/records?kind=doc");
    assert.deepEqual(rows(records.html), [
      "/ui/knowledge/gemv/gs-1/records/doc:lane-1/drafts/outline.md",
    ]);
    // Its preview's Open full page: its page's address keeps the slashes in one part.
    const preview = await s.page(
      `/ui/knowledge/gemv/gs-1/records?item=${encodeURIComponent("gemv/gs-1/records/doc:lane-1/drafts/outline.md")}`,
    );
    assert.match(
      preview.html,
      /<a class="kx-full" href="\/ui\/knowledge\/gemv\/gs-1\/records\/doc:lane-1%2Fdrafts%2Foutline\.md">/,
    );
    const doc = await s.page("/ui/knowledge/gemv/gs-1/records/doc:lane-1%2Fdrafts%2Foutline.md");
    assert.equal(doc.status, 200);
    assert.match(doc.html, /<h2>drafts\/outline\.md<\/h2>/);
    assert.match(doc.html, /<code>gemv\/gs-1\/records\/doc:lane-1\/drafts\/outline\.md<\/code>/);
  });

  test("the tree: collections, archived ones greyed and tagged; runs running or fresh; slots; each with its count; a folder opens in place", async () => {
    const s = await stack();
    const t = tree((await s.page("/ui/knowledge/gemv/gs-1")).html);
    assert.match(t, /<div class="kx-treehead">Collections<\/div>/);
    assert.match(
      t,
      /aria-expanded="false" aria-label="Expand attic">[\s\S]*?<a class="kx-node dim" href="\/ui\/knowledge\/attic">[\s\S]*?<span class="nm">attic<\/span><span class="kx-tag">archived<\/span><span class="n">1<\/span>/,
    );
    assert.match(
      t,
      /aria-expanded="true" aria-label="Collapse gemv">[\s\S]*?<span class="nm">gemv<\/span><span class="n">9<\/span>/,
    );
    assert.match(
      t,
      /<div class="kx-row on"><button type="button" class="kx-chev" data-tree="gemv\/gs-1" aria-expanded="true" aria-label="Collapse gs-1">[\s\S]*?<a class="kx-node" href="\/ui\/knowledge\/gemv\/gs-1" aria-current="page">[\s\S]*?<span class="nm">gs-1<\/span><span class="dot ok" role="img" aria-label="running"><\/span><span class="n">8<\/span>/,
    );
    assert.match(
      t,
      /<span class="nm">gs-2<\/span><span class="kx-tag">fresh<\/span><span class="n">1<\/span>/,
    );
    // A slot holds no folders: no chevron.
    assert.match(
      t,
      /<span class="kx-chev" aria-hidden="true"><\/span><a class="kx-node" href="\/ui\/knowledge\/gemv\/gs-1\/records">/,
    );
    assert.ok(!t.includes("at-1"), "a closed folder's folders come only when it opens");
    // Opened in place: control draws its folders.
    const opened = await s.control.request("/ui/kb/tree?at=attic", {
      headers: { cookie: s.cookie },
    });
    assert.equal(opened.status, 200);
    const fragment = await opened.text();
    assert.match(
      fragment,
      /^<ul class="kx-ul" style="--d:1"><li><div class="kx-row"><button type="button" class="kx-chev" data-tree="attic\/at-1" aria-expanded="false"/,
    );
    assert.match(
      await (
        await s.control.request("/ui/kb/tree?at=empty", { headers: { cookie: s.cookie } })
      ).text(),
      /<li class="kx-empty">Empty<\/li>/,
    );
    assert.equal(
      (
        await s.control.request("/ui/kb/tree?at=gemv/gs-1/records", {
          headers: { cookie: s.cookie },
        })
      ).status,
      404,
    );
    assert.equal((await s.control.request("/ui/kb/tree?at=gemv")).status, 303, "signed in only");
  });

  test("the table: sortable columns with ▲ and ▼, an outcome's chip, and pages of 50 with no end", async () => {
    const s = await stack({ notes: 57 });
    const records = await s.page("/ui/knowledge/gemv/gs-1/records");
    // Newest change first, said on Modified.
    assert.match(
      main(records.html),
      /<th class="c-mod" aria-sort="descending"><a href="\/ui\/knowledge\/gemv\/gs-1\/records\?sort=modified&amp;order=asc">Modified<span class="kx-arrow" aria-hidden="true">▼<\/span>/,
    );
    assert.match(
      main(records.html),
      /<th class="c-name" aria-sort="none"><a href="\/ui\/knowledge\/gemv\/gs-1\/records\?sort=name&amp;order=asc">Name<\/a>/,
    );
    assert.equal(rows(records.html).length, 50);
    assert.match(
      main(records.html),
      /<span class="muted">1–50 of 62 · 50 a page<\/span><a href="\/ui\/knowledge\/gemv\/gs-1\/records\?offset=50">Next ›<\/a>/,
    );
    const next = await s.page("/ui/knowledge/gemv/gs-1/records?offset=50");
    assert.equal(rows(next.html).length, 12);
    assert.match(
      main(next.html),
      /51–62 of 62 · 50 a page<\/span><a href="\/ui\/knowledge\/gemv\/gs-1\/records">‹ Previous<\/a><\/div>/,
    );
    const byName = await s.page("/ui/knowledge/gemv/gs-1/records?sort=name&order=asc");
    assert.match(
      main(byName.html),
      /<th class="c-name" aria-sort="ascending"><a href="[^"]*sort=name&amp;order=desc">Name<span class="kx-arrow" aria-hidden="true">▲<\/span>/,
    );
    // "Kept the old path…", the field note, first; "vector loads…", the attempt, last.
    assert.equal(rows(byName.html)[0], "/ui/knowledge/gemv/gs-1/records/note:1");
    const desc = await s.page("/ui/knowledge/gemv/gs-1/records?sort=name&order=desc");
    assert.equal(rows(desc.html)[0], "/ui/knowledge/gemv/gs-1/records/attempt:a-1");
    const won = await s.page("/ui/knowledge/gemv/gs-1/records?sort=outcome");
    assert.match(main(won.html), /<td class="c-out"><span class="chip ok">won<\/span><\/td>/);
    assert.match(main(won.html), /<span class="chip kx-dim">dropped<\/span>/);
  });

  test("the filters: dropdowns of checkboxes with counts, chips each removing one pick, Clear and the count, all in the address", async () => {
    const s = await stack();
    const won = await s.page("/ui/knowledge/gemv?outcome=won");
    // A filter lists every item under the folder, not its folders.
    assert.deepEqual(rows(won.html).sort(), [
      "/ui/knowledge/gemv/gs-1/records/attempt:a-1",
      "/ui/knowledge/gemv/gs-1/records/experiment:x-1",
    ]);
    assert.equal(count(won.html), "2 of 9 items");
    assert.match(
      main(won.html),
      /<summary class="kx-ddb on">Outcome<span class="kx-badge">1<\/span>/,
    );
    assert.match(
      main(won.html),
      /<input type="checkbox" name="outcome" value="won" checked><span class="chip ok">won<\/span><span class="n">2<\/span>/,
    );
    // An outcome's count leaves its own pick out; a kind's keeps it.
    assert.match(
      main(won.html),
      /value="dropped"><span class="chip kx-dim">dropped<\/span><span class="n">1<\/span>/,
    );
    assert.match(
      main(won.html),
      /value="experiment"><span class="lbl">experiment<\/span><span class="n">1<\/span>/,
    );
    assert.ok(!main(won.html).includes('value="note"'), "no kind the outcome leaves out");
    assert.match(
      main(won.html),
      /<a class="kx-chip" href="\/ui\/knowledge\/gemv" aria-label="Remove the filter Outcome: won"><span>Outcome: won<\/span>/,
    );
    assert.match(main(won.html), /<a class="kx-clearall" href="\/ui\/knowledge\/gemv">Clear<\/a>/);
    for (const f of ["Kind", "Outcome", "Type", "Writer"])
      assert.match(
        main(won.html),
        new RegExp(`<span class="lb">${f}<i class="ii" tabindex="0" data-tip="`),
      );
    // Two picks in one filter: either; given with commas or one by one, as the form sends them.
    const two = await s.page("/ui/knowledge/gemv?type=file&type=blurb");
    assert.equal(count(two.html), "3 of 9 items");
    assert.equal(count((await s.page("/ui/knowledge/gemv?type=file,blurb")).html), "3 of 9 items");
    assert.match(main(two.html), /<a class="kx-chip" href="\/ui\/knowledge\/gemv\?type=blurb"/);
    // And with a writer: both.
    assert.equal(
      count((await s.page("/ui/knowledge/gemv?type=file,blurb&slot=planner")).html),
      "1 of 9 items",
    );
    // The form keeps the sort and sends the picks; a value the page does not know is left out.
    assert.match(
      main(won.html),
      /<form class="kx-filters" method="get" action="\/ui\/knowledge\/gemv">/,
    );
    assert.equal(
      count((await s.page("/ui/knowledge/gemv?kind=nonsense")).html),
      "2 runs · 9 items",
    );
    const none = await s.page("/ui/knowledge/gemv/gs-2?kind=finding");
    assert.match(main(none.html), /No items match the filters\./);
  });

  test("the search: one line in the toolbar, of the open folder, with the filters it takes", async () => {
    const s = await stack();
    const found = await s.page("/ui/knowledge/gemv?q=vector&kind=experiment");
    assert.match(
      found.html,
      /<form class="kx-search" role="search" method="get" action="\/ui\/knowledge\/gemv"><span class="kx-field">[\s\S]*?<input type="search" name="q" value="vector" placeholder="Search" aria-label="Search"[^>]*><a class="kx-qx" href="\/ui\/knowledge\/gemv\?kind=experiment" aria-label="Clear the search">[\s\S]*?<\/span><label class="kx-as">[\s\S]*?<\/label><input type="hidden" name="kind" value="experiment">/,
    );
    assert.equal(count(found.html), "2 results in gemv");
    // Both experiments say vector, in the order the search ranks them.
    assert.deepEqual(rows(found.html).sort(), [
      "/ui/knowledge/gemv/gs-1/records/experiment:x-1",
      "/ui/knowledge/gemv/gs-1/records/experiment:x-2",
    ]);
    // Where the words land in a text: marked in its excerpt.
    assert.match(
      main((await s.page("/ui/knowledge/gemv?q=packed")).html),
      /<span class="kx-snip">128-bit loads of the <mark>packed<\/mark> weights/,
    );
    // Best first: the headers sort nothing; the Type filter works while searching too.
    assert.match(main(found.html), /<th class="c-name">Name<\/th>/);
    assert.ok(main(found.html).includes('data-dd="type"'));
    assert.equal(count((await s.page("/ui/knowledge/attic?q=vector")).html), "0 results in attic");
    assert.equal(
      count((await s.page("/ui/knowledge?q=vector")).html),
      "4 results in the knowledge base",
    );
  });

  test("agents' items are data: escaped, never markup, with no link but to an item's own page", async () => {
    const s = await stack();
    for (const path of [
      "/ui/knowledge/gemv/gs-1/worker-1",
      "/ui/knowledge/gemv/gs-1/worker-1/finding:1",
      "/ui/knowledge/gemv?q=bandwidth",
    ]) {
      const { html } = await s.page(path);
      assert.ok(!html.includes("<script>alert(1)</script>"), path);
      assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Vector loads/, path);
      for (const m of main(html).matchAll(/href="([^"]*)"/g))
        assert.match(m[1] ?? "", /^\/ui\/knowledge(\/|\?|$)/, `${path}: ${m[1]}`);
    }
    const item = (await s.page("/ui/knowledge/gemv/gs-1/worker-1/finding:1")).html;
    assert.match(item, /See \[the doc\]\(\/ui\/settings\)\.<\/div>/);
  });

  test("nothing on the page alone: its folders, rows and counts are kb_list's, the same over REST and MCP", async () => {
    const s = await stack();
    const rest = await s.api("GET", "/v1/kb/list?at=gemv&outcome=won&sort=name");
    assert.equal(rest.status, 200);
    const answer = (await rest.json()) as {
      at: { path: string; items: number };
      folders: { path: string; running: boolean; fresh: boolean }[];
      matched: number;
      total: number;
      counts: { outcome: Record<string, number> };
      items: { address: string }[];
    };
    assert.deepEqual([answer.at.path, answer.total, answer.matched], ["gemv", 9, 2]);
    assert.deepEqual(answer.counts.outcome, { won: 2, dropped: 1 });
    assert.deepEqual(
      answer.folders.map((f) => [f.path, f.running, f.fresh]),
      [
        ["gemv/gs-1", true, false],
        ["gemv/gs-2", false, true],
      ],
    );
    const page = await s.page("/ui/knowledge/gemv?outcome=won&sort=name");
    assert.equal(count(page.html), `${answer.matched} of ${answer.total} items`);
    assert.deepEqual(
      rows(page.html),
      answer.items.map((x) => `/ui/knowledge/${x.address}`),
    );
    const mcp = await mcpClient(s.control);
    const r = (await mcp.callTool({
      name: "kb_list",
      arguments: { at: "gemv", outcomes: ["won"], sort: "name" },
    })) as { content: { text: string }[] };
    assert.deepEqual(JSON.parse(r.content[0]?.text ?? "{}"), answer);
    // The owner's and an operator's, as every collection is; an agent's or a reader's token has none.
    const names = async (token: string) =>
      (await (await mcpClient(s.control, token)).listTools()).tools.map((t) => t.name);
    assert.ok((await names(OPERATOR)).includes("kb_list"));
    for (const token of [AGENT, READER]) assert.ok(!(await names(token)).includes("kb_list"));
    const refused = await s.api("GET", "/v1/kb/list?at=nope");
    assert.equal(refused.status, 404);
    assert.deepEqual(await refused.json(), { error: "the knowledge base has no collection nope" });
    const bad = await s.api("GET", "/v1/kb/list?type=page");
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /^bad request: types\.0:/);
  });

  test("the page's script is served from control, and parses", async () => {
    const s = await stack();
    const r = await s.control.request("/ui/assets/knowledge.js", { headers: { cookie: s.cookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /^text\/javascript/);
    const js = await r.text();
    assert.match(js, /\/ui\/kb\/tree\?at=/);
    assert.doesNotThrow(() => new Function(js));
    assert.match(
      (await s.page("/ui/knowledge")).html,
      /<script src="\/ui\/assets\/knowledge\.js" defer><\/script>/,
    );
  });
});

describe("the left navigation", () => {
  test("collapses to its icons on every page, and this browser's cookie draws it so before the script runs", async () => {
    const s = await stack();
    const open = (await s.page("/ui")).html;
    assert.match(open, /<div class="app">/);
    assert.match(
      open,
      /<button type="button" class="ib side-tog" id="side-tog" aria-controls="sidebar" aria-expanded="true" aria-label="Collapse the navigation" title="Collapse the navigation">/,
    );
    assert.match(open, /<a href="\/ui\/knowledge" class="">/, "no title while each name shows");
    for (const path of ["/ui", "/ui/knowledge/gemv", "/ui/campaigns", "/ui/settings"]) {
      const r = await s.control.request(path, {
        headers: { cookie: `${s.cookie}; thermite_nav=rail` },
      });
      const html = await r.text();
      assert.match(html, /<div class="app rail">/, path);
      assert.match(html, /aria-expanded="false" aria-label="Expand the navigation"/, path);
      assert.match(html, /<a href="\/ui\/knowledge" class="[^"]*" title="Knowledge">/, path);
    }
    const other = await s.control.request("/ui", {
      headers: { cookie: `${s.cookie}; thermite_nav=open` },
    });
    assert.match(await other.text(), /<div class="app">/);
    const js = await (
      await s.control.request("/ui/assets/app.js", { headers: { cookie: s.cookie } })
    ).text();
    assert.match(js, /document\.cookie = "thermite_nav" \+ "=" \+ \(rail \? "rail" : "open"\)/);
    assert.doesNotThrow(() => new Function(js));
  });
});
