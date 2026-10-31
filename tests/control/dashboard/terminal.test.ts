import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  XTERM_DIR,
  XTERM_SHA256,
  xtermFile,
} from "../../../src/control/dashboard/live/terminal.ts";
import { prepareCommand } from "../../../src/control/issue/index.ts";
import { TERMINAL_JS } from "../../../src/control/ui/terminal.ts";
import { SCREENS_WATCHED_MAX } from "../../../src/core/screens.ts";
import { TERMINAL_KEYS } from "../../../src/core/terminal-input.ts";
import { ModelSource, TrialConsole } from "../../../src/harness/agents/index.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { ask } from "../../../src/supervisor/ask.ts";
import { relayScreensOnce } from "../../../src/supervisor/live/index.ts";
import { ADMIN, controlStack, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { type PushedEvent, readPushed } from "../../helpers/sse.ts";

/**
 * A trial's terminal on its Live page (goal 169): the owner's alone. Its screen goes from the
 * harness through the supervisor to control only while a page watches it, and stays in memory;
 * the console sends terminal_input, the owner's signed command; no other token can send one.
 */

const TRIAL = "t-0123456789abcdef";
const PAGE = `/ui/rigs/rig-a/live?source=trial:${TRIAL}`;
const SCREEN = `/ui/rigs/rig-a/live/screen?trial=${TRIAL}`;
const TOKENS = {
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "reader-token-abcdef",
};

/** What the fake terminal was given, and a screen it shows. */
function fakeTerminal() {
  const typed: { text?: string | undefined; keys?: readonly string[] | undefined }[] = [];
  return {
    typed,
    ownerInput: async (i: { text?: string | undefined; keys?: readonly string[] | undefined }) => {
      typed.push(i);
    },
    limitShown: () => undefined,
    screen: async () => ({ cols: 100, rows: 30, data: "\x1b[32mSCREEN-OF-THE-AGENT\x1b[0m" }),
    lastScreen: () => undefined,
  };
}

/** Control, rig-a with run js-1 at work and lane-1's trial in its terminal, the owner signed in. */
async function setup() {
  const s = controlStack({ tokens: TOKENS });
  await s.env.service.applyCommand(s.env.assign);
  new Registry(s.env.ledger).startTrial({
    id: TRIAL,
    run: "js-1",
    lane: "lane-1",
    epoch: 1,
    family: "f",
    parent: "p",
    token: "tok-terminal",
  });
  const term = fakeTerminal();
  s.env.service.consoles.set(TRIAL, new TrialConsole(term));
  await s.relay();
  s.store.liveLines.add(
    "rig-a",
    "log-t",
    [
      {
        seq: 1,
        at: new Date().toISOString(),
        source: `trial:${TRIAL}`,
        kind: "status",
        text: "trial on f: make it faster",
        lane: "lane-1",
        run: "js-1",
      },
    ],
    true,
  );
  const owner = await signIn(s.control);
  // The supervisor's calls, and those that reached the harness's screens route.
  const asked: string[] = [];
  const fetchImpl = s.cfg.fetchImpl as typeof fetch;
  const cfg = {
    harnessUrl: s.cfg.harnessUrl,
    harnessToken: s.cfg.harnessToken,
    control: { rig: "rig-a", bus: s.bus },
    fetchImpl: (async (input, init) => {
      if (String(input).includes("/v1/screens")) asked.push(String(init?.body ?? ""));
      return await fetchImpl(input, init);
    }) as typeof fetch,
  };
  return { ...s, owner, term, asked, screensCfg: cfg };
}

/** The trials control says are watched, once there are `n`, or after a second. */
async function watchedSoon(cfg: Parameters<typeof relayScreensOnce>[0], n: number) {
  let watch: string[] = [];
  for (let i = 0; i < 50; i++) {
    watch = await relayScreensOnce(cfg, []);
    if (watch.length === n) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return watch;
}

const frames = (events: PushedEvent[]) =>
  events
    .filter((e) => e.event === "frame")
    .map((e) => JSON.parse(e.data) as Record<string, unknown>);

describe("a trial's terminal on Live", () => {
  test("its page shows the owner its terminal and console, with every named key; xterm.js is served as pinned", async () => {
    const s = await setup();
    const html = await s.owner.page(PAGE);
    assert.match(html, /data-term="\/ui\/rigs\/rig-a\/live\/screen\?trial=t-0123456789abcdef"/);
    assert.match(html, /data-term-console/);
    for (const k of TERMINAL_KEYS) assert.match(html, new RegExp(`name="key" value="${k}"`));
    assert.match(html, /<script src="\/ui\/assets\/xterm\.js" defer>/);
    assert.match(html, /Nothing typed yet/);
    // The run's Live lists each lane's terminal when the rig runs its programs in them.
    const run = await s.owner.page("/ui/campaigns/js-sum/runs/js-1/live");
    assert.match(
      run,
      /<a href="\/ui\/rigs\/rig-a\/live\?source=trial%3At-0123456789abcdef">lane-1's terminal<\/a>/,
    );
    const xterm = await s.owner.get("/ui/assets/xterm.js");
    assert.equal(xterm.status, 200);
    assert.equal(
      createHash("sha256")
        .update(Buffer.from(await xterm.arrayBuffer()))
        .digest("hex"),
      XTERM_SHA256["xterm.js"],
    );
    assert.ok(xtermFile("xterm.css")?.includes(".xterm"), XTERM_DIR);
    const js = await (await s.owner.get("/ui/assets/terminal.js")).text();
    assert.equal(js, TERMINAL_JS);
    assert.doesNotThrow(() => new Function(TERMINAL_JS));
    assert.match(TERMINAL_JS, /disableStdin: true/);
    assert.match(TERMINAL_JS, /linkHandler: \{ activate: \(\) => \{\} \}/);
  });

  test("a rig whose workers run in Pi lists their terminals too, and a trial's page draws its Pi view's", async () => {
    const s = await setup();
    // The rig's own model, with no harness named: its workers run in Pi, which the rig reports.
    s.env.service.models = new ModelSource(
      join(mkdtempSync(join(tmpdir(), "thermite-pi-")), "route.json"),
      {
        baseUrl: "http://127.0.0.1:9/v1",
        model: "local",
        apiKey: "k",
        contextWindow: 32_000,
        maxTokens: 2_000,
      },
    );
    await s.relay();
    const run = await s.owner.page("/ui/campaigns/js-sum/runs/js-1/live");
    assert.match(
      run,
      /<a href="\/ui\/rigs\/rig-a\/live\?source=trial%3At-0123456789abcdef">lane-1's terminal<\/a>/,
    );
    const html = await s.owner.page(PAGE);
    assert.match(html, /data-term="\/ui\/rigs\/rig-a\/live\/screen\?trial=t-0123456789abcdef"/);
    assert.match(html, /data-term-console/);
  });

  test("no other token sees the view or the console: the dashboard signs in the owner alone", async () => {
    const s = await setup();
    for (const token of Object.values(TOKENS)) {
      const other = await signIn(s.control, token);
      assert.equal(other.cookie, "", "no session for a token that is not the owner's");
      for (const path of [PAGE, SCREEN, "/ui/assets/xterm.js"]) {
        const r = await s.control.request(path, {
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(r.status, 303, `${path} with another token`);
        assert.match(String(r.headers.get("location")), /\/ui\/login/);
      }
    }
    // The reader's live lines over REST carry no screen.
    const lines = await s.control.request("/v1/rigs/rig-a/live", {
      headers: { authorization: `Bearer ${TOKENS.read}` },
    });
    assert.doesNotMatch(await lines.text(), /SCREEN-OF-THE-AGENT/);
  });

  test("its screen goes to control only while a page watches it, held in memory, never recorded", async () => {
    const s = await setup();
    // Nobody watches: the supervisor asks the harness for nothing, and control keeps nothing.
    assert.deepEqual(await relayScreensOnce(s.screensCfg, []), []);
    assert.deepEqual(s.asked, []);
    const unasked = await ask(s.screensCfg.control, "screens", {
      frames: [{ trial: TRIAL, state: "running", cols: 1, rows: 1, data: "x", at: "now" }],
    });
    assert.deepEqual(unasked, { watch: [] });
    // A page watches: control says so, the supervisor sends the screen, the page gets it.
    const page = await s.owner.get(SCREEN);
    const reading = readPushed(page, (e) => frames(e).length > 0, 5000);
    const watch = await watchedSoon(s.screensCfg, 1);
    assert.deepEqual(watch, [TRIAL]);
    assert.deepEqual(await relayScreensOnce(s.screensCfg, watch), [TRIAL]);
    const [frame] = frames(await reading);
    assert.deepEqual(
      { state: frame?.state, cols: frame?.cols, rows: frame?.rows, data: frame?.data },
      { state: "running", cols: 100, rows: 30, data: "\x1b[32mSCREEN-OF-THE-AGENT\x1b[0m" },
    );
    assert.equal(s.asked.length, 1);
    // The page went: nobody watches, and control dropped the screen it held. A new page waits
    // for a new screen.
    assert.deepEqual(await watchedSoon(s.screensCfg, 0), []);
    const again = await readPushed(await s.owner.get(SCREEN), (e) => frames(e).length > 0, 300);
    assert.deepEqual(frames(again), []);
    assert.ok(again.some((e) => e.event === "waiting"));
    // Nothing of it was recorded: not in the rig's ledger, nor in control's live lines.
    await s.relay();
    const ledger = JSON.stringify(s.env.ledger.eventsAfter(0, 10_000).events);
    assert.doesNotMatch(ledger, /SCREEN-OF-THE-AGENT/);
    assert.doesNotMatch(JSON.stringify(s.store.liveLines.tail("rig-a", 1000)), /SCREEN-OF/);
  });

  test("at most SCREENS_WATCHED_MAX of a rig's terminals are watched at once; one more is told why", async () => {
    const s = await setup();
    const held = await Promise.all(
      Array.from({ length: SCREENS_WATCHED_MAX }, (_, i) =>
        s.owner.get(`/ui/rigs/rig-a/live/screen?trial=t-other-${i}`),
      ),
    );
    assert.equal(
      (await watchedSoon(s.screensCfg, SCREENS_WATCHED_MAX)).length,
      SCREENS_WATCHED_MAX,
    );
    const busy = await readPushed(await s.owner.get(SCREEN), (e) =>
      e.some((x) => x.event === "busy"),
    );
    assert.match(String(busy.find((e) => e.event === "busy")?.data), /are watched already/);
    for (const r of held) await r.body?.cancel();
  });

  test("the console sends terminal_input as the owner's signed command, typed into the trial's terminal, its outcome shown", async () => {
    const s = await setup();
    const csrf = s.owner.csrfOf(await s.owner.page(PAGE));
    const sent = await s.owner.post(
      "/ui/rigs/rig-a/live/terminal",
      { csrf, run: "js-1", trial: TRIAL, text: "/compact", wait: "queue" },
      { accept: "application/json" },
    );
    assert.equal(sent.status, 200);
    const progress = (await sent.json()) as { follow?: string };
    assert.match(String(progress.follow), /^\/ui\/commands\//);
    const key = await s.owner.post("/ui/rigs/rig-a/live/terminal", {
      csrf,
      run: "js-1",
      trial: TRIAL,
      key: "down",
    });
    assert.equal(key.status, 303);
    // A shell command waits for its confirmation.
    const shell = await s.owner.post(
      "/ui/rigs/rig-a/live/terminal",
      { csrf, run: "js-1", trial: TRIAL, text: "!make clean" },
      { accept: "application/json" },
    );
    assert.equal(shell.status, 400);
    assert.match(String(((await shell.json()) as { said?: string }).said), /Confirm it first/);
    const cmds = s.store.commands.latest("rig-a", "terminal_input", 10);
    assert.deepEqual(cmds.map((c) => [c.issued_by, c.payload.text ?? c.payload.keys]).reverse(), [
      ["owner:ui", "/compact"],
      ["owner:ui", ["down"]],
    ]);
    await s.relay();
    await s.relay();
    assert.deepEqual(s.term.typed, [
      { text: "/compact", keys: undefined },
      { text: undefined, keys: ["down"] },
    ]);
    const html = await s.owner.page(PAGE);
    assert.match(html, /<code>\/compact<\/code> · <span class="ok">typed<\/span>/);
    assert.match(html, /\[down\] · <span class="ok">typed<\/span>/);
  });

  test("a worker in Pi's view: the console offers its commands and a follow-up, sent as follow_up", async () => {
    const s = await setup();
    const html = await s.owner.page(PAGE);
    // Shown only once a frame says the screen is a Pi view.
    assert.match(
      html,
      /<label class="term-confirm" data-term-pi hidden><input type="checkbox" name="follow_up" value="1"> Follow-up/,
    );
    assert.match(
      html,
      /data-term-pi hidden>The Pi view: words steer the agent; <b>Esc<\/b> stops its reply; its commands are \/status, \/compact, \/mcp, \/mcp reconnect \[server\] and \/skill:NAME\./,
    );
    assert.match(TERMINAL_JS, /el\.hidden = !f\.pi_view/);
    const csrf = s.owner.csrfOf(html);
    await s.owner.post("/ui/rigs/rig-a/live/terminal", {
      csrf,
      run: "js-1",
      trial: TRIAL,
      text: "then run the tests",
      follow_up: "1",
    });
    // A key never carries it.
    await s.owner.post("/ui/rigs/rig-a/live/terminal", {
      csrf,
      run: "js-1",
      trial: TRIAL,
      key: "esc",
      follow_up: "1",
    });
    const cmds = s.store.commands.latest("rig-a", "terminal_input", 10).reverse();
    assert.deepEqual(
      cmds.map((c) => [c.payload.text ?? c.payload.keys, c.payload.follow_up ?? null]),
      [
        ["then run the tests", true],
        [["esc"], null],
      ],
    );
    await s.relay();
    await s.relay();
    assert.deepEqual(s.term.typed[0], {
      text: "then run the tests",
      keys: undefined,
      follow_up: true,
    });
    assert.match(
      await s.owner.page(PAGE),
      /<code>then run the tests<\/code> · <span class="ok">typed, as a follow-up<\/span>/,
    );
  });

  test("over MCP and REST, the owner's token alone issues it; control refuses an operator's before signing", async () => {
    const s = await setup();
    const payload = { run: "js-1", trial: TRIAL, text: "/status" };
    const issue = async (client: Client) =>
      (await client.callTool({
        name: "issue_command",
        arguments: { kind: "terminal_input", payload },
      })) as { isError?: boolean; content?: { text?: string }[] };
    assert.ok(!(await issue(await mcpClient(s.control, ADMIN))).isError, "the owner's token");
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read]) {
      const client = await mcpClient(s.control, token);
      let refused = true;
      try {
        refused = Boolean((await issue(client)).isError);
      } catch {
        // The reader has no issue_command at all.
      }
      assert.ok(refused, token);
    }
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read]) {
      const r = await s.control.request("/v1/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ rig: "rig-a", kind: "terminal_input", payload }),
      });
      assert.ok(r.status === 401 || r.status === 403, `${token}: ${r.status}`);
    }
    const rest = await s.control.request("/v1/commands", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ rig: "rig-a", kind: "terminal_input", payload }),
    });
    assert.equal(rest.status, 201);
    assert.throws(
      () =>
        prepareCommand(s.store, s.env.keys.privateKeyPem, {
          kind: "terminal_input",
          payload,
          issuedBy: "owner:operator",
        }),
      /Only the owner types into an agent's terminal/,
    );
    const by = s.store.commands.latest("rig-a", "terminal_input", 10).map((c) => c.issued_by);
    assert.deepEqual(by.sort(), ["owner:api", "owner:mcp"]);
  });
});
