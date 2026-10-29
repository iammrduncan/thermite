import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ControlStore } from "../../../src/control/store/index.ts";
import type { SignedCommand } from "../../../src/core/commands.ts";
import { McpUses } from "../../../src/core/mcp.ts";

/**
 * Each command's run and campaign in columns of their own (goal 168, step 4): filled by the
 * migration from each command's JSON, written by enqueue, and read by the readers by run or
 * campaign, which answer as the JSON did.
 */

const fresh = () => join(mkdtempSync(join(tmpdir(), "thermite-store-")), "control.db");
const version = (store: ControlStore) =>
  (store.db.prepare("select max(version) as v from schema_migrations").get() as { v: number }).v;
const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

let made = 0;
/** A command as control signs it; the store checks no signature. */
function command(
  rig: string,
  kind: string,
  payload: unknown,
  o: { issued?: number; expires?: number } = {},
): SignedCommand {
  made++;
  return {
    envelope: {
      v: 1,
      id: `00000000-0000-4000-8000-${String(made).padStart(12, "0")}`,
      rig,
      kind,
      issued_by: "owner:test",
      issued_at: minutes((o.issued ?? 0) - 100 + made / 1000),
      expires_at: minutes(o.expires ?? 60),
      payload,
    },
    signature: "not checked by the store",
  } as unknown as SignedCommand;
}

const assign = (run: unknown, campaign: unknown, extra: Record<string, unknown> = {}) => ({
  run,
  contract: { campaign },
  contract_sha: "0".repeat(64),
  ...extra,
});
const mcp = (name: string) => [{ name, agents: ["workers"] }];

/** Commands of every shape a store holds, in every state: [command, status, acked minutes ago]. */
function commands(): [SignedCommand | string, string, number?][] {
  return [
    [command("rig-a", "assign_campaign", assign("sort-1", "sort-speed")), "delivered", 2],
    [command("rig-a", "assign_campaign", assign("sort-2", "sort-speed")), "pending"],
    [
      command("rig-a", "assign_campaign", assign("sort-3", "sort-speed"), { expires: -5 }),
      "pending",
    ],
    [command("rig-b", "assign_campaign", assign("sort-4", "sort-speed")), "failed", 1],
    [command("rig-b", "assign_campaign", assign("sort-5", "sort-speed")), "delivered", 60],
    [
      command("rig-b", "assign_campaign", assign("mm-1", "matmul", { mcp_servers: mcp("kb") })),
      "delivered",
      1,
    ],
    [
      command("rig-b", "assign_campaign", assign("mm-2", "matmul", { mcp_servers: null })),
      "pending",
    ],
    [
      command("rig-b", "assign_campaign", assign("mm-3", "matmul", { mcp_servers: "x" })),
      "rejected",
      1,
    ],
    [
      command("rig-a", "assign_campaign", assign("mm-4", "matmul", { mcp_servers: [] })),
      "expired",
      1,
    ],
    [
      command("rig-a", "assign_campaign", assign("mm-5", "matmul", { mcp_servers: mcp("web") })),
      "pending",
    ],
    [
      command("rig-a", "assign_campaign", assign("mm-5", "matmul", { mcp_servers: mcp("kb") })),
      "delivered",
      3,
    ],
    [command("rig-a", "assign_campaign", assign("odd-1", 7)), "pending"],
    [command("rig-a", "assign_campaign", assign(42, "numbers")), "pending"],
    [command("rig-a", "assign_campaign", assign("", "blank")), "pending"],
    [command("rig-a", "assign_campaign", { run: "no-contract" }), "pending"],
    [command("rig-a", "resume_run", { run: "sort-1" }), "pending"],
    [command("rig-b", "resume_run", { run: "mm-1" }), "pending"],
    [command("rig-b", "resume_run", { run: "mm-1" }, { expires: -1 }), "pending"],
    [command("rig-a", "resume_run", { run: "nobody" }), "pending"],
    [command("rig-a", "message_agent", { run: "sort-1", to: "planner", text: "hi" }), "pending"],
    [command("rig-a", "pause_run", { run: "sort-2", reason: "a test" }), "delivered", 1],
    [command("rig-a", "export_now", { full: false, run: "sort-1" }), "pending"],
    [command("rig-a", "export_now", { full: true }), "pending"],
    [command("rig-a", "rig_check", { check: "model" }), "pending"],
    ["{", "pending"],
    ["{}", "delivered", 1],
    ['{"envelope":5}', "pending"],
    ['{"envelope":{"payload":{"run":["a"],"contract":{"campaign":{"x":1}}}}}', "pending"],
  ];
}

