import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sendCommandsOn } from "../../../src/control/issue/index.ts";
import { advanceResets } from "../../../src/control/lifecycle.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { commandSubject } from "../../../src/core/link/commands.ts";
import { applied, busOf, controlStore, enrollRigs } from "../../helpers/control-store.ts";
import { DROPPED, rowsOf, seen, withWriteFailing } from "../../helpers/together.ts";

/**
 * A command issued inside a transaction, with control's commands on the message bus: the command
 * is one of the transaction's changes, so a transaction that is dropped sends the rig nothing.
 * The other tests of this folder run with no bus for commands, and read the store alone.
 */

describe("a command issued inside a transaction, with commands on the bus", () => {
  test("advanceResets, a step's move: a wipe whose transaction was dropped is not sent to the rig", async () => {
    const store = controlStore();
    const { bus } = busOf(store);
    await applied(store);
    await sendCommandsOn(store, bus);
    await enrollRigs(store, ["rig-a"]);
    const id = await store.fullResets.create("rig-a", "owner:api");
    await store.fullResets.update(id, {
      state: "confirmed",
      export_name: "export-1",
      through_event: 5,
    });
    const { privateKeyPem } = generateSigningKeys();
    // The reset's move to wiping fails after its command was issued.
    const dropped = await withWriteFailing(
      store,
      store.fullResets,
      "update",
      () => advanceResets({ store, privateKeyPem, driver: undefined, staleAfterMs: 180_000 }),
      (_id, fields) => (fields as { state: string }).state === "wiping",
    );
    assert.deepEqual(seen(dropped).slice(0, 1), DROPPED);
    assert.deepEqual(rowsOf(store, "command"), [], "control's store has no command");
    // The publish waits its turn for the bus: give it the time to be made.
    await new Promise((r) => setTimeout(r, 50));
    const sent = bus.kept
      .filter((m) => m.subject === commandSubject("rig-a"))
      .map((m) => (JSON.parse(String(m.data)) as { envelope: { kind: string } }).envelope.kind);
    assert.deepEqual(sent, [], "no command of the dropped transaction is on the rig's subject");
  });
});
