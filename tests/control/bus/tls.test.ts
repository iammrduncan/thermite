import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { connect, createServer } from "node:tls";
import { busHost } from "../../../src/common/bus/index.ts";
import { makeCa, makeServerCert } from "../../../src/control/bus/cert.ts";
import {
  BUS_CA_DAYS,
  BUS_CA_FILES,
  BUS_RENEW_DAYS,
  BUS_SERVER_DAYS,
  BUS_TLS_FILES,
  BusTls,
  busPublicUrl,
} from "../../../src/control/bus/tls.ts";

const DAY = 86_400_000;
const folders = () => {
  const root = mkdtempSync(join(tmpdir(), "thermite-bus-tls-"));
  return { stateDir: join(root, "state"), configDir: join(root, "nats-config"), root };
};
const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");
const mode = (dir: string, name: string) => statSync(join(dir, name)).mode & 0o777;

/** Whether a TLS client that trusts `ca` completes a handshake with a server of this pair. */
async function handshake(server: { cert: string; key: string }, ca: string, name?: string) {
  const srv = createServer(server, (s) => s.end("hello"));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  try {
    return await new Promise<string>((done) => {
      const s = connect({ host: "127.0.0.1", port, ca, servername: name }, () => {
        s.once("data", (d) => {
          done(`ok ${d}`);
          s.end();
        });
      });
      s.on("error", (e) => done(`refused: ${e.message}`));
    });
  } finally {
    srv.close();
  }
}

describe("the bus's certificates", () => {
  test("control's authority signs the server's certificate for each of its names", async () => {
    const now = new Date("2026-10-28T12:00:00Z");
    const ca = makeCa(now, BUS_CA_DAYS);
    const server = makeServerCert(
      ca,
      ["nats", "control.example.com", "192.0.2.10", "::1"],
      now,
      30,
    );
    const authority = new X509Certificate(ca.cert);
    const cert = new X509Certificate(server.cert);
    assert.ok(authority.ca);
    assert.ok(!cert.ca);
    assert.ok(cert.checkIssued(authority) && cert.verify(authority.publicKey));
    assert.equal(cert.checkHost("nats"), "nats");
    assert.equal(cert.checkHost("control.example.com"), "control.example.com");
    assert.equal(cert.checkIP("192.0.2.10"), "192.0.2.10");
    assert.equal(cert.checkIP("::1"), "::1");
    assert.equal(cert.checkHost("other.example.com"), undefined);
    // An hour before now, for a clock a little behind, to the days asked.
    assert.equal(Date.parse(cert.validFrom), now.getTime() - 3_600_000);
    assert.equal(Date.parse(cert.validTo), now.getTime() + 30 * DAY);
    assert.equal(Date.parse(authority.validTo), now.getTime() + BUS_CA_DAYS * DAY);
    // A certificate past 2049 is written as GeneralizedTime, and reads the same.
    const late = makeCa(new Date("2049-12-31T00:00:00Z"), 2);
    assert.equal(new X509Certificate(late.cert).validTo, "Jan  2 00:00:00 2050 GMT");
  });

  test("a client that trusts control's authority completes a handshake; another authority's does not", async () => {
    const now = new Date();
    const ca = makeCa(now, 10);
    const server = makeServerCert(ca, ["nats", "127.0.0.1"], now, 10);
    assert.equal(await handshake(server, ca.cert), "ok hello");
    assert.equal(await handshake(server, ca.cert, "nats"), "ok hello");
    assert.match(await handshake(server, makeCa(now, 10).cert), /^refused: /);
    assert.match(await handshake(server, ca.cert, "other.example.com"), /^refused: .*altnames/i);
  });

  test("a name that is neither a host name nor an address is refused", () => {
    const ca = makeCa(new Date(), 1);
    assert.throws(() => makeServerCert(ca, [], new Date(), 1), /at least one name/);
    assert.throws(
      () => makeServerCert(ca, ["nats", "bad name"], new Date(), 1),
      /^Error: not a host name or an address: "bad name"$/,
    );
  });
});

