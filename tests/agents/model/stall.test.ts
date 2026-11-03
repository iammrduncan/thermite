import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildModel } from "../../../src/agents/model/index.ts";
import {
  DataSeen,
  modelStallMs,
  STALL_SETTING,
  stalledFor,
  stallGuard,
  stallWords,
} from "../../../src/agents/model/stall.ts";
import {
  classifyProviderError,
  type FailureCount,
} from "../../../src/harness/agents/provider-errors.ts";
import {
  keepGoing,
  type ProviderWait,
  runTrial,
} from "../../../src/harness/agents/worker/index.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/** Runs `f` with THERMITE_MODEL_STALL_SECONDS set to `s`, then puts it back. */
async function withStall<T>(s: string, f: () => Promise<T>): Promise<T> {
  const before = process.env[STALL_SETTING];
  process.env[STALL_SETTING] = s;
  try {
    return await f();
  } finally {
    if (before === undefined) delete process.env[STALL_SETTING];
    else process.env[STALL_SETTING] = before;
  }
}

/** A chat completions request to a fake model, as pi-ai sends one. */
const ask = (fetch: typeof globalThis.fetch, url: string) =>
  fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
};

describe("a model stream that goes silent (goal 079)", () => {
  test("THERMITE_MODEL_STALL_SECONDS: 600 s unless set, 0 turns it off, anything else is refused", () => {
    assert.equal(modelStallMs({}), 600_000);
    assert.equal(modelStallMs({ [STALL_SETTING]: "" }), 600_000);
    assert.equal(modelStallMs({ [STALL_SETTING]: "900" }), 900_000);
    assert.equal(modelStallMs({ [STALL_SETTING]: "0.5" }), 500);
    assert.equal(modelStallMs({ [STALL_SETTING]: "0" }), undefined);
    for (const bad of ["ten", "-1", "Infinity"])
      assert.throws(
        () => modelStallMs({ [STALL_SETTING]: bad }),
        new RegExp(
          `^Error: THERMITE_MODEL_STALL_SECONDS takes a number of seconds from 0 \\(0: off\\), not "${bad}"$`,
        ),
      );
    assert.equal(stallWords(600_000), "the model's stream went silent for 600 s");
    assert.equal(stallWords(300), "the model's stream went silent for 0.3 s");
    assert.equal(stalledFor("504: the model's stream went silent for 600 s"), "600");
  });

  test("a silent stream is the provider's passing fault, as words and as a gateway's 504", () => {
    for (const text of [
      stallWords(600_000),
      `504 {"type":"error","error":{"type":"model_stream_silent","message":"${stallWords(600_000)}"}}`,
    ])
      assert.equal(classifyProviderError(text).kind, "server", text);
  });

  test("keep-alive comments and pings are not data; any other line is", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const sse = new DataSeen("text/event-stream; charset=utf-8");
    assert.equal(sse.feed(enc(": OPENROUTER PROCESSING\n\n")), false);
    assert.equal(sse.feed(enc('event: ping\ndata: {"type": "ping"}\n\n')), false);
    // A data line counts once it is whole, also when it comes in two parts.
    assert.equal(sse.feed(enc('data: {"choices":')), false);
    assert.equal(sse.feed(enc("[]}\n\n")), true);
    assert.equal(new DataSeen("application/json").feed(enc("{")), true);
  });

  test("the guard breaks off a call that sends nothing, or only keep-alives, and only those", async () => {
    const fake = await startFakeModel(() => ({ silent: "open" }));
    const said: number[] = [];
    const guarded = stallGuard(globalThis.fetch, 300, (ms) => said.push(ms));
    try {
      // Headers, then nothing: reading the answer fails with the words, and the provider's
      // connection is closed.
      const open = await ask(guarded, fake.url);
      assert.equal(open.status, 200);
      const t0 = Date.now();
      await assert.rejects(
        open.text(),
        /^ModelStreamSilent: the model's stream went silent for 0\.3 s$/,
      );
      assert.ok(Date.now() - t0 >= 250, "not before its time");
      await until(() => fake.closedEarly === 1);
      assert.equal(fake.closedEarly, 1);
      assert.deepEqual(said, [300]);
    } finally {
      await fake.close();
    }
    // Only comment lines, as a gateway keeps a connection alive while its model sends nothing:
    // the same.
    const alive = await startFakeModel(() => ({ silent: "keep_alive" }));
    try {
      const r = await ask(guarded, alive.url);
      await assert.rejects(r.text(), /went silent for 0\.3 s/);
      await until(() => alive.closedEarly === 1);
      assert.equal(alive.closedEarly, 1);
    } finally {
      await alive.close();
    }
    // No answer at all: a gateway's 504 with the words.
    const none = await startFakeModel(() => ({ silent: "no_answer" }));
    try {
      const r = await ask(guarded, none.url);
      assert.equal(r.status, 504);
      assert.deepEqual(await r.json(), {
        type: "error",
        error: { type: "model_stream_silent", message: "the model's stream went silent for 0.3 s" },
      });
      await until(() => none.closedEarly === 1);
      assert.equal(none.closedEarly, 1);
    } finally {
      await none.close();
    }
    // A slow stream whose data keeps coming is never cut, however long it lasts; nor is a reader
    // that takes its time over data that has come.
    const slow = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t = setInterval(() => {
        res.write(`data: {"n":${++n}}\n\n`);
        if (n === 8) {
          clearInterval(t);
          res.end("data: [DONE]\n\n");
        }
      }, 120);
    });
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/v1`;
      const r = await ask(guarded, url);
      const text = await r.text();
      assert.match(text, /"n":8/);
      const again = await ask(guarded, url);
      const reader = (again.body as ReadableStream<Uint8Array>).getReader();
      let got = "";
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        got += new TextDecoder().decode(part.value);
        await new Promise((r) => setTimeout(r, 400));
      }
      assert.match(got, /\[DONE\]/);
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((r) => slow.close(() => r()));
    }
    assert.deepEqual(said, [300, 300, 300], "only the silent calls");
    // A reader that gives up on an answer (the agent stopped) is not told it went silent.
    const quit = await startFakeModel(() => ({ silent: "open" }));
    try {
      const r = await ask(guarded, quit.url);
      const reader = (r.body as ReadableStream<Uint8Array>).getReader();
      const pending = reader.read();
      await new Promise((x) => setTimeout(x, 50));
      await reader.cancel("the agent stopped");
      assert.deepEqual(await pending, { done: true, value: undefined });
      await new Promise((x) => setTimeout(x, 400));
      assert.deepEqual(said, [300, 300, 300], "a cancelled answer is not silent");
    } finally {
      await quit.close();
    }
  });

  test("Pi's calls: a stream that goes silent ends the call as the provider's server error, with the words", async () => {
    for (const silent of ["open", "keep_alive", "no_answer"] as const) {
      const fake = await startFakeModel(() => ({ silent }));
      try {
        const reply = await withStall("0.3", async () => {
          const { models, model } = buildModel({
            baseUrl: fake.url,
            model: "test",
            apiKey: "k",
            contextWindow: 0,
            maxTokens: 0,
          });
          return models.completeSimple(model, {
            messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
          });
        });
        assert.equal(reply.stopReason, "error", silent);
        assert.match(
          String(reply.errorMessage),
          /the model's stream went silent for 0\.3 s/,
          silent,
        );
        assert.equal(classifyProviderError(String(reply.errorMessage)).kind, "server", silent);
        await until(() => fake.closedEarly === 1);
        assert.equal(fake.closedEarly, 1, silent);
      } finally {
        await fake.close();
      }
    }
  });

  test("a Pi trial whose call goes silent is retried in the same conversation, and Live says so", async () => {
    const seen: string[] = [];
    let calls = 0;
    const fake = await startFakeModel(({ messages }) => {
      calls++;
      seen.push(JSON.stringify(messages));
      return calls === 1 ? { silent: "keep_alive" } : { text: "Nothing to change here." };
    });
    const waits: ProviderWait[] = [];
    const scratch = mkdtempSync(join(tmpdir(), "thermite-stall-"));
    try {
      const r = await withStall("0.3", () =>
        runTrial(
          {
            trialId: "t-silent",
            run: "js-1",
            lane: "lane-1",
            workspace: scratch,
            parentCommit: "0".repeat(40),
            editablePaths: ["src/**"],
            brief: "Make work() faster.",
          },
          {
            runner: new LocalRunner(scratch),
            laneTool: [],
            model: {
              baseUrl: fake.url,
              model: "test",
              apiKey: "k",
              contextWindow: 0,
              maxTokens: 0,
            },
            submit: async () => {
              throw new Error("no submission here");
            },
            status: async () => ({}),
            waiting: (w) => waits.push(w),
          },
        ),
      );
      // It went on after the silent call: the trial ended as the model chose, not on an error.
      assert.equal(r.stopped, "no_submission", JSON.stringify(r));
      assert.equal(r.errorKind, undefined);
      assert.equal(r.failing, undefined);
      assert.equal(waits.length, 1);
      assert.equal(waits[0]?.kind, "server");
      assert.match(String(waits[0]?.words), /^the model's stream went silent for 0\.3 s/);
      // The same conversation: the next call has the brief and is told the call failed.
      assert.ok(calls >= 2);
      assert.match(String(seen[1]), /Make work\(\) faster\./);
      assert.match(
        String(seen[1]),
        /The model call failed \(the model's stream went silent for 0\.3 s\)/,
      );
      assert.equal(fake.closedEarly, 1);
      // Live says it in its own words, and the harness logs it.
      const env = makeHarnessEnv();
      env.service.trialWait(
        { id: "t-silent", run: "js-1", lane: "lane-1" },
        waits[0] as ProviderWait,
      );
      const line = env.service.live.since(0, 100).entries.at(-1);
      assert.match(
        String(line?.text),
        /^the model's stream went silent for 0\.3 s: retried at \d\d:\d\d:\d\d UTC, in the same conversation\.$/,
      );
      assert.equal(line?.lane, "lane-1");
    } finally {
      await fake.close();
    }
  });

  test("silent streams that keep coming stop the agents after 30 minutes, as other passing faults do", async () => {
    // A stand-in agent whose every call went silent, and a clock that moves a minute a wait.
    const messages: unknown[] = [];
    const listeners = new Set<(e: unknown) => void>();
    const silentReply = () => {
      const message = {
        role: "assistant",
        stopReason: "error",
        errorMessage: stallWords(600_000),
        usage: { input: 0, output: 0 },
      };
      messages.push(message);
      for (const l of listeners) l({ type: "turn_end", message, toolResults: [] });
    };
    silentReply();
    const agent = {
      state: { messages },
      prompt: async () => silentReply(),
      subscribe: (l: (e: unknown) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    } as never;
    let clock = Date.parse("2026-10-22T16:00:00Z");
    const count: FailureCount = { failures: 0, rateWaits: 0 };
    const end = await keepGoing(agent, () => false, 0, undefined, {
      sleep: async () => {
        clock += 10 * 60_000;
      },
      now: () => clock,
      count,
    });
    assert.equal(end?.stopped, "error");
    assert.equal(end?.kind, "server");
    assert.equal(
      end?.error,
      "no model call worked for 30 minutes (the provider failed for now): the model's stream went silent for 600 s",
    );
  });
});
