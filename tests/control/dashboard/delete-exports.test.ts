import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { EXPORT_RECEIVING_MS } from "../../../src/control/exports.ts";
import { uploadExportsOnce } from "../../../src/supervisor/export-upload.ts";
import { controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";

/**
 * Exports on control are removed only by hand (the owner's decision of 2026-11-01): Delete on the
 * Exports page, with its confirmation in the page, over REST, MCP and the command line. The
 * owner's alone; one still arriving is refused in words, and every delete is in the audit log.
 */

const OWNER = "owner-token-abcdef";
const OPERATOR = "operator-token-abcdef";
const RIG_A = "rig-a-token-abcdef";
const DONE = "20261101T010000Z-0123abcd";
const ALSO = "20261101T020000Z-89abcdef";
const PART = "20261101T030000Z-feedface";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const files = () => ({
  "events.jsonl": Buffer.from(`${JSON.stringify({ id: 1, kind: "run_created" })}\n`.repeat(20)),
  "journal.jsonl": Buffer.alloc(0),
  "attempts/a-1.patch": Buffer.from("diff --git a/k.c b/k.c\n+faster\n".repeat(10)),
});

/** Control with a folder for exports, an operator's token, and rig-a sending it exports. */
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "thermite-delete-exports-"));
  const outbox = join(root, "outbox");
  mkdirSync(outbox);
  const kept = join(root, "control-exports");
  const { store, control, api } = await controlOnly({
    tokens: { admin: OWNER, operator: OPERATOR, rigs: { "rig-a": RIG_A } },
    options: { exportsDir: kept },
  });
  let pieces = 0;
  let breakAfter = Number.POSITIVE_INFINITY;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/file")) {
      if (pieces >= breakAfter) throw new Error("connection reset");
      pieces++;
    }
    return control.request(`${url.pathname}${url.search}`, init as RequestInit);
  };
  /** An export rig-a sends: all of it, or its first `pieces` pieces only (still arriving). */
  const send = async (name: string, o: { run?: string; pieces?: number } = {}) => {
    const dir = join(outbox, name);
    const f = files();
    for (const [rel, bytes] of Object.entries(f)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), bytes);
    }
    const manifest = {
      rig: "rig-a",
      ...(o.run ? { run: o.run, end: true } : {}),
      from_event: 0,
      through_event: 7,
      created_at: new Date().toISOString(),
      files: Object.fromEntries(Object.entries(f).map(([rel, b]) => [rel, sha(b)])),
    };
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    pieces = 0;
    breakAfter = o.pieces ?? Number.POSITIVE_INFINITY;
    const cfg = {
      rig: "rig-a",
      outboxDir: outbox,
      controlUrl: "http://control",
      controlToken: RIG_A,
      fetchImpl,
      chunkBytes: 64,
    };
    await uploadExportsOnce(cfg, { queue: [name], uploaded: [] });
  };
  const onDisk = (name: string) => existsSync(join(kept, "rig-a", name));
  /** Every file control holds of an export is this old: control received nothing of it since. */
  const age = (name: string, ms: number) => {
    const at = new Date(Date.now() - ms);
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else utimesSync(p, at, at);
      }
    };
    walk(join(kept, "rig-a", name));
  };
  const audits = async () =>
    (await store.auditLog.list(100))
      .filter((a) => a.action === "export_deleted")
      .map((a) => a.body as { rig: string; export: string; bytes: number });
  return { root, store, control, api, send, onDisk, age, audits };
}

