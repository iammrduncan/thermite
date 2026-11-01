import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { HarnessClient } from "../../src/common/api/harness.ts";
import type { Route } from "../../src/core/api/route.ts";
import { generateSigningKeys, signEnvelope } from "../../src/core/commands.ts";
import { RigSpace } from "../../src/core/retention/index.ts";
import {
  advisorItems,
  advisorRecordsDir,
  onRetentionTaken,
  sendSpace,
} from "../../src/supervisor/retention.ts";

/**
 * The advisors' records under a retention policy (supervisor/retention.ts): each in its run's
 * folder, removed once the harness took the policy's command, with those of runs still open kept,
 * and what went told to the harness; and what the rig keeps, told to control on the bus.
 */

const DAY = 86_400_000;

function home() {
  const dir = mkdtempSync(join(tmpdir(), "thermite-advisor-records-"));
  const put = (rel: string, days: number, bytes = 100) => {
    const path = join(dir, "advisors", rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes));
    const at = new Date(Date.now() - days * DAY);
    utimesSync(path, at, at);
    return path;
  };
  return { dir, put };
}

/** A harness that answers the space and records what the supervisor removed. */
function harness(openRuns: string[]) {
  const removed: unknown[] = [];
  const client: HarnessClient = {
    call: async (route: Route, input?: { body?: unknown }) => {
      if (route.path === "/v1/space")
        return { builds: { bytes: 7, runs: [], items: [[-1, 1, 7, 0, 1]] }, open_runs: openRuns };
      if (route.path === "/v1/retention/removed") {
        removed.push(input?.body);
        return { ok: true };
      }
      throw new Error(`unexpected call ${route.path}`);
    },
  } as HarnessClient;
  return { client, removed };
}

const command = (rule: Record<string, unknown>) =>
  signEnvelope(
    {
      v: 1,
      id: crypto.randomUUID(),
      rig: "rig-a",
      kind: "retention_run",
      issued_by: "owner:ui",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      payload: { policy: 3, name: "Old records", rule, by: "hand" },
    },
    generateSigningKeys().privateKeyPem,
  );

describe("the advisors' records under a retention policy", () => {
  test("a round's record goes in its run's folder; each record knows its run", () => {
    const h = home();
    assert.equal(advisorRecordsDir(h.dir, "r-1"), join(h.dir, "advisors", "runs", "r-1"));
    assert.equal(advisorRecordsDir(h.dir, undefined), join(h.dir, "advisors"));
    assert.equal(advisorRecordsDir(h.dir, "../x"), join(h.dir, "advisors"), "never outside");
    h.put("runs/r-1/2026-10-01-audit-a.json", 3);
    h.put("compactions/r-2/round-1-teacher-1.md", 3);
    h.put("2026-09-01-review-4.json", 3);
    const items = advisorItems(h.dir, new Set(["r-1"]));
    const byRun = Object.fromEntries(items.map((x) => [x.id, [x.run, x.open]]));
    assert.deepEqual(byRun, {
      [join("runs", "r-1", "2026-10-01-audit-a.json")]: ["r-1", true],
      [join("compactions", "r-2", "round-1-teacher-1.md")]: ["r-2", false],
      "2026-09-01-review-4.json": [null, false],
    });
    assert.deepEqual(advisorItems(join(h.dir, "none"), new Set()), []);
  });

  test("removed once the harness took the command; runs still open kept; what went told to the harness", async () => {
    const h = home();
    const open = h.put("runs/r-1/old-audit.json", 60);
    const closed = h.put("runs/r-2/old-audit.json", 60, 300);
    const young = h.put("runs/r-2/new-audit.json", 1);
    const kept = h.put("compactions/r-2/round-1-teacher-1.md", 60, 50);
    const hx = harness(["r-1"]);
    const o = {
      home: h.dir,
      harness: hx.client,
      control: { rig: "rig-a", bus: { request: async () => new Uint8Array() } },
    };
    await onRetentionTaken(o, command({ kind: "advisor_records", rule: "older", older_n: 30 }));
    assert.ok(existsSync(open), "its run is still open");
    assert.ok(existsSync(young), "inside the rule");
    assert.equal(existsSync(closed), false);
    assert.equal(existsSync(kept), false);
    assert.equal(
      existsSync(join(h.dir, "advisors", "compactions", "r-2")),
      false,
      "an empty folder goes",
    );
    assert.equal(hx.removed.length, 1);
    const body = hx.removed[0] as Record<string, unknown>;
    assert.equal(body.policy, 3);
    assert.equal(body.kind, "advisor_records");
    assert.equal(body.count, 2);
    assert.equal(body.bytes, 350);
    // A builds policy is the harness's: the supervisor removes nothing.
    await onRetentionTaken(o, command({ kind: "builds", rule: "older", older_n: 1 }));
    assert.equal(hx.removed.length, 1);
    assert.ok(existsSync(young));
  });

  test("what the rig keeps goes to control on the bus: the harness's builds and the advisors' records", async () => {
    const h = home();
    h.put("runs/r-1/a.json", 2, 40);
    const asked: { subject: string; body: unknown }[] = [];
    const bus = {
      request: async (subject: string, data: string | Uint8Array) => {
        asked.push({ subject, body: JSON.parse(String(data)) });
        return new TextEncoder().encode(JSON.stringify({ ok: true }));
      },
    };
    await sendSpace({
      home: h.dir,
      harness: harness(["r-1"]).client,
      control: { rig: "rig-a", bus },
    });
    assert.equal(asked[0]?.subject, "thermite.rig.rig-a.ask.space");
    const space = RigSpace.parse(asked[0]?.body);
    assert.equal(space.kinds.builds?.bytes, 7);
    assert.equal(space.kinds.advisor_records?.bytes, 40);
    assert.deepEqual(space.kinds.advisor_records?.runs, ["r-1"]);
    assert.equal(space.kinds.advisor_records?.items[0]?.[3], 1, "its run is open");
  });
});