describe("the bus's TLS as control keeps it", () => {
  test("the authority is made once, beside control's signing key, and kept", () => {
    const f = folders();
    const first = new BusTls({ ...f, names: ["nats"] });
    assert.equal(read(f.stateDir, BUS_CA_FILES.cert), first.caCert);
    assert.equal(mode(f.stateDir, BUS_CA_FILES.key), 0o600);
    assert.equal(mode(f.stateDir, BUS_CA_FILES.cert), 0o644);
    assert.equal(new BusTls({ ...f, names: ["nats"] }).caCert, first.caCert);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("an authority with one file, or one that does not open, stops control with what to do", () => {
    const f = folders();
    new BusTls({ ...f, names: ["nats"] });
    rmSync(join(f.stateDir, BUS_CA_FILES.key));
    assert.throws(
      () => new BusTls({ ...f, names: ["nats"] }),
      /^Error: the bus's certificate authority has one of its two files only: delete both bus-ca\.pem and bus-ca\.key from control's state folder for a new one, then move every rig on the bus onto its images again, so that it gets the new certificate$/,
    );
    writeFileSync(join(f.stateDir, BUS_CA_FILES.key), makeCa(new Date(), 1).key);
    assert.throws(() => new BusTls({ ...f, names: ["nats"] }), /does not open: delete both/);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("the server's certificate is written with its key, and made anew only when it must be", () => {
    const f = folders();
    let now = new Date("2026-10-28T12:00:00Z");
    const tls = new BusTls({ ...f, names: ["nats", "control.example.com", ""], now: () => now });
    assert.deepEqual(tls.names, ["nats", "control.example.com"]);
    assert.equal(tls.write(), true);
    const cert = () => new X509Certificate(read(f.configDir, BUS_TLS_FILES.cert));
    assert.ok(cert().checkIssued(new X509Certificate(tls.caCert)));
    assert.equal(cert().checkHost("control.example.com"), "control.example.com");
    // The server reads its key through control's group; its certificate is no secret.
    assert.equal(mode(f.configDir, BUS_TLS_FILES.key), 0o640);
    assert.equal(mode(f.configDir, BUS_TLS_FILES.cert), 0o644);
    const written = read(f.configDir, BUS_TLS_FILES.cert);
    assert.equal(tls.write(), false);
    // Control started again with the same names: the same certificate.
    assert.equal(new BusTls({ ...f, names: ["nats", "control.example.com"] }).write(), false);
    assert.equal(read(f.configDir, BUS_TLS_FILES.cert), written);
    // Near its end: a new one.
    now = new Date(now.getTime() + (BUS_SERVER_DAYS - BUS_RENEW_DAYS + 1) * DAY);
    assert.equal(tls.write(), true);
    assert.notEqual(read(f.configDir, BUS_TLS_FILES.cert), written);
    rmSync(f.root, { recursive: true, force: true });
  });

  test("a new name, another key, another authority or a broken file: a new certificate", () => {
    const f = folders();
    const tls = new BusTls({ ...f, names: ["nats"] });
    tls.write();
    assert.equal(new BusTls({ ...f, names: ["nats", "bus.example.com"] }).write(), true);
    assert.equal(cert(f).checkHost("bus.example.com"), "bus.example.com");
    writeFileSync(join(f.configDir, BUS_TLS_FILES.key), makeCa(new Date(), 1).key);
    assert.equal(tls.write(), true);
    const other = makeCa(new Date(), 1);
    const foreign = makeServerCert(other, ["nats"], new Date(), 100);
    writeFileSync(join(f.configDir, BUS_TLS_FILES.cert), foreign.cert);
    writeFileSync(join(f.configDir, BUS_TLS_FILES.key), foreign.key);
    assert.equal(tls.write(), true);
    writeFileSync(join(f.configDir, BUS_TLS_FILES.cert), "not a certificate");
    assert.equal(tls.write(), true);
    assert.ok(cert(f).checkIssued(new X509Certificate(tls.caCert)));
    rmSync(f.root, { recursive: true, force: true });
  });
});

const cert = (f: { configDir: string }) =>
  new X509Certificate(readFileSync(join(f.configDir, BUS_TLS_FILES.cert)));

describe("the bus's address for rigs", () => {
  test("its setting, or control's address for rigs with NATS's own port", () => {
    const url = "https://control.example.com";
    assert.equal(busPublicUrl({}, undefined), undefined);
    assert.equal(busPublicUrl({}, url), "nats://control.example.com:4222");
    assert.equal(
      busPublicUrl({}, "https://control.example.com:8443/"),
      "nats://control.example.com:4222",
    );
    assert.equal(
      busPublicUrl({ THERMITE_NATS_PUBLIC_URL: " nats://bus.example.com:14222 " }, url),
      "nats://bus.example.com:14222",
    );
    assert.throws(
      () => busPublicUrl({ THERMITE_NATS_PUBLIC_URL: "https://bus.example.com" }, url),
      /^Error: THERMITE_NATS_PUBLIC_URL takes a nats:\/\/ address, such as nats:\/\/nats:4222, not "https:\/\/bus\.example\.com"$/,
    );
    assert.equal(busHost("nats://nats:4222"), "nats");
    assert.equal(busHost("nats://[::1]:4222"), "::1");
    assert.equal(busHost(busPublicUrl({}, "http://[::1]:8800") ?? ""), "::1");
  });
});
