import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ADMIN, controlOnly } from "../../helpers/control-stack.ts";
import { enrollRigs } from "../../helpers/control-store.ts";

/**
 * The public names of v0.1.1 (the guide's questions 11 and 23): control's APIs take only the new
 * names. A command that uses a name from before is refused in words that give the new one, and
 * nothing is signed. Commands signed before read under the new names at the rig (core/names.ts).
 */
describe("old names in a new command (goal 125)", () => {
  test("refused before anything is signed, with the new name", async () => {
    const { store, control } = await controlOnly({ tokens: { rigs: {} } });
    await enrollRigs(store, ["rig-a"]);
    const post = (kind: string, payload: unknown) =>
      control.request("/v1/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ rig: "rig-a", kind, payload }),
      });
    const refused = async (kind: string, payload: unknown, words: string) => {
      const r = await post(kind, payload);
      assert.equal(r.status, 400, kind);
      assert.equal(((await r.json()) as { error: string }).error, `bad ${kind} payload: ${words}`);
    };
    await refused(
      "queue_add",
      { run: "r-1", title: "tile it", family: "tiling" },
      "`family` is now `direction`",
    );
    await refused(
      "queue_edit",
      { run: "r-1", id: "x-000000000001", family: "tiling" },
      "`family` is now `direction`",
    );
    await refused(
      "redirect",
      { run: "r-1", directives: [{ kind: "note", value: "memory first", rationale: "r" }] },
      "the kind `note` is now `planner_note`",
    );
    await refused(
      "redirect",
      { run: "r-1", directives: [{ kind: "try", family: "tiling", rationale: "r" }] },
      "`family` is now `direction`",
    );
    await refused(
      "assign_campaign",
      { run: "r-2", direction: "memory first" },
      "`direction` is now `note`",
    );
    assert.equal((await store.commands.list(10)).length, 0, "nothing was signed");
    // The new names are taken.
    assert.equal(
      (await post("queue_add", { run: "r-1", title: "tile it", direction: "tiling" })).status,
      201,
    );
    assert.equal(
      (
        await post("redirect", {
          run: "r-1",
          directives: [{ kind: "planner_note", value: "memory first", rationale: "r" }],
        })
      ).status,
      201,
    );
  });
});
