import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { McpServers } from "../../../src/control/mcp-servers/index.ts";
import { ControlTunnels, tunnelRouteAllowed } from "../../../src/control/runpod/tunnel.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { ControlStore, RIG_ID } from "../../../src/control/store/index.ts";
import { generateSigningKeys, type KeyPairPem } from "../../../src/core/commands.ts";
import {
  controlCodeProof,
  keySha256,
  newNonce,
  type RequestHead,
  signRequest,
  TUNNEL_MAX_REQUEST,
} from "../../../src/core/tunnel.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { readEnrollment } from "../../../src/harness/broker/one-container.ts";
import { syncMcpServers } from "../../../src/supervisor/mcp-sync.ts";
import { relayCommandsOnce, relayOnce } from "../../../src/supervisor/relay/index.ts";
import { PodTunnel, pullModeOptions, startPullMode } from "../../../src/supervisor/tunnel-pod.ts";
import { assigned } from "../../helpers/assignments.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { controlStore, heldEvents } from "../../helpers/control-store.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";
import { appendOther } from "../../helpers/kinds.ts";

const MARKER = "a-made-up-secret-marker-0001";
const MODEL_KEY = "a-made-up-model-key-0001";
const MCP_KEY = "a-made-up-mcp-key-0001";
const CONFIG = { THERMITE_TARGET: "cpu", THERMITE_MAX_TRIALS: "2" };

/**
 * A request on a connection of its own, as a stranger or a proxy would send it: a pod that
 * restarted never meets a connection kept from before.
 */
function raw(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      agent: false,
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          if (typeof v === "string") headers.set(k, v);
        resolve(
          new Response(body.length ? new Uint8Array(body) : null, {
            status: res.statusCode ?? 0,
            headers,
          }),
        );
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    const body = init.body;
    req.end(typeof body === "string" || body instanceof Uint8Array ? body : undefined);
  });
}

/**
 * Control, a pod's end of the tunnel on local ports, and between them a "proxy" that records
 * every byte and can change, replay or swap what passes, as RunPod's proxy could.
 */
