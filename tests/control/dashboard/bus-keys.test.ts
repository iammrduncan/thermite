import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createUser } from "@nats-io/nkeys";
import { BusUsers } from "../../../src/control/bus/users.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { newSealKey } from "../../../src/core/link/config.ts";
import { userKeyFingerprint } from "../../../src/core/link/users.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * A rig's keys on the message bus on the dashboard: their fingerprints on the rig's page, a change
 * or a refusal under Needs you with no approval to give, which Seen takes off; and the bus's
 * server that keeps not taking control's users file, under Needs you until it does.
 */

const TOKENS = { "rig-a": "rig-a-token-abcdef", "rig-b": "rig-b-token-abcdef" };

async function setup() {
  let now = Date.now();
  let failing = false;
  let users: BusUsers | undefined;
  const s = controlOnly({
    tokens: { rigs: TOKENS },
    options: (store) => {
      users = new BusUsers({
        store,
        secrets: SecretBox.ephemeral(),
        file: join(mkdtempSync(join(tmpdir(), "thermite-bus-keys-")), "users.conf"),
        reload: async () => {
          if (failing) throw new Error("connection refused: nats:4222");
        },
        clock: () => now,
      });
      return { busUsers: users };
    },
  });
  const ui = await signIn(s.control);
  const figures = (rig: keyof typeof TOKENS, busKey: string, sealKey: string) =>
    s.control.request(`/v1/rigs/${rig}/supervisor`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS[rig]}`, "content-type": "application/json" },
      body: JSON.stringify({
        at: new Date().toISOString(),
        bus_key: busKey,
        bus_seal_key: sealKey,
      }),
    });
  for (const rig of Object.keys(TOKENS))
    await ingestReport(s.store, {
      rig,
      ledger_id: `ledger-${rig}`,
      cursor: 0,
      next: 0,
      events: [],
      summary: {},
    });
  return {
    ...s,
    ...ui,
    users: users as BusUsers,
    figures,
    later: (ms: number) => {
      now += ms;
    },
    fail: (v: boolean) => {
      failing = v;
    },
  };
}

describe("a rig's keys on the message bus on the dashboard", () => {
  test("a changed key shows on the rig's page and under Needs you, until Seen; nothing to approve", async () => {
    const s = await setup();
    const [first, second] = [createUser().getPublicKey(), createUser().getPublicKey()];
    const seal = newSealKey().publicKey;
    assert.equal((await s.figures("rig-a", first, seal)).status, 200);
    let rig = await s.page("/ui/rigs/rig-a");
    assert.match(
      rig,
      new RegExp(
        `<dt>Keys on the bus</dt><dd><code>${userKeyFingerprint(first)}</code> its user · <code>[0-9a-f]+</code> its seal key</dd>`,
      ),
    );
    // A first key is no change: nothing waits.
    assert.ok(!(await s.page("/ui")).includes("Key changed"));
    assert.equal((await s.figures("rig-a", second, seal)).status, 200);
    const home = await s.page("/ui");
    assert.match(home, /<span class="dq-kind">.*Key changed<\/span>/);
    assert.match(home, /rig-a's key on the message bus changed/);
    assert.match(
      home,
      /The new key took effect at once, and the old one no longer works\. Nothing waits for your approval/,
    );
    assert.match(
      home,
      new RegExp(
        `Its key on the message bus changed \\(fingerprint ${userKeyFingerprint(first)} → ${userKeyFingerprint(second)}\\)`,
      ),
    );
    assert.match(home, /<button>Seen<\/button>/);
    rig = await s.page("/ui/rigs/rig-a");
    assert.match(rig, /its seal key · <span class="warn">changed [^<]+ ago<\/span>/);
    assert.match(
      rig,
      new RegExp(
        `Its key on the message bus changed: fingerprint ${userKeyFingerprint(first)} → ${userKeyFingerprint(second)}\\.`,
      ),
    );
    // Seen takes the card off; the change stays in the rig's history.
    const csrf = s.csrfOf(home);
    const r = await s.post("/ui/rigs/rig-a/bus-keys/seen", { csrf, back: "/ui" });
    assert.equal(r.headers.get("location"), "/ui");
    assert.ok(!(await s.page("/ui")).includes("Key changed"));
    assert.match(await s.page("/ui/rigs/rig-a"), /Its key on the message bus changed: fingerprint/);
    assert.equal(s.store.auditLog.list(10, { action: "rig_bus_keys_seen" }).length, 1);
    // A key another rig holds: refused, shown as refused.
    assert.equal((await s.figures("rig-b", second, newSealKey().publicKey)).status, 409);
    const refused = await s.page("/ui");
    assert.match(refused, /Key refused/);
    assert.match(refused, /rig-b's new key on the message bus was refused/);
    assert.match(refused, /which rig rig-a holds/);
  });

  test("the bus's server that keeps not reloading its users shows under Needs you until it does", async () => {
    const s = await setup();
    s.fail(true);
    await s.users.sync();
    assert.ok(!(await s.page("/ui")).includes("Bus users"), "one failure: no card yet");
    s.later(61_000);
    await s.users.sync();
    const home = await s.page("/ui");
    assert.match(home, /Bus users/);
    assert.match(home, /The bus's server does not reload its users since/);
    assert.match(home, /<code>connection refused: nats:4222<\/code>/);
    assert.match(
      home,
      /Control goes on trying every 5 seconds\. Nothing waits for your approval\./,
    );
    s.fail(false);
    await s.users.sync();
    assert.ok(!(await s.page("/ui")).includes("Bus users"));
  });
});
