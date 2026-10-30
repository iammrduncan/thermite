import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { tunnelRouteAllowed } from "../../src/control/runpod/tunnel.ts";
import { uploadExportsOnce } from "../../src/supervisor/export-upload.ts";
import { controlOnly, signIn } from "../helpers/control-stack.ts";
import { ingestReport } from "../helpers/control-store.ts";

const OWNER = "owner-token-abcdef";
const RIG_A = "rig-a-token-abcdef";
const RIG_B = "rig-b-token-abcdef";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** An export as the harness writes one into the outbox. */
function writeExport(outbox: string, name: string, files: Record<string, Buffer>, full = false) {
  const dir = join(outbox, name);
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  }
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify({
      rig: "rig-a",
      ...(full ? { full: true } : {}),
      from_event: 0,
      through_event: 7,
      created_at: new Date().toISOString(),
      files: Object.fromEntries(Object.entries(files).map(([rel, b]) => [rel, sha(b)])),
    })}\n`,
  );
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "thermite-exports-"));
  const outbox = join(root, "outbox");
  mkdirSync(outbox);
  const { store, control } = controlOnly({
    tokens: { admin: OWNER, rigs: { "rig-a": RIG_A, "rig-b": RIG_B } },
    options: { exportsDir: join(root, "control-exports") },
  });
  let pieces = 0;
  let pieceBytes = 0;
  let breakAfter = Number.POSITIVE_INFINITY;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/file")) {
      if (pieces >= breakAfter) throw new Error("connection reset");
      pieces++;
      pieceBytes += (init?.body as Uint8Array | undefined)?.length ?? 0;
    }
    return control.request(`${url.pathname}${url.search}`, init as RequestInit);
  };
  const cfg = {
    rig: "rig-a",
    outboxDir: outbox,
    controlUrl: "http://control",
    controlToken: RIG_A,
    fetchImpl,
    chunkBytes: 64,
  };
  const as = (token: string) => ({ authorization: `Bearer ${token}` });
  return {
    root,
    outbox,
    store,
    control,
    cfg,
    as,
    sent: () => ({ pieces, bytes: pieceBytes }),
    breakAfter: (n: number) => {
      breakAfter = n;
      pieces = 0;
      pieceBytes = 0;
    },
  };
}

const NAME = "20261020T120000Z-0123abcd";
const files = () => ({
  "events.jsonl": Buffer.from(`${JSON.stringify({ id: 1, kind: "run_created" })}\n`.repeat(20)),
  "journal.jsonl": Buffer.alloc(0),
  "attempts/a-1.patch": Buffer.from("diff --git a/k.c b/k.c\n+faster\n".repeat(10)),
  "champions/r-1/2.patch": Buffer.from("diff --git a/k.c b/k.c\n+champion\n".repeat(5)),
  "ledger.sqlite": Buffer.from("SQLite format 3\0".repeat(30)),
});

describe("exports sent to control", () => {
  test("an export reaches control in pieces, every file checked, and the owner reads it back", async () => {
    const s = setup();
    const f = files();
    writeExport(s.outbox, NAME, f);
    const after = await uploadExportsOnce(s.cfg, { queue: [NAME], uploaded: [] });
    assert.deepEqual(after.queue, []);
    assert.deepEqual(after.uploaded, [NAME]);
    assert.equal(after.lastError, undefined);
    assert.ok(after.lastLedgerAt, "the first export takes the ledger snapshot along");
    assert.ok(s.sent().pieces > 10, "in many pieces");

    const list = (await (
      await s.control.request("/v1/rigs/rig-a/exports", { headers: s.as(OWNER) })
    ).json()) as { exports: Record<string, unknown>[] };
    assert.equal(list.exports.length, 1);
    assert.equal(list.exports[0]?.name, NAME);
    assert.equal(list.exports[0]?.files, 5);
    assert.equal(list.exports[0]?.files_kept, 5);
    assert.ok(list.exports[0]?.complete_at);
    for (const [rel, bytes] of Object.entries(f)) {
      const got = await s.control.request(
        `/v1/rigs/rig-a/exports/${NAME}/file?path=${encodeURIComponent(rel)}`,
        { headers: s.as(OWNER) },
      );
      assert.equal(got.status, 200, rel);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes, rel);
      assert.equal(got.headers.get("x-thermite-sha256"), sha(bytes));
    }
    // On disk in control's folder, with the manifest as the harness wrote it.
    const kept = JSON.parse(
      readFileSync(join(s.root, "control-exports", "rig-a", NAME, "manifest.json"), "utf8"),
    ) as { rig: string; created_at: string };
    assert.equal(kept.rig, "rig-a");
    assert.ok(kept.created_at);

    // The next export within the day leaves its ledger snapshot out; control takes it so.
    const next = "20261020T130000Z-89abcdef";
    writeExport(s.outbox, next, files());
    const again = await uploadExportsOnce(s.cfg, { ...after, queue: [next] });
    assert.deepEqual(again.uploaded, [NAME, next]);
    assert.equal(again.lastLedgerAt, after.lastLedgerAt);
    const one = (await (
      await s.control.request(`/v1/rigs/rig-a/exports/${next}`, { headers: s.as(OWNER) })
    ).json()) as { files: { path: string }[]; complete_at: string | null };
    assert.ok(one.complete_at);
    assert.deepEqual(one.files.map((x) => x.path).sort(), [
      "attempts/a-1.patch",
      "champions/r-1/2.patch",
      "events.jsonl",
      "journal.jsonl",
    ]);
    // A full export always takes it.
    const full = "20261020T140000Z-feedface";
    writeExport(s.outbox, full, files(), true);
    const third = await uploadExportsOnce(s.cfg, { ...again, queue: [full] });
    assert.deepEqual(third.uploaded.at(-1), full);
    assert.ok(s.store.exports.get("rig-a", full)?.files["ledger.sqlite"]);
  });

  test("a broken upload goes on next round where control stopped", async () => {
    const s = setup();
    const f = files();
    const total = Object.values(f).reduce((n, b) => n + b.length, 0);
    writeExport(s.outbox, NAME, f);
    s.breakAfter(6);
    const first = await uploadExportsOnce(s.cfg, { queue: [NAME], uploaded: [] });
    assert.deepEqual(first.queue, [NAME], "it waits for the next round");
    assert.deepEqual(first.uploaded, []);
    assert.match(String(first.lastError), /^upload failed: connection reset/);
    assert.equal(s.store.exports.get("rig-a", NAME)?.complete_at, null);
    s.breakAfter(Number.POSITIVE_INFINITY);
    const second = await uploadExportsOnce(s.cfg, first);
    assert.deepEqual(second.uploaded, [NAME]);
    assert.equal(second.lastError, undefined);
    assert.equal(s.sent().bytes, total - 6 * 64, "only what control did not have yet");
    assert.ok(s.store.exports.get("rig-a", NAME)?.complete_at);
  });

  test("only the rig's own token sends its exports, and only the owner's reads them", async () => {
    const s = setup();
    writeExport(s.outbox, NAME, files());
    const manifest = JSON.parse(readFileSync(join(s.outbox, NAME, "manifest.json"), "utf8"));
    const plan = Object.fromEntries(Object.entries(files()).map(([rel, b]) => [rel, b.length]));
    const begin = (token: string | undefined, rig = "rig-a") =>
      s.control.request(`/v1/rigs/${rig}/exports/${NAME}`, {
        method: "POST",
        headers: { ...(token ? s.as(token) : {}), "content-type": "application/json" },
        body: JSON.stringify({ manifest, files: plan }),
      });
    assert.equal((await begin(undefined)).status, 401, "no token");
    assert.equal((await begin(RIG_B)).status, 401, "another rig's token");
    assert.equal((await begin(OWNER)).status, 401, "the owner's token is not a rig's");
    assert.equal(s.store.exports.get("rig-a", NAME), undefined, "nothing was started");
    const piece = (token: string) =>
      s.control.request(`/v1/rigs/rig-a/exports/${NAME}/file?path=events.jsonl&offset=0`, {
        method: "POST",
        headers: { ...s.as(token), "content-type": "application/octet-stream" },
        body: new Uint8Array(files()["events.jsonl"]),
      });
    assert.equal((await begin(RIG_A)).status, 200);
    assert.equal((await piece(RIG_B)).status, 401);
    assert.equal((await piece(OWNER)).status, 401);
    // Reading back is the owner's alone.
    for (const path of [
      "/v1/rigs/rig-a/exports",
      `/v1/rigs/rig-a/exports/${NAME}`,
      `/v1/rigs/rig-a/exports/${NAME}/file?path=events.jsonl`,
      "/v1/rigs/rig-a/results-left",
    ]) {
      assert.equal((await s.control.request(path, { headers: s.as(RIG_A) })).status, 401, path);
      assert.equal((await s.control.request(path)).status, 401, path);
    }
    // A retired rig sends nothing more: the token control made for it has ended.
    s.store.retired.add("rig-a", "owner:test");
    assert.equal((await begin(RIG_A)).status, 401);
    assert.equal((await piece(RIG_A)).status, 401);
    // Through the tunnel to a rig behind a proxy: its sends only, never the owner's reads.
    assert.ok(tunnelRouteAllowed("rp-1", "POST", `/v1/rigs/rp-1/exports/${NAME}`));
    assert.ok(
      tunnelRouteAllowed("rp-1", "POST", `/v1/rigs/rp-1/exports/${NAME}/file?path=a&offset=0`),
    );
    assert.ok(tunnelRouteAllowed("rp-1", "POST", "/v1/rigs/rp-1/champions/r-1/2/patch"));
    assert.ok(!tunnelRouteAllowed("rp-1", "GET", `/v1/rigs/rp-1/exports/${NAME}`));
    assert.ok(!tunnelRouteAllowed("rp-1", "GET", "/v1/rigs/rp-1/exports"));
    assert.ok(!tunnelRouteAllowed("rp-1", "POST", `/v1/rigs/rp-2/exports/${NAME}`));
  });

  test("control keeps only what matches the manifest", async () => {
    const s = setup();
    const f = files();
    writeExport(s.outbox, NAME, f);
    const manifest = JSON.parse(readFileSync(join(s.outbox, NAME, "manifest.json"), "utf8"));
    const plan = Object.fromEntries(Object.entries(f).map(([rel, b]) => [rel, b.length]));
    const begin = (body: unknown, name = NAME) =>
      s.control.request(`/v1/rigs/rig-a/exports/${name}`, {
        method: "POST",
        headers: { ...s.as(RIG_A), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const { "attempts/a-1.patch": _left, ...short } = plan;
    const r1 = await begin({ manifest, files: short });
    assert.equal(r1.status, 400);
    assert.match(String(((await r1.json()) as { error: string }).error), /leaves out attempts/);
    const r2 = await begin({ manifest, files: { ...plan, "extra.bin": 3 } });
    assert.equal(r2.status, 400);
    assert.match(
      String(((await r2.json()) as { error: string }).error),
      /does not list extra\.bin/,
    );
    const bad = { ...manifest, files: { ...manifest.files, "../escape": "a".repeat(64) } };
    assert.equal((await begin({ manifest: bad, files: { ...plan, "../escape": 1 } })).status, 400);
    assert.equal(
      (await begin({ manifest: { ...manifest, rig: "rig-b" }, files: plan })).status,
      400,
    );
    assert.equal((await begin({ manifest, files: plan }, "not-a-name")).status, 400);
    assert.equal((await begin({ manifest, files: plan })).status, 200);
    // The same name with another manifest is refused.
    const other = await begin({ manifest: { ...manifest, through_event: 9 }, files: plan });
    assert.equal(other.status, 409);

    const send = (path: string, offset: number, bytes: Buffer) =>
      s.control.request(
        `/v1/rigs/rig-a/exports/${NAME}/file?path=${encodeURIComponent(path)}&offset=${offset}`,
        {
          method: "POST",
          headers: { ...s.as(RIG_A), "content-type": "application/octet-stream" },
          body: new Uint8Array(bytes),
        },
      );
    const patch = f["attempts/a-1.patch"];
    // A piece at another place than the one control has: it says where it is.
    const off = await send("attempts/a-1.patch", 5, patch.subarray(5));
    assert.equal(off.status, 409);
    assert.equal(((await off.json()) as { received: number }).received, 0);
    // Bytes that are not the manifest's: refused when the last one arrives, and not kept.
    const wrong = Buffer.from(patch);
    wrong[0] = 0x21;
    const r3 = await send("attempts/a-1.patch", 0, wrong);
    assert.equal(r3.status, 422);
    const why = (await r3.json()) as { error: string; received: number };
    assert.match(
      why.error,
      /the SHA-256 of attempts\/a-1\.patch is [0-9a-f]{64}, not the manifest's/,
    );
    assert.equal(why.received, 0, "it starts again from the first byte");
    assert.equal(s.store.exports.get("rig-a", NAME)?.done.length, 0);
    const missing = await s.control.request(
      `/v1/rigs/rig-a/exports/${NAME}/file?path=attempts%2Fa-1.patch`,
      { headers: s.as(OWNER) },
    );
    assert.equal(missing.status, 404, "a file not kept is not served");
    // Past the file's end.
    const long = await send("attempts/a-1.patch", 0, Buffer.concat([patch, Buffer.from("x")]));
    assert.equal(long.status, 400);
    // The right bytes are kept.
    const ok = await send("attempts/a-1.patch", 0, patch);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { received: patch.length, done: true, complete: false });
    assert.deepEqual(s.store.exports.get("rig-a", NAME)?.done, ["attempts/a-1.patch"]);
  });
});

/** Every file under a folder, by its path from there. */
const filesUnder = (dir: string): string[] =>
  (readdirSync(dir, { recursive: true }) as string[]).filter((p) =>
    statSync(join(dir, p)).isFile(),
  );

describe("Export and the Exports page (goal 103)", () => {
  // A path ustar can't hold (a name of 123 characters: a pax record) and one it holds split at a
  // "/" (more than 100 characters in all).
  const longName = `research/r-1/folder/${"n".repeat(120)}.md`;
  const deepPath = `research/r-1/folder/${"sub/".repeat(25)}deep.md`;
  const fullFiles = () => ({
    ...files(),
    [longName]: Buffer.from("# a note with a long name\n"),
    [deepPath]: Buffer.alloc(1300, 7),
  });
  const PART = "20261020T160000Z-11111111";

  test("a complete export downloads as one .tar.gz of its manifest and files; only the owner's token gets it", async () => {
    const s = setup();
    const f = fullFiles();
    writeExport(s.outbox, NAME, f, true);
    await uploadExportsOnce(s.cfg, { queue: [NAME], uploaded: [] });
    assert.ok(s.store.exports.get("rig-a", NAME)?.complete_at);

    const res = await s.control.request(`/v1/rigs/rig-a/exports/${NAME}/archive`, {
      headers: s.as(OWNER),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/gzip");
    assert.equal(
      res.headers.get("content-disposition"),
      `attachment; filename="rig-a-${NAME}.tar.gz"`,
    );
    // The system's tar reads it: every file at its path, under <rig>-<export>/, and the manifest.
    const tgz = join(s.root, "export.tar.gz");
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    const out = join(s.root, "unpacked");
    mkdirSync(out);
    execFileSync("tar", ["-xzf", tgz, "-C", out]);
    const top = join(out, `rig-a-${NAME}`);
    assert.deepEqual(filesUnder(top).sort(), ["manifest.json", ...Object.keys(f)].sort());
    const manifest = JSON.parse(readFileSync(join(top, "manifest.json"), "utf8")) as {
      full: boolean;
      files: Record<string, string>;
    };
    assert.equal(manifest.full, true);
    for (const [rel, bytes] of Object.entries(f)) {
      const got = readFileSync(join(top, rel));
      assert.deepEqual(got, bytes, rel);
      assert.equal(sha(got), manifest.files[rel], `${rel}: its SHA-256 is the manifest's`);
    }
    assert.ok(
      s.store.auditLog.list(10).some((a) => a.action === "export_downloaded"),
      "the download is in the audit log",
    );

    // No token, or a rig's: refused.
    for (const headers of [{}, s.as(RIG_A), s.as(RIG_B)])
      assert.equal(
        (await s.control.request(`/v1/rigs/rig-a/exports/${NAME}/archive`, { headers })).status,
        401,
      );
    // An export control does not have: 404.
    for (const path of [
      "/v1/rigs/rig-a/exports/20261020T150000Z-00000000/archive",
      `/v1/rigs/rig-b/exports/${NAME}/archive`,
    ])
      assert.equal((await s.control.request(path, { headers: s.as(OWNER) })).status, 404, path);
    // One still arriving: 404, and it says why.
    writeExport(s.outbox, PART, files());
    s.breakAfter(3);
    await uploadExportsOnce(s.cfg, { queue: [PART], uploaded: [] });
    assert.equal(s.store.exports.get("rig-a", PART)?.complete_at, null);
    const part = await s.control.request(`/v1/rigs/rig-a/exports/${PART}/archive`, {
      headers: s.as(OWNER),
    });
    assert.equal(part.status, 404);
    assert.match(((await part.json()) as { error: string }).error, /still arriving/);
    rmSync(s.root, { recursive: true, force: true });
  });

  test("the Exports page lists every export with its fields, and Download only for a complete one", async () => {
    const s = setup();
    writeExport(s.outbox, NAME, fullFiles(), true);
    await uploadExportsOnce(s.cfg, { queue: [NAME], uploaded: [] });
    writeExport(s.outbox, PART, files());
    s.breakAfter(3);
    await uploadExportsOnce(s.cfg, { queue: [PART], uploaded: [] });
    const { get } = await signIn(s.control, OWNER);

    const html = await (await get("/ui/exports")).text();
    assert.match(html, /<a href="\/ui\/exports" class="on">.*<span>Exports<\/span><\/a>/);
    const rows = [
      ...html.matchAll(/<tr data-export="([^"]+)" data-rig="([^"]+)">([\s\S]*?)<\/tr>/g),
    ];
    assert.deepEqual(rows.map((r) => r[1]).sort(), [NAME, PART].sort());
    const done = rows.find((r) => r[1] === NAME)?.[3] ?? "";
    const arriving = rows.find((r) => r[1] === PART)?.[3] ?? "";
    assert.match(done, /<b>rig-a<\/b>/);
    assert.match(done, /<span class="chip ok">full<\/span>/);
    assert.match(done, /<td class="num nowrap">1–7<\/td>/, "its event range");
    assert.match(done, /<td class="num">7<\/td>/, "its files");
    assert.match(done, /KiB<\/td>/, "its size");
    assert.match(done, new RegExp(`href="/ui/exports/rig-a/${NAME}/archive" download>Download`));
    assert.match(arriving, /what changed/);
    assert.match(arriving, /still arriving/);
    assert.doesNotMatch(arriving, /archive/, "no Download for an export still arriving");

    // The rig's filter, as the rig's page links to it.
    const other = await (await get("/ui/exports?rig=rig-b")).text();
    assert.doesNotMatch(other, /<tr data-export=/);
    assert.match(other, /No export from rig-b on control/);

    // The dashboard's Download: the same archive, for the owner's session only.
    const dl = await get(`/ui/exports/rig-a/${NAME}/archive`);
    assert.equal(dl.status, 200);
    assert.equal(
      dl.headers.get("content-disposition"),
      `attachment; filename="rig-a-${NAME}.tar.gz"`,
    );
    assert.ok((await dl.arrayBuffer()).byteLength > 100);
    const anon = await s.control.request(`/ui/exports/rig-a/${NAME}/archive`);
    assert.equal(anon.status, 303, "no session: sign in first");
    assert.equal((await get(`/ui/exports/rig-a/${PART}/archive`)).status, 404);
    rmSync(s.root, { recursive: true, force: true });
  });

  test("Export on a rig's page sends export_now with full as the owner chose, and says where it will show", async () => {
    const s = setup();
    await ingestReport(s.store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: 0,
      next: 1,
      events: [
        {
          id: 1,
          at: new Date().toISOString(),
          actor: "harness",
          kind: "run_created",
          subject: "r-1",
          body: {
            campaign: "papers",
            version: 1,
            mode: "research",
            seed: { repo: "proj", commit: "a".repeat(40) },
          },
        },
      ],
      summary: {},
    });
    const { cookie, page, post } = await signIn(s.control, OWNER);
    // A run's page has Export too: the run alone first, and chosen; then the rig's (goal 103).
    const run = await page("/ui/campaigns/papers/runs/r-1");
    const runForm =
      /<form method="post" action="\/ui\/commands" class="stack export-now">([\s\S]*?)<\/form>/.exec(
        run,
      )?.[1];
    assert.ok(runForm, "Export's form is on the run's page");
    assert.match(runForm, /<b>Export r-1, or rig-a, the rig that holds it\.<\/b>/);
    assert.match(
      runForm,
      /<input type="radio" name="full" value="run" checked[^>]*><span><b>This run<\/b>/,
    );
    assert.match(
      runForm,
      /<input type="radio" name="full" value="false"(?! checked)[^>]*><span><b>What changed \(all of rig-a\)<\/b>/,
    );
    assert.match(runForm, /<input type="hidden" name="run" value="r-1">/);
    const runHidden = Object.fromEntries(
      [...runForm.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const ran = await s.control.request("/ui/commands", {
      method: "POST",
      body: new URLSearchParams({ ...runHidden, full: "run" }),
      headers: {
        cookie,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    const ranAnswer = (await ran.json()) as { said: string; follow: string };
    const ranCmd = s.store.commands.row(
      decodeURIComponent(ranAnswer.follow.replace(/^\/ui\/commands\//, "").replace(/\.json$/, "")),
    );
    assert.deepEqual([ranCmd?.kind, ranCmd?.payload], ["export_now", { full: false, run: "r-1" }]);
    assert.match(ranAnswer.said, /An export of r-1 alone was asked for\./);
    const html = await page("/ui/rigs/rig-a");
    const form =
      /<form method="post" action="\/ui\/commands" class="stack export-now">([\s\S]*?)<\/form>/.exec(
        html,
      )?.[1];
    assert.ok(form, "Export's form is on the rig's page");
    assert.match(
      form,
      /<span class="lb">What to export<i class="ii" tabindex="0" data-tip="[^"]+">i<\/i><\/span>/,
    );
    assert.match(form, /<input type="radio" name="full" value="false" checked/);
    assert.match(form, /<input type="radio" name="full" value="true"(?! checked)/);
    assert.match(form, /<a href="\/ui\/exports\?rig=rig-a">Exports page<\/a>/);
    const hidden = Object.fromEntries(
      [...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    assert.equal(hidden.kind, "export_now");
    // As the page's script sends the form, with each choice.
    for (const full of ["true", "false"]) {
      const r = await s.control.request("/ui/commands", {
        method: "POST",
        body: new URLSearchParams({ ...hidden, full }),
        headers: {
          cookie,
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
      });
      assert.equal(r.status, 200);
      const a = (await r.json()) as { said: string; follow: string };
      const id = decodeURIComponent(
        a.follow.replace(/^\/ui\/commands\//, "").replace(/\.json$/, ""),
      );
      const cmd = s.store.commands.row(id);
      assert.equal(cmd?.kind, "export_now");
      assert.deepEqual(cmd?.payload, { full: full === "true" });
      assert.match(
        a.said,
        full === "true" ? /A full export was asked for\./ : /An export was asked for\./,
      );
      assert.match(a.said, /it shows on the Exports page/);
    }
    // Without the script: the page it lands on says so too.
    const plain = await post("/ui/commands", { ...hidden, full: "true" });
    assert.equal(plain.status, 303);
    assert.match(
      decodeURIComponent(plain.headers.get("location") ?? ""),
      /A full export was asked for\. When all its files reach control, it shows on the Exports page/,
    );
    rmSync(s.root, { recursive: true, force: true });
  });
});
