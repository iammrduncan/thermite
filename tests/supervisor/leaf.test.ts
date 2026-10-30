import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fromSeed } from "@nats-io/nkeys";
import { makeCa } from "../../src/control/bus/cert.ts";
import { mintLeaf } from "../../src/control/bus/leaf.ts";
import { LEAF_ENV, LEAF_JS_API, POD_BUS_URL } from "../../src/core/link/leaf.ts";
import {
  leafValues,
  POD_BUS_PROGRAM,
  startPodBus,
  writePodBus,
} from "../../src/supervisor/leaf.ts";
import { BUS_KEY_FILE } from "../../src/supervisor/relay/index.ts";

/** A launch's leaf values, as control mints them. */
const launch = () => mintLeaf("rp-1", makeCa(new Date(), 30).cert).env;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for the pod's server: it notes each start (its arguments and environment) in
 * `starts`, and stays up until it is stopped, or exits at once when `exit` is there.
 */
function standIn(dir: string): {
  program: string;
  starts: () => { argv: string[]; env: object }[];
} {
  const log = join(dir, "starts.jsonl");
  const program = join(dir, "nats-server");
  writeFileSync(
    program,
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + "\\n");
if (fs.existsSync(${JSON.stringify(join(dir, "exit"))})) process.exit(3);
process.stderr.write("[1] [INF] Server is ready\\n");
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`,
  );
  chmodSync(program, 0o755);
  return {
    program,
    starts: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
        : [],
  };
}

describe("the pod's own bus server, as its supervisor runs it", () => {
  test("the leaf's launch values: all three or none; one alone, or one that is no PEM text, stops the supervisor", () => {
    assert.equal(leafValues({}), undefined);
    const env = launch();
    const values = leafValues(env);
    assert.equal(
      createPrivateKey(values?.key ?? "").asymmetricKeyType,
      "ec",
      "the pod's key opens",
    );
    assert.throws(
      () => leafValues({ [LEAF_ENV.cert]: env[LEAF_ENV.cert] }),
      /the leaf node needs THERMITE_LEAF_CERT, THERMITE_LEAF_KEY, THERMITE_LEAF_CONTROL_CA; the launch gave only THERMITE_LEAF_CERT/,
    );
    assert.throws(
      () => leafValues({ ...env, [LEAF_ENV.key]: "bm9wZQ==" }),
      /THERMITE_LEAF_KEY is not a PEM text/,
    );
  });

  test("its files: the key the supervisor's alone, in a folder only it opens, and a configuration that lets in the rig's key", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "thermite-podbus-")), "bus");
    const values = leafValues(launch());
    assert.ok(values);
    const written = writePodBus(dir, values, "UKEY");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "leaf-key.pem")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(dir, "leaf-key.pem"), "utf8"), values.key);
    assert.equal(readFileSync(written.cert, "utf8"), values.cert);
    assert.equal(readFileSync(join(dir, "control-ca.pem"), "utf8"), values.controlCa);
    const config = readFileSync(written.config, "utf8");
    assert.match(config, /"nkey": "UKEY"/);
    assert.match(config, new RegExp(`"ca_file": "${join(dir, "control-ca.pem")}"`));
  });

  test("started from the launch values, with nothing of the supervisor's environment, the pod's key gone from it; started again after it exits; stopped with the supervisor", async () => {
    const home = mkdtempSync(join(tmpdir(), "thermite-podbus-"));
    const fake = standIn(home);
    const env: NodeJS.ProcessEnv = { ...launch(), THERMITE_TUNNEL_DIR: join(home, "tunnel") };
    const bus = startPodBus(env, home, { program: fake.program, restartMs: 50 });
    assert.ok(bus);
    try {
      assert.equal(bus.url, POD_BUS_URL);
      assert.equal(bus.apiPrefix, LEAF_JS_API);
      assert.deepEqual(bus.trust, { caFile: join(home, "tunnel", "bus", "leaf-cert.pem") });
      assert.equal(env[LEAF_ENV.key], undefined, "nothing the supervisor starts has the pod's key");
      // The rig's key, made in its home, is the one the server lets in.
      const seed = readFileSync(join(home, BUS_KEY_FILE), "utf8").trim();
      const config = readFileSync(join(home, "tunnel", "bus", "server.conf"), "utf8");
      assert.match(config, new RegExp(fromSeed(new TextEncoder().encode(seed)).getPublicKey()));
      for (let i = 0; i < 50 && !fake.starts().length; i++) await sleep(20);
      const [first] = fake.starts();
      assert.deepEqual(first?.argv, ["-c", join(home, "tunnel", "bus", "server.conf")]);
      assert.ok(
        !Object.keys(first?.env ?? {}).some((k) => k.startsWith("THERMITE_")),
        "no setting of the supervisor's reaches it",
      );
      // It exits: it starts again.
      writeFileSync(join(home, "exit"), "");
      const pid = (await import("node:child_process")).execFileSync("pgrep", ["-f", fake.program], {
        encoding: "utf8",
      });
      process.kill(Number(pid.trim().split("\n")[0]), "SIGKILL");
      for (let i = 0; i < 100 && fake.starts().length < 3; i++) await sleep(20);
      assert.ok(fake.starts().length >= 3, `started again: ${fake.starts().length} starts`);
    } finally {
      await bus.stop();
    }
    const n = fake.starts().length;
    await sleep(200);
    assert.equal(fake.starts().length, n, "stopped: never started again");
  });

  test("without the leaf's values there is no pod server, and nothing is written", () => {
    const home = mkdtempSync(join(tmpdir(), "thermite-podbus-"));
    assert.equal(startPodBus({ THERMITE_TUNNEL_DIR: join(home, "tunnel") }, home), undefined);
    assert.ok(!existsSync(join(home, "tunnel")));
  });

  test("the rig image copies the server's program from the image compose.yaml pins, by its digest, to where the supervisor runs it", () => {
    const compose = readFileSync("compose.yaml", "utf8");
    const pinned = /\n {2}nats:\n {4}image: (\S+@sha256:[0-9a-f]{64})/.exec(compose)?.[1];
    assert.ok(pinned, "compose.yaml pins the bus's server by digest");
    const rig = readFileSync("containers/rig/Containerfile", "utf8");
    assert.match(
      rig,
      new RegExp(
        `COPY --from=${pinned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\\\\\n\\s+/usr/local/bin/nats-server ${POD_BUS_PROGRAM}\\n`,
      ),
    );
    assert.match(rig, /^EXPOSE 8790 7422$/m);
  });
});
