import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { makeCa } from "../../../src/control/bus/cert.ts";
import { BusUsers } from "../../../src/control/bus/index.ts";
import {
  BUS_SERVER_DIR,
  leafCaFile,
  leafRigsFor,
  leafRigsOf,
  mintLeaf,
  writeLeafFiles,
} from "../../../src/control/bus/leaf.ts";
import { ControlTunnels } from "../../../src/control/runpod/tunnel.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import {
  fromEnvLine,
  LEAF_ENV,
  LEAF_PORT,
  leafAccount,
  leafTlsName,
} from "../../../src/core/link/leaf.ts";

/** The certificates of a PEM text, in order. */
const certsOf = (pem: string) =>
  (pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n/g) ?? []).map(
    (c) => new X509Certificate(c),
  );

describe("a RunPod pod's leaf node, as control keeps it", () => {
  test("a launch's leaf keys: the pod's certificate for its leaf name and loopback, signed by an authority of its own, and control's authority", () => {
    const control = makeCa(new Date(), 30);
    const minted = mintLeaf("rp-1", control.cert);
    assert.deepEqual(Object.keys(minted.env).sort(), Object.values(LEAF_ENV).sort());
    const [pod, podCa, ...more] = certsOf(fromEnvLine("cert", minted.env[LEAF_ENV.cert]));
    assert.ok(pod && podCa && more.length === 0, "the pod's certificate, then its authority's");
    assert.equal(podCa.toString(), new X509Certificate(minted.podCa).toString());
    assert.ok(
      pod.checkIssued(podCa) && pod.verify(podCa.publicKey),
      "signed by the pod's authority",
    );
    assert.ok(!pod.checkIssued(new X509Certificate(control.cert)), "not by control's");
    assert.ok(pod.checkHost(leafTlsName("rp-1")) && pod.checkIP("127.0.0.1"));
    assert.ok(!pod.checkHost(leafTlsName("rp-2")), "another rig's name is not its");
    const key = createPrivateKey(fromEnvLine("key", minted.env[LEAF_ENV.key]));
    assert.ok(pod.publicKey.equals(createPublicKey(key)), "the key is the certificate's");
    assert.equal(fromEnvLine("ca", minted.env[LEAF_ENV.controlCa]), control.cert);
    // A second launch: a new authority, so one pod's certificate never passes for another's.
    const again = mintLeaf("rp-1", control.cert);
    assert.ok(!pod.checkIssued(new X509Certificate(again.podCa)));
  });

  test("a launch gives the pod its leaf with control's authority, and none launches without it; control keeps the pod's authority, never its key", () => {
    const store = new ControlStore(":memory:");
    const control = makeCa(new Date(), 30);
    const keys = generateSigningKeys();
    const tunnels = new ControlTunnels(store, SecretBox.ephemeral(), keys.privateKeyPem, {
      busCa: control.cert,
    });
    const minted = tunnels.mint({ by: "owner:ui", rig: "rp-1" });
    for (const name of Object.values(LEAF_ENV)) assert.ok(minted.env[name], name);
    const kept = store.tunnels.get("rp-1");
    assert.ok(kept?.leaf_ca && kept.leaf_address === null);
    const dump = JSON.stringify(store.db.prepare("select * from tunnel_rig").all());
    assert.ok(!dump.includes("PRIVATE KEY") && !dump.includes(minted.env[LEAF_ENV.key] ?? "?"));
    // Without control's authority, no pod: it could not join the bus.
    const plain = new ControlTunnels(store, SecretBox.ephemeral(), keys.privateKeyPem);
    assert.throws(
      () => plain.mint({ by: "owner:ui", rig: "rp-2" }),
      /control has no authority for its message bus/,
    );
    assert.equal(store.tunnels.get("rp-2"), undefined);
    store.db.close();
  });

  test("the pod's address: kept when it changes, with a step in the rig's history, and cleared while the pod has none", () => {
    const store = new ControlStore(":memory:");
    const tunnels = new ControlTunnels(
      store,
      SecretBox.ephemeral(),
      generateSigningKeys().privateKeyPem,
      {
        busCa: makeCa(new Date(), 30).cert,
      },
    );
    tunnels.mint({ by: "owner:ui", rig: "rp-1" });
    assert.equal(store.tunnels.setLeafAddress("rp-1", "203.0.113.5:40123"), true);
    assert.equal(store.tunnels.setLeafAddress("rp-1", "203.0.113.5:40123"), false, "the same");
    assert.equal(store.tunnels.setLeafAddress("rp-1", null), true, "stopped");
    assert.equal(store.tunnels.get("rp-1")?.leaf_address, null);
    assert.equal(store.tunnels.setLeafAddress("rp-1", "198.51.100.7:41000"), true);
    const steps = store.rigHistory.list("rp-1").filter((e) => e.step === "runpod_leaf_address");
    assert.deepEqual(
      steps.map((e) => e.detail),
      ["203.0.113.5:40123", "198.51.100.7:41000"],
    );
    // A rig launched before the leaf node, as an older store holds it, keeps no address.
    store.tunnels.add({
      rig: "rp-2",
      port: 8790,
      prefix_sealed: "x",
      box_private_sealed: "x",
      box_public: "x",
      code_sealed: "x",
      code_expires_at: null,
      config: { env: {} },
      created_by: "owner:ui",
      leaf_ca: null,
    });
    assert.equal(store.tunnels.setLeafAddress("rp-2", "203.0.113.9:4000"), false);
    store.db.close();
  });

  test("the users file names a leaf rig's account from its launch, and its pod only once the server took the account in an earlier reload; retired, both go", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-leaf-"));
    const store = new ControlStore(":memory:");
    const secrets = SecretBox.ephemeral();
    const tunnels = new ControlTunnels(store, secrets, generateSigningKeys().privateKeyPem, {
      busCa: makeCa(new Date(), 30).cert,
    });
    tunnels.mint({ by: "owner:ui", rig: "rp-1" });
    const reloaded: string[] = [];
    const file = () => readFileSync(join(dir, "users.conf"), "utf8");
    const options = {
      store,
      secrets,
      file: join(dir, "users.conf"),
      reload: async () => {
        reloaded.push(file());
      },
    };
    const users = new BusUsers(options);
    await users.sync();
    assert.match(file(), new RegExp(`"${leafAccount("rp-1")}"`), "its account from the launch");
    assert.doesNotMatch(file(), /leafnodes/, "no address yet: no connection");
    assert.equal(
      readFileSync(join(dir, leafCaFile("rp-1")), "utf8"),
      store.tunnels.get("rp-1")?.leaf_ca,
    );
    store.tunnels.setLeafAddress("rp-1", "203.0.113.5:40123");
    await users.sync();
    assert.match(file(), /"tls:\/\/203\.0\.113\.5:40123"/);
    assert.match(file(), new RegExp(`"${join(BUS_SERVER_DIR, leafCaFile("rp-1"))}"`));
    // Never an account and its pod in one reload: the server would not answer through it.
    const first = (text: string) => ({
      account: text.includes(`"${leafAccount("rp-1")}"`),
      pod: text.includes("leafnodes"),
    });
    assert.deepEqual(reloaded.map(first), [
      { account: true, pod: false },
      { account: true, pod: true },
    ]);

    // A second rig whose address is there before its account: the account first, then its pod.
    tunnels.mint({ by: "owner:ui", rig: "rp-2" });
    store.tunnels.setLeafAddress("rp-2", "203.0.113.6:40124");
    await users.sync();
    await users.sync();
    const two = reloaded.slice(2).map((t) => ({
      account: t.includes(`"${leafAccount("rp-2")}"`),
      pod: t.includes("203.0.113.6:40124"),
    }));
    assert.deepEqual(two, [
      { account: true, pod: false },
      { account: true, pod: true },
    ]);

    // Control started again: it reads which accounts the server has from the file, and keeps
    // their pods, with no reload.
    const again = new BusUsers(options);
    const before = reloaded.length;
    assert.equal(again.text(), file());
    store.retired.add("rp-1", "owner:ui");
    store.retired.add("rp-2", "owner:ui");
    await again.sync();
    assert.doesNotMatch(file(), /leafnodes|LEAF_rp/);
    assert.ok(!existsSync(join(dir, leafCaFile("rp-1"))), "its authority's file goes too");
    assert.equal(reloaded.length, before + 1);
    store.db.close();
  });

  test("the leaf rigs as the users file names them: the server's own paths, and the runs each rig has", () => {
    const store = new ControlStore(":memory:");
    const tunnels = new ControlTunnels(
      store,
      SecretBox.ephemeral(),
      generateSigningKeys().privateKeyPem,
      {
        busCa: makeCa(new Date(), 30).cert,
      },
    );
    tunnels.mint({ by: "owner:ui", rig: "rp-1" });
    store.tunnels.setLeafAddress("rp-1", "203.0.113.5:40123");
    const named = leafRigsFor(store, leafRigsOf(store));
    assert.deepEqual(named.rigs, [
      {
        rig: "rp-1",
        runs: [],
        address: "203.0.113.5:40123",
        caFile: join(BUS_SERVER_DIR, leafCaFile("rp-1")),
      },
    ]);
    assert.equal(named.certFile, join(BUS_SERVER_DIR, "server-cert.pem"));
    assert.equal(named.keyFile, join(BUS_SERVER_DIR, "server-key.pem"));
    store.db.close();
  });

  test("an authority's file is written only when it changed, and one that is no certificate is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-leaf-"));
    const ca = makeCa(new Date(), 30).cert;
    const rig = { rig: "rp-1", ca, address: `203.0.113.5:${LEAF_PORT}` };
    assert.equal(writeLeafFiles(dir, [rig]), true);
    assert.equal(writeLeafFiles(dir, [rig]), false);
    writeFileSync(join(dir, "users.conf"), "kept");
    assert.equal(writeLeafFiles(dir, []), true);
    assert.ok(existsSync(join(dir, "users.conf")), "only the authorities' files go");
    assert.throws(() => writeLeafFiles(dir, [{ ...rig, ca: "not a certificate" }]));
  });
});