/** Each row as v0.1.0 to schema 12 kept it, its JSON as given: no run or campaign of its own. */
function keepOld(store: ControlStore, rows: [SignedCommand | string, string, number?][]): void {
  for (const [i, [c, status, ago]] of rows.entries()) {
    const e = typeof c === "string" ? undefined : c.envelope;
    store.db
      .prepare(
        "insert into command (id, rig, kind, signed, issued_by, issued_at, status, acked_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        e?.id ?? `raw-${i}`,
        e?.rig ?? "rig-a",
        e?.kind ?? "assign_campaign",
        typeof c === "string" ? c : JSON.stringify(c),
        "owner:test",
        e?.issued_at ?? minutes(-50 + i),
        status,
        ago === undefined ? null : minutes(-ago),
      );
  }
}

/** Each row through enqueue, then brought to its status. */
function enqueueAll(store: ControlStore, rows: [SignedCommand | string, string, number?][]): void {
  for (const [c, status, ago] of rows) {
    if (typeof c === "string") continue;
    store.commands.enqueue(c);
    store.db
      .prepare("update command set status = ?, acked_at = ? where id = ?")
      .run(status, ago === undefined ? null : minutes(-ago), c.envelope.id);
  }
}

/** A store at schema 12, as this goal's step 4 left it before the columns. */
function storeAtTwelve(path: string): ControlStore {
  const store = new ControlStore(path);
  store.db.exec(`drop index command_run;
    drop index command_campaign;
    alter table command drop column run;
    alter table command drop column campaign;
    delete from schema_migrations where version >= 13`);
  return store;
}

/** The run and the campaign a command's JSON names, as text, read the way the readers read them. */
function namedInJson(signed: string): { run: string | null; campaign: string | null } {
  let p: { run?: unknown; contract?: { campaign?: unknown } } | undefined;
  try {
    p = (JSON.parse(signed) as { envelope?: { payload?: typeof p } }).envelope?.payload;
  } catch {
    p = undefined;
  }
  return {
    run: typeof p?.run === "string" ? p.run : null,
    campaign: typeof p?.contract?.campaign === "string" ? p.contract.campaign : null,
  };
}

/** The readers as they read each command's JSON before the columns (goal 168, step 4). */
const byJson = {
  latestAssignments(store: ControlStore) {
    const rows = store.db
      .prepare(
        "select id, rig, signed, issued_at from command where kind = 'assign_campaign' and status in ('pending', 'delivered') order by issued_at desc",
      )
      .all() as { id: string; rig: string; signed: string; issued_at: string }[];
    const out = new Map<string, unknown>();
    for (const r of rows) {
      try {
        const payload = (
          JSON.parse(r.signed) as { envelope?: { payload?: Record<string, unknown> } }
        ).envelope?.payload;
        const campaign = (payload?.contract as { campaign?: unknown } | undefined)?.campaign;
        if (payload && typeof campaign === "string" && !out.has(campaign))
          out.set(campaign, {
            id: r.id,
            rig: r.rig,
            run: String(payload.run ?? ""),
            payload,
            issued_at: r.issued_at,
          });
      } catch {}
    }
    return out;
  },
  assignedMcpServers(store: ControlStore, rig: string) {
    const out = new Map<string, unknown>();
    for (const r of store.db
      .prepare(
        "select signed from command where rig = ? and kind = 'assign_campaign' and status not in ('failed', 'rejected', 'expired') order by issued_at",
      )
      .all(rig) as { signed: string }[]) {
      try {
        const p = (
          JSON.parse(r.signed) as {
            envelope?: { payload?: { run?: unknown; mcp_servers?: unknown } };
          }
        ).envelope?.payload;
        const uses = McpUses.safeParse(p?.mcp_servers ?? []).data ?? [];
        if (typeof p?.run === "string" && uses.length) out.set(p.run, uses);
      } catch {}
    }
    return out;
  },
  pendingStarts(store: ControlStore, campaign: string) {
    const now = Date.now();
    const out: { rig: string; run: string; kind: string }[] = [];
    const assigned = new Map<string, Map<string, string>>();
    const since = new Date(now - 10 * 60_000).toISOString();
    for (const r of store.db
      .prepare(
        `select rig, kind, status, signed from command where kind in ('assign_campaign', 'resume_run')
           and (status = 'pending' or (status = 'delivered' and kind = 'assign_campaign' and acked_at > ?))
         order by issued_at`,
      )
      .all(since) as Record<string, string>[]) {
      let env: {
        expires_at?: string;
        payload?: { run?: unknown; contract?: { campaign?: unknown } };
      };
      try {
        env = (JSON.parse(String(r.signed)) as { envelope?: typeof env }).envelope ?? {};
      } catch {
        continue;
      }
      const rig = String(r.rig);
      const run = typeof env.payload?.run === "string" ? env.payload.run : "";
      if (!run) continue;
      if (r.status === "pending" && Date.parse(env.expires_at ?? "") < now) continue;
      if (r.status === "delivered" && store.runRegistry.campaignOf(run, rig) !== undefined)
        continue;
      let of: string | undefined;
      if (r.kind === "assign_campaign") {
        const named = env.payload?.contract?.campaign;
        of = typeof named === "string" ? named : undefined;
      } else {
        if (!assigned.has(rig)) assigned.set(rig, store.runRegistry.assignedCampaigns(rig));
        of = assigned.get(rig)?.get(run) ?? store.runRegistry.campaignOf(run, rig);
      }
      if (of === campaign) out.push({ rig, run, kind: String(r.kind) });
    }
    return out;
  },
};

