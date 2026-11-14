import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { logLevel, startLogging } from "../../../src/common/log.ts";
import { controlLogLevelOf, setControlLogLevel } from "../../../src/control/log-level.ts";
import { openControlStore } from "../../../src/control/store/index.ts";
import { WRITE_FAILED, watched, withWriteFailing } from "../../helpers/together.ts";

/**
 * The transaction of control's own log level (control/log-level.ts): the setting and its entry
 * in the audit log are kept together or dropped together, and a level that was not kept is not
 * applied.
 */

describe("control's own settings", () => {
  test("setControlLogLevel: the setting and its audit entry", async () => {
    startLogging("control", {});
    const store = openControlStore(":memory:");
    const set = () => setControlLogLevel(store, { level: "debug" }, "owner:api");
    const dropped = await withWriteFailing(store, store.auditLog, "add", set);
    assert.equal(dropped.threw?.message, WRITE_FAILED);
    assert.deepEqual(
      dropped.txs.map((t) => [t.failed, t.changed]),
      [[true, []]],
    );
    assert.equal(await store.ownSettings.get("log_level"), undefined, "no setting is kept");
    assert.equal((await controlLogLevelOf(store)).from, "environment");
    assert.deepEqual(await store.auditLog.list(5, { action: "control_log_level_set" }), []);
    assert.equal(logLevel(), "info", "a level that was not kept is not applied");

    const kept = await watched(store, set);
    assert.equal(kept.out?.ok, true);
    assert.deepEqual(
      kept.txs.map((t) => [t.failed, t.changed]),
      [[false, ["audit", "control_setting"]]],
    );
    assert.equal((await store.ownSettings.get("log_level"))?.value, "debug");
    assert.deepEqual(
      (await store.auditLog.list(5, { action: "control_log_level_set" })).map((e) => e.body),
      [{ level: "debug", was: "info" }],
    );
    assert.equal(logLevel(), "debug");
    // The process's level back, for whatever runs after this test.
    startLogging("control", {});
    await store.close();
  });
});
