import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createUser } from "@nats-io/nkeys";
import { userKeyFingerprint } from "../../../src/core/link/users.ts";
import { controlOnly, RIG_TOKEN } from "../../helpers/control-stack.ts";

/**
 * Goal 206, step 2c: a runner process's supervisor registers its own key on the bus with control,
 * with the rig's token, and control keeps it for the runner's user.
 */

describe("a runner's key on the bus (goal 206)", () => {
  const RIG_B_TOKEN = "rig-b-token-abcdef";
  const setup = () => {
    const s = controlOnly({ tokens: { rigs: { "rig-a": RIG_TOKEN, "rig-b": RIG_B_TOKEN } } });
    const register = (runner: string, key: string, token = RIG_TOKEN, rig = "rig-a") =>
      s.control.request(`/v1/rigs/${rig}/runners/${runner}/supervisor`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ bus_key: key }),
      });
    return { ...s, register };
  };

  test("is kept by rig and runner, in the rig's history by its fingerprint, and again changes nothing", async () => {
    const s = setup();
    const key = createUser().getPublicKey();
    assert.equal((await s.register("spark-02", key)).status, 200);
    assert.equal(s.store.busKeys.runnerKey("rig-a", "spark-02"), key);
    assert.deepEqual(s.store.busKeys.runnerKeys(), [{ rig: "rig-a", runner: "spark-02", key }]);
    assert.equal((await s.register("spark-02", key)).status, 200);
    const steps = s.store.rigHistory
      .list("rig-a")
      .filter((h) => h.step === "runner_bus_key")
      .map((h) => h.detail);
    assert.deepEqual(steps, [`spark-02: ${userKeyFingerprint(key)}`]);
  });

  test("a key another holds, a bad key or name, or another rig's token is refused", async () => {
    const s = setup();
    const key = createUser().getPublicKey();
    assert.equal((await s.register("spark-02", key)).status, 200);
    // The same key for another runner, or the rig's own key, is held already.
    assert.equal((await s.register("spark-03", key)).status, 409);
    assert.equal((await s.register("spark-04", "not a key")).status, 400);
    assert.equal((await s.register("Spark_04", createUser().getPublicKey())).status, 400);
    // Rig b's token is not rig a's.
    const other = await s.register("spark-05", createUser().getPublicKey(), RIG_B_TOKEN);
    assert.equal(other.status, 401);
    assert.equal(s.store.busKeys.runnerKey("rig-a", "spark-05"), undefined);
  });
});
