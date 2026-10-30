import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createUser } from "@nats-io/nkeys";
import {
  CONTROL_LEAF_NAME,
  envLine,
  fromEnvLine,
  LEAF_ADDRESS,
  LEAF_JS_API,
  LEAF_PORT,
  leafAccount,
  leafTlsName,
  POD_BUS_PORT,
  podServerConfig,
} from "../../../src/core/link/leaf.ts";
import {
  BUS_ACCOUNT,
  leafServices,
  rigPermissions,
  usersFile,
} from "../../../src/core/link/users.ts";

const user = () => createUser().getPublicKey();
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

/** A NATS configuration's top-level `name: <json>` values, read back. */
function values(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of text.matchAll(/^([a-z_]+): ([\s\S]*?)(?=\n[a-z_]+: |\n$)/gm))
    out[m[1] as string] = JSON.parse(m[2] as string);
  return out;
}

describe("a rig on RunPod on the bus: its leaf node", () => {
  test("a PEM text crosses as one line of base64 and comes back whole; anything else is refused", () => {
    const line = envLine(PEM);
    assert.doesNotMatch(line, /\n/);
    assert.equal(fromEnvLine("X", line), PEM);
    assert.throws(
      () => fromEnvLine("THERMITE_LEAF_KEY", "bm90IGEga2V5"),
      /THERMITE_LEAF_KEY is not a PEM text/,
    );
  });

  test("each rig has an account of its own and a certificate name that never resolves", () => {
    assert.equal(leafAccount("rp-1a2b"), "LEAF_rp-1a2b");
    assert.equal(leafTlsName("rp-1a2b"), "rp-1a2b.leaf.thermite.invalid");
    assert.throws(() => leafAccount("Not.A.Rig"), /not a rig's name/);
    assert.ok(LEAF_ADDRESS.test("203.0.113.5:40123"));
    assert.ok(!LEAF_ADDRESS.test("203.0.113.5"));
    assert.ok(!LEAF_ADDRESS.test("[2001:db8::1]:7422"));
  });

  test("the pod's server: its supervisor on the loopback with its key, control's server on the leaf port with its certificate alone", () => {
    const key = user();
    const files = {
      cert: "/t/bus/leaf-cert.pem",
      key: "/t/bus/leaf-key.pem",
      controlCa: "/t/bus/control-ca.pem",
    };
    const v = values(podServerConfig({ files, supervisorKey: key, maxPayload: 8 }));
    assert.equal(v.listen, `127.0.0.1:${POD_BUS_PORT}`);
    assert.equal(v.max_payload, 8);
    assert.deepEqual(v.tls, { cert_file: files.cert, key_file: files.key });
    assert.deepEqual(v.authorization, { users: [{ nkey: key }] });
    assert.deepEqual(v.leafnodes, {
      listen: `0.0.0.0:${LEAF_PORT}`,
      no_advertise: true,
      tls: {
        cert_file: files.cert,
        key_file: files.key,
        ca_file: files.controlCa,
        verify_and_map: true,
      },
      authorization: { users: [{ user: `CN=${CONTROL_LEAF_NAME}` }] },
    });
    assert.equal(v.jetstream, undefined, "the pod keeps no stream");
  });

  test("a leaf account takes, as services, exactly what the rig's user may publish, the JetStream API under its own name", () => {
    const services = leafServices("rp-1", ["run-a"]);
    const allowed = rigPermissions("rp-1", ["run-a"]).publish.allow;
    assert.deepEqual(
      services.map((s) => s.subject),
      allowed,
    );
    for (const s of services) {
      if (s.subject.startsWith("$JS.API."))
        assert.equal(s.local, `${LEAF_JS_API}${s.subject.slice("$JS.API".length)}`, s.subject);
      else assert.equal(s.local, undefined, s.subject);
      assert.equal(s.stream, s.subject.includes(".CONSUMER.MSG.NEXT."), s.subject);
    }
    assert.ok(
      services.some((s) => s.stream),
      "a pull of a consumer gets many answers",
    );
  });

  test("the users file names each leaf rig's account, the bus's services for it, and control's connection to its pod", () => {
    const text = usersFile({
      control: user(),
      system: user(),
      rigs: [],
      leaf: {
        rigs: [
          {
            rig: "rp-1",
            runs: ["run-a"],
            address: "203.0.113.5:40123",
            caFile: "/s/leaf-rp-1-ca.pem",
          },
        ],
        certFile: "/s/server-cert.pem",
        keyFile: "/s/server-key.pem",
      },
    });
    const v = values(text);
    const accounts = v.accounts as Record<
      string,
      { exports?: unknown[]; imports?: unknown[]; jetstream?: string }
    >;
    const leaf = accounts[leafAccount("rp-1")];
    assert.ok(leaf, "the rig's leaf account");
    assert.equal(leaf.jetstream, undefined, "it holds no stream of its own");
    const services = leafServices("rp-1", ["run-a"]);
    assert.deepEqual(
      leaf.imports,
      services.map((s) => ({
        service: { account: BUS_ACCOUNT, subject: s.subject },
        ...(s.local ? { to: s.local } : {}),
      })),
    );
    assert.deepEqual(
      accounts[BUS_ACCOUNT]?.exports,
      services.map((s) => ({
        service: s.subject,
        accounts: [leafAccount("rp-1")],
        ...(s.stream ? { response_type: "stream" } : {}),
      })),
    );
    assert.deepEqual(v.leafnodes, {
      remotes: [
        {
          urls: ["tls://203.0.113.5:40123", `tls://${leafTlsName("rp-1")}:${LEAF_PORT}`],
          account: leafAccount("rp-1"),
          tls: {
            ca_file: "/s/leaf-rp-1-ca.pem",
            cert_file: "/s/server-cert.pem",
            key_file: "/s/server-key.pem",
          },
        },
      ],
    });
  });

  test("without leaf rigs the users file has no leaf node, account or service", () => {
    const text = usersFile({ control: user(), system: user(), rigs: [] });
    const v = values(text);
    assert.equal(v.leafnodes, undefined);
    assert.equal(
      (v.accounts as Record<string, { exports?: unknown }>)[BUS_ACCOUNT]?.exports,
      undefined,
    );
    assert.deepEqual(Object.keys(v.accounts as object).sort(), [BUS_ACCOUNT, "SYS"].sort());
  });

  test("a pod's address that is not an address and a port never reaches the file", () => {
    assert.throws(
      () =>
        usersFile({
          control: user(),
          system: user(),
          rigs: [],
          leaf: {
            rigs: [{ rig: "rp-1", address: "203.0.113.5:1\n}", caFile: "/c" }],
            certFile: "/c",
            keyFile: "/k",
          },
        }),
      /not a pod's address/,
    );
  });
});
