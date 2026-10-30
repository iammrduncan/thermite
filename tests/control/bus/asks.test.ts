import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildInfo } from "../../../src/common/build-info.ts";
import type { BusRequest } from "../../../src/common/bus/index.ts";
import { fitPage } from "../../../src/control/bus/asks.ts";
import { answerRigAsk, serveRigAsks } from "../../../src/control/bus/index.ts";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { Screens } from "../../../src/control/live/index.ts";
import {
  PAST_PAGE_BYTES,
  RIG_ASK_KINDS,
  RIG_ASK_SUBJECTS,
  rigAskOf,
  rigAskSubject,
} from "../../../src/core/link/asks.ts";
import { REPORT_MAX_BYTES } from "../../../src/core/link/report.ts";
import { SCREENS_MAX_BYTES } from "../../../src/core/screens.ts";
import { controlOnly } from "../../helpers/control-stack.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";

/**
 * What a rig asks of control on the message bus (core/link/asks.ts, control/bus/asks.ts): each on
 * the rig's own subject, answered at its own inbox alone, a refusal in words.
 */

function setup() {
  const env = makeHarnessEnv("rig-a");
  const c = controlOnly({ keys: env.keys });
  const screens = new Screens();
  const deps = {
    store: c.store,
    control: buildInfo(),
    privateKeyPem: env.keys.privateKeyPem,
    screens,
  };
  return {
    ...c,
    env,
    screens,
    deps,
    ask: (kind: (typeof RIG_ASK_KINDS)[number], body: unknown) =>
      answerRigAsk(deps, "rig-a", kind, body),
  };
}

