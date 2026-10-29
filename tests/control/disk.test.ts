import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GIB } from "../../src/common/disk.ts";
import { ControlDisk, controlDiskOf } from "../../src/control/disk.ts";
import { AssignmentHeld } from "../../src/control/issue/index.ts";
import { controlOnly, signIn } from "../helpers/control-stack.ts";

/**
 * Control's disk floor (goal 173), with a full disk standing in for its state folder and the bus's
 * store: at the floor, control holds new runs with the reason the owner reads, says so under Needs
 * you, in its health (degraded, still 200) and in /metrics, and drops nothing; it lets go once each
 * place has 1 GiB more than the floor.
 */

/** A disk that frees what the test says: its state folder's free space, and the bus's store's use. */
function standIn() {
  const at = { stateFree: 40 * GIB, storeUsed: 2 * GIB, storeLimit: 10 * GIB, storeAway: false };
  return {
    at,
    free: () => ({ free: at.stateFree, total: 100 * GIB }),
    busStore: async () => {
      if (at.storeAway) throw new Error("the bus's server can't be reached");
      return { used: at.storeUsed, limit: at.storeLimit };
    },
  };
}

describe("control's disk floor (goal 173)", () => {
  test("at the floor new runs wait, with the reason, and nothing else does", async () => {
    const { store, api, control } = controlOnly();
    const disk = standIn();
    const watch = new ControlDisk({
      store,
      stateDir: "/var/lib/thermite-control",
      floorGib: 5,
      ...disk,
    });
    assert.equal(controlDiskOf(store), watch);
    let state = await watch.check();
    assert.equal(state.low, false);
    assert.deepEqual(state.places, [
      { name: "state", free_gib: 40, total_gib: 100 },
      { name: "bus store", free_gib: 8, total_gib: 10 },
    ]);
    let health = await api("GET", "/v1/health");
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { degraded: boolean }).degraded, false);

    // The bus's store fills: 0.5 GiB left of its 10.
    disk.at.storeUsed = 9.5 * GIB;
    state = await watch.check();
    assert.equal(state.low, true);
    assert.ok(state.since);
    const why =
      "Control's disk is at its floor of 5 GiB: the bus's store has 0.5 GiB left of its 10 GiB. No new run starts until there is room: free space there, or raise the bus's store (THERMITE_NATS_STORE). Reports, commands and the runs under way go on.";
    assert.equal(watch.held, why);
    assert.equal(store.auditLog.list(5, { action: "disk_" })[0]?.action, "disk_low");

    // A new run is refused, as a conflict, in those words; a command that starts none goes on.
    const assign = await api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: {},
    });
    assert.equal(assign.status, 409);
    assert.deepEqual(await assign.json(), { error: why });
    assert.ok(new AssignmentHeld(why) instanceof Error);
    const other = await api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "pause_run",
      payload: {},
    });
    assert.notEqual(other.status, 409);

    // Its health says so, degraded and not down; /metrics gives both places.
    health = await api("GET", "/v1/health");
    assert.equal(health.status, 200);
    const body = (await health.json()) as {
      ok: boolean;
      degraded: boolean;
      disk: { low: boolean };
    };
    assert.equal(body.ok, true);
    assert.equal(body.degraded, true);
    assert.equal(body.disk.low, true);
    const metrics = await (await api("GET", "/metrics")).text();
    assert.match(metrics, /thermite_control_disk_free_bytes\{place="state"\} 42949672960\n/);
    assert.match(metrics, /thermite_control_disk_free_bytes\{place="bus store"\} 536870912\n/);
    assert.match(metrics, /thermite_control_disk_floor_bytes 5368709120\n/);
    assert.match(metrics, /thermite_control_disk_low 1\n/);

    // Needs you: what is full, and what to do.
    const ui = await signIn(control);
    const page = await ui.page("/ui");
    assert.match(page, /Control holds new runs: its disk is at its floor/);
    assert.match(page, /the bus's store has 0\.5 GiB left of its 10 GiB/);
    assert.match(page, /THERMITE_DISK_FLOOR_GIB sets the floor/);
  });

  test("it lets go only with 1 GiB more than the floor, and keeps its state on no reading", async () => {
    const { store } = controlOnly();
    const disk = standIn();
    const watch = new ControlDisk({ store, stateDir: "/s", floorGib: 5, ...disk });
    disk.at.stateFree = 4 * GIB;
    assert.equal((await watch.check()).low, true);
    assert.match(watch.held ?? "", /its state folder has 4 GiB free/);
    // Above the floor, but by less than 1 GiB: still held.
    disk.at.stateFree = 5.5 * GIB;
    assert.equal((await watch.check()).low, true);
    // The bus's store can't be read: held still, and said.
    disk.at.stateFree = 50 * GIB;
    disk.at.storeAway = true;
    const away = await watch.check();
    assert.equal(away.low, true);
    assert.deepEqual(away.unread, [
      { name: "bus store", error: "the bus's server can't be reached" },
    ]);
    disk.at.storeAway = false;
    assert.equal((await watch.check()).low, false);
    assert.equal(watch.held, undefined);
    assert.deepEqual(
      store.auditLog.list(5, { action: "disk_" }).map((e) => e.action),
      ["disk_room", "disk_low"],
    );
    // A floor of 0: none.
    const none = new ControlDisk({
      store,
      stateDir: "/s",
      floorGib: 0,
      free: () => ({ free: 0, total: 1 }),
    });
    assert.equal((await none.check()).low, false);
  });
});
