import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  eventLine,
  type OpencodePluginContext,
  thermitePlugin,
} from "../../../../src/agents/programs/opencode/plugin.ts";
import { opencodeSession } from "../../../../src/agents/programs/opencode/session-events.ts";

/** The spike's recorded events of OpenCode 2.1.4, as a plugin got them (the README says how). */
const EVENTS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fixtures",
  "session-logs",
  "opencode-2.1.4",
  "opencode-tui",
  "events.jsonl",
);

/** OpenCode as the plugin sees it: its sessions, a prompt route where it has one, its events. */
function fakeOpencode(o: { prompt?: boolean; parent?: string } = {}) {
  const events: unknown[] = [];
  let wake: (() => void) | undefined;
  const prompted: unknown[] = [];
  const ctx: OpencodePluginContext = {
    session: {
      hook: async () => undefined,
      context: async () => [],
      get: async ({ sessionID }) => ({
        id: sessionID,
        ...(sessionID === o.parent ? { parentID: "ses_main" } : {}),
      }),
      ...(o.prompt === false
        ? {}
        : {
            prompt: async (input: unknown) => {
              prompted.push(input);
              return {};
            },
          }),
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<unknown>>((resolve) => {
              const take = () => resolve({ done: false, value: events.shift() });
              if (events.length) take();
              else wake = take;
            }),
        }),
      }),
    },
  };
  return {
    ctx,
    prompted,
    emit: async (...es: unknown[]) => {
      for (const e of es) {
        events.push(e);
        wake?.();
        await new Promise((r) => setTimeout(r, 5));
      }
      await new Promise((r) => setTimeout(r, 40));
    },
  };
}

/** A stand-in for the harness's trial routes that counts the offers asked for. */
async function harness() {
  let offers = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.endsWith("/offer")) offers++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ offer: null, text: "" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    offers: () => offers,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("Thermite's OpenCode plugin: a trial's signals (goal 169)", () => {
  test("every event it gets goes to the trial's signals file, and reads back as OpenCode's own events; the streamed deltas are left out", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "thermite-plugin-")), "opencode-signals.jsonl");
    const f = fakeOpencode({ prompt: false });
    const stop = await thermitePlugin({ THERMITE_SIGNALS: file }).setup(f.ctx);
    const recorded = readFileSync(EVENTS, "utf8").split("\n").filter(Boolean);
    await f.emit(
      ...recorded.map((l) => ({ ...JSON.parse(l), location: { directory: "/somewhere" } })),
    );
    stop?.();
    const written = readFileSync(file, "utf8").trim().split("\n");
    assert.ok(written.every((l) => !("location" in JSON.parse(l))));
    assert.ok(written.every((l) => !l.includes('.delta"')));
    const read = (lines: string[]) => {
      const s = opencodeSession.newState();
      return { events: opencodeSession.read(lines, s), unknown: opencodeSession.unknown(s) };
    };
    assert.deepEqual(read(written), read(recorded));
    assert.deepEqual(read(written).unknown, new Map());
  });

  test("a long event is cut to its type and session", () => {
    const line = eventLine({
      id: "e-1",
      type: "session.tool.success",
      data: {
        sessionID: "ses_1",
        ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "z".repeat(900)])),
      },
    });
    assert.ok(Buffer.byteLength(line) <= 16 * 1024);
    assert.deepEqual(JSON.parse(line).data, { sessionID: "ses_1", cut: true });
  });

  test("it asks for the owner's message only when the agent's own session starts a tool, and only where OpenCode can take one", async () => {
    const h = await harness();
    const env = {
      THERMITE_SIGNALS: join(mkdtempSync(join(tmpdir(), "thermite-plugin-")), "s.jsonl"),
      THERMITE_HARNESS_URL: h.url,
      THERMITE_TRIAL_AUTH: "trial.tok",
    };
    const called = (sessionID: string) => ({
      type: "session.tool.called",
      data: { sessionID, id: "call_1" },
    });
    const f = fakeOpencode({ parent: "ses_sub" });
    const stop = await thermitePlugin(env).setup(f.ctx);
    await f.emit(called("ses_sub"), {
      type: "session.tool.success",
      data: { sessionID: "ses_main" },
    });
    assert.equal(h.offers(), 0, "a subagent's tool, and a tool that ended");
    await f.emit(called("ses_main"));
    assert.equal(h.offers(), 1);
    assert.deepEqual(f.prompted, [], "none offered: nothing steered");
    stop?.();
    const old = fakeOpencode({ prompt: false });
    const stopOld = await thermitePlugin(env).setup(old.ctx);
    await old.emit(called("ses_main"));
    assert.equal(h.offers(), 1, "an OpenCode with no prompt route asks for none");
    stopOld?.();
    const none = fakeOpencode();
    const stopNone = await thermitePlugin({ ...env, THERMITE_TRIAL_AUTH: "" }).setup(none.ctx);
    await none.emit(called("ses_main"));
    assert.equal(h.offers(), 1, "without the trial's credential it asks for none");
    stopNone?.();
    await h.close();
  });
});
