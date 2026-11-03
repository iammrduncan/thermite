import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SSEStreamingApi } from "hono/streaming";
import {
  LIVE_PUSH_LINES,
  LIVE_PUSH_RETRY_MS,
  type LiveFeed,
  pushLive,
  pushStart,
  recheckIds,
} from "../../../../src/control/dashboard/live/push.ts";
import { ControlStore } from "../../../../src/control/store/index.ts";

/**
 * The Live pages' push (goal 168, step 2), against a stand-in for the response it writes to: a
 * reader's lines at once and as the store gets them, a reader that falls behind, lines drawn
 * again, and the push's end.
 */

/** What a push wrote: its events, and its other lines (the retry, the comments). */
class FakeStream {
  aborted = false;
  closed = false;
  readonly events: { event?: string; id?: string; data: string }[] = [];
  readonly raw: string[] = [];
  private readonly aborts: (() => void)[] = [];
  private changed: () => void = () => {};

  async writeSSE(m: { event?: string; id?: string; data: string }) {
    this.events.push(m);
    this.changed();
  }
  async write(s: string) {
    this.raw.push(s);
    this.changed();
  }
  onAbort(fn: () => void) {
    this.aborts.push(fn);
  }
  /** The reader goes. */
  abort() {
    this.aborted = true;
    for (const fn of this.aborts) fn();
  }
  /** Waits until `ok` holds, a second at most. */
  async until(ok: () => boolean) {
    const end = Date.now() + 1000;
    while (!ok() && Date.now() < end)
      await new Promise<void>((r) => {
        this.changed = r;
        setTimeout(r, 20);
      });
    assert.ok(ok(), "the push did not write it in time");
  }
  of(type: string) {
    return this.events.filter((e) => e.event === type).map((e) => JSON.parse(e.data));
  }
}

/** A store, how many pushes watch it now, and rig-a's lines as a feed draws them. */
function setup() {
  const store = new ControlStore(":memory:");
  let watching = 0;
  const watch = store.liveLines.watch.bind(store.liveLines);
  store.liveLines.watch = (fn) => {
    watching++;
    const stop = watch(fn);
    return () => {
      watching--;
      stop();
    };
  };
  let seq = 0;
  const add = (rig: string, n: number) =>
    store.liveLines.add(
      rig,
      "log-1",
      Array.from({ length: n }, () => ({
        seq: ++seq,
        at: new Date().toISOString(),
        source: "judge",
        kind: "log" as const,
        text: `line ${seq}`,
      })),
      true,
    );
  const draw = (lines: { id: number; text: string }[]) =>
    lines.map((e) => ({ id: e.id, html: `<p>${e.text}</p>` }));
  const feed: LiveFeed = {
    rig: "rig-a",
    after: (after, limit) => draw(store.liveLines.after("rig-a", after, limit)),
    newest: (limit) => draw(store.liveLines.tail("rig-a", limit)),
    count: (after) => store.liveLines.count("rig-a", after),
  };
  return { store, add, feed, watching: () => watching };
}

const push = (stream: FakeStream, s: ReturnType<typeof setup>, o: Parameters<typeof pushLive>[3]) =>
  pushLive(stream as unknown as SSEStreamingApi, s.store, s.feed, o);

describe("the Live pages' push", () => {
  test("a reader gets the lines after its place at once, then each new line of its rig as the store gets it", async () => {
    const s = setup();
    s.add("rig-a", 3);
    const stream = new FakeStream();
    const done = push(stream, s, { after: 1, recheck: [] });
    await stream.until(() => stream.of("lines").length === 1);
    assert.equal(stream.raw[0], `retry: ${LIVE_PUSH_RETRY_MS}\n\n`);
    assert.deepEqual(
      stream.of("lines")[0].entries.map((e: { id: number }) => e.id),
      [2, 3],
    );
    assert.equal(stream.events.at(-1)?.id, "3", "its place, for when it connects again");
    // Another rig's lines are not this reader's; its own rig's come as the store has them.
    s.add("rig-b", 2);
    s.add("rig-a", 1);
    await stream.until(() => stream.of("lines").length === 2);
    assert.deepEqual(
      stream.of("lines")[1].entries.map((e: { html: string }) => e.html),
      ["<p>line 6</p>"],
    );
    assert.equal(s.watching(), 1);
    // The reader goes: the push ends, and stops watching the store.
    stream.abort();
    await done;
    assert.equal(s.watching(), 0);
    s.add("rig-a", 1);
    assert.equal(stream.of("lines").length, 2);
  });

  test("a reader that falls behind keeps what it has: it gets the newest lines, and how many it missed", async () => {
    const s = setup();
    s.add("rig-a", LIVE_PUSH_LINES + 200);
    const stream = new FakeStream();
    const done = push(stream, s, { after: 0, recheck: [] });
    await stream.until(() => stream.of("lines").length === 1);
    assert.deepEqual(stream.of("missed"), [{ lines: 200 }]);
    const ids = stream.of("lines")[0].entries.map((e: { id: number }) => e.id);
    assert.equal(ids.length, LIVE_PUSH_LINES);
    assert.deepEqual([ids[0], ids.at(-1)], [201, LIVE_PUSH_LINES + 200], "the newest");
    // Caught up, it gets each new line again, with nothing missed.
    s.add("rig-a", 1);
    await stream.until(() => stream.of("lines").length === 2);
    assert.equal(stream.of("missed").length, 1);
    stream.abort();
    await done;
  });

  test("lines drawn waiting for their event are drawn again once they wait no more, once", async () => {
    const s = setup();
    s.add("rig-a", 2);
    let arrived = false;
    const asked: number[][] = [];
    s.feed.redraw = (ids) => {
      asked.push(ids);
      return arrived ? ids.filter((id) => id === 1).map((id) => ({ id, html: "<p>read</p>" })) : [];
    };
    const stream = new FakeStream();
    const done = push(stream, s, { after: 2, recheck: [1], beatMs: 30 });
    await stream.until(() => asked.length >= 1);
    assert.deepEqual(asked[0], [1]);
    assert.equal(stream.of("redrawn").length, 0);
    // The event comes; a quiet push looks again at its beat, which says it is still there.
    arrived = true;
    await stream.until(() => stream.of("redrawn").length === 1);
    assert.deepEqual(stream.of("redrawn")[0], { redrawn: [{ id: 1, html: "<p>read</p>" }] });
    assert.ok(stream.events.some((e) => e.event === "beat"));
    const looked = asked.length;
    s.add("rig-a", 1);
    await stream.until(() => stream.of("lines").length === 1);
    assert.equal(asked.length, looked, "nothing waits any more");
    stream.abort();
    await done;
  });

  test("a reader starts after its last event's line, or the page's; only the newest waiting lines are followed", () => {
    assert.equal(pushStart("42", "7"), 42);
    assert.equal(pushStart(undefined, "7"), 7);
    assert.equal(pushStart("", "x"), 0);
    assert.equal(pushStart("-3", undefined), 0);
    assert.deepEqual(recheckIds("4,x,-1,5.5,6"), [4, 6]);
    assert.equal(recheckIds(Array.from({ length: 80 }, (_, i) => i + 1).join(",")).length, 50);
    assert.deepEqual(recheckIds(undefined), []);
  });
});
