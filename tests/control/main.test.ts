import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { controlBusUrl } from "../../src/control/bus/index.ts";
import { controlPublicUrl } from "../../src/control/settings.ts";

/**
 * Control needs its message bus (goal 168, step 4): it keeps every rig's events in the bus's
 * events stream and derives its records from them there, so it does not start without one, and
 * says which setting to give. Nor does it start with a plain http address for rigs on another
 * host, unless the owner allows it.
 */

const WORDS =
  "control needs its message bus: set THERMITE_NATS_URL to its NATS server, such as nats://nats:4222. Control keeps every rig's events in the bus's EVENTS stream and derives its records from them there, and its rigs reach it only on the bus";

describe("control and its bus", () => {
  test("the bus's address is required, and a bad one is refused", () => {
    assert.equal(controlBusUrl({ THERMITE_NATS_URL: " nats://nats:4222 " }), "nats://nats:4222");
    for (const env of [{}, { THERMITE_NATS_URL: "" }, { THERMITE_NATS_URL: " " }])
      assert.throws(() => controlBusUrl(env), { message: WORDS });
    assert.throws(
      () => controlBusUrl({ THERMITE_NATS_URL: "http://nats:4222" }),
      /^Error: THERMITE_NATS_URL takes a nats:\/\/ address, such as nats:\/\/nats:4222, not "http:\/\/nats:4222"$/,
    );
  });

  test("control without THERMITE_NATS_URL does not start, and says why", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "thermite-control-")), "state");
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", THERMITE_CONTROL_DIR: dir };
    const r = spawnSync(process.execPath, ["src/control/main.ts"], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 1, r.stderr);
    const lines = `${r.stdout}${r.stderr}`
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { msg: string; error?: string });
    const fatal = lines.find((l) => l.msg === "fatal");
    assert.match(String(fatal?.error), new RegExp(`^Error: ${WORDS.replace(/[.()]/g, "\\$&")}`));
    assert.equal(existsSync(dir), false, "before it makes its state folder");
  });

  test("control's address for rigs: https, or plain http only to this computer, a compose service or where the owner allows it", () => {
    const url = (address: string, allow?: string) =>
      controlPublicUrl({
        THERMITE_CONTROL_PUBLIC_URL: address,
        ...(allow ? { THERMITE_CONTROL_ALLOW_PLAIN_HTTP: allow } : {}),
      });
    assert.equal(controlPublicUrl({}), undefined);
    assert.equal(url(" "), undefined);
    for (const ok of [
      "https://control.example.com",
      "https://192.0.2.5:8800",
      "http://localhost:8800",
      "http://127.0.0.1:8800",
      "http://[::1]:8800",
      "http://control:8800",
    ])
      assert.equal(url(ok), ok);
    const refused = (address: string) =>
      `THERMITE_CONTROL_PUBLIC_URL is "${address}", plain http to another host: rigs would send their tokens, and rigs off the message bus their keys, across the network unencrypted. Give control an https:// address, or set THERMITE_CONTROL_ALLOW_PLAIN_HTTP=1 to allow plain http on a network you trust`;
    for (const lan of [
      "http://192.0.2.5:8800",
      "http://control.example.net:8800",
      "http://[2001:db8::5]:8800",
    ]) {
      assert.throws(() => url(lan), { message: refused(lan) });
      assert.throws(() => url(lan, "yes"), { message: refused(lan) }, "only 1 allows it");
      assert.equal(url(lan, "1"), lan);
    }
    assert.throws(() => url("control.example.com"), {
      message:
        'THERMITE_CONTROL_PUBLIC_URL takes an https:// address, such as https://control.example.com, not "control.example.com"',
    });
    assert.throws(() => url("ftp://control.example.com"), /takes an https:\/\/ address/);
  });

  test("control with a plain http address for rigs on another host does not start, and says why", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "thermite-control-")), "state");
    const r = spawnSync(process.execPath, ["src/control/main.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
        THERMITE_CONTROL_DIR: dir,
        THERMITE_NATS_URL: "nats://127.0.0.1:9",
        THERMITE_CONTROL_PUBLIC_URL: "http://192.0.2.5:8800",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 1, r.stderr);
    const fatal = `${r.stdout}${r.stderr}`
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as { msg: string; error?: string })
      .find((l) => l.msg === "fatal");
    assert.match(
      String(fatal?.error),
      /^Error: THERMITE_CONTROL_PUBLIC_URL is "http:\/\/192\.0\.2\.5:8800", plain http to another host: .* set THERMITE_CONTROL_ALLOW_PLAIN_HTTP=1/,
    );
    assert.equal(existsSync(dir), false, "before it makes its state folder");
  });

  test("while its views wait for the bus, control answers that it is starting", async () => {
    // A port nothing listens on, for the bus, and a free one for control.
    const free = () =>
      new Promise<number>((done) => {
        const s = createServer().listen(0, "127.0.0.1", () => {
          const { port } = s.address() as { port: number };
          s.close(() => done(port));
        });
      });
    const [busPort, port] = [await free(), await free()];
    const root = mkdtempSync(join(tmpdir(), "thermite-control-"));
    mkdirSync(join(root, "nats"));
    const child = spawn(process.execPath, ["src/control/main.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
        THERMITE_CONTROL_DIR: join(root, "state"),
        // The owner's credential: the hash of a made-up token.
        THERMITE_CONTROL_ADMIN_TOKEN_SHA256: createHash("sha256").update("made-up").digest("hex"),
        THERMITE_CONTROL_LISTEN: `127.0.0.1:${port}`,
        THERMITE_NATS_URL: `nats://127.0.0.1:${busPort}`,
        THERMITE_NATS_CONFIG_DIR: join(root, "nats"),
      },
      stdio: "ignore",
    });
    try {
      const url = `http://127.0.0.1:${port}`;
      let health: Response | undefined;
      for (let i = 0; i < 100 && !health; i++) {
        health = await fetch(`${url}/v1/health`).catch(() => undefined);
        if (!health) await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(health, "control's port opened");
      assert.equal(health.status, 503);
      assert.deepEqual(await health.json(), { ok: false, bus: "away", starting: true });
      const page = await fetch(`${url}/v1/campaigns`);
      assert.equal(page.status, 503);
      assert.equal(page.headers.get("retry-after"), "5");
      assert.deepEqual(await page.json(), {
        error: "control is starting: it builds its views from the events stream first",
      });
    } finally {
      child.kill("SIGKILL");
    }
  });
});
