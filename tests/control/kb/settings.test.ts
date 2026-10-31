import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { takeKbItem } from "../../../src/control/events/knowledge.ts";
import {
  followKbFiles,
  KbFiles,
  kbSettingsOf,
  kbStored,
  setKbSettings,
} from "../../../src/control/kb/index.ts";
import type { ControlStore } from "../../../src/control/store/index.ts";
import {
  KB_FILE_CHUNK_BYTES,
  KB_FILE_HEADERS,
  KB_FILES_STREAM_CONFIG,
  kbChunkId,
  kbFileChunks,
  kbFileSubject,
} from "../../../src/core/link/kb-files.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { FakeBus } from "../../helpers/fake-bus.ts";

/**
 * The knowledge base's settings on control (goal 175, step 7): the largest file it takes, none by
 * default, and how long a file no item names stays, THERMITE_CONTROL_KB_ORPHAN_HOURS by default;
 * the same on Settings › Knowledge base, REST, MCP and `thermite kb settings`.
 */

const TOKENS = { admin: ADMIN, operator: "operator-token-abcdef", rigs: {} };
const RIG = { rig: "rig-a", ledger: "ledger-a" };
const MIB = 1024 ** 2;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Control whose environment keeps orphans 48 hours, with gs-1 of gemv reported by rig-a. */
function stack() {
  const dir = mkdtempSync(join(tmpdir(), "thermite-kb-settings-"));
  let files: KbFiles | undefined;
  const { store, control } = controlOnly({
    tokens: TOKENS,
    options: (s) => {
      files = new KbFiles(dir, s, { orphanHours: 48 });
      return { staleAfterMs: 600_000, kbFiles: files };
    },
  });
  const run = { kind: "run_created", subject: "gs-1", body: { campaign: "gemv" } };
  store.runRegistry.registerRunCreated(RIG.rig, RIG.ledger, { ...run, at: "2026-10-30T10:00:00Z" });
  store.kb().index(RIG, { ...run, at: "2026-10-30T10:00:00.000Z", actor: "harness" });
  const rest = async (method: string, path: string, body?: unknown, token = ADMIN) => {
    const r = await control.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { store, control, files: files as KbFiles, rest };
}

/** worker-1's `kb_item` event for a file of `bytes` bytes, as the apply of the events stream takes it. */
function writeFile(store: ControlStore, item: number, bytes: number) {
  takeKbItem(store, RIG, {
    id: 10 + item,
    at: "2026-10-30T10:05:00.000Z",
    actor: "worker-1",
    subject: "gs-1",
    body: {
      slot: "worker-1",
      item,
      version: 1,
      kind: "reference",
      title: `paper ${item}`,
      links: [],
      file: {
        sha256: String(item).repeat(64).slice(0, 64),
        name: `p${item}.pdf`,
        type: "application/pdf",
        bytes,
      },
    },
  });
}

describe("the knowledge base's settings", () => {
  test("no limit and the environment's hours by default; REST, MCP and the page read and set them alike", async () => {
    const s = stack();
    const got = await s.rest("GET", "/v1/kb/settings");
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, {
      max_file_mib: 0,
      orphan_hours: 48,
      orphan_hours_from: "environment",
      orphan_hours_default: 48,
      set_by: null,
      set_at: null,
    });
    const set = await s.rest("PUT", "/v1/kb/settings", { max_file_mib: 10, orphan_hours: 0 });
    assert.equal(set.status, 200);
    assert.equal(set.body.said, "The knowledge base takes files up to 10 MiB; every file is kept.");
    assert.deepEqual(
      [set.body.max_file_mib, set.body.orphan_hours, set.body.orphan_hours_from, set.body.set_by],
      [10, 0, "setting", "owner:api"],
    );
    // Refused in words, the same on each surface.
    for (const [body, words] of [
      [{}, "bad request: settings: give max_file_mib, orphan_hours or both"],
      [{ max_file_mib: -1 }, /^bad request: max_file_mib: /],
      [{ orphan_hours: "a day" }, /^bad request: orphan_hours: /],
      [{ max_file_mib: 1, other: 2 }, /^bad request: settings: Unrecognized key/],
    ] as const) {
      const r = await s.rest("PUT", "/v1/kb/settings", body);
      assert.equal(r.status, 400);
      assert.match(
        String(r.body.error),
        typeof words === "string" ? new RegExp(`^${words}$`) : words,
      );
    }
    // MCP: the operator reads them; only the owner sets them, and null puts one back.
    const op = await mcpClient(s.control, TOKENS.operator);
    const read = (await op.callTool({ name: "kb_settings", arguments: {} })) as {
      content: { text: string }[];
    };
    assert.equal(JSON.parse(String(read.content[0]?.text)).max_file_mib, 10);
    assert.ok(!(await op.listTools()).tools.some((t) => t.name === "set_kb_settings"));
    const owner = await mcpClient(s.control);
    const out = (await owner.callTool({
      name: "set_kb_settings",
      arguments: { max_file_mib: null, orphan_hours: null },
    })) as { content: { text: string }[] };
    const now = JSON.parse(String(out.content[0]?.text));
    assert.deepEqual(
      [now.max_file_mib, now.orphan_hours, now.orphan_hours_from],
      [0, 48, "environment"],
    );
    assert.equal(
      now.said,
      "The knowledge base takes files of any size; a file no item names is removed after 48 hours (THERMITE_CONTROL_KB_ORPHAN_HOURS).",
    );
    assert.deepEqual(
      s.store.auditLog.list(20, { action: "kb_settings_set" }).map((e) => [e.actor, e.body]),
      [
        ["owner:mcp", { max_file_mib: null, orphan_hours: null }],
        ["owner:api", { max_file_mib: 10, orphan_hours: 0 }],
      ],
    );
  });

  test("Settings › Knowledge base: each label has its ⓘ, and Save says what it kept, or why not", async () => {
    const s = stack();
    const ui = await signIn(s.control);
    const page = await ui.page("/ui/settings");
    assert.match(page, /<div class="block" id="kb"><div class="head"><h2>Knowledge base<\/h2>/);
    for (const label of ["Largest file, in MiB", "Orphan files kept, in hours"])
      assert.match(page, new RegExp(`${label}<i class="ii" tabindex="0" data-tip="[^"]+">i</i>`));
    assert.match(page, /placeholder="48 \(THERMITE_CONTROL_KB_ORPHAN_HOURS\)"/);
    assert.match(page, /Save keeps both\. A limit applies to the files that come from then on\./);
    const csrf = ui.csrfOf(page);
    const saved = await ui.post("/ui/settings/kb", { csrf, max_file_mib: "2.5", orphan_hours: "" });
    assert.equal(saved.status, 303);
    assert.match(
      String(saved.headers.get("location")),
      /ok=The%20knowledge%20base%20takes%20files%20up%20to%202\.5%20MiB.*at=kb#kb$/,
    );
    assert.equal(kbSettingsOf(s.store, 48).max_file_mib, 2.5);
    const after = await ui.page(String(saved.headers.get("location")));
    assert.match(after, /<b class="ok">The knowledge base takes files up to 2\.5 MiB;/);
    assert.match(after, /name="max_file_mib" inputmode="decimal" maxlength="20" value="2\.5"/);
    const bad = await ui.post("/ui/settings/kb", { csrf, max_file_mib: "lots", orphan_hours: "" });
    assert.match(
      String(bad.headers.get("location")),
      /error=Largest%20file%20takes%20a%20number%2C%200%20or%20more%2C%20not%20%22lots%22\..*at=kb#kb$/,
    );
    // Empty is no limit.
    await ui.post("/ui/settings/kb", { csrf, max_file_mib: "", orphan_hours: "" });
    assert.equal(kbSettingsOf(s.store, 48).max_file_mib, 0);
  });

  test("a file over the limit is refused in words, as a refused write; 0 is no limit", async () => {
    const s = stack();
    writeFile(s.store, 1, 3 * MIB);
    assert.equal(
      s.store.kb().at("gemv/gs-1/worker-1/reference:1")?.file?.bytes,
      3 * MIB,
      "no limit",
    );
    setKbSettings(s.store, { max_file_mib: 2 }, 48, "owner:api");
    writeFile(s.store, 2, 3 * MIB);
    writeFile(s.store, 3, 2 * MIB);
    assert.equal(s.store.kb().at("gemv/gs-1/worker-1/reference:2"), undefined, "refused");
    assert.ok(s.store.kb().at("gemv/gs-1/worker-1/reference:3"), "at the limit: taken");
    const why =
      "the file p2.pdf has 3,145,728 bytes: over the knowledge base's limit of 2 MiB (2,097,152 bytes), set on control";
    const stored = await kbStored(s.store, undefined);
    assert.deepEqual(
      stored.refused.rows.map((r) => [r.run, r.slot, r.why]),
      [["gs-1", "worker-1", why]],
      "What's stored shows it",
    );
    setKbSettings(s.store, { max_file_mib: 0 }, 48, "owner:api");
    writeFile(s.store, 4, 50 * MIB);
    assert.ok(s.store.kb().at("gemv/gs-1/worker-1/reference:4"), "0: no limit again");
  });

  test("a file's chunks over the limit are not kept, unless an item control stored names the file", async () => {
    const s = stack();
    const bus = new FakeBus();
    await bus.makeStream(KB_FILES_STREAM_CONFIG);
    const putAll = async (bytes: Buffer) => {
      for (let i = 0; i < kbFileChunks(bytes.length); i++) {
        const at = i * KB_FILE_CHUNK_BYTES;
        await bus.publish(kbFileSubject(RIG.rig), bytes.subarray(at, at + KB_FILE_CHUNK_BYTES), {
          id: `${kbChunkId(RIG.rig, sha(bytes), i)}:${Math.random()}`,
          headers: {
            [KB_FILE_HEADERS.sha256]: sha(bytes),
            [KB_FILE_HEADERS.chunk]: String(i),
            [KB_FILE_HEADERS.chunks]: String(kbFileChunks(bytes.length)),
            [KB_FILE_HEADERS.bytes]: String(bytes.length),
          },
        });
      }
      await followKbFiles(bus, s.files);
    };
    setKbSettings(s.store, { max_file_mib: 1 }, 48, "owner:api");
    const large = randomBytes(2 * KB_FILE_CHUNK_BYTES + 5);
    await putAll(large);
    assert.equal(s.store.kb().files.has(sha(large)), false);
    assert.equal(existsSync(s.files.path(sha(large))), false);
    const refused = s.store.auditLog.list(20, { action: "kb_file_refused" });
    assert.equal(refused.length, 1, "one entry for the file");
    assert.equal(refused[0]?.count, 3, "with how many of its chunks came");
    assert.match(JSON.stringify(refused[0]?.body), /over the knowledge base's limit of 1 MiB/);
    // An item stored before the limit names this one: its file is kept.
    const named = randomBytes(KB_FILE_CHUNK_BYTES + 9);
    setKbSettings(s.store, { max_file_mib: 0 }, 48, "owner:api");
    s.store.kb().write(
      { ...RIG, run: "gs-1", event: 99, at: "2026-10-30T10:06:00.000Z" },
      {
        slot: "worker-1",
        item: 9,
        version: 1,
        kind: "reference",
        title: "named",
        links: [],
        file: { sha256: sha(named), name: "n.pdf", type: "application/pdf", bytes: named.length },
      },
    );
    setKbSettings(s.store, { max_file_mib: 1 }, 48, "owner:api");
    await putAll(named);
    assert.equal(s.store.kb().files.has(sha(named)), true);
  });

  test("orphan files go after the set hours, stay at 0, and follow the environment when unset", () => {
    const s = stack();
    const kb = s.store.kb();
    const orphan = randomBytes(64);
    kb.files.kept(sha(orphan), 64, "2026-10-28T00:00:00.000Z");
    const path = s.files.path(sha(orphan));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, orphan);
    const now = Date.parse("2026-10-30T00:00:00.000Z");
    // 48 hours from the environment: kept 48 hours ago to the millisecond, not yet older.
    assert.equal(s.files.orphanHours(), 48);
    assert.equal(s.files.removeOrphans(undefined, now), 0);
    setKbSettings(s.store, { orphan_hours: 0 }, 48, "owner:api");
    assert.equal(s.files.removeOrphans(undefined, now), 0, "0 keeps every file");
    assert.equal(kb.files.has(sha(orphan)), true);
    setKbSettings(s.store, { orphan_hours: 24 }, 48, "owner:api");
    assert.equal(s.files.removeOrphans(undefined, now), 1, "the owner's 24 hours");
    assert.equal(kb.files.has(sha(orphan)), false);
    assert.equal(existsSync(path), false);
    setKbSettings(s.store, { orphan_hours: null }, 48, "owner:api");
    assert.equal(s.files.orphanHours(), 48, "back to THERMITE_CONTROL_KB_ORPHAN_HOURS");
  });
});
