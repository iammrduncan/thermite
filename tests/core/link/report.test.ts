import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import {
  REPORT_CONSUMER_CONFIG,
  REPORT_MAX_BYTES,
  REPORT_STREAM_CONFIG,
  REPORT_SUBJECTS,
  REPORTS_WAITING_PER_RIG,
  readReport,
  reportFits,
  reportMessageId,
  reportSignedBy,
  reportSubject,
  rigOfSubject,
} from "../../../src/core/link/report.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";
import { appendOther } from "../../helpers/kinds.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** A signed report from a harness of rig-a with `n` events. */
function signedReport(n: number): Record<string, unknown> {
  const env = makeHarnessEnv("rig-a");
  for (let i = 0; i < n; i++) appendOther(env.service.ledger, "t", "step", null, { i });
  return env.service.snapshot(0, 1000) as Record<string, unknown>;
}

describe("the reports' contract on the message bus", () => {
  test("each rig has its own subject, under the stream's subjects", () => {
    assert.equal(reportSubject("rig-a"), "thermite.rig.rig-a.report");
    assert.equal(rigOfSubject(reportSubject("rig-a")), "rig-a");
    // The stream's wildcard stands for one token: a rig's name never holds a dot.
    const wildcard = new RegExp(`^${REPORT_SUBJECTS.replace(/\./g, "\\.").replace("*", "[^.]+")}$`);
    assert.match(reportSubject("local-1"), wildcard);
    assert.throws(() => reportSubject("rig.a"), /not a rig's name/);
    assert.throws(() => reportSubject("*"), /not a rig's name/);
    for (const subject of [
      "thermite.rig.rig-a.b.report",
      "thermite.rig.*.report",
      "thermite.rig.Rig_A.report",
      "thermite.rig.rig-a.cmd",
      "thermite.rig..report",
    ])
      assert.equal(rigOfSubject(subject), null, subject);
  });

  test("a page's id names its ledger and events; a report without events adds its time", () => {
    const page = { ledger_id: "L", cursor: 10, next: 20, events: [{}], generated_at: "t1" };
    assert.equal(reportMessageId(page), "L:10-20");
    // The same page made again later is the same message: the bus keeps it once.
    assert.equal(reportMessageId({ ...page, generated_at: "t2" }), "L:10-20");
    // A page that reaches further is another message, though it starts at the same place.
    assert.notEqual(reportMessageId({ ...page, next: 25 }), reportMessageId(page));
    assert.notEqual(reportMessageId({ ...page, ledger_id: "M" }), reportMessageId(page));
    // A report with no events says the rig is alive: each one is a message of its own.
    const alive = { ledger_id: "L", cursor: 20, next: 20, events: [], generated_at: "t1" };
    assert.equal(reportMessageId(alive), "L:20-20@t1");
    assert.notEqual(reportMessageId({ ...alive, generated_at: "t2" }), reportMessageId(alive));
  });

  test("a report fits when it leaves room for its headers under the limit", () => {
    assert.equal(REPORT_MAX_BYTES, 8 * 1024 * 1024);
    assert.ok(reportFits(0));
    assert.ok(reportFits(REPORT_MAX_BYTES - 4096));
    assert.ok(!reportFits(REPORT_MAX_BYTES - 4095));
    assert.ok(!reportFits(REPORT_MAX_BYTES));
  });

  test("the NATS server in the compose files takes the contract's largest message", () => {
    for (const file of ["compose.yaml", "containers/release/compose.template.yaml"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const set = [...text.matchAll(/^\s*max_payload: (\d+)$/gm)].map((m) => Number(m[1]));
      assert.deepEqual(set, [REPORT_MAX_BYTES], file);
    }
  });

  test("the stream keeps a report until control has it, and control reads it one message at a time", () => {
    const s = REPORT_STREAM_CONFIG;
    assert.deepEqual(s.subjects, [REPORT_SUBJECTS]);
    assert.equal(s.retention, "workqueue", "an inbox: a report control acked is gone");
    assert.deepEqual(
      [s.max_msgs, s.max_bytes, s.max_age, s.max_msgs_per_subject],
      [-1, -1, 0, REPORTS_WAITING_PER_RIG],
      "at most REPORTS_WAITING_PER_RIG of one rig's reports wait, and no limit on their age",
    );
    assert.ok(!("deny_delete" in s) && !("deny_purge" in s), "not a stream kept for good");
    assert.equal(s.discard, "new", "a full store refuses new reports, never drops waiting ones");
    assert.equal(s.max_msg_size, REPORT_MAX_BYTES);
    assert.equal(REPORT_CONSUMER_CONFIG.ack_policy, "explicit");
    assert.equal(REPORT_CONSUMER_CONFIG.deliver_policy, "all");
    assert.equal(REPORT_CONSUMER_CONFIG.max_ack_pending, 1, "pages fold in order");
  });

  test("a reader keeps the fields it knows, counts the rest, and the signature holds", () => {
    const raw = signedReport(2);
    const events = raw.events as Record<string, unknown>[];
    // Fields a newer rig might send outside what it signs: one on the report, one on an event.
    const newer = {
      ...raw,
      route: "bus",
      events: events.map((e, i) => (i === 0 ? { ...e, lane: "1" } : e)),
    };
    const read = readReport(newer);
    assert.equal(read.unknown, 2);
    assert.ok(!("route" in read.report));
    assert.ok(!("lane" in (read.report.events[0] ?? {})));
    // Neither was signed: with both dropped, what is left is what the harness signed.
    assert.equal(reportSignedBy(read.report, String(raw.rig_pubkey)), true);
    assert.equal(readReport(raw).unknown, 0);
    assert.throws(() => readReport({ ...raw, cursor: "0" }), z.ZodError);
    assert.throws(() => readReport("a report"), z.ZodError);
  });

  test("only the rig's report key signed a report", () => {
    const raw = signedReport(1);
    const { report } = readReport(raw);
    const key = String(raw.rig_pubkey);
    assert.equal(reportSignedBy(report, key), true);
    assert.equal(reportSignedBy({ ...report, next: report.next + 1 }, key), false);
    assert.equal(reportSignedBy({ ...report, signature: undefined }, key), false);
    const other = signedReport(1);
    assert.equal(reportSignedBy(report, String(other.rig_pubkey)), false);
  });
});
