import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KbFiles } from "../../../src/control/kb/index.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import {
  FINDING,
  fillReader,
  HTML_PAGE,
  SVG_IMAGE,
  WITHDRAWN_WHY,
} from "../../helpers/kb-reader.ts";

/**
 * The Knowledge page's reader (goal 176): an item in the preview pane beside the table, with the
 * item in the page's address, and on its own page; its versions, the withdrawn mark, its links
 * both ways, who can read it, and its file, which downloads and never renders in the dashboard's
 * origin.
 */

/** Control with the reader's cases, its files held in `dir`. Signed in. */
async function withFiles() {
  const dir = mkdtempSync(join(tmpdir(), "thermite-kb-files-"));
  let files: KbFiles | undefined;
  const { store, control } = controlOnly({
    tokens: { rigs: { "rig-a": "rig-a-token-abcd", "rig-b": "rig-b-token-abcd" } },
    options: (s) => {
      files = new KbFiles(dir, s);
      return { staleAfterMs: 600_000, kbFiles: files };
    },
  });
  await fillReader(store, files);
  const s = await signIn(control);
  const page = async (path: string) => {
    const r = await s.get(path);
    return { status: r.status, html: await r.text() };
  };
  return { store, control, page, get: s.get };
}

const pane = (html: string) => {
  const at = html.indexOf('<aside class="kx-prev"');
  return at < 0 ? "" : html.slice(at, html.indexOf("</aside>", at));
};
const q = (address: string) => encodeURIComponent(address);

