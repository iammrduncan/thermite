import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { folderBytes } from "../../src/common/fs.ts";
import { spaceBlock } from "../../src/control/dashboard/settings/space.ts";
import { spaceMetricsText } from "../../src/control/metrics.ts";
import { SPACE_KINDS, SPACE_LOOK_MS, spaceOf, spaceTotal } from "../../src/control/space.ts";
import { ControlStore } from "../../src/control/store/index.ts";
import { esc } from "../../src/control/ui/components/index.ts";
import { controlStack, signIn } from "../helpers/control-stack.ts";
import { report } from "../helpers/view-events.ts";

/** The space each kind of what control keeps takes (goal 125, T12): Settings › Space, /metrics. */

const put = (path: string, bytes: number) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
};

describe("the space control's kinds take", () => {
  test("a folder's bytes are its files', links not followed; none is 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-space-"));
    put(join(dir, "a", "b", "c.bin"), 300);
    put(join(dir, "a", "d.bin"), 20);
    symlinkSync(join(dir, "a", "d.bin"), join(dir, "a", "link"));
    assert.equal(folderBytes(join(dir, "a")), 320);
    assert.equal(folderBytes(join(dir, "none")), 0);
  });

  test("each kind on control's disk, read at most once a minute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-space-"));
    const store = new ControlStore(join(dir, "control.db"));
    put(join(dir, "exports", "rig-a", "20261031T000000Z-0123abcd", "events.jsonl"), 1000);
    put(join(dir, "kits", "speed", "kit.json"), 200);
    put(join(dir, "kb-files", "ab", "abcd"), 30);
    const now = Date.parse("2026-10-31T00:00:00Z");
    const first = await spaceOf(store, undefined, now);
    assert.deepEqual(
      first.map((u) => u.kind),
      Object.keys(SPACE_KINDS),
    );
    const of = (uses: typeof first) => Object.fromEntries(uses.map((u) => [u.kind, u.bytes]));
    const was = of(first);
    assert.deepEqual(
      { ...was, store: null },
      {
        events: 0,
        exports: 1000,
        store: null,
        kb_versions: 0,
        audit: 0,
        copies: 0,
        kb_files: 30,
        kits: 200,
        builds: 0,
        trial_logs: 0,
        advisor_records: 0,
      },
    );
    assert.ok(Number(was.store) > 0, "the store's file");
    put(join(dir, "exports", "rig-a", "later.bin"), 500);
    assert.equal(of(await spaceOf(store, undefined, now + SPACE_LOOK_MS - 1)).exports, 1000);
    assert.equal(of(await spaceOf(store, undefined, now + SPACE_LOOK_MS)).exports, 1500);
    store.db.close();
  });

  test("a rig's kinds are the sum of what each rig not retired last said it keeps", async () => {
    const store = new ControlStore(":memory:");
    const inv = (bytes: number) => ({ bytes, runs: [], items: [] });
    const at = new Date().toISOString();
    store.retention.takeSpace("rig-a", {
      read_at: at,
      kinds: { builds: inv(100), advisor_records: inv(7) },
    });
    store.retention.takeSpace("rig-b", { read_at: at, kinds: { builds: inv(50) } });
    store.retention.takeSpace("rig-c", { read_at: at, kinds: { builds: inv(1000) } });
    store.retired.add("rig-c", "owner:ui");
    const uses = await spaceOf(store, undefined);
    const of = (kind: string) => uses.find((u) => u.kind === kind);
    assert.deepEqual([of("builds")?.bytes, of("builds")?.rigs], [150, 2]);
    assert.deepEqual([of("advisor_records")?.bytes, of("advisor_records")?.rigs], [7, 1]);
    // The rows inside control's store are not counted twice in the total.
    assert.equal(
      spaceTotal(uses),
      uses
        .filter((u) => !["kb_versions", "audit"].includes(u.kind))
        .reduce((n, u) => n + (u.bytes ?? 0), 0),
    );
  });

  test("/metrics has one series for each kind, and Settings › Space shows each with its ⓘ", async () => {
    const { store, control } = controlStack();
    await report(store, "rig-1", "ledger-1", [
      { kind: "run_created", subject: "r-1", body: { campaign: "speed", mode: "hill_climb" } },
    ]);
    const metrics = await spaceMetricsText(store, undefined);
    for (const kind of Object.keys(SPACE_KINDS))
      assert.match(
        metrics,
        new RegExp(`^thermite_control_space_bytes\\{kind="${kind}"\\} \\d+$`, "m"),
      );
    const html = await (await signIn(control)).page("/ui/settings/space");
    for (const [kind, k] of Object.entries(SPACE_KINDS)) {
      const row = html.slice(html.indexOf(`data-space="${kind}"`));
      assert.ok(row.length < html.length, kind);
      const cell = row.slice(0, 2000);
      assert.ok(cell.includes(esc(k.label)), k.label);
      assert.ok(cell.includes(`class="ii" tabindex="0" data-tip="${esc(k.words)}"`), `${kind}'s ⓘ`);
    }
    assert.match(html, /<h2>Space<\/h2>/);
  });

  test("a kind that can't be read says why on the page", () => {
    const block = spaceBlock([
      { kind: "events", bytes: null, error: "the message bus: no answer" },
      { kind: "kits", bytes: 2048 },
    ]);
    assert.match(block, /not read: the message bus: no answer/);
    assert.match(block, /2\.0 KiB/);
  });
});
