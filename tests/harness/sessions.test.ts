import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { PI_SESSION_LOG, writeSessionLog } from "../../src/agents/session-log.ts";
import { GIB } from "../../src/common/disk.ts";
import { RetentionRemoved } from "../../src/core/retention/index.ts";
import { DiskWatch } from "../../src/harness/disk.ts";
import { spaceOf } from "../../src/harness/retention.ts";
import {
  cliSessionFiles,
  keepSession,
  removeSessions,
  sessionItems,
  sessionsDir,
} from "../../src/harness/sessions.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

/**
 * Each trial's session log, kept on the rig when the trial ends (harness/sessions.ts; the owner's
 * decision of 2026-11-01): the program's own log copied out of the trial's area, by run and
 * trial, where no agent writes; not at the disk floor; reported to control with its run, time
 * and bytes; and removed by a retention policy of that kind, runs still open kept.
 */

const TRIAL = "t-0123456789abcdef";
const OTHER = "t-fedcba9876543210";

function area() {
  const dir = mkdtempSync(join(tmpdir(), "thermite-trial-area-"));
  const put = (rel: string, text: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
    return join(dir, rel);
  };
  return { dir, put };
}

describe("the trials' session logs", () => {
  test("a command-line program's own log: its output or its terminal's copy, its signals, Codex's rollouts", () => {
    const a = area();
    a.put("codex-events.jsonl", '{"type":"turn"}\n');
    a.put("codex-signals.jsonl", '{"hook":"stop"}\n');
    a.put("codex-home/.codex/sessions/2026/11/01/rollout-1-abc.jsonl", '{"rollout":1}\n');
    a.put("codex-home/.codex/config.toml", "model = 'm'\n");
    const files = cliSessionFiles(a.dir, join(a.dir, "codex-home"), "codex");
    const env = makeHarnessEnv();
    const state = env.service.paths.stateDir;
    const kept = keepSession({ stateDir: state }, "smoke-1", TRIAL, files);
    assert.deepEqual(kept, { kept: 3, bytes: 16 + 16 + 14 });
    const dir = join(sessionsDir(state), "smoke-1", TRIAL);
    assert.equal(readFileSync(join(dir, "codex-events.jsonl"), "utf8"), '{"type":"turn"}\n');
    assert.ok(existsSync(join(dir, "codex-home-rollout-1-abc.jsonl")));
    assert.ok(
      !existsSync(join(dir, "codex-session.jsonl")),
      "a file the program did not write is left out",
    );
    assert.equal(statSync(join(dir, "codex-events.jsonl")).mode & 0o777, 0o640);
    assert.equal(statSync(dir).mode & 0o002, 0, "no other user may write there");
    // A program that left nothing, or a name that is not a run's or a trial's: nothing kept.
    assert.deepEqual(keepSession({ stateDir: state }, "smoke-1", OTHER, []), {
      skipped: "its program left no session log",
    });
    assert.match(
      String(
        (keepSession({ stateDir: state }, "../x", TRIAL, files) as { skipped: string }).skipped,
      ),
      /not a run's and a trial's name/,
    );
  });

  test("at the rig's disk floor a log is not kept, and why is said", () => {
    const env = makeHarnessEnv();
    const state = env.service.paths.stateDir;
    const disk = new DiskWatch({
      ledger: env.service.ledger,
      places: [{ name: "state", path: state }],
      floorGib: 1,
      free: () => ({ free: GIB + 10, total: 100 * GIB }),
    });
    const a = area();
    const log = a.put("claude-events.jsonl", "x".repeat(100));
    const r = keepSession({ stateDir: state, disk }, "smoke-1", TRIAL, [
      { name: "claude-events.jsonl", path: log },
    ]);
    assert.match(String((r as { skipped: string }).skipped), /floor of 1 GiB: it is not copied/);
    assert.ok(!existsSync(join(sessionsDir(state), "smoke-1", TRIAL)));
  });

  test("a Pi agent's conversation, each message as it ends, one line", () => {
    const a = area();
    const handlers: ((e: unknown) => void)[] = [];
    const agent = { subscribe: (h: (e: unknown) => void) => handlers.push(h) };
    writeSessionLog(agent as never, join(a.dir, PI_SESSION_LOG));
    for (const h of handlers) {
      h({ type: "message_start", message: { role: "assistant" } });
      h({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      });
      h({ type: "message_end", message: { role: "toolResult", content: "ok" } });
    }
    const lines = readFileSync(join(a.dir, PI_SESSION_LOG), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0] as string).message.role, "assistant");
  });

  test("reported with their run, time and bytes, and removed by a policy, runs still open kept", async () => {
    const env = makeHarnessEnv();
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const state = env.service.paths.stateDir;
    const a = area();
    const log = a.put("opencode-events.jsonl", "y".repeat(400));
    keepSession({ stateDir: state }, "smoke-1", TRIAL, [
      { name: "opencode-events.jsonl", path: log },
    ]);
    keepSession({ stateDir: state }, "old-run", OTHER, [
      { name: "opencode-events.jsonl", path: log },
    ]);
    const items = sessionItems(state, new Set(["smoke-1"]));
    assert.deepEqual(items.map((x) => [x.id, x.run, x.open, x.bytes]).sort(), [
      [`old-run/${OTHER}`, "old-run", false, 400],
      [`smoke-1/${TRIAL}`, "smoke-1", true, 400],
    ]);
    const space = await spaceOf(env.service.ledger, state);
    assert.equal(space.trial_logs.items.length, 2);
    assert.equal(space.trial_logs.bytes, 800);

    const run = (keep: boolean) =>
      env.service.applyCommand(
        env.sign("retention_run", {
          policy: 4,
          name: "Old logs",
          rule: { kind: "trial_logs", rule: "older", older_n: 1, keep: { open: keep } },
          by: "schedule",
        }),
      );
    // Kept just now: inside an "older than 1 day" rule. Made older, they go, but the open run's.
    const old = new Date(Date.now() - 3 * 86_400_000);
    const { utimesSync } = await import("node:fs");
    for (const id of [`old-run/${OTHER}`, `smoke-1/${TRIAL}`])
      utimesSync(join(sessionsDir(state), id, "opencode-events.jsonl"), old, old);
    await run(true);
    assert.ok(existsSync(join(sessionsDir(state), "smoke-1", TRIAL)), "its run is still open");
    assert.ok(!existsSync(join(sessionsDir(state), "old-run")), "removed, and its run's folder");
    const [e] = env.service.ledger.events
      .list("retention_removed")
      .map((x) => RetentionRemoved.parse(x.body));
    assert.deepEqual([e?.kind, e?.count, e?.bytes, e?.by], ["trial_logs", 1, 400, "schedule"]);
    await run(false);
    assert.ok(!existsSync(join(sessionsDir(state), "smoke-1")));
    assert.equal(removeSessions(state, ["../../etc"]), 0, "never outside the kept logs");
  });
});
