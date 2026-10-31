import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { KB_RIG } from "../../helpers/kb-places.ts";
import { FINDING, fillReader } from "../../helpers/kb-reader.ts";

/**
 * A folder's info pane on the Knowledge page (goal 176): what the open collection, run or slot
 * holds, from its summary in kb_list; a slot folder's writer in the table; Info at phone width.
 */

async function stack() {
  const { store, control } = controlOnly({
    tokens: { rigs: { "rig-a": "rig-a-token-abcd", "rig-b": "rig-b-token-abcd" } },
    options: { staleAfterMs: 600_000 },
  });
  await fillReader(store);
  store.auditLog.add("control", "kb_item_refused", {
    ...KB_RIG,
    event: 77,
    run: "gs-1",
    writer: "worker-1",
    slot: "worker-1",
    why: "the campaign lets worker-1 write journal, note in run gs-1: not a <paper>",
  });
  const s = await signIn(control);
  return {
    html: async (path: string) => (await s.get(path)).text(),
    pane: async (path: string) => {
      const html = await (await s.get(path)).text();
      const at = html.indexOf('<aside class="kx-prev');
      return at < 0 ? "" : html.slice(at, html.indexOf("</aside>", at));
    },
  };
}

describe("a folder's info pane", () => {
  test("a collection: its campaign, mode, runs, what it holds, its slots and its grants", async () => {
    const s = await stack();
    const p = await s.pane("/ui/knowledge/gemv");
    assert.match(p, /<aside class="kx-prev kx-info" id="kx-prev" aria-label="About this folder"/);
    assert.match(p, /<span class="kx-pid">Collection · gemv<\/span>/);
    assert.match(
      p,
      /<dt>Campaign<\/dt><dd><a href="\/ui\/campaigns\/gemv">gemv<\/a><\/dd><dt>Mode<\/dt><dd>goal<\/dd><dt>Runs<\/dt><dd>2<\/dd>/,
    );
    assert.match(
      p,
      /<dt>Records<\/dt><dd>7<\/dd><dt>Blurbs<\/dt><dd>2<\/dd><dt>Files<\/dt><dd>3<\/dd>/,
    );
    assert.match(
      p,
      /<dt>Slots<\/dt><dd><span class="kx-chips"><span class="chip">records <span class="muted">7<\/span><\/span>/,
    );
    assert.match(p, /Read by<i[\s\S]*?<span>survey<\/span>/);
    const attic = await s.pane("/ui/knowledge/attic");
    assert.match(attic, /<dt>Archived<\/dt><dd><span class="kx-tag">archived<\/span><\/dd>/);
    const root = await s.pane("/ui/knowledge");
    assert.match(root, /<span class="kx-pid">Knowledge base<\/span>/);
  });

  test("a run: its state, and what its agents search", async () => {
    const s = await stack();
    const gs1 = await s.pane("/ui/knowledge/gemv/gs-1");
    assert.match(
      gs1,
      /<dt>State<\/dt><dd><span class="dot ok"><\/span> running<\/dd><dt>Started fresh<\/dt><dd>no<\/dd><dt>Its agents search<\/dt><dd>its whole collection<\/dd><dt>Rig<\/dt><dd>rig-a<\/dd>/,
    );
    assert.match(
      gs1,
      /<button type="button" class="sm" disabled>[\s\S]*?<span>Search as this run<\/span><\/button><span class="lb"><i class="ii" tabindex="0" data-tip="/,
    );
    assert.match(
      await s.pane("/ui/knowledge/gemv/gs-2"),
      /<dt>Started fresh<\/dt><dd>yes<\/dd><dt>Its agents search<\/dt><dd>only its own run<\/dd>/,
    );
    assert.match(
      await s.pane("/ui/knowledge/survey/sv-1"),
      /<dt>Its agents search<\/dt><dd>its whole collection, and <a href="\/ui\/knowledge\/gemv">gemv<\/a>, read only<\/dd>/,
    );
    // The table names each slot's writer.
    const html = await s.html("/ui/knowledge/gemv/gs-1?sort=name");
    assert.match(
      html,
      /<span>worker-1<\/a><\/span><\/span><\/span><\/td><td class="c-kind">Slot<\/td><td class="c-out"><\/td><td class="c-writer">worker · Claude Code<\/td>|>worker-1<\/a><\/span><\/span><\/span><\/td><td class="c-kind">Slot<\/td><td class="c-out"><\/td><td class="c-writer">worker · Claude Code<\/td>/,
    );
    assert.match(html, /<td class="c-writer">Thermite's code<\/td>/);
  });

  test("a slot: its writer, the kinds it may write, what it holds, and the writes control refused it", async () => {
    const s = await stack();
    const p = await s.pane("/ui/knowledge/gemv/gs-1/worker-1");
    assert.match(p, /<span class="kx-pid">Slot · worker-1<\/span>/);
    assert.match(p, /<dt>Writer<\/dt><dd>worker · Claude Code<\/dd>/);
    assert.match(
      p,
      /<dt>May write<\/dt><dd><span class="kx-chips"><span class="chip">journal<\/span><span class="chip">surprise<\/span><span class="chip">note<\/span><span class="chip">finding<\/span><span class="chip">doc<\/span><span class="chip">reference<\/span><\/span><\/dd>/,
    );
    assert.match(
      p,
      /<dt>Holds<\/dt><dd><span class="kx-chips"><span class="chip">reference <span class="muted">3<\/span><\/span><span class="chip">finding <span class="muted">1<\/span><\/span><\/span><\/dd>/,
    );
    assert.match(p, /Refused writes<i[\s\S]*?<span class="n">1<\/span>/);
    assert.match(
      p,
      /ago<\/span> the campaign lets worker-1 write journal, note in run gs-1: not a &lt;paper&gt;<\/li>/,
    );
    assert.match(
      await s.pane("/ui/knowledge/gemv/gs-1/records"),
      /<dt>May write<\/dt><dd>every kind, from the run(&#39;|')s own records<\/dd>/,
    );
  });

  test("an item opened takes the pane's place; Info shows the folder's pane at phone width", async () => {
    const s = await stack();
    const html = await s.html(
      `/ui/knowledge/gemv/gs-1/worker-1?item=${encodeURIComponent(FINDING)}`,
    );
    assert.ok(
      !html.includes('class="kx-prev kx-info"'),
      "the item's reader, not the folder's pane",
    );
    assert.match(html, /<aside class="kx-prev" id="kx-prev" aria-label="Preview"/);
    const folder = await s.html("/ui/knowledge/gemv");
    assert.match(
      folder,
      /<button type="button" class="kx-infobtn" aria-controls="kx-prev" aria-expanded="false">/,
    );
    assert.match(
      folder,
      /<button type="button" class="kx-x kx-infox" data-info-close aria-label="Close">/,
    );
  });
});
