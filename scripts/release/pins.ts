#!/usr/bin/env node
// The images Thermite pins by digest and does not build (src/release/pins.ts): their update path.
// With no option, it lists each one, its tag and digest and where each copy is, and fails when one
// image is pinned more than one way. With --registry, it also asks each image's registry, with no
// sign-in, which digest its tag has now, and lists the ones whose tag was built again since (a base
// image's tag is rebuilt with its distribution's fixes). With --update, it then writes the new
// digest into every copy of each of those. A maintainer runs it before each release, and a newer
// tag (a new version) stays the maintainer's choice. It reaches the registries, so CI never runs it.
//
//   node --experimental-strip-types scripts/release/pins.ts [--registry [--update]]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  findPins,
  pinnedFiles,
  pinProblems,
  pinsByTag,
  tagDigest,
} from "../../src/release/pins.ts";

const ROOT = join(import.meta.dirname, "..", "..");

const { values } = parseArgs({
  options: { registry: { type: "boolean" }, update: { type: "boolean" } },
});
if (values.update && !values.registry) {
  process.stderr.write("pins: --update needs --registry\n");
  process.exit(1);
}

const pins = findPins(pinnedFiles(ROOT));
const problems = pinProblems(pins);
for (const [tag, copies] of pinsByTag(pins)) {
  const [first] = copies;
  if (!first) continue;
  console.log(`${tag}@${first.digest}`);
  for (const p of copies) console.log(`  ${p.file}:${p.line}`);
}
if (problems.length) {
  for (const p of problems) process.stderr.write(`pins: ${p}\n`);
  process.exit(1);
}
if (!values.registry) process.exit(0);

let moved = 0;
let unchecked = 0;
for (const [tag, copies] of pinsByTag(pins)) {
  const [first] = copies;
  if (!first) continue;
  let now: string;
  try {
    now = await tagDigest(first.image, first.tag);
  } catch (err) {
    unchecked++;
    console.log(`not checked: ${tag}: ${err instanceof Error ? err.message : err}`);
    continue;
  }
  if (now === first.digest) {
    console.log(`up to date: ${tag}`);
    continue;
  }
  moved++;
  console.log(`built again: ${tag} is ${now} now, not ${first.digest}`);
  if (!values.update) continue;
  const to = `${tag}@${now}`;
  for (const file of new Set(copies.map((p) => p.file))) {
    const path = join(ROOT, file);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll(first.ref, to));
    console.log(`  written: ${file}`);
  }
}
console.log(
  `${moved} built again${values.update && moved ? " and written" : ""}, ${unchecked} not checked`,
);
process.exit(unchecked ? 1 : 0);
