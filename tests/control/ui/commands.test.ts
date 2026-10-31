import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ControlStore } from "../../../src/control/store/index.ts";
import { commandRow, commandStatus } from "../../../src/control/ui/commands/index.ts";
import type { SignedCommand } from "../../../src/core/commands.ts";

const NOW = Date.parse("2026-10-27T06:00:00Z");

describe("a command's status on the Commands page (goal 161)", () => {
  test("a command the owner cancelled shows as cancelled, in a neutral chip", () => {
    const store = new ControlStore(":memory:");
    const signed = {
      envelope: {
        id: "c-1",
        rig: "rig-a",
        kind: "rig_check",
        issued_by: "owner:ui",
        issued_at: "2026-10-27T05:59:00Z",
      },
    } as unknown as SignedCommand;
    store.commands.enqueue(signed);
    assert.equal(store.commands.cancel("c-1", "owner:ui"), true);
    const [listed] = store.commands.list(10);
    assert.ok(listed);
    assert.deepEqual(commandStatus(listed), { word: "cancelled", tone: "" });
    const row = commandRow(listed, NOW);
    assert.match(row, /<span class="chip ">cancelled<\/span>/);
    assert.doesNotMatch(row, /chip bad/);
  });

  test("other statuses keep their tones", () => {
    const of = (status: string, outcome: unknown = {}) => commandStatus({ status, outcome });
    assert.deepEqual(of("delivered"), { word: "delivered", tone: "ok" });
    assert.deepEqual(of("pending"), { word: "pending", tone: "info" });
    assert.deepEqual(of("expired"), { word: "expired", tone: "" });
    assert.deepEqual(of("failed", { error: "no such run" }), { word: "failed", tone: "bad" });
    assert.deepEqual(of("rejected", null), { word: "rejected", tone: "bad" });
  });
});
