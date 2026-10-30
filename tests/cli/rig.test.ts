import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { type Enrolled, writeRigFiles } from "../../src/cli/rig.ts";
import { fingerprint } from "../../src/control/store/index.ts";
import { controlOnly } from "../helpers/control-stack.ts";
import { ingestReport } from "../helpers/control-store.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../src/cli/thermite/main.ts");
/** Control's tokens: the owner's, as the token files below hold it, and no rigs. */
const TOKENS = { admin: "owner-token-abcdef", rigs: {} };

describe("thermite rig", () => {
  test("add enrolls a rig and writes its files; token replaces its token; retire shuts it out", async () => {
    const { keys, store, control: api } = controlOnly({ tokens: TOKENS });
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "thermite-rig-"));
      const ownerFile = join(dir, "owner-token");
      writeFileSync(ownerFile, "owner-token-abcdef\n", { mode: 0o600 });
      const cli = (...args: string[]) =>
        run(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args]);
      const out = join(dir, "rig-gpu-1");
      const added = await cli(
        "rig",
        "add",
        "gpu-1",
        "--control",
        control,
        "--token-file",
        ownerFile,
        "--out",
        out,
      );
      assert.match(added.stdout, new RegExp(`fingerprint ${fingerprint(keys.publicKeyPem)}`));
      const token = readFileSync(join(out, "secrets/control-rig-token"), "utf8").trim();
      // The token is only in its file, never printed.
      assert.ok(!added.stdout.includes(token));
      assert.equal(statSync(join(out, "secrets/control-rig-token")).mode & 0o777, 0o600);
      assert.equal(statSync(join(out, "secrets/harness-supervisor-token")).mode & 0o777, 0o600);
      assert.equal(
        readFileSync(join(out, "keys/control-signing.pub"), "utf8").trim(),
        keys.publicKeyPem.trim(),
      );
      assert.match(
        readFileSync(join(out, "rig.env"), "utf8"),
        /^THERMITE_RIG_ID=gpu-1\nCONTROL_URL=http/,
      );
      assert.ok(store.enrollments.tokenMatches("gpu-1", token));
      // A second add into the same directory is refused before control is asked.
      await assert.rejects(
        cli("rig", "add", "gpu-2", "--control", control, "--token-file", ownerFile, "--out", out),
        /not empty/,
      );
      assert.equal(store.enrollments.rig("gpu-2"), undefined);
      const newFile = join(dir, "gpu-1.token");
      await cli(
        "rig",
        "token",
        "gpu-1",
        "--control",
        control,
        "--token-file",
        ownerFile,
        "--out",
        newFile,
      );
      const rotated = readFileSync(newFile, "utf8").trim();
      assert.ok(!store.enrollments.tokenMatches("gpu-1", token));
      assert.ok(store.enrollments.tokenMatches("gpu-1", rotated));
      await cli("rig", "retire", "gpu-1", "--control", control, "--token-file", ownerFile);
      assert.ok(!store.enrollments.tokenMatches("gpu-1", rotated));
    } finally {
      server.close();
    }
  });

  test("add: the rig's files name the message bus and hold control's authority; without the bus, none", async () => {
    const bus = { url: "nats://control.example.com:4222", ca: "-----BEGIN CERTIFICATE-----\nca\n" };
    const { api } = controlOnly({ tokens: TOKENS, options: { rigBus: bus } });
    const r = await api("POST", "/v1/rigs", { rig: "gpu-2" });
    assert.equal(r.status, 201);
    const enrolled = (await r.json()) as Enrolled;
    assert.deepEqual(enrolled.bus, bus);
    const out = join(mkdtempSync(join(tmpdir(), "thermite-rig-bus-")), "rig");
    const files = writeRigFiles(out, enrolled, "https://control.example.com");
    assert.ok(files.includes("keys/bus-ca.pem"));
    assert.equal(readFileSync(join(out, "keys/bus-ca.pem"), "utf8"), bus.ca);
    assert.equal(
      readFileSync(join(out, "rig.env"), "utf8"),
      "THERMITE_RIG_ID=gpu-2\nCONTROL_URL=https://control.example.com\nTHERMITE_NATS_URL=nats://control.example.com:4222\n",
    );
    assert.match(readFileSync(join(out, "README.txt"), "utf8"), /THERMITE_NATS_CA_FILE/);
    // Without an address for rigs on control's bus: no bus in the answer, and no files at all, in
    // words, since a rig works only on the bus.
    const off = controlOnly({ tokens: TOKENS, options: { rigBus: undefined } });
    const plain = (await (await off.api("POST", "/v1/rigs", { rig: "gpu-3" })).json()) as Enrolled;
    assert.equal(plain.bus, null);
    const out2 = join(mkdtempSync(join(tmpdir(), "thermite-rig-bus-")), "rig");
    assert.throws(
      () => writeRigFiles(out2, plain, "https://control.example.com"),
      /control enrolled gpu-3 but has no address for rigs on its message bus .*retire this rig \(thermite rig retire gpu-3\)/,
    );
    assert.equal(existsSync(out2), false, "nothing written");
  });

  test("list shows each rig's state and versions against control's, with what to do", async () => {
    const { store, control: api } = controlOnly({
      tokens: TOKENS,
      options: {
        build: { version: "0.2.0", commit: "1a2b3c4d5e6f7a8b", protocol: 2, oldest_protocol: 1 },
      },
    });
    // rig-old reports from an older, compatible build; rig-new never reported; rig-x is refused.
    const report = { cursor: 0, next: 0, events: [], summary: {}, ledger_id: "l1" };
    await ingestReport(store, {
      rig: "rig-old",
      ...report,
      generated_at: new Date().toISOString(),
    });
    const old = { version: "0.1.0", commit: "abcdef0123456789", protocol: 1, oldest_protocol: 1 };
    store.builds.setRig("rig-old", "harness", old);
    store.builds.setRig("rig-old", "supervisor", old);
    store.enrollments.enroll("rig-new", "0".repeat(64), "owner:test");
    store.builds.setRig("rig-x", "supervisor", { ...old, protocol: 0, oldest_protocol: 0 });
    store.refusals.set(
      "rig-x",
      "Control cannot work with this rig: its supervisor speaks protocol 0.",
    );
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "thermite-rig-"));
      const ownerFile = join(dir, "owner-token");
      writeFileSync(ownerFile, "owner-token-abcdef\n", { mode: 0o600 });
      const cli = (...args: string[]) =>
        run(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args]);
      const { stdout } = await cli("rig", "list", "--control", control, "--token-file", ownerFile);
      const lines = stdout.split("\n");
      assert.equal(lines[0], "control 0.2.0 (1a2b3c4d5e6f), protocol 2 (works with 1 to 2)");
      assert.match(lines[1] ?? "", /^RIG\s+STATE\s+LAST REPORT\s+VERSION\s+HARNESS\s+SUPERVISOR$/);
      assert.match(
        lines[2] ?? "",
        /^rig-old\s+reporting\s+\S+\s+behind\s+0\.1\.0 \(abcdef012345\)\s+0\.1\.0 \(abcdef012345\)$/,
      );
      assert.equal(
        lines[3],
        "  This rig runs an older Thermite than control: harness 0.1.0, supervisor 0.1.0. Control runs 0.2.0. Control still works with it. Update the rig's images.",
      );
      assert.match(lines[4] ?? "", /^rig-x\s+offline\s+never\s+refused\s+no version\s+0\.1\.0/);
      assert.equal(
        lines[5],
        "  Control cannot work with this rig: its supervisor speaks protocol 0.",
      );
      assert.equal(lines[6], "rig-new: enrolled, no report yet");
      const json = await cli(
        "rig",
        "list",
        "--control",
        control,
        "--token-file",
        ownerFile,
        "--json",
      );
      const answer = JSON.parse(json.stdout) as { control: { version: string } };
      assert.equal(answer.control.version, "0.2.0");
      // The owner's token only.
      writeFileSync(ownerFile, "not-the-token\n");
      await assert.rejects(
        cli("rig", "list", "--control", control, "--token-file", ownerFile),
        /401/,
      );
    } finally {
      server.close();
    }
  });
});
