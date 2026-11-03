import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { REGISTER } from "../../src/core/api/control/rigs.ts";
import { gitAccessFrom, RigConfig } from "../../src/supervisor/config/index.ts";
import { REGISTER_AGAIN_MS, registerKeys } from "../../src/supervisor/register.ts";

/**
 * The supervisor's one call to control over HTTPS, the registration of its keys on the bus, tried
 * again until control has them; and a Git access, which comes in the rig's config on the bus.
 */

describe("the registration of the rig's keys", () => {
  test("its first try returns; a failed one is tried again until control has the keys", async () => {
    assert.equal(REGISTER_AGAIN_MS, 30_000);
    const bodies: unknown[] = [];
    let fails = 2;
    let stopping = false;
    const answers: unknown[] = [];
    const control = {
      call: (async (route: unknown, o: { body: unknown }) => {
        assert.equal(route, REGISTER);
        bodies.push(o.body);
        if (fails-- > 0) throw new Error("control -> 503: control is starting");
        return { ok: true, reports: { ledger_id: null, cursor: 0 } };
      }) as never,
    };
    await registerKeys({
      control,
      body: () => ({ at: "now", bus_key: "U".repeat(56), bus_seal_key: "k".repeat(44) }),
      stopping: () => stopping,
      answered: (a) => answers.push(a),
      againMs: 10,
    });
    assert.equal(bodies.length, 1, "it returns after the first try");
    for (let i = 0; i < 300 && answers.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(bodies.length, 3);
    assert.deepEqual(answers, [{ ok: true, reports: { ledger_id: null, cursor: 0 } }]);
    stopping = true;
  });
});

describe("a Git access from the rig's config on the bus", () => {
  test("waits for the access its assignment names, and says why when it does not come", async () => {
    const known = new RigConfig();
    const later = gitAccessFrom(known, "deploy", 2_000);
    known.set("git-access", "r-1", {
      accesses: [{ name: "deploy", kind: "ssh", host: "git.example.com", private_key: "KEY" }],
    });
    assert.deepEqual(await later, {
      auth: { kind: "ssh", privateKey: "KEY" },
      host: "git.example.com",
    });
    await assert.rejects(
      gitAccessFrom(known, "other", 0),
      /Git access other: control gave this rig none in its config on the message bus/,
    );
  });
});
