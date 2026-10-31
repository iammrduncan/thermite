import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  inspectSnapshotFolder,
  lookWords,
  SEALED,
} from "../../../../src/harness/broker/snapshot/index.ts";
import { fixture, sealedOf, typicalState } from "./setup.ts";

/**
 * What the snapshot folder on the volume may hold (inspectSnapshotFolder): the sealed manifest,
 * sealed files and empty probe files, and nothing else.
 */

describe("what the snapshot folder may hold (inspectSnapshotFolder)", () => {
  test("only the sealed manifest, sealed files and empty probe files", async () => {
    const f = fixture();
    typicalState(f);
    assert.equal(lookWords(inspectSnapshotFolder(f.dir)), "no snapshot yet");
    await f.take("kept");
    const look = inspectSnapshotFolder(f.dir);
    assert.equal(look.problem, undefined);
    assert.equal(lookWords(look), `the manifest and ${look.files} sealed files`);
    // A user's empty probe file, and a file being sealed (empty, or begun), pass.
    writeFileSync(join(f.dir, "probe-10013"), "");
    writeFileSync(join(f.dir, `.new-${"a".repeat(32)}`), "");
    writeFileSync(
      join(f.dir, `.new-${"b".repeat(32)}`),
      readFileSync(sealedOf(f, "harness/kits/abc/kit.json")).subarray(0, 12),
    );
    assert.equal(inspectSnapshotFolder(f.dir).problem, undefined);
    const fails: [string, string | Buffer, RegExp][] = [
      ["probe-10014", "x", /^a file that is not sealed: probe-10014$/],
      ["a".repeat(64), "the pod's keys in plain text", /^a file that is not sealed: a{64}$/],
      [SEALED.next, '{"entries":[]}', /^a file that is not sealed: manifest\.new$/],
      // A sealed file's bytes under the manifest's name: the kind must match.
      [
        SEALED.next,
        readFileSync(sealedOf(f, "harness/kits/abc/kit.json")),
        /^a file that is not sealed: manifest\.new$/,
      ],
      ["notes.txt", "", /^a name a sealed snapshot never uses: notes\.txt$/],
    ];
    for (const [name, content, why] of fails) {
      writeFileSync(join(f.dir, name), content);
      assert.match(inspectSnapshotFolder(f.dir).problem ?? "", why, name);
      rmSync(join(f.dir, name));
    }
    mkdirSync(join(f.dir, "extra"));
    assert.match(
      inspectSnapshotFolder(f.dir).problem ?? "",
      /^a folder a sealed snapshot never holds: extra$/,
    );
    rmSync(join(f.dir, "extra"), { recursive: true });
    symlinkSync("/etc/hostname", join(f.dir, "b".repeat(64)));
    assert.match(
      inspectSnapshotFolder(f.dir).problem ?? "",
      /^a link or special file a sealed snapshot never holds/,
    );
    rmSync(join(f.dir, "b".repeat(64)));
    // The next take sweeps what it may: the probes' files and files half sealed.
    writeFileSync(join(f.dir, "probe-10015"), "");
    await f.take("again");
    assert.deepEqual(
      readdirSync(f.dir).filter((n) => n.startsWith("probe-") || n.startsWith(".new-")),
      [],
    );
    rmSync(f.root, { recursive: true, force: true });
  });
});
