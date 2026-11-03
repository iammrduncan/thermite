import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import {
  LIVE_CONSUMER,
  LIVE_CONSUMER_CONFIG,
  LIVE_KEPT_BYTES,
  LIVE_KEPT_PER_SUBJECT,
  LIVE_KEPT_SECONDS,
  LIVE_MAX_BYTES,
  LIVE_STREAM,
  LIVE_STREAM_CONFIG,
  LIVE_SUBJECTS,
  liveFits,
  liveGroups,
  liveMessageId,
  liveSubject,
  readLiveMessage,
  readLiveSubject,
  rigLiveSubject,
} from "../../../src/core/link/live.ts";
import { REPORT_SUBJECTS } from "../../../src/core/link/report.ts";
import { LIVE_TEXT_MAX, type LiveEntry } from "../../../src/core/live.ts";

/** A line of the live log, as the harness keeps it. */
const line = (seq: number, source: string, run?: string, text = `line ${seq}`): LiveEntry => ({
  seq,
  at: "2026-10-28T12:00:00.000Z",
  source,
  kind: "text",
  text,
  ...(run ? { run } : {}),
});

/** A subject as a stream's pattern reads it: `*` stands for one token. */
const takes = (pattern: string, subject: string) =>
  new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, "[^.]+")}$`).test(subject);

describe("the live stream's contract", () => {
  test("a run's line goes on the run's subject; a line with no run, on the rig's", () => {
    assert.equal(
      liveSubject("rig-a", { run: "sort-3", source: "planner" }),
      "thermite.run.sort-3.live.planner",
    );
    // A trial's source names its trial, with a dash where a subject could not hold a colon.
    assert.equal(
      liveSubject("rig-a", { run: "sort-3", source: "trial:t-0123456789abcdef" }),
      "thermite.run.sort-3.live.trial-t-0123456789abcdef",
    );
    assert.equal(liveSubject("rig-a", { source: "judge" }), "thermite.rig.rig-a.live.judge");
    // A run named before goal 170, with a dot or capitals, has no subject: the rig's holds it.
    assert.equal(
      liveSubject("rig-a", { run: "Sort.3", source: "supervisor" }),
      "thermite.rig.rig-a.live.supervisor",
    );
    assert.equal(rigLiveSubject("rig-a", "planner"), "thermite.rig.rig-a.live.planner");
    // Never a subject for a name that is not a rig's, or a source that is not one.
    assert.throws(() => rigLiveSubject("Rig.A", "judge"), /not a rig's name/);
    assert.throws(() => liveSubject("rig-a", { source: "judge.>" }), /not a live source/);
    // The stream takes every one of them, and none of the reports' subjects.
    for (const s of [
      "thermite.run.sort-3.live.planner",
      "thermite.run.sort-3.live.trial-t-0123456789abcdef",
      "thermite.rig.rig-a.live.judge",
    ])
      assert.ok(
        LIVE_SUBJECTS.some((p) => takes(p, s)),
        s,
      );
    assert.ok(!LIVE_SUBJECTS.some((p) => takes(p, "thermite.rig.rig-a.report")));
    assert.ok(!takes(REPORT_SUBJECTS, "thermite.rig.rig-a.live.judge"));
  });

  test("a subject is read back to the run or rig and the source it names, and nothing else is", () => {
    assert.deepEqual(readLiveSubject("thermite.run.sort-3.live.trial-t-0123456789abcdef"), {
      run: "sort-3",
      source: "trial:t-0123456789abcdef",
    });
    assert.deepEqual(readLiveSubject("thermite.rig.rig-a.live.supervisor"), {
      rig: "rig-a",
      source: "supervisor",
    });
    for (const s of [
      "thermite.rig.rig-a.report",
      "thermite.run.sort-3.live",
      "thermite.run.sort-3.live.planner.extra",
      "thermite.run.Sort.live.planner",
      "thermite.run.sort-3.live.teacher",
      "thermite.rig.-bad-.live.judge",
      "thermite.run.*.live.planner",
      "thermite.run.sort-3.live.trial-",
    ])
      assert.equal(readLiveSubject(s), null, s);
  });

  test("a page's lines become one message for each run's source, in the order of their first line", () => {
    const page = [
      line(1, "planner", "r1"),
      line(2, "trial:t-1", "r1"),
      line(3, "judge"),
      line(4, "planner", "r1"),
      line(5, "trial:t-2", "r1"),
      line(6, "trial:t-1", "r1"),
      line(7, "planner", "r2"),
    ];
    assert.deepEqual(
      liveGroups(page).map((g) => g.map((e) => e.seq)),
      [[1, 4], [2, 6], [3], [5], [7]],
    );
    assert.deepEqual(liveGroups([]), []);
    // A message's id: its log, and its first and last line, so one sent twice is kept once.
    assert.equal(
      liveMessageId({ log_id: "log-1", entries: [line(2, "x"), line(6, "x")] }),
      "log-1:2-6",
    );
  });

  test("a message is cut to fit, and never a line: the longest line fits many times over", () => {
    const long = "é".repeat(LIVE_TEXT_MAX);
    const page = Array.from({ length: 300 }, (_, i) => line(i + 1, "planner", "r1", long));
    const groups = liveGroups(page);
    assert.ok(groups.length > 1, "too large for one message");
    assert.deepEqual(
      groups.flat().map((e) => e.seq),
      page.map((e) => e.seq),
      "every line once, in order",
    );
    // Each message, with the batch's own fields as the harness signs it, fits.
    const batch = (entries: LiveEntry[]) => ({
      rig: "r".repeat(40),
      log_id: "l".repeat(64),
      from: 0,
      next: 300,
      entries,
      rig_pubkey: `-----BEGIN PUBLIC KEY-----\n${"A".repeat(60)}\n-----END PUBLIC KEY-----\n`,
      signature: "s".repeat(88),
    });
    for (const g of groups)
      assert.ok(liveFits(Buffer.byteLength(JSON.stringify(batch(g)))), `${g.length} lines`);
    assert.ok(!liveFits(LIVE_MAX_BYTES));
  });

  test("a message is read as a batch over HTTP is: the lines it knows kept, the rest counted", () => {
    const raw = {
      rig: "rig-a",
      log_id: "log-1",
      from: 0,
      next: 3,
      entries: [
        line(1, "planner", "r1"),
        { ...line(2, "planner", "r1"), kind: "diff" },
        line(3, "planner", "r1"),
      ],
    };
    const read = readLiveMessage(raw);
    assert.deepEqual(
      read.entries.map((e) => e.seq),
      [1, 3],
    );
    assert.deepEqual(read.unknown, { "kind diff": 1 });
    assert.equal(read.batch.log_id, "log-1");
    assert.throws(() => readLiveMessage({ rig: "rig-a" }), z.ZodError);
  });

  test("the stream is a view, kept by count, age and bytes; control reads it in order", () => {
    assert.equal(LIVE_STREAM_CONFIG.name, LIVE_STREAM);
    assert.deepEqual(LIVE_STREAM_CONFIG.subjects, LIVE_SUBJECTS);
    assert.equal(LIVE_STREAM_CONFIG.max_age, LIVE_KEPT_SECONDS * 1e9);
    assert.equal(LIVE_STREAM_CONFIG.max_msgs_per_subject, LIVE_KEPT_PER_SUBJECT);
    assert.equal(LIVE_STREAM_CONFIG.max_bytes, LIVE_KEPT_BYTES);
    assert.equal(LIVE_STREAM_CONFIG.max_msg_size, LIVE_MAX_BYTES);
    // The oldest go when a limit is reached: a publish is never refused for room.
    assert.equal(LIVE_STREAM_CONFIG.discard, "old");
    assert.equal(LIVE_STREAM_CONFIG.retention, "limits");
    assert.ok(LIVE_STREAM_CONFIG.duplicate_window < LIVE_STREAM_CONFIG.max_age);
    assert.equal(LIVE_CONSUMER_CONFIG.durable_name, LIVE_CONSUMER);
    assert.equal(LIVE_CONSUMER_CONFIG.max_ack_pending, 1, "one at a time, in order");
    assert.equal(LIVE_CONSUMER_CONFIG.deliver_policy, "all");
  });
});
