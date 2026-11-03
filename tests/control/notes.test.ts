import assert from "node:assert/strict";
import { test } from "node:test";
import { PageNotes } from "../../src/control/notes.ts";

test("a page's note: its words come back by its ID, with credentials taken out; other values stay as given", () => {
  const notes = new PageNotes();
  const id = notes.put("git said: https://user:s3cr3t-value-0123@host.example/repo not found");
  assert.match(id, /^note-[0-9a-f]{24}$/);
  assert.equal(notes.read(id), "git said: https://***@host.example/repo not found");
  // The dashboard's own words in an address, and no value at all, pass through.
  assert.equal(notes.read("Choose a rig."), "Choose a rig.");
  assert.equal(notes.read(undefined), undefined);
  // An ID control does not keep (gone after its time, or made up) says so in words.
  assert.equal(
    notes.read(`note-${"0".repeat(24)}`),
    "This message is no longer kept: do it again to see why.",
  );
});

test("at most 500 notes are kept: past it, the oldest goes", () => {
  const notes = new PageNotes();
  const first = notes.put("the first");
  for (let i = 0; i < 500; i++) notes.put(`note ${i}`);
  assert.equal(notes.read(first), "This message is no longer kept: do it again to see why.");
});