describe("a rig's asks of control on the bus", () => {
  test("each kind has the rig's own subject, and a subject that is no rig's ask is none", () => {
    assert.equal(RIG_ASK_SUBJECTS, "thermite.rig.*.ask.*");
    for (const kind of RIG_ASK_KINDS) {
      const subject = rigAskSubject("rig-a", kind);
      assert.equal(subject, `thermite.rig.rig-a.ask.${kind}`);
      assert.deepEqual(rigAskOf(subject), { rig: "rig-a", kind });
    }
    assert.equal(rigAskOf("thermite.rig.rig-a.ask.wipe"), undefined);
    assert.equal(rigAskOf("thermite.rig.rig-a.report"), undefined);
    assert.throws(() => rigAskSubject("Rig A", "figures"), /not a rig's name/);
    // What a rig asks fits one of the bus's messages: the screens, at their largest, too.
    assert.ok(SCREENS_MAX_BYTES < REPORT_MAX_BYTES);
    assert.ok(PAST_PAGE_BYTES < REPORT_MAX_BYTES);
  });

  test("figures are kept and answered with control's place; a field control knows keeps its check", async () => {
    const s = setup();
    assert.deepEqual(s.ask("figures", { at: new Date().toISOString(), relay: { cursor: 4 } }), {
      ok: true,
      reports: { ledger_id: null, cursor: 0 },
    });
    assert.deepEqual(s.store.reportedRigs.supervisor("rig-a")?.relay, { cursor: 4 });
    const bad = s.ask("figures", { at: "now", relay: { cursor: "four" } }) as { refused: string };
    assert.match(bad.refused, /^the figures is not one control takes: relay\.cursor/);
    // Its keys are not taken here: the registration over HTTPS takes them.
    s.ask("figures", { at: "now", bus_key: "U".repeat(56) });
    assert.equal(s.store.busKeys.rigKey("rig-a"), undefined);
  });

  test("a refused rig's figures are not kept, but answered with control's place; its other asks are refused", async () => {
    const s = setup();
    const newer = { version: "9.0.0", commit: null, protocol: 99, oldest_protocol: 99 };
    s.store.builds.setRig("rig-a", "supervisor", newer);
    const answer = s.ask("figures", { at: "now", relay: { cursor: 1 } });
    assert.deepEqual(answer, { reports: { ledger_id: null, cursor: 0 } });
    assert.equal(s.store.reportedRigs.supervisor("rig-a"), null);
    const daily = s.ask("daily", { kind: "daily", body: "# A day" }) as { refused: string };
    assert.match(daily.refused, /^Control cannot work with this rig/);
    assert.equal(s.store.refusals.get("rig-a")?.calls, 2);
  });

  test("screens: kept only for a trial a page watches, and the trials watched now", () => {
    const s = setup();
    const frame = { trial: "t-1", state: "running", cols: 1, rows: 1, data: "x", at: "now" };
    assert.deepEqual(s.ask("screens", { frames: [frame] }), { watch: [] });
    assert.equal(s.screens.frame("rig-a", "t-1"), undefined);
    const stop = s.screens.watch("rig-a", "t-1");
    assert.deepEqual(s.ask("screens", { frames: [] }), { watch: ["t-1"] });
    s.ask("screens", { frames: [frame] });
    assert.equal(s.screens.frame("rig-a", "t-1")?.data, "x");
    stop?.();
  });

  test("the daily report is kept, and answered with its id", () => {
    const s = setup();
    const r = s.ask("daily", { kind: "daily", body: "# The day" }) as { id: number };
    assert.equal(s.store.rigReports.list(5, "rig-a")[0]?.id, r.id);
  });

  test("past research: a page ends before an item that would pass the bytes one answer carries", () => {
    const item = (seq: number) => ({ seq, body: "x".repeat(100) });
    const page = { items: [1, 2, 3, 4].map(item), next: 4, more: false };
    const one = Buffer.byteLength(JSON.stringify(item(1)));
    assert.deepEqual(fitPage(page, one * 4), page, "all of it fits");
    const two = fitPage(page, one * 2 + 1);
    assert.deepEqual([two.items.map((x) => x.seq), two.next, two.more], [[1, 2], 2, true]);
    // One item larger than the page still goes, alone.
    const first = fitPage(page, 1);
    assert.deepEqual([first.items.length, first.next, first.more], [1, 1, true]);
    assert.ok(PAST_PAGE_BYTES < REPORT_MAX_BYTES);
  });

  test("a command's newest form: renewed near its expiry, as control holds it otherwise, none once it is not pending", async () => {
    const s = setup();
    const { id } = issueCommand(s.store, s.env.keys.privateKeyPem, {
      rig: "rig-a",
      kind: "pause_run",
      payload: { run: "r-1", reason: "x" },
      ttlMinutes: 5,
      issuedBy: "owner:test",
    });
    const renewed = s.ask("renew", { id }) as { command: { envelope: { expires_at: string } } };
    assert.ok(Date.parse(renewed.command.envelope.expires_at) > Date.now() + 50 * 60_000);
    assert.ok(s.store.auditLog.list(5).some((a) => a.action === "command_renewed"));
    // Not due again: the form control holds now.
    const again = s.ask("renew", { id }) as { command: { envelope: { expires_at: string } } };
    assert.equal(again.command.envelope.expires_at, renewed.command.envelope.expires_at);
    s.store.commands.cancel(id, "owner:test");
    assert.match(
      (s.ask("renew", { id }) as { refused: string }).refused,
      /holds no pending command/,
    );
  });

  test("served on the bus: answered at the asking rig's own inbox alone", async () => {
    const s = setup();
    let answer: ((r: BusRequest) => Promise<string | undefined>) | undefined;
    await serveRigAsks(
      {
        serve: async (subject, a) => {
          assert.equal(subject, RIG_ASK_SUBJECTS);
          answer = a;
        },
      },
      s.deps,
    );
    assert.ok(answer);
    const ask = (reply: string | undefined, subject = "thermite.rig.rig-a.ask.figures") =>
      answer?.({ subject, reply, data: new TextEncoder().encode(JSON.stringify({ at: "now" })) });
    assert.match(String(await ask("_INBOX.rig.rig-a.x.1")), /"reports"/);
    assert.equal(await ask("_INBOX.rig.rig-b.x.1"), undefined, "another rig's inbox");
    assert.equal(await ask(undefined), undefined, "no inbox");
    assert.equal(await ask("_INBOX.rig.rig-a.x.2", "thermite.rig.rig-a.ask.nope"), undefined);
    const notJson = await answer({
      subject: "thermite.rig.rig-a.ask.daily",
      reply: "_INBOX.rig.rig-a.y",
      data: new TextEncoder().encode("{"),
    });
    assert.match(String(notJson), /"refused":"the daily is not JSON/);
  });
});
