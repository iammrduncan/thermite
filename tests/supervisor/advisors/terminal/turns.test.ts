// The owner's messages inside an advisor's turn (src/supervisor/advisors/terminal/turns.ts): the
// call's turn routes on localhost, as Thermite's hook program and OpenCode plugin ask them, behind
// the call's own credential.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TurnDelivery } from "../../../../src/agents/cli/index.ts";
import { OFFER_PATH, TAKEN_PATH } from "../../../../src/agents/programs/hooks/main.ts";
import { serveAdvisorTurns } from "../../../../src/supervisor/advisors/terminal/index.ts";

test("the call's turn routes: its credential only, its delivery while its terminal runs", async () => {
  const turns = await serveAdvisorTurns();
  try {
    assert.match(turns.auth, /^call\.[0-9a-f]{48}$/);
    const ask = (path: string, body: unknown, auth = turns.auth) =>
      fetch(`${turns.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // Another credential is refused, and so is a place the routes do not know.
    assert.equal((await ask(OFFER_PATH, { at: "after-tool" }, "call.other")).status, 401);
    assert.equal((await ask(OFFER_PATH, { at: "somewhere" })).status, 400);
    // No delivery yet: nothing to offer.
    assert.deepEqual(await (await ask(OFFER_PATH, { at: "turn-end" })).json(), {
      offer: null,
      text: "",
    });
    const taken: string[] = [];
    const d: TurnDelivery = {
      offer: (at) =>
        at === "after-tool" ? { offer: "o-1", text: "the owner's words" } : undefined,
      taken: (offer) => {
        taken.push(offer);
        return [7];
      },
    };
    turns.set(d);
    assert.deepEqual(await (await ask(OFFER_PATH, { at: "after-tool" })).json(), {
      offer: "o-1",
      text: "the owner's words",
    });
    assert.deepEqual(await (await ask(TAKEN_PATH, { offer: "o-1" })).json(), { messages: [7] });
    assert.deepEqual(taken, ["o-1"]);
    // Its terminal ended: nothing more.
    turns.set(undefined);
    assert.deepEqual(await (await ask(TAKEN_PATH, { offer: "o-1" })).json(), { messages: [] });
  } finally {
    await turns.close();
  }
});