describe("each command's run and campaign, in columns of their own", () => {
  test("the migration fills them from each command's JSON, on a store at schema 12", () => {
    const path = fresh();
    const twelve = storeAtTwelve(path);
    const rows = commands();
    keepOld(twelve, rows);
    twelve.db.close();

    const store = new ControlStore(path);
    assert.equal(version(store), 16);
    const kept = store.db
      .prepare("select id, signed, run, campaign from command order by issued_at")
      .all() as { id: string; signed: string; run: string | null; campaign: string | null }[];
    assert.equal(kept.length, rows.length);
    for (const r of kept)
      assert.deepEqual({ run: r.run, campaign: r.campaign }, namedInJson(r.signed), r.signed);
    // Every shape is there: text, none, not text, and JSON this store did not write.
    const of = (id: string) => kept.find((r) => r.id === id);
    const first = rows[0]?.[0] as SignedCommand;
    assert.deepEqual(
      [of(first.envelope.id)?.run, of(first.envelope.id)?.campaign],
      ["sort-1", "sort-speed"],
    );
    assert.ok(kept.some((r) => r.run === null && r.signed === "{"));
    const indexes = store.db
      .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'command'")
      .all()
      .map((r) => (r as { name: string }).name);
    assert.ok(
      indexes.includes("command_run") && indexes.includes("command_campaign"),
      `${indexes}`,
    );
    store.db.close();
  });

  test("enqueue writes them, as the migration reads them", () => {
    const store = new ControlStore(":memory:");
    enqueueAll(store, commands());
    const kept = store.db.prepare("select signed, run, campaign from command").all() as {
      signed: string;
      run: string | null;
      campaign: string | null;
    }[];
    assert.ok(kept.length > 20);
    for (const r of kept)
      assert.deepEqual({ run: r.run, campaign: r.campaign }, namedInJson(r.signed), r.signed);
  });

  test("each reader by run or campaign answers as the commands' JSON did", () => {
    const path = fresh();
    const twelve = storeAtTwelve(path);
    // Half kept before the columns, filled by the migration; half through enqueue after it.
    const rows = commands();
    keepOld(twelve, rows.slice(0, 14));
    twelve.db.close();
    const store = new ControlStore(path);
    enqueueAll(store, rows.slice(14));
    // A run of matmul a rig reported, so a delivered assignment of it waits no more.
    store.runRegistry.registerRunCreated("rig-b", "l-1", {
      kind: "run_created",
      subject: "mm-1",
      body: { campaign: "matmul" },
      at: minutes(-1),
    });

    const latest = store.commands.latestAssignments();
    assert.deepEqual(latest, byJson.latestAssignments(store));
    assert.deepEqual([...latest.keys()].sort(), ["blank", "matmul", "numbers", "sort-speed"]);
    for (const rig of ["rig-a", "rig-b", "rig-c"])
      assert.deepEqual(
        store.commands.assignedMcpServers(rig, new Set()),
        byJson.assignedMcpServers(store, rig),
        rig,
      );
    assert.deepEqual([...store.commands.assignedMcpServers("rig-a", new Set()).keys()], ["mm-5"]);
    // A closed run's servers are no longer handed.
    assert.deepEqual([...store.commands.assignedMcpServers("rig-a", new Set(["mm-5"])).keys()], []);
    for (const campaign of ["sort-speed", "matmul", "numbers", "blank", "7", "none"])
      assert.deepEqual(
        store.commands.pendingStarts(campaign),
        byJson.pendingStarts(store, campaign),
        campaign,
      );
    assert.ok(store.commands.pendingStarts("sort-speed").length >= 2);
    store.db.close();
  });
});