async function setup(
  o: {
    now?: () => number;
    codeTtlMs?: number;
    /** The code the pod is launched with, when not the one control minted. */
    podCode?: string;
    rig?: string;
    controlKeys?: KeyPairPem;
  } = {},
) {
  const store = controlStore();
  const secrets = SecretBox.ephemeral();
  const control = o.controlKeys ?? generateSigningKeys();
  const sent: Buffer[] = [];
  const wire: Buffer[] = [];
  const answers: Response[] = [];
  let mode: "pass" | "tamper" | "old-answer" = "pass";
  let last: { url: string; init: RequestInit } | undefined;
  const proxy: typeof fetch = async (input, init) => {
    last = { url: String(input), init: { ...init, signal: undefined } as RequestInit };
    if (init?.body) {
      sent.push(Buffer.from(init.body as Uint8Array));
      wire.push(Buffer.from(init.body as Uint8Array));
    }
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>))
      wire.push(Buffer.from(`${k}: ${v}`));
    const res = await raw(String(input), init);
    const body = Buffer.from(await res.arrayBuffer());
    wire.push(body);
    const copy = () =>
      new Response(body.length ? new Uint8Array(body) : null, {
        status: res.status,
        headers: res.headers,
      });
    const old = answers.at(-1);
    answers.push(copy());
    if (mode === "old-answer" && old) return old.clone();
    if (mode === "tamper" && body.length) body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 1;
    return copy();
  };
  const tunnels = new ControlTunnels(store, secrets, control.privateKeyPem, {
    fetch: proxy,
    ...(o.now ? { now: o.now } : {}),
  });
  const { control: api } = controlOnly({
    store,
    keys: control,
    tokens: { rigs: {} },
    options: { secrets, tunnels },
  });
  const minted = tunnels.mint({
    by: "owner:ui",
    ...(o.rig ? { rig: o.rig } : {}),
    ...(o.codeTtlMs ? { codeTtlMs: o.codeTtlMs } : {}),
    config: CONFIG,
  });
  const rig = minted.rig;
  const home = mkdtempSync(join(tmpdir(), "thermite-pull-"));
  const env = {
    ...minted.env,
    THERMITE_TUNNEL_POD: "pod1",
    ...(o.podCode ? { THERMITE_TUNNEL_ENROLL_CODE: o.podCode } : {}),
  };
  const opts = {
    ...(pullModeOptions(env, rig, home) as NonNullable<ReturnType<typeof pullModeOptions>>),
    publicPort: 0,
    callTimeoutMs: 10_000,
    ...(o.now ? { now: o.now } : {}),
  };
  const pod = { tunnel: new PodTunnel(opts), url: "", local: "" };
  await pod.tunnel.start();
  const ports = pod.tunnel.ports();
  pod.url = `http://127.0.0.1:${ports.public_port}`;
  pod.local = `http://127.0.0.1:${ports.local_port}`;
  tunnels.attach(rig, "pod1", pod.url);
  /** The supervisor's own call to control, through its local port. */
  const call = (path: string, init: RequestInit = {}, token = opts.localToken) =>
    fetch(`${pod.local}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...((init.headers as object) ?? {}) },
    });
  /** Control's steps, until `until` settles. */
  const pump = async <T>(until: Promise<T>, wait = 100): Promise<T> => {
    let done = false;
    const p = until.finally(() => {
      done = true;
    });
    while (!done) await tunnels.step(rig, wait);
    return p;
  };
  /** A request to the pod, signed as control signs (or with another key), changed as asked. */
  const signed = (
    op: "enroll" | "exchange",
    body: Buffer,
    h: Partial<RequestHead> = {},
    key = control.privateKeyPem,
  ): [string, RequestInit] => {
    const path = `/${env.THERMITE_TUNNEL_PREFIX}/${op}`;
    const head: RequestHead = {
      method: "POST",
      path,
      rig,
      pod: "pod1",
      at: o.now ? o.now() : Date.now(),
      nonce: newNonce(),
      ...h,
    };
    return [
      path,
      {
        method: "POST",
        headers: {
          "x-thermite-at": String(head.at),
          "x-thermite-nonce": head.nonce,
          "x-thermite-signature": signRequest(head, body, key),
        },
        body: new Uint8Array(body),
      },
    ];
  };
  /** Control's enrollment request, made by hand with a fresh nonce. */
  const enrollBody = (nonce: string, code = minted.env.THERMITE_TUNNEL_ENROLL_CODE) =>
    Buffer.from(
      JSON.stringify({
        control_key: control.publicKeyPem,
        code_proof: controlCodeProof(code, rig, "pod1", nonce),
        config: { env: CONFIG },
      }),
    );
  const podState = () =>
    ["enrollment.json", "nonces.json"].map((f) =>
      existsSync(join(opts.dir, f)) ? readFileSync(join(opts.dir, f), "utf8") : "",
    );
  /** The rig's page on the dashboard, as the owner sees it. */
  const rigPage = async () => await (await signIn(api)).page(`/ui/rigs/${rig}`);
  return {
    store,
    secrets,
    api,
    control,
    tunnels,
    minted,
    rig,
    env,
    opts,
    pod,
    call,
    pump,
    signed,
    enrollBody,
    podState,
    rigPage,
    sent,
    wire,
    setMode: (m: typeof mode) => {
      mode = m;
    },
    /** The last request control sent through the proxy, sent again as the proxy could. */
    replayLast: () => raw(last?.url ?? "", last?.init),
    /** The pod stops and starts again, on the same port, with its state on disk. */
    restart: async () => {
      await pod.tunnel.stop();
      pod.tunnel = new PodTunnel({ ...opts, publicPort: ports.public_port });
      await pod.tunnel.start();
      pod.local = `http://127.0.0.1:${pod.tunnel.ports().local_port}`;
    },
    stop: () => pod.tunnel.stop(),
  };
}