describe("exports on control are deleted by hand", () => {
  test("over REST: the owner deletes; one still arriving is refused, and nothing goes; each delete is audited", async () => {
    const s = await setup();
    await s.send(DONE, { run: "r-1" });
    await s.send(ALSO);
    await s.send(PART, { pieces: 3 });
    assert.ok((await s.store.exports.get("rig-a", DONE))?.complete_at);
    assert.equal((await s.store.exports.get("rig-a", PART))?.complete_at, null);

    // Only the owner's token: a rig's, the operator's (REST has none of its own) and none refused.
    const body = { exports: [{ rig: "rig-a", name: DONE }] };
    for (const token of [RIG_A, OPERATOR, ""])
      assert.equal((await s.api("POST", "/v1/exports/delete", body, token)).status, 401);
    assert.ok(await s.store.exports.get("rig-a", DONE));

    // All or none: with one still arriving, nothing is deleted, and it says why.
    const refused = await s.api("POST", "/v1/exports/delete", {
      exports: [
        { rig: "rig-a", name: DONE },
        { rig: "rig-a", name: PART },
      ],
    });
    assert.equal(refused.status, 409);
    const why = ((await refused.json()) as { error: string }).error;
    assert.match(
      why,
      new RegExp(
        `^rig-a · ${PART} \\(\\d of 3 files\\) is still arriving: control is receiving its files\\. Delete it once complete\\. Nothing was deleted\\.$`,
      ),
    );
    assert.ok((await s.store.exports.get("rig-a", DONE)) && s.onDisk(DONE), "nothing was deleted");
    assert.deepEqual(await s.audits(), []);

    // A bad name is refused as input.
    const bad = await s.api("POST", "/v1/exports/delete", {
      exports: [{ rig: "rig-a", name: "x" }],
    });
    assert.equal(bad.status, 400);

    const bytes = (await s.store.exports.get("rig-a", DONE))?.bytes ?? 0;
    const ok = await s.api("POST", "/v1/exports/delete", {
      exports: [
        { rig: "rig-a", name: DONE },
        { rig: "rig-a", name: "20261101T050000Z-00000000" },
      ],
    });
    assert.equal(ok.status, 200);
    const out = (await ok.json()) as {
      deleted: { rig: string; name: string; bytes: number; files: number }[];
      gone: { rig: string; name: string }[];
      said: string;
    };
    assert.deepEqual(out.deleted, [{ rig: "rig-a", name: DONE, bytes, files: 3 }]);
    assert.deepEqual(out.gone, [{ rig: "rig-a", name: "20261101T050000Z-00000000" }]);
    assert.match(out.said, new RegExp(`^Deleted 1 export from control: rig-a · ${DONE} \\(`));
    assert.match(out.said, /Control did not have rig-a · 20261101T050000Z-00000000/);
    assert.equal(await s.store.exports.get("rig-a", DONE), undefined, "its record is gone");
    assert.equal(s.onDisk(DONE), false, "its files are gone");
    assert.ok(s.onDisk(ALSO), "another export stays");
    assert.deepEqual(await s.audits(), [
      { rig: "rig-a", export: DONE, bytes, files: 3, complete: true },
    ]);
    assert.equal(
      (await s.api("GET", `/v1/rigs/rig-a/exports/${DONE}`)).status,
      404,
      "the export is no longer listed",
    );

    // One that stopped arriving long ago, whose rig sends no more of it, can be deleted.
    s.age(PART, EXPORT_RECEIVING_MS + 60_000);
    const stale = await s.api("POST", "/v1/exports/delete", {
      exports: [{ rig: "rig-a", name: PART }],
    });
    assert.equal(stale.status, 200);
    assert.equal(await s.store.exports.get("rig-a", PART), undefined);
    assert.equal(s.onDisk(PART), false);
  });

  test("on the Exports page: tick, Delete, the confirmation says what goes, and Delete again deletes", async () => {
    const s = await setup();
    await s.send(DONE, { run: "r-1" });
    await s.send(ALSO);
    await s.send(PART, { pieces: 3 });
    const { page, post, get, csrfOf } = await signIn(s.control, OWNER);

    const html = await page("/ui/exports");
    const box = (name: string) =>
      new RegExp(`<tr data-export="${name}" data-rig="rig-a"><td>(<input[^>]*>)</td>`).exec(
        html,
      )?.[1] ?? "";
    assert.match(box(DONE), new RegExp(`name="pick" value="rig-a/${DONE}"`));
    assert.match(box(PART), /disabled title="Still arriving: it can be deleted once complete"/);
    assert.doesNotMatch(box(PART), /name="pick"/, "an export still arriving has no box to tick");
    assert.match(html, /<form method="get" action="\/ui\/exports" id="xpick">/);
    assert.match(html, /<button class="sm danger" name="delete" value="1">Delete<\/button>/);
    assert.match(html, /<span class="muted small">at its end<\/span>/, "a run's end export");
    assert.doesNotMatch(html, /id="xdelete"/, "no confirmation before Delete");

    // Delete with two ticked: the confirmation, in the page, with each one's rig, name and size.
    const ask = await page(
      `/ui/exports?delete=1&pick=${encodeURIComponent(`rig-a/${DONE}`)}&pick=${encodeURIComponent(`rig-a/${ALSO}`)}`,
    );
    const card = /<div class="card warn" id="xdelete"[\s\S]*?<\/form><\/div>/.exec(ask)?.[0] ?? "";
    assert.match(card, /<b>Delete these 2 exports from control\?<\/b>/);
    assert.match(card, /This can't be undone/);
    for (const name of [DONE, ALSO]) {
      assert.match(
        card,
        new RegExp(
          `<tr data-delete="${name}" data-rig="rig-a"><td><b>rig-a</b></td><td><code>${name}</code></td>[\\s\\S]*?<td class="num nowrap">\\d+(\\.\\d)? (B|KiB)</td></tr>`,
        ),
      );
      assert.match(card, new RegExp(`<input type="hidden" name="export" value="rig-a/${name}">`));
    }
    assert.match(card, /<b>In all<\/b>/);
    assert.match(card, /<button class="danger">Delete 2 exports<\/button>/);
    assert.match(card, /<a class="btn" href="\/ui\/exports">Cancel<\/a>/);
    assert.match(ask, new RegExp(`value="rig-a/${DONE}" checked`), "the boxes stay ticked");
    assert.ok(await s.store.exports.get("rig-a", DONE), "asking deletes nothing");

    // The still-arriving one ticked by hand: refused in words, with nothing to press.
    const no = await page(`/ui/exports?delete=1&pick=${encodeURIComponent(`rig-a/${PART}`)}`);
    assert.match(no, /<b class="bad">These exports can't be deleted now\.<\/b>/);
    assert.match(no, /is still arriving: control is receiving its files/);
    assert.doesNotMatch(no, /action="\/ui\/exports\/delete"/);
    // Nothing ticked: it says what to do.
    assert.match(await page("/ui/exports?delete=1"), /<b>Nothing to delete\.<\/b>/);

    // The confirmation's Delete: gone, with what went at the top of the page.
    const csrf = csrfOf(card);
    assert.ok(csrf, "the confirmation's form carries the form token");
    const done = await post("/ui/exports/delete", [
      ["csrf", csrf],
      ["export", `rig-a/${DONE}`],
      ["export", `rig-a/${ALSO}`],
      ["back", "/ui/exports"],
    ]);
    assert.equal(done.status, 303);
    const to = done.headers.get("location") ?? "";
    assert.match(
      decodeURIComponent(to.replace(/\+/g, " ")),
      new RegExp(`Deleted 2 exports from control: rig-a · ${DONE} \\(.*\\) and rig-a · ${ALSO}`),
    );
    assert.equal(await s.store.exports.get("rig-a", DONE), undefined);
    assert.equal(await s.store.exports.get("rig-a", ALSO), undefined);
    assert.equal(s.onDisk(DONE) || s.onDisk(ALSO), false);
    assert.deepEqual((await s.audits()).map((a) => a.export).sort(), [ALSO, DONE].sort());
    const after = await (await get(to)).text();
    assert.match(after, /<b class="ok">Deleted 2 exports from control/);
    assert.doesNotMatch(after, new RegExp(`data-export="${DONE}"`));

    // The page's form for one still arriving: refused, nothing deleted, said on the page.
    const refused = await post("/ui/exports/delete", [
      ["csrf", csrf],
      ["export", `rig-a/${PART}`],
    ]);
    assert.equal(refused.status, 303);
    const back = await (await get(refused.headers.get("location") ?? "")).text();
    assert.match(back, /<b class="bad">Not deleted\.<\/b>/);
    assert.match(back, /is still arriving/);
    assert.ok(await s.store.exports.get("rig-a", PART));
    // A form with no export: refused in words.
    const empty = await post("/ui/exports/delete", [
      ["csrf", csrf],
      ["back", "/ui/exports"],
    ]);
    assert.match(
      decodeURIComponent((empty.headers.get("location") ?? "").replace(/\+/g, " ")),
      /Tick one or more exports, then press Delete\./,
    );
  });

  test("over MCP: the owner's delete_exports deletes; an operator has no such tool", async () => {
    const s = await setup();
    await s.send(DONE);
    await s.send(PART, { pieces: 3 });
    const operator = await mcpClient(s.control, OPERATOR);
    const theirs = (await operator.listTools()).tools.map((t) => t.name);
    assert.ok(theirs.includes("exports"), "an operator lists exports");
    assert.ok(!theirs.includes("delete_exports"), "but deletes none");
    const tried = (await operator.callTool({
      name: "delete_exports",
      arguments: { exports: [{ rig: "rig-a", name: DONE }] },
    })) as { isError?: boolean };
    assert.equal(tried.isError, true);
    assert.ok(await s.store.exports.get("rig-a", DONE));

    const owner = await mcpClient(s.control, OWNER);
    const call = (name: string) =>
      owner.callTool({
        name: "delete_exports",
        arguments: { exports: [{ rig: "rig-a", name }] },
      }) as Promise<{ isError?: boolean; content: { text: string }[] }>;
    const no = await call(PART);
    assert.equal(no.isError, true);
    assert.match(no.content[0]?.text ?? "", /is still arriving/);
    const yes = await call(DONE);
    assert.ok(!yes.isError, yes.content[0]?.text);
    const out = JSON.parse(yes.content[0]?.text ?? "{}") as { said: string; deleted: unknown[] };
    assert.equal(out.deleted.length, 1);
    assert.match(out.said, /^Deleted 1 export from control/);
    assert.equal(await s.store.exports.get("rig-a", DONE), undefined);
    assert.equal(s.onDisk(DONE), false);
    assert.equal((await s.audits()).length, 1);
    await operator.close();
    await owner.close();
  });
});
