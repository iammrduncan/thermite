import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { copiesOf } from "../../../src/common/db-copy.ts";
import { rowsBehind, sqliteBehind } from "../../../src/control/store/behind.ts";
import { openControlStore, STORE_VERSION } from "../../../src/control/store/index.ts";
import { withEventsTable } from "../../helpers/old-store.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "thermite-store-")), "control.db");

describe("the message bus's keys in control's store", () => {
  test("a store at version 6 is copied, then gets the keys' tables (goal 168)", async () => {
    const path = fresh();
    const six = openControlStore(path);
    // As version 6 left it: its events table, no keys' tables.
    withEventsTable(sqliteBehind(six).db, 6);
    sqliteBehind(six).db.exec("drop table rig_bus_key; drop table bus_identity");
    await six.close();
    const store = openControlStore(path);
    const v = (await rowsBehind(store, "select max(version) as v from schema_migrations"))[0];
    assert.equal(v?.v, STORE_VERSION);
    assert.deepEqual(await store.busKeys.rigKeys(), []);
    await store.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [6],
    );
  });

  test("a store at version 8 gets the seal key beside each rig's key, kept as it was", async () => {
    const path = fresh();
    const eight = openControlStore(path);
    await eight.busKeys.setRigKey("rig-a", "UA");
    sqliteBehind(eight).db.exec("alter table rig_bus_key drop column seal_key");
    sqliteBehind(eight).db.exec("delete from schema_migrations where version >= 9");
    await eight.close();
    const store = openControlStore(path);
    assert.deepEqual(await store.busKeys.rigKeys(), [
      { rig: "rig-a", key: "UA", sealKey: undefined },
    ]);
    await store.busKeys.setRigSealKey("rig-a", "SA");
    assert.equal(await store.busKeys.rigSealKey("rig-a"), "SA");
    await store.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [8],
    );
  });

  test("a rig's key is replaced by its next; control's own are kept as first made", async () => {
    const store = openControlStore(":memory:");
    assert.equal(await store.busKeys.rigKey("rig-a"), undefined);
    await store.busKeys.setRigKey("rig-b", "UB");
    await store.busKeys.setRigKey("rig-a", "UA1");
    await store.busKeys.setRigKey("rig-a", "UA2");
    assert.equal(await store.busKeys.rigKey("rig-a"), "UA2");
    assert.deepEqual(await store.busKeys.rigKeys(), [
      { rig: "rig-a", key: "UA2", sealKey: undefined },
      { rig: "rig-b", key: "UB", sealKey: undefined },
    ]);
    // A seal key is kept beside a rig's key, and replaced by its next; none without a rig's key.
    await store.busKeys.setRigSealKey("rig-a", "SA1");
    await store.busKeys.setRigSealKey("rig-a", "SA2");
    await store.busKeys.setRigSealKey("rig-c", "SC");
    assert.equal(await store.busKeys.rigSealKey("rig-a"), "SA2");
    assert.equal(await store.busKeys.rigSealKey("rig-b"), undefined);
    assert.equal(await store.busKeys.rigSealKey("rig-c"), undefined);
    assert.equal((await store.busKeys.rigKeys())[0]?.sealKey, "SA2");
    await store.busKeys.addIdentity("control", "UC1", "s1:first");
    await store.busKeys.addIdentity("control", "UC2", "s1:second");
    assert.deepEqual(await store.busKeys.identity("control"), {
      publicKey: "UC1",
      sealedSeed: "s1:first",
    });
    assert.equal(await store.busKeys.identity("system"), undefined);
  });
});
