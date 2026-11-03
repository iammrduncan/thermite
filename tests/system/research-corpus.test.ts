import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { researchRenders } from "../helpers/research-renders.ts";

/** What the four renderers made of the fixture's research before they shared core/corpus.ts. */
const BEFORE = new URL("../fixtures/research-renders.json", import.meta.url);

test("the research folder, the teachers' reads, the knowledge base and control's view make what they made before they shared one reading of the corpus (goal 125, T11)", async () => {
  const before = JSON.parse(readFileSync(BEFORE, "utf8")) as unknown;
  assert.deepStrictEqual(await researchRenders(), before);
});
