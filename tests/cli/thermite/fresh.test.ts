import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceInstead } from "../../../src/cli/thermite/fresh.ts";

/**
 * A checkout's build of the command line older than its source runs the source instead (goal 180).
 * The source itself runs as it is. The build's side needs a build: goal 180 records it, run by
 * hand with `npx thermite` after a source file changed.
 */

test("the source runs as it is: it never hands over to itself", async () => {
  assert.equal(await sourceInstead(), false);
});
