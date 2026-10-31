import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { z } from "zod";
import { canonicalJson } from "../../../src/core/canonical.ts";
import {
  COMMAND_MAX_BYTES,
  generateSigningKeys,
  signEnvelope,
  verifyCommand,
} from "../../../src/core/commands.ts";
import {
  COMMAND_MAX_MESSAGE_BYTES,
  COMMAND_QUEUE_MAX,
  COMMAND_STREAM,
  COMMAND_STREAM_CONFIG,
  COMMAND_SUBJECTS,
  commandConsumerConfig,
  commandConsumerName,
  commandMessageId,
  commandSubject,
  readCommand,
} from "../../../src/core/link/commands.ts";
import { REPORT_SUBJECTS, reportSubject, rigOfSubject } from "../../../src/core/link/report.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const keys = generateSigningKeys();

/** A command control signed for rig-a: a pause of run-1. */
function signed(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return signEnvelope(
    {
      v: 1,
      id: randomUUID(),
      rig: "rig-a",
      kind: "pause_run",
      issued_by: "owner:test",
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      payload: { run: "run-1", reason: "a test" },
      ...over,
    },
    keys.privateKeyPem,
  );
}

/** A message's data, as control publishes it. */
const bytes = (x: unknown) => new TextEncoder().encode(canonicalJson(x));
/** A subject as the stream's wildcard reads it: the star stands for one token. */
const under = (pattern: string) =>
  new RegExp(`^${pattern.replace(/\./g, "\\.").replace("*", "[^.]+")}$`);

describe("the commands' contract on the message bus", () => {
  test("each rig has its own subject under the stream's, apart from its reports", () => {
    assert.equal(COMMAND_STREAM, "COMMANDS");
    assert.equal(commandSubject("rig-a"), "thermite.rig.rig-a.cmd");
    assert.match(commandSubject("local-1"), under(COMMAND_SUBJECTS));
    assert.doesNotMatch(commandSubject("rig-a"), under(REPORT_SUBJECTS));
    assert.doesNotMatch(reportSubject("rig-a"), under(COMMAND_SUBJECTS));
    assert.equal(rigOfSubject(commandSubject("rig-a")), null, "not a report subject");
    for (const bad of ["rig.a", "*", ">", "Rig_A", ""])
      assert.throws(() => commandSubject(bad), /not a rig's name/, bad);
  });

  test("each rig's consumer takes its subject alone, from the first command, acked one by one", () => {
    const c = commandConsumerConfig("rig-a");
    assert.equal(c.durable_name, commandConsumerName("rig-a"));
    assert.equal(c.durable_name, "rig-rig-a-commands");
    assert.doesNotMatch(c.durable_name, /[.*>\s]/, "a durable name takes no dots or wildcards");
    assert.equal(c.filter_subject, commandSubject("rig-a"));
    assert.notEqual(commandConsumerConfig("rig-b").filter_subject, c.filter_subject);
    assert.equal(c.ack_policy, "explicit");
    assert.equal(c.deliver_policy, "all");
    // A command that waits never holds up the next: as many in hand as the rig's queue holds.
    assert.equal(c.max_ack_pending, COMMAND_QUEUE_MAX);
    assert.equal(c.max_deliver, -1);
    assert.throws(() => commandConsumerName("rig.a"), /not a rig's name/);
  });

  test("the stream is a work queue, limited for each rig, refusing what it can't hold", () => {
    const s = COMMAND_STREAM_CONFIG;
    assert.deepEqual(s.subjects, [COMMAND_SUBJECTS]);
    assert.equal(s.retention, "workqueue", "a command acked by its rig is gone");
    assert.equal(s.max_msgs_per_subject, COMMAND_QUEUE_MAX);
    assert.equal(s.discard, "new");
    assert.equal(s.discard_new_per_subject, true, "a full queue refuses, never drops a command");
    assert.equal(s.max_age, 7 * 24 * 3600 * 1e9, "a week, the longest a command lives");
    assert.equal(s.duplicate_window, s.max_age, "a command published again is kept once");
    assert.ok(!("deny_delete" in s), "control takes a cancelled command off it");
  });

  test("its largest message is the largest signed command, which the NATS server takes", () => {
    assert.equal(COMMAND_MAX_BYTES, 3.5 * 1024 * 1024);
    assert.equal(COMMAND_STREAM_CONFIG.max_msg_size, COMMAND_MAX_MESSAGE_BYTES);
    assert.ok(COMMAND_MAX_MESSAGE_BYTES > COMMAND_MAX_BYTES, "room for its headers");
    for (const file of ["compose.yaml", "containers/release/compose.template.yaml"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const payload = Number(/^\s*max_payload: (\d+)$/m.exec(text)?.[1]);
      assert.ok(COMMAND_MAX_MESSAGE_BYTES <= payload, file);
    }
  });

  test("a command's message id is its own id: published twice, it is kept once", () => {
    const cmd = signed();
    assert.equal(commandMessageId(cmd), cmd.envelope.id);
    assert.notEqual(commandMessageId(signed()), commandMessageId(cmd));
  });

  test("the supervisor reads a command and passes it on as control signed it", () => {
    const cmd = signed();
    const read = readCommand(bytes(cmd));
    assert.deepEqual(read, cmd);
    assert.ok(verifyCommand(read, keys.publicKeyPem, "rig-a").ok, "control's key signed it");
    // A field a newer control signs stays, so the harness checks the signature over all of it.
    const newer = signEnvelope({ ...cmd.envelope, ...{ route: "bus" } }, keys.privateKeyPem);
    const kept = readCommand(bytes(newer)) as unknown as { envelope: { route?: string } };
    assert.equal(kept.envelope.route, "bus");
    // A changed command no longer verifies: the supervisor can't alter what control signed.
    const altered = { ...cmd, envelope: { ...cmd.envelope, rig: "rig-b" } };
    assert.equal(verifyCommand(altered, keys.publicKeyPem, "rig-b").ok, false);
  });

  test("a message that is not a command is refused", () => {
    const cmd = signed();
    assert.throws(() => readCommand(new TextEncoder().encode("{")), SyntaxError);
    for (const bad of [
      "a command",
      { envelope: cmd.envelope },
      { ...cmd, signature: "" },
      { ...cmd, envelope: { ...cmd.envelope, id: "not-a-uuid" } },
      { ...cmd, envelope: { ...cmd.envelope, expires_at: "soon" } },
      { ...cmd, envelope: { ...cmd.envelope, rig: undefined } },
    ])
      assert.throws(() => readCommand(bytes(bad)), z.ZodError, JSON.stringify(bad));
  });
});