describe("the reader", () => {
  test("an item opens in the pane beside its folder's table, with the item in the address; × closes it", async () => {
    const s = await withFiles();
    const folder = await s.page("/ui/knowledge/gemv/gs-1/worker-1?sort=name");
    assert.equal(pane(folder.html), "", "no pane until an item is open");
    // A row's title opens it in the pane, keeping the folder's view.
    assert.match(
      folder.html,
      new RegExp(
        `<a href="/ui/knowledge/gemv/gs-1/worker-1\\?sort=name&amp;item=${q(FINDING)}" data-item>`,
      ),
    );
    const open = await s.page(`/ui/knowledge/gemv/gs-1/worker-1?sort=name&item=${q(FINDING)}`);
    assert.equal(open.status, 200);
    const p = pane(open.html);
    assert.match(p, /<aside class="kx-prev" id="kx-prev" aria-label="Preview" tabindex="-1">/);
    assert.match(p, /<span class="mono kx-pid">finding:1<\/span>/);
    assert.match(
      p,
      /<a class="kx-full" href="\/ui\/knowledge\/gemv\/gs-1\/worker-1\/finding:1">[\s\S]*?<span>Open full page<\/span><\/a>/,
    );
    assert.match(
      p,
      /<a class="kx-x" href="\/ui\/knowledge\/gemv\/gs-1\/worker-1\?sort=name" data-pclose aria-label="Close the preview">/,
    );
    assert.match(p, /<h2>Vector loads double the bandwidth, measured twice<\/h2>/);
    assert.match(
      p,
      /<span class="chip">finding<\/span><span class="mono">worker-1<\/span><span aria-hidden="true">·<\/span><span>worker · Claude Code<\/span><span aria-hidden="true">·<\/span><span title="2026-10-30T11:00:00.000Z">written /,
    );
    assert.match(
      p,
      /<code>gemv\/gs-1\/worker-1\/finding:1<\/code><button type="button" class="ghost sm" data-copy=/,
    );
    assert.match(p, /<div class="kx-text">Measured again over 30 runs/);
    // The table marks the row that is open.
    assert.match(open.html, new RegExp(`<tr data-item-href="[^"]*item=${q(FINDING)}" class="on">`));
    // An item the knowledge base has not: said in the pane.
    const missing = pane(
      (await s.page(`/ui/knowledge/gemv?item=${q("gemv/gs-1/worker-1/finding:9")}`)).html,
    );
    assert.match(
      missing,
      /<b>Not found\.<\/b> the knowledge base has no item gemv\/gs-1\/worker-1\/finding:9/,
    );
  });

  test("versions: Version n of m, the latest first; an older one says so, with Show the latest", async () => {
    const s = await withFiles();
    const latest = pane((await s.page(`/ui/knowledge/gemv?item=${q(FINDING)}`)).html);
    assert.match(latest, /<summary class="kx-ddb">Version 2 of 2<svg/);
    assert.match(
      latest,
      /<span class="lb">Versions<i class="ii" tabindex="0" data-tip="Each version is kept/,
    );
    const options = [...latest.matchAll(/<a class="kx-vopt[^"]*" href="([^"]+)"/g)].map((m) =>
      (m[1] ?? "").replace(/&amp;/g, "&"),
    );
    assert.deepEqual(options, [
      `/ui/knowledge/gemv?item=${q(FINDING)}`,
      `/ui/knowledge/gemv?item=${q(FINDING)}&version=1`,
    ]);
    assert.match(latest, /<span>Version 2<\/span><span class="muted xs">latest, /);
    assert.ok(!latest.includes("older version"));
    const older = pane((await s.page(`/ui/knowledge/gemv?item=${q(FINDING)}&version=1`)).html);
    assert.match(older, /Version 1 of 2/);
    assert.match(
      older,
      new RegExp(
        `<span class="chip warn">older version</span><a class="kx-latest" href="/ui/knowledge/gemv\\?item=${q(FINDING)}" data-item>Show the latest</a>`,
      ),
    );
    assert.match(
      older,
      /<h2>&lt;script&gt;alert\(1\)&lt;\/script&gt; Vector loads double the bandwidth<\/h2>/,
    );
    assert.ok(!older.includes("<script>alert(1)</script>"));
    // On its own page, the same reader, full width; its versions are its page's.
    const page = await s.page("/ui/knowledge/gemv/gs-1/worker-1/finding:1?version=1");
    assert.equal(pane(page.html), "");
    assert.match(page.html, /<article class="kx-item"><h2>&lt;script&gt;/);
    assert.match(
      page.html,
      /<a class="kx-latest" href="\/ui\/knowledge\/gemv\/gs-1\/worker-1\/finding:1">Show the latest<\/a>/,
    );
  });

  test("withdrawn evidence: a warning mark with its reason, in the pane and in the table", async () => {
    const s = await withFiles();
    const open = await s.page(
      `/ui/knowledge/gemv/gs-1/records?item=${q("gemv/gs-1/records/attempt:a-2")}`,
    );
    const mark = pane(open.html);
    assert.ok(
      mark.includes(
        `<span class="chip warn tipped" tabindex="0" role="note" data-tip="${WITHDRAWN_WHY}"><svg`,
      ),
      mark,
    );
    assert.ok(mark.includes(`<span>Withdrawn</span><span class="kx-sr">: ${WITHDRAWN_WHY}</span>`));
    assert.match(
      open.html,
      new RegExp(
        `<span class="kx-wd" role="img" aria-label="Evidence withdrawn" title="${WITHDRAWN_WHY}">`,
      ),
    );
    assert.ok(
      !pane(
        (await s.page(`/ui/knowledge/gemv?item=${q("gemv/gs-1/records/attempt:a-1")}`)).html,
      ).includes("Withdrawn"),
    );
  });

  test("links both ways and who can read it: each collapsed, each link opening that item in the pane", async () => {
    const s = await withFiles();
    const p = pane((await s.page(`/ui/knowledge/gemv?item=${q(FINDING)}`)).html);
    assert.match(
      p,
      /<details class="kx-sec"><summary><svg[\s\S]*?<span>Links<\/span><span class="n">2<\/span><\/summary>/,
    );
    assert.match(
      p,
      new RegExp(
        `<a class="kx-link" href="/ui/knowledge/gemv\\?item=${q("survey/sv-1/worker-1/finding:1")}" data-item><span class="chip ok">supported by</span>`,
      ),
    );
    assert.match(
      p,
      /<span class="chip ">followed by<\/span><span class="kx-ltext"><span class="kx-ltitle">Tile next<\/span>/,
    );
    assert.match(p, /<span>Who can read it<\/span><span class="n">2 of 5 running runs<\/span>/);
    const readers = [
      ...p.matchAll(
        /<div class="kx-reader" role="listitem"><span class="(ok|bad)" role="img" aria-label="(can read|cannot read)">[\s\S]*?<span class="mono">([^<]+)<\/span><span class="muted">([^<]+)<\/span>/g,
      ),
    ].map((m) => [m[3], m[2], m[4]]);
    assert.deepEqual(readers, [
      ["at-1", "cannot read", "no grant"],
      ["gs-1", "can read", "its collection"],
      ["gs-2", "cannot read", "started fresh"],
      ["sv-1", "can read", "granted and included"],
      ["sv-2", "cannot read", "grant not included"],
    ]);
    assert.ok(!/<details class="kx-sec" open/.test(p), "collapsed until opened");
    // A link to an item the knowledge base has not: said, and no link.
    const other = pane(
      (await s.page(`/ui/knowledge?item=${q("survey/sv-1/worker-1/finding:1")}`)).html,
    );
    assert.match(
      other,
      /<span class="kx-link dim"><span class="chip ">follows<\/span><span class="kx-ltext"><span class="kx-ltitle">Not in the knowledge base<\/span>/,
    );
  });

  test("a file: its facts and Download; a stored HTML or SVG file never renders in the dashboard's origin", async () => {
    const s = await withFiles();
    for (const [n, name, body] of [
      [3, "loads.html", HTML_PAGE],
      [4, "loads.svg", SVG_IMAGE],
    ] as const) {
      const address = `gemv/gs-1/worker-1/reference:${n}`;
      const p = pane((await s.page(`/ui/knowledge/gemv/gs-1/worker-1?item=${q(address)}`)).html);
      assert.match(p, new RegExp(`<div class="kx-fname"><b>${name.replace(".", "\\.")}</b>`));
      assert.match(p, /kept whole, its text not searched/);
      assert.match(p, /<dt>From<\/dt><dd>worker-1 wrote it in gs-1, on rig-a<\/dd>/);
      const href = `/ui/kb/file?address=${q(address)}&amp;version=1`;
      assert.ok(p.includes(`<a class="btn sm" href="${href}" download>`), p);
      assert.ok(!p.includes("Show text"), "no text until control extracts it");
      // The reader never puts the file in the page: no frame, image, object or embed.
      assert.ok(!/<(iframe|img|object|embed)\b/i.test(p));
      const r = await s.get(href.replace("&amp;", "&"));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "application/octet-stream");
      assert.match(
        r.headers.get("content-disposition") ?? "",
        new RegExp(`^attachment; filename="${name.replace(".", "\\.")}"`),
      );
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.equal(
        r.headers.get("content-security-policy"),
        "default-src 'none'; sandbox",
        "not the dashboard's own policy",
      );
      assert.equal(await r.text(), body);
    }
    // A file control does not hold yet: said, with no Download.
    const pdf = pane(
      (await s.page(`/ui/knowledge/gemv?item=${q("gemv/gs-1/worker-1/reference:2")}`)).html,
    );
    assert.match(pdf, /PDF · 50\.8 KiB/);
    assert.match(pdf, /Control does not hold the file yet: it comes when the rig sends it\./);
    assert.ok(!pdf.includes("Download"));
    const waits = await s.get(`/ui/kb/file?address=${q("gemv/gs-1/worker-1/reference:2")}`);
    assert.equal(waits.status, 409);
    assert.equal((await s.get(`/ui/kb/file?address=${q(FINDING)}`)).status, 404);
    assert.equal(
      (await s.control.request(`/ui/kb/file?address=${q("gemv/gs-1/worker-1/reference:3")}`))
        .status,
      303,
      "signed in only",
    );
  });
});
