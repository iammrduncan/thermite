import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  POD_LOG_MAX_TAIL,
  POD_LOG_TAIL,
  podLogs,
  SseParser,
} from "../../../src/control/runpod/cloud.ts";
import { type PodLogRead, RunpodRigs } from "../../../src/control/runpod/rigs.ts";
import { ControlTunnels } from "../../../src/control/runpod/tunnel.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { generateSigningKeys } from "../../../src/core/commands.ts";
import { TEST_BUS_CA } from "../../helpers/bus-ca.ts";
import { controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { controlStore, ingestReport } from "../../helpers/control-store.ts";
import { FAKE_RUNPOD_KEY, fakeRunpod } from "../../helpers/fake-runpod.ts";

/** A pod log read stops this soon after the last line here, so the tests take little time. */
const FAST = { idleMs: 150, totalMs: 3_000 };

const tokens = {
  admin: "owner-token-abcdef",
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "read-token-abcdef",
  rigs: {},
};

/** Control with a RunPod account (the fake RunPod) and one rig launched on it, not enrolled. */
async function setup(o: Parameters<typeof fakeRunpod>[0] = {}) {
  const store = controlStore();
  const secrets = SecretBox.ephemeral();
  store.gpuClouds.add({
    name: "runpod",
    kind: "runpod",
    key_sealed: secrets.seal(FAKE_RUNPOD_KEY),
    key_hint: "…cdef",
    by: "owner:ui",
  });
  const cloud = fakeRunpod(o);
  const keys = generateSigningKeys();
  const tunnels = new ControlTunnels(store, secrets, keys.privateKeyPem, { busCa: TEST_BUS_CA });
  const rigs = new RunpodRigs(store, secrets, tunnels, {
    fetch: cloud.fetch,
    image: "ghcr.io/example/thermite-rig:test-cuda",
    privateKeyPem: keys.privateKeyPem,
    logTimes: FAST,
  });
  const { control: api } = controlOnly({
    store,
    keys,
    tokens,
    options: { secrets, tunnels, runpodRigs: rigs, cloudFetch: cloud.fetch },
  });
  const v = await rigs.launch("runpod", { gpu: "RTX A4000", rig: "rp-log-1" }, "owner:api");
  // What the pod printed before anyone read it: RunPod's own steps and the rig image's lines.
  cloud.log(v.pod, "system", "Pulling image ghcr.io/example/thermite-rig:test-cuda");
  cloud.log(v.pod, "system", "Container started");
  cloud.log(v.pod, "container", "thermite rig: waiting for control to enroll this pod");
  const rest = (path: string, token = tokens.admin) =>
    api.request(path, { headers: { authorization: `Bearer ${token}` } });
  return { store, cloud, rigs, api, pod: v.pod, rest };
}

describe("Server-Sent Events, read strictly", () => {
  test("data lines join with a line feed; comments, ids and unknown fields are ignored", () => {
    const p = new SseParser();
    const out = p.push(
      ': a comment\n\nid: 1\nretry: 10\nfoo: bar\ndata: {"a":\ndata:1}\n\ndata\n\nevent: ping\ndata: x\n\n',
    );
    assert.deepEqual(out, [
      { event: "message", data: '{"a":\n1}' },
      { event: "ping", data: "x" },
    ]);
  });

  test("CRLF, CR and LF all end a line, also when a chunk ends between CR and LF", () => {
    const p = new SseParser();
    const got = [
      ...p.push("\uFEFFdata: one\r"),
      ...p.push("\n\r\ndata: two\r\rdata: thr"),
      ...p.push("ee\n\n"),
    ];
    assert.deepEqual(
      got.map((e) => e.data),
      ["one", "two", "three"],
    );
    // An event the stream cut before its blank line is not one.
    assert.deepEqual(p.push("data: cut"), []);
    assert.deepEqual(p.end(), []);
  });
});

describe("a pod's log from RunPod", () => {
  test("the lines, oldest first, with their source and time; 200 asked for by default, with the key", async () => {
    const s = await setup();
    const lines = await podLogs(FAKE_RUNPOD_KEY, s.pod, FAST, s.cloud.fetch);
    assert.deepEqual(
      lines.map((l) => [l.source, l.line]),
      [
        ["system", "Pulling image ghcr.io/example/thermite-rig:test-cuda"],
        ["system", "Container started"],
        ["container", "thermite rig: waiting for control to enroll this pod"],
      ],
    );
    assert.match(lines[0]?.ts ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    const call = s.cloud.calls.at(-1);
    assert.equal(call?.path, `/v2/pods/${s.pod}/logs`);
    assert.equal(call?.search, "?tail=200");
    assert.equal(s.cloud.openLogStreams(), 0, "control closed the stream");
    const sys = await podLogs(FAKE_RUNPOD_KEY, s.pod, { ...FAST, source: "system" }, s.cloud.fetch);
    assert.deepEqual(
      sys.map((l) => l.source),
      ["system", "system"],
    );
  });

  test("tail is capped at 2000, and the read stops once tail lines came", async () => {
    const s = await setup();
    for (let i = 0; i < 2100; i++) s.cloud.log(s.pod, "container", `line ${i}`);
    const many = await podLogs(FAKE_RUNPOD_KEY, s.pod, { tail: 9999 }, s.cloud.fetch);
    assert.equal(s.cloud.calls.at(-1)?.search, `?tail=${POD_LOG_MAX_TAIL}`);
    assert.equal(many.length, POD_LOG_MAX_TAIL);
    assert.equal(many.at(-1)?.line, "line 2099", "the newest lines");
    // Stopped at tail lines, not at the idle stop: no wait at all.
    const t0 = Date.now();
    const few = await podLogs(FAKE_RUNPOD_KEY, s.pod, { tail: 5 }, s.cloud.fetch);
    assert.ok(Date.now() - t0 < 1_000, "it did not wait for the idle stop");
    assert.deepEqual(
      few.map((l) => l.line),
      ["line 2095", "line 2096", "line 2097", "line 2098", "line 2099"],
    );
    assert.equal(s.cloud.openLogStreams(), 0);
  });

  test("the idle stop: once no line came for 2 seconds, control stops reading the open stream", async () => {
    const s = await setup();
    const t0 = Date.now();
    const lines = await podLogs(FAKE_RUNPOD_KEY, s.pod, {}, s.cloud.fetch);
    const took = Date.now() - t0;
    assert.equal(lines.length, 3);
    assert.ok(took >= 1_900 && took < 4_000, `stopped after ${took} ms`);
    assert.equal(s.cloud.openLogStreams(), 0, "the stream RunPod kept open was aborted");
  });

  test("a stream that never goes quiet stops after the total time, with what came", async () => {
    const s = await setup();
    const tick = setInterval(() => s.cloud.log(s.pod, "container", "still busy"), 20);
    try {
      const t0 = Date.now();
      const lines = await podLogs(
        FAKE_RUNPOD_KEY,
        s.pod,
        { idleMs: 500, totalMs: 400 },
        s.cloud.fetch,
      );
      const took = Date.now() - t0;
      assert.ok(took >= 350 && took < 1_500, `stopped after ${took} ms`);
      assert.ok(lines.length > 3 && lines.length < POD_LOG_TAIL);
      assert.equal(s.cloud.openLogStreams(), 0);
    } finally {
      clearInterval(tick);
    }
  });

  test("a key that may not read logs, a wrong key and a pod RunPod no longer has: each in words, never the key", async () => {
    const s = await setup({ noLogs: true });
    await assert.rejects(podLogs(FAKE_RUNPOD_KEY, s.pod, FAST, s.cloud.fetch), (err: Error) => {
      assert.match(err.message, /may not read pod logs/);
      assert.ok(!err.message.includes(FAKE_RUNPOD_KEY));
      return true;
    });
    const t = await setup();
    await assert.rejects(
      podLogs("rpa_wrong-key-0000000000", t.pod, FAST, t.cloud.fetch),
      /RunPod refused the key: it is wrong or was revoked/,
    );
    await assert.rejects(
      podLogs(FAKE_RUNPOD_KEY, "gone1", FAST, t.cloud.fetch),
      /RunPod has no pod gone1/,
    );
    const down = await setup();
    const off = fakeRunpod({ down: true });
    await assert.rejects(
      podLogs(FAKE_RUNPOD_KEY, down.pod, FAST, off.fetch),
      (err: Error) =>
        /control could not reach RunPod/.test(err.message) &&
        !err.message.includes(FAKE_RUNPOD_KEY),
    );
  });

  test("a line that holds a token or a key is redacted, and terminal colours are taken out", async () => {
    const s = await setup();
    s.cloud.log(s.pod, "container", "downloading with hf_example-token-0002 set");
    s.cloud.log(s.pod, "container", "request sent with Authorization: Bearer abc.def.ghi");
    s.cloud.log(s.pod, "container", `using key ${FAKE_RUNPOD_KEY}`);
    s.cloud.log(s.pod, "container", "\u001b[32mready\u001b[0m");
    const lines = (await podLogs(FAKE_RUNPOD_KEY, s.pod, FAST, s.cloud.fetch)).map((l) => l.line);
    const text = lines.join("\n");
    assert.ok(!text.includes("example-token-0002"));
    assert.ok(!text.includes("abc.def.ghi"));
    assert.ok(!text.includes(FAKE_RUNPOD_KEY));
    assert.ok(lines.includes("downloading with hf_*** set"));
    assert.ok(lines.includes("using key rpa_***"));
    assert.equal(lines.at(-1), "ready");
  });
});

describe("a RunPod rig's pod log over REST and MCP", () => {
  test("REST: the owner reads it; tail and source are checked; another token gets 401; a rig not on RunPod 404", async () => {
    const s = await setup();
    const r = await s.rest("/v1/rigs/rp-log-1/runpod/logs");
    assert.equal(r.status, 200);
    const body = (await r.json()) as PodLogRead;
    assert.deepEqual(Object.keys(body).sort(), ["lines", "pod", "read_at", "rig"]);
    assert.equal(body.rig, "rp-log-1");
    assert.equal(body.pod, s.pod);
    assert.deepEqual(Object.keys(body.lines[0] ?? {}).sort(), ["line", "source", "ts"]);
    assert.equal(body.lines.length, 3);
    const sys = (await (
      await s.rest("/v1/rigs/rp-log-1/runpod/logs?source=system&tail=1")
    ).json()) as PodLogRead;
    assert.deepEqual(
      sys.lines.map((l) => l.line),
      ["Container started"],
    );
    assert.equal(s.cloud.calls.at(-1)?.search, "?tail=1&source=system");
    await s.rest("/v1/rigs/rp-log-1/runpod/logs?tail=50000");
    assert.equal(s.cloud.calls.at(-1)?.search, "?tail=2000", "capped at 2000");
    for (const q of ["tail=0", "tail=abc", "tail=-3", "source=both"])
      assert.equal((await s.rest(`/v1/rigs/rp-log-1/runpod/logs?${q}`)).status, 400, q);
    for (const t of [tokens.operator, tokens.agent, tokens.read])
      assert.equal((await s.rest("/v1/rigs/rp-log-1/runpod/logs", t)).status, 401);
    await ingestReport(s.store, {
      rig: "plain-1",
      ledger_id: "l1",
      cursor: 0,
      next: 0,
      summary: {},
      events: [],
    });
    const plain = await s.rest("/v1/rigs/plain-1/runpod/logs");
    assert.equal(plain.status, 404);
    assert.deepEqual(await plain.json(), { error: "not found" });
  });

  test("REST: RunPod's refusal comes back in words, as 502", async () => {
    const s = await setup({ noLogs: true });
    const r = await s.rest("/v1/rigs/rp-log-1/runpod/logs");
    assert.equal(r.status, 502);
    const { error } = (await r.json()) as { error: string };
    assert.match(error, /may not read pod logs/);
    assert.ok(!error.includes(FAKE_RUNPOD_KEY));
  });

  test("MCP: runpod_rig_logs for the owner and the operator; not a reader's or an agent's", async () => {
    const s = await setup();
    const names = async (token: string) =>
      (await (await mcpClient(s.api, token)).listTools()).tools.map((t) => t.name);
    for (const t of [tokens.admin, tokens.operator])
      assert.ok((await names(t)).includes("runpod_rig_logs"));
    for (const t of [tokens.read, tokens.agent])
      assert.ok(!(await names(t)).includes("runpod_rig_logs"));
    const operator = await mcpClient(s.api, tokens.operator);
    const r = await operator.callTool({
      name: "runpod_rig_logs",
      arguments: { rig: "rp-log-1", tail: 2, source: "system" },
    });
    assert.notEqual(r.isError, true);
    const read = JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as PodLogRead;
    assert.equal(read.pod, s.pod);
    assert.deepEqual(
      read.lines.map((l) => l.line),
      ["Pulling image ghcr.io/example/thermite-rig:test-cuda", "Container started"],
    );
    const none = await operator.callTool({ name: "runpod_rig_logs", arguments: { rig: "nope" } });
    assert.equal(none.isError, true);
    assert.match((none.content as { text: string }[])[0]?.text ?? "", /no rig nope on a GPU cloud/);
  });
});

describe("a RunPod rig's pod log on its page", () => {
  /** The rig's page, signed in as the owner, with the form token. */
  async function signedIn(s: Awaited<ReturnType<typeof setup>>) {
    const { page, csrfOf, post } = await signIn(s.api, tokens.admin);
    const csrf = csrfOf(await page("/ui/settings"));
    const read = (json: boolean) =>
      post("/ui/rigs/rp-log-1/runpod/logs", { csrf }, json ? { accept: "application/json" } : {});
    return { page, read };
  }

  test("before it enrolls: below Getting it ready, read once as the page opens; Read again shows the lines, each marked", async () => {
    const s = await setup();
    s.cloud.log(s.pod, "container", "token ghp_example-token-0001 from env");
    const u = await signedIn(s);
    const before = await u.page("/ui/rigs/rp-log-1");
    assert.match(before, /Getting it ready.*<h2>Pod log<\/h2>.*<h2>The pod<\/h2>/s);
    assert.match(before, /Not read yet\. Reading it…/);
    assert.match(before, /action="\/ui\/rigs\/rp-log-1\/runpod\/logs" data-act data-autoread/);
    assert.match(before, /RunPod's API, with the key of the GPU cloud in Settings › Providers/);
    const calls = s.cloud.calls.length;
    await u.page("/ui/rigs/rp-log-1");
    assert.ok(
      !s.cloud.calls.slice(calls).some((c) => c.path.endsWith("/logs")),
      "loading the page never reads RunPod's log",
    );
    // The page's script sends the form: control answers how it went, and the block is drawn again.
    const r = await u.read(true);
    const a = (await r.json()) as { final: boolean; tone: string; said: string; follow: string };
    assert.equal(a.final, true);
    assert.equal(a.tone, "ok");
    assert.match(a.said, new RegExp(`Read 4 lines of pod ${s.pod}'s log from RunPod\\.`));
    assert.equal(a.follow, "/ui/rigs/rp-log-1/runpod/logs");
    const after = await u.page("/ui/rigs/rp-log-1");
    assert.match(
      after,
      /<div class="pl system"><span class="pl-src">system<\/span><span class="pl-t"[^>]*>[\d:]{8}<\/span><span class="pl-l">Container started<\/span>/,
    );
    assert.match(
      after,
      /<div class="pl container"><span class="pl-src">container<\/span>.*waiting for control to enroll this pod/,
    );
    assert.match(after, /token ghp_\*\*\* from env/);
    assert.ok(!after.includes("example-token-0001"));
    assert.match(after, />Read again<\/button>/);
    assert.match(after, /4 lines, container and system, oldest first/);
    assert.ok(!after.includes("data-autoread"), "read once: no second read as the page opens");
    // Without the page's script, the form posts and the page opens at the block.
    const plain = await u.read(false);
    assert.equal(plain.status, 303);
    assert.match(plain.headers.get("location") ?? "", /\/ui\/rigs\/rp-log-1\?ok=Read.*#podlog$/);
  });

  test("a refusal shows in the block in words", async () => {
    const s = await setup({ noLogs: true });
    const u = await signedIn(s);
    const a = (await (await u.read(true)).json()) as { tone: string; said: string };
    assert.equal(a.tone, "bad");
    assert.match(a.said, /^Not read: RunPod refused to show pod \S+'s log with this key/);
    const page = await u.page("/ui/rigs/rp-log-1");
    assert.match(page, /<div class="flash bad">Not read: RunPod refused to show pod/);
  });

  test("once it reports, the block is lower on its page and waits for Read the log", async () => {
    const s = await setup();
    await ingestReport(s.store, {
      rig: "rp-log-1",
      ledger_id: "l1",
      cursor: 0,
      next: 1,
      summary: {},
      events: [
        {
          id: 1,
          at: new Date().toISOString(),
          actor: "t",
          kind: "rig_started",
          subject: "rp-log-1",
          body: {},
        },
      ],
    });
    const u = await signedIn(s);
    const page = await u.page("/ui/rigs/rp-log-1");
    assert.match(page, /<h2>The pod<\/h2>.*<h2>The judge's last jobs<\/h2>.*<h2>Pod log<\/h2>/s);
    assert.match(page, />Read the log<\/button>/);
    assert.ok(!page.includes("data-autoread"), "no read as the page opens once the rig reports");
  });
});