const isEmpty404 = async (r: Response, what: string) => {
  assert.equal(r.status, 404, what);
  assert.equal((await r.arrayBuffer()).byteLength, 0, `${what}: no body`);
};

describe("pull mode: control connects to a rig through a proxy", () => {
  test("only the paths a rig may use, only for itself", () => {
    for (const [m, p] of [
      ["POST", "/v1/rigs/rp-1/ingest"],
      ["GET", "/v1/rigs/rp-1/commands/pending"],
      ["POST", "/v1/rigs/rp-1/commands/c-1/ack"],
      ["GET", "/v1/rigs/rp-1/model-route"],
      ["GET", "/v1/rigs/rp-1/mcp-servers"],
      ["GET", "/v1/rigs/rp-1/kb?run=r-1&after=0"],
      ["POST", "/v1/rigs/rp-1/champions/r-1/3/patch"],
      ["GET", "/v1/rigs/rp-1/git-access/deploy"],
      ["GET", "/v1/rigs/rp-1/git/kits/smoke.git/info/refs"],
    ])
      assert.ok(tunnelRouteAllowed("rp-1", m as string, p as string), `${m} ${p}`);
    for (const [m, p] of [
      ["GET", "/v1/rigs/rp-2/commands/pending"],
      ["POST", "/v1/rigs/rp-1/retire"],
      ["POST", "/v1/rigs/rp-1/token"],
      ["GET", "/v1/rigs/rp-1/events"],
      ["GET", "/v1/rigs/rp-1/view"],
      ["GET", "/v1/rigs/rp-1/champions/r-1/3/patch"],
      ["GET", "/v1/rigs"],
      ["POST", "/v1/commands"],
      ["GET", "/v1/rigs/rp-1/git/kits/../../secrets"],
      ["DELETE", "/v1/rigs/rp-1/ingest"],
      ["POST", "/v1/rigs/rp-1/model-route"],
      ["POST", "/v1/rigs/rp-1/mcp-servers"],
      ["GET", "/v1/rigs/rp-2/mcp-servers"],
    ])
      assert.ok(!tunnelRouteAllowed("rp-1", m as string, p as string), `${m} ${p}`);
  });

  test("a launch gets a new rig, a one-time code and only public material; no expiry unless set", async () => {
    const s = await setup();
    try {
      assert.match(s.rig, /^rp-[0-9a-f]{8}$/);
      assert.match(s.rig, RIG_ID);
      assert.deepEqual(Object.keys(s.minted.env).sort(), [
        "THERMITE_RIG_ID",
        "THERMITE_STATE_SNAPSHOT_KEY",
        "THERMITE_TUNNEL_CONTROL_BOX",
        "THERMITE_TUNNEL_CONTROL_KEY_SHA256",
        "THERMITE_TUNNEL_ENROLL_CODE",
        "THERMITE_TUNNEL_PORT",
        "THERMITE_TUNNEL_PREFIX",
      ]);
      // The state snapshot's key: 32 random bytes, new for each launch, and control keeps no copy.
      const snapshotKey = s.minted.env.THERMITE_STATE_SNAPSHOT_KEY;
      assert.match(snapshotKey, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(Buffer.from(snapshotKey, "base64url").length, 32);
      assert.equal(s.minted.env.THERMITE_TUNNEL_PORT, "8790");
      assert.equal(
        s.minted.env.THERMITE_TUNNEL_CONTROL_KEY_SHA256,
        keySha256(s.control.publicKeyPem),
      );
      assert.ok(
        !JSON.stringify(s.minted.env).includes("PRIVATE"),
        "no private key in RunPod's settings",
      );
      assert.equal(s.store.tunnels.get(s.rig)?.code_expires_at, null);
      // Control's database holds the code, the path and its own box key only sealed.
      const dump = JSON.stringify(s.store.db.prepare("select * from tunnel_rig").all());
      assert.ok(!dump.includes(s.minted.env.THERMITE_TUNNEL_ENROLL_CODE));
      assert.ok(!dump.includes(s.minted.env.THERMITE_TUNNEL_PREFIX));
      assert.ok(!dump.includes("PRIVATE"));
      assert.ok(!dump.includes(snapshotKey), "the snapshot key is not kept, sealed or not");
      const timed = s.tunnels.mint({ by: "owner:ui", rig: "rp-timed", codeTtlMs: 30 * 60_000 });
      assert.notEqual(timed.env.THERMITE_STATE_SNAPSHOT_KEY, snapshotKey, "a new key each launch");
      assert.ok(Date.parse(timed.env.THERMITE_TUNNEL_ENROLL_UNTIL ?? "") > Date.now());
      assert.throws(() => s.tunnels.mint({ by: "owner:ui", rig: s.rig }), /exists already/);
      assert.throws(() => s.tunnels.mint({ by: "owner:ui", rig: "Bad_Name" }), /a rig's name/);
      assert.throws(() => s.tunnels.attach("rp-none", "pod2"), /no rig rp-none/);
      // A rig minted for a pod not launched yet waits, and says so.
      assert.equal(await s.tunnels.step("rp-timed"), "its pod is not launched yet");
      s.tunnels.attach("rp-timed", "abc123");
      assert.equal(s.store.tunnels.get("rp-timed")?.url, "https://abc123-8790.proxy.runpod.net");
    } finally {
      await s.stop();
    }
  });

  test("enrolls once: control pins the pod's keys, the code is spent at both ends, and the harness's files come only then", async () => {
    const s = await setup();
    try {
      const enrolled = join(s.opts.enrolledDir, "control.pub");
      // Before enrollment the pod serves nothing, not even to control.
      const [xp, xi] = s.signed("exchange", Buffer.from("{}"));
      await isEmpty404(await raw(`${s.pod.url}${xp}`, xi), "an exchange before enrollment");
      assert.equal(await s.tunnels.step(s.rig), "enrolled");
      const t = s.store.tunnels.get(s.rig);
      assert.equal(t?.pod_sign_public, s.pod.tunnel.publicKeys().sign);
      assert.equal(t?.pod_box_public, s.pod.tunnel.publicKeys().box);
      assert.equal(s.store.tunnels.get(s.rig)?.code_sealed, "", "spent at control");
      assert.equal(s.store.tunnels.pin(s.rig, "x", "y"), false, "a second pin");
      assert.ok(!existsSync(enrolled), "nothing for the harness before control's first exchange");
      // An enrollment answer lost on the way may be asked for again until the first exchange.
      const n1 = newNonce();
      const [ep, ei] = s.signed("enroll", s.enrollBody(n1), { nonce: n1 });
      assert.equal((await raw(`${s.pod.url}${ep}`, ei)).status, 200);
      assert.match(await s.tunnels.step(s.rig), /^exchanged/);
      assert.ok(s.pod.tunnel.enrolled());
      assert.equal(readFileSync(enrolled, "utf8"), s.control.publicKeyPem);
      const rigJson = JSON.parse(readFileSync(join(s.opts.enrolledDir, "rig.json"), "utf8"));
      assert.equal(rigJson.rig, s.rig);
      assert.equal(rigJson.control_key_sha256, keySha256(s.control.publicKeyPem));
      assert.deepEqual(rigJson.config.env, { THERMITE_TARGET: "cpu", THERMITE_MAX_TRIALS: "2" });
      assert.equal(
        readFileSync(join(s.opts.enrolledDir, "rig.env"), "utf8"),
        `THERMITE_RIG_ID=${s.rig}\nTHERMITE_TARGET=cpu\nTHERMITE_MAX_TRIALS=2\n`,
      );
      // Root in the one-container image takes what the pod wrote: the key the launch named and
      // the settings by name.
      assert.deepEqual(
        readEnrollment({
          dir: s.opts.enrolledDir,
          rig: s.rig,
          controlKeySha256: keySha256(s.control.publicKeyPem),
          owner: process.getuid?.() ?? 0,
        }),
        {
          state: "ready",
          controlKeyPem: s.control.publicKeyPem,
          settings: { THERMITE_TARGET: "cpu", THERMITE_MAX_TRIALS: "2" },
        },
      );
      // Spent at the pod: a second enrollment, even signed by control with the right code.
      const n2 = newNonce();
      const [p2, i2] = s.signed("enroll", s.enrollBody(n2), { nonce: n2 });
      await isEmpty404(await raw(`${s.pod.url}${p2}`, i2), "a second enrollment");
      // Also after a restart: the pod keeps its keys and its enrollment.
      const keys = s.pod.tunnel.publicKeys();
      await s.restart();
      assert.deepEqual(s.pod.tunnel.publicKeys(), keys);
      const n3 = newNonce();
      const [p3, i3] = s.signed("enroll", s.enrollBody(n3), { nonce: n3 });
      await isEmpty404(await raw(`${s.pod.url}${p3}`, i3), "a second enrollment after a restart");
      assert.match(await s.tunnels.step(s.rig), /^exchanged/);
      assert.throws(() => s.tunnels.attach(s.rig, "pod2"), /enrolled already/);
    } finally {
      await s.stop();
    }
  });

  test("a wrong code is refused at the pod, and nothing is pinned", async () => {
    const s = await setup({ podCode: "f".repeat(64) });
    try {
      assert.match(
        await s.tunnels.step(s.rig),
        /did not enroll \(an empty 404\)\. Most often nothing listens on the pod.s port yet/,
      );
      assert.equal(s.store.tunnels.get(s.rig)?.enrolled_at, null);
      assert.equal(s.store.tunnels.get(s.rig)?.pod_sign_public, null);
      assert.ok(!s.pod.tunnel.enrolled());
      assert.deepEqual(s.podState(), ["", ""], "the pod recorded nothing");
      assert.match(s.store.tunnels.get(s.rig)?.error ?? "", /wrong or expired code/);
      // The rig's page says so, before the rig ever reported.
      const page = await s.rigPage();
      assert.match(page, /Control connects to rp-[0-9a-f]{8} through RunPod's proxy/);
      assert.match(page, /waiting for enrollment/);
      assert.match(page, /The code does not expire/);
      assert.match(page, /Last error/);
      assert.match(page, /wrong or expired code/);
    } finally {
      await s.stop();
    }
  });

  test("an expired code is refused, only when an expiry was set", async () => {
    let now = Date.now();
    const timed = await setup({ now: () => now, codeTtlMs: 30 * 60_000 });
    try {
      now += 31 * 60_000;
      assert.match(await timed.tunnels.step(timed.rig), /enrollment code expired/);
      assert.equal(timed.store.tunnels.get(timed.rig)?.enrolled_at, null);
      // The pod refuses it too, whoever asks.
      const n = newNonce();
      const [p, i] = timed.signed("enroll", timed.enrollBody(n), { nonce: n });
      await isEmpty404(await raw(`${timed.pod.url}${p}`, i), "an expired code at the pod");
      assert.deepEqual(timed.podState(), ["", ""]);
    } finally {
      await timed.stop();
    }
    let later = Date.now();
    const open = await setup({ now: () => later });
    try {
      later += 30 * 24 * 3_600_000;
      assert.equal(await open.tunnels.step(open.rig), "enrolled", "no expiry by default");
    } finally {
      await open.stop();
    }
  });

  test("a stop ends the supervisor's calls that wait for control, at once", async () => {
    const s = await setup();
    assert.equal(await s.tunnels.step(s.rig), "enrolled");
    // Control does not connect now: the call waits at the local port (here up to 10 s).
    const waiting = s.call(`/v1/rigs/${s.rig}/commands/pending`);
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await s.stop();
    const r = await waiting;
    assert.equal(r.status, 503);
    assert.equal(await r.text(), "stopping");
    assert.ok(Date.now() - t0 < 2000, "not after the call's own time limit");
  });

  test("everyone but control gets the same empty 404, a lane in the pod included, and nothing changes", async () => {
    const s = await setup();
    try {
      assert.equal(await s.tunnels.step(s.rig), "enrolled");
      assert.match(await s.tunnels.step(s.rig), /^exchanged/);
      const before = s.podState();
      const files = readFileSync(join(s.opts.enrolledDir, "rig.json"), "utf8");
      const other = generateSigningKeys();
      const empty = Buffer.from("{}");
      const prefix = s.env.THERMITE_TUNNEL_PREFIX;
      const tries: [string, string, RequestInit][] = [
        ["no signature", `/${prefix}/exchange`, { method: "POST", body: "{}" }],
        ["a wrong path", "/exchange", s.signed("exchange", empty)[1]],
        ["a GET", `/${prefix}/exchange`, { method: "GET" }],
        ["signed by another key", ...s.signed("exchange", empty, {}, other.privateKeyPem)],
        ["stale", ...s.signed("exchange", empty, { at: Date.now() - 5 * 60_000 })],
        ["from the future", ...s.signed("exchange", empty, { at: Date.now() + 5 * 60_000 })],
        ["for another rig", ...s.signed("exchange", empty, { rig: "rp-other" })],
        ["for another pod", ...s.signed("exchange", empty, { pod: "pod2" })],
        ["signed by control but not sealed to the pod", ...s.signed("exchange", empty)],
        ["an enrollment by another key", ...s.signed("enroll", empty, {}, other.privateKeyPem)],
        [
          "too large",
          `/${prefix}/exchange`,
          { ...s.signed("exchange", empty)[1], body: new Uint8Array(TUNNEL_MAX_REQUEST + 1) },
        ],
        ["the root", "/", { method: "GET" }],
      ];
      for (const [what, path, init] of tries)
        await isEmpty404(await raw(`${s.pod.url}${path}`, init), what);
      // A lane inside the pod: the public port refuses it as anyone, and so does the
      // supervisor's local port, without the supervisor's token.
      const lane = s.signed("exchange", empty, {}, other.privateKeyPem);
      await isEmpty404(await raw(`${s.pod.url}${lane[0]}`, lane[1]), "a lane on the public port");
      await isEmpty404(
        await s.call(`/v1/rigs/${s.rig}/model-route`, {}, "a-lane-guessing"),
        "a lane on the local port",
      );
      await isEmpty404(await s.call("/v1/rigs/rp-other/model-route"), "another rig's path");
      assert.deepEqual(s.podState(), before, "no nonce, key or enrollment changed");
      assert.equal(readFileSync(join(s.opts.enrolledDir, "rig.json"), "utf8"), files);
      // The next exchange reports the refusals; control keeps the count and logs it.
      assert.match(await s.tunnels.step(s.rig), /^exchanged/);
      assert.ok((s.store.tunnels.get(s.rig)?.refused_total ?? 0) >= tries.length + 3);
      assert.ok(s.store.auditLog.list(20).some((a) => a.action === "tunnel_refusals"));
      const page = await s.rigPage();
      assert.match(page, /Refused requests<\/dt><dd>[1-9]/);
      assert.match(page, /Enrolled .* ago/);
      // A pod launched without the leaf node is not on the bus, and its page says so.
      assert.match(page, /Message bus<\/dt><dd><span class="muted">Not on it: launched before/);
      // From the network, control's rig routes still need a token: the tunnel's binding is
      // only for calls control's end of the tunnel makes in-process.
      assert.equal((await s.api.request(`/v1/rigs/${s.rig}/commands/pending`)).status, 401);
    } finally {
      await s.stop();
    }
  });

  test("replays: control's request again is refused, also after the pod restarts; an old or changed answer is dropped", async () => {
    const s = await setup();
    try {
      assert.equal(await s.tunnels.step(s.rig), "enrolled");
      assert.match(await s.tunnels.step(s.rig), /^exchanged/);
      await isEmpty404(await s.replayLast(), "a replay of control's own request");
      await s.restart();
      await isEmpty404(await s.replayLast(), "the same replay after the pod restarted");
      // A call waits; the proxy swaps the pod's answer for an older one: control drops it.
      const pending = s.call(`/v1/rigs/${s.rig}/commands/pending`);
      await new Promise((r) => setTimeout(r, 50));
      s.setMode("old-answer");
      assert.match(await s.tunnels.step(s.rig), /did not verify/);
      // A changed answer is dropped too.
      s.setMode("tamper");
      assert.match(await s.tunnels.step(s.rig), /did not verify/);
      s.setMode("pass");
      // The pod offers the call again after a while; control then takes and answers it.
      await new Promise((r) => setTimeout(r, 5_200));
      const res = await s.pump(pending);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { commands: [], held: [] });
    } finally {
      await s.stop();
    }
  });

  test("a pull from start to end: the supervisor reports and takes commands through control's connections only, sealed", async () => {
    const henv = makeHarnessEnv("rig-pull");
    const s = await setup({ rig: "rig-pull", controlKeys: henv.keys });
    try {
      assert.equal(await s.tunnels.step(s.rig), "enrolled");
      // The harness, as the supervisor reaches it; control only through the pod's local port.
      const harness = createHarnessApi(henv.service, { supervisor: "sup" });
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.host === "harness")
          return harness.request(`${url.pathname}${url.search}`, init as RequestInit);
        assert.equal(url.origin, s.pod.local, "the supervisor calls only its local port");
        return fetch(input, init);
      };
      const cfg = {
        rig: s.rig,
        harnessUrl: "http://harness",
        harnessToken: "sup",
        controlUrl: s.pod.local,
        controlToken: s.opts.localToken,
        fetchImpl,
      };
      // Reports: the harness's signed events reach control, which pins the harness's key.
      appendOther(henv.service.ledger, "t", "first", null, { note: MARKER });
      const state = await s.pump(relayOnce({ ...cfg, skipCommands: true }, { cursor: 0 }));
      assert.ok(state.cursor > 0);
      const kinds = (await heldEvents(s.store, s.rig)).map((e) => e.kind);
      assert.ok(kinds.includes("first"));
      assert.ok(s.store.reportedRigs.key(s.rig).pubkey, "the harness's report key is pinned");
      // A command: issued at control, delivered to the harness, its outcome back at control.
      const { id } = issueCommand(s.store, henv.keys.privateKeyPem, {
        rig: s.rig,
        kind: "rig_settings",
        payload: { trial_minutes: 33 },
        issuedBy: "owner:ui",
      });
      await s.pump(relayCommandsOnce(cfg));
      assert.equal(s.store.commands.get(id)?.status, "delivered");
      // A model route with its key reaches the supervisor.
      s.store.modelProviders.put({
        name: "models",
        type: "openai",
        base_url: "https://models.example.com/v1",
        key: { sealed: s.secrets.seal(MODEL_KEY), hint: "…0001" },
      });
      s.store.agentModels.assignRig(s.rig, { provider: "models", model: "m-1" });
      const route = await s.pump(s.call(`/v1/rigs/${s.rig}/model-route`));
      assert.equal(route.status, 200);
      assert.ok(JSON.stringify(await route.json()).includes(MODEL_KEY));
      // The MCP servers its run's kit names, with their sign-in: the supervisor gets them through
      // the tunnel and hands the harness its share (a 404 here would read as an older control).
      new McpServers(s.store, s.secrets).put(
        { name: "gbrain", url: "https://brain.example.com/mcp", auth: "key", secret: MCP_KEY },
        "owner:test",
      );
      assigned(s.store, s.rig, "run-1", "camp", {
        mcp_servers: [{ name: "gbrain", agents: ["workers"] }],
      });
      const mcp = await s.pump(syncMcpServers(cfg));
      assert.equal(mcp.handed, "set");
      assert.deepEqual(
        mcp.servers.map((c) => [c.name, c.headers.Authorization]),
        [["gbrain", MCP_KEY]],
      );
      const held = await harness.request("/v1/mcp-servers", {
        headers: { authorization: "Bearer sup" },
      });
      assert.deepEqual(
        ((await held.json()) as { servers: { name: string }[] }).servers.map((x) => x.name),
        ["gbrain"],
        "the harness holds the workers' server",
      );
      // What crossed the proxy: no marker, no key, no code, no token, no plain JSON.
      const all = Buffer.concat(s.wire).toString("latin1");
      for (const secret of [
        MARKER,
        MODEL_KEY,
        MCP_KEY,
        s.minted.env.THERMITE_TUNNEL_ENROLL_CODE,
        s.opts.localToken,
        '"commands"',
        '"events"',
      ])
        assert.ok(!all.includes(secret), `${secret.slice(0, 12)}… crossed in plain text`);
      // The pod never connected anywhere: every request went from control to the pod.
      assert.ok(s.sent.every((b) => b.length <= TUNNEL_MAX_REQUEST));
    } finally {
      await s.stop();
    }
  });

  test("a large answer crosses in parts, each request within the limit", async () => {
    const s = await setup();
    try {
      assert.equal(await s.tunnels.step(s.rig), "enrolled");
      const big = randomBytes(2_500_000);
      s.tunnels.serveWith(async () => new Response(new Uint8Array(big), { status: 200 }));
      const before = s.sent.length;
      const res = await s.pump(s.call(`/v1/rigs/${s.rig}/model-route`));
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), big);
      const requests = s.sent.slice(before);
      assert.ok(requests.length >= 5, "several exchanges carried it");
      assert.ok(requests.every((b) => b.length <= TUNNEL_MAX_REQUEST));
    } finally {
      await s.stop();
    }
  });

  test("the supervisor starts pull mode from the launch's values, and keeps the code and RunPod's key from what it starts", async () => {
    const port = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        srv.close(() => resolve(typeof a === "object" && a ? a.port : 0));
      });
    });
    const control = generateSigningKeys();
    const store = new ControlStore(":memory:");
    const tunnels = new ControlTunnels(store, SecretBox.ephemeral(), control.privateKeyPem);
    const minted = tunnels.mint({ by: "owner:ui" });
    const home = mkdtempSync(join(tmpdir(), "thermite-pull-"));
    const env: NodeJS.ProcessEnv = {
      ...minted.env,
      THERMITE_TUNNEL_PORT: String(port),
      RUNPOD_POD_ID: "pod9",
      RUNPOD_API_KEY: "rpa_made-up-key-0001",
    };
    assert.equal(await startPullMode({}, minted.rig, home), undefined, "off without the port");
    for (const name of ["THERMITE_TUNNEL_PREFIX", "THERMITE_TUNNEL_ENROLL_CODE", "RUNPOD_POD_ID"])
      assert.throws(
        () => pullModeOptions({ ...env, [name]: "" }, minted.rig, home),
        new RegExp(`pull mode needs ${name}`),
      );
    assert.throws(
      () => pullModeOptions({ ...env, THERMITE_TUNNEL_CONTROL_BOX: "bm90" }, minted.rig, home),
      /not a public key/,
    );
    assert.throws(
      () => pullModeOptions({ ...env, THERMITE_TUNNEL_PORT: "http" }, minted.rig, home),
      /THERMITE_TUNNEL_PORT takes a whole number from 1 to 65535, not "http"/,
    );
    const pull = await startPullMode(env, minted.rig, home);
    try {
      assert.ok(pull);
      assert.equal(env.THERMITE_TUNNEL_ENROLL_CODE, undefined);
      assert.equal(env.RUNPOD_API_KEY, undefined);
      assert.match(pull.controlUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.deepEqual(pull.dirs, [join(home, "tunnel"), join(home, "enrolled")]);
      assert.equal(pull.tunnel.ports().public_port, port);
      await isEmpty404(await raw(`http://127.0.0.1:${port}/`), "the pod's port");
    } finally {
      await pull?.tunnel.stop();
    }
  });
});
