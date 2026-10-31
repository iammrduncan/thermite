import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AGENTS_NUMBERS } from "../../src/agents/settings.ts";
import { CLI_NUMBERS } from "../../src/cli/settings.ts";
import {
  type NumberSpec,
  optionalNumberSetting,
  readNumber,
  ruleWords,
} from "../../src/common/settings.ts";
import { CONTROL_NUMBERS } from "../../src/control/settings.ts";
import { BROKER_NUMBERS, brokerNumbers } from "../../src/harness/broker/settings.ts";
import { HARNESS_NUMBERS, harnessNumbers } from "../../src/harness/settings.ts";
import { SUPERVISOR_NUMBERS, supervisorMs } from "../../src/supervisor/settings.ts";

describe("numeric settings stop the part at start with words (goal 164)", () => {
  test("seconds: unset or empty is the default; a typo, 0 or a unit is refused", () => {
    const poll = SUPERVISOR_NUMBERS.pollSeconds;
    assert.equal(supervisorMs({}, poll), 60_000);
    assert.equal(supervisorMs({ THERMITE_POLL_SECONDS: " " }, poll), 60_000);
    assert.equal(supervisorMs({ THERMITE_POLL_SECONDS: "2.5" }, poll), 2500);
    for (const bad of ["abc", "0", "-5", "30s"])
      assert.throws(
        () => supervisorMs({ THERMITE_POLL_SECONDS: bad }, poll),
        new RegExp(
          `^Error: THERMITE_POLL_SECONDS takes a number of seconds above 0, not "${bad}"$`,
        ),
      );
  });

  test("minutes: the export interval that once stopped exports, or exported every few seconds", () => {
    const env = (v: string) => ({ THERMITE_EXPORT_MINUTES: v });
    assert.equal(harnessNumbers(env("90")).exportEveryMs, 90 * 60_000);
    assert.throws(
      () => harnessNumbers(env("6O")),
      /THERMITE_EXPORT_MINUTES takes a number of minutes above 0, not "6O"/,
    );
    assert.throws(() => harnessNumbers(env("0")), /above 0/);
  });

  test("an interval whose 0 turns its loop off takes 0, and nothing below", () => {
    const kb = SUPERVISOR_NUMBERS.kbSyncSeconds;
    assert.equal(supervisorMs({ THERMITE_KB_SYNC_SECONDS: "0" }, kb), 0);
    assert.throws(
      () => supervisorMs({ THERMITE_KB_SYNC_SECONDS: "-1" }, kb),
      /^Error: THERMITE_KB_SYNC_SECONDS takes a number of seconds from 0 \(0: off\), not "-1"$/,
    );
    const live = SUPERVISOR_NUMBERS.liveIntervalMs;
    assert.equal(supervisorMs({ THERMITE_LIVE_INTERVAL_MS: "250" }, live), 250);
  });

  test("counts and ports: whole numbers within their bounds", () => {
    const port = CLI_NUMBERS.controlPort;
    assert.equal(readNumber({}, port), 8800);
    assert.equal(readNumber({ THERMITE_CONTROL_PORT: "8801" }, port), 8801);
    assert.throws(
      () => readNumber({ THERMITE_CONTROL_PORT: "88.5" }, port),
      /THERMITE_CONTROL_PORT takes a whole number from 1 to 65535, not "88.5"/,
    );
    assert.throws(() => readNumber({ THERMITE_CONTROL_PORT: "70000" }, port), /from 1 to 65535/);
    assert.equal(readNumber({}, SUPERVISOR_NUMBERS.tunnelPort), undefined);
    assert.equal(optionalNumberSetting({}, "N", { integer: true }), undefined);
    assert.equal(ruleWords({ unit: "MiB", aboveMin: true }), "a number of MiB above 0");
  });

  test("every table's default is a value its own rule takes (goal 125, T4)", () => {
    const tables: Record<string, NumberSpec>[] = [
      CONTROL_NUMBERS,
      HARNESS_NUMBERS,
      AGENTS_NUMBERS,
      BROKER_NUMBERS,
      SUPERVISOR_NUMBERS,
      CLI_NUMBERS,
    ];
    // A setting is defined once: two tables may share it (the disk floor, common/disk.ts), but
    // never as two specs of the same name.
    const names = new Map<string, NumberSpec>();
    for (const spec of tables.flatMap((t) => Object.values(t))) {
      const seen = names.get(spec.name);
      assert.ok(seen === undefined || seen === spec, `${spec.name} is defined in two tables`);
      if (seen) continue;
      names.set(spec.name, spec);
      if (spec.fallback === undefined) continue;
      assert.equal(readNumber({ [spec.name]: String(spec.fallback) }, spec), spec.fallback);
    }
    assert.equal(readNumber({}, CONTROL_NUMBERS.sessionDays), 30);
  });

  test("the harness's and the broker's settings are read at their start", () => {
    assert.equal(harnessNumbers({}).exportEveryMs, 60 * 60_000);
    assert.equal(
      harnessNumbers({ THERMITE_RESEARCH_MAX_MB: "2" }).researchMaxBytes,
      2 * 1024 * 1024,
    );
    assert.throws(
      () => harnessNumbers({ THERMITE_MAX_TURNS: "lots" }),
      /THERMITE_MAX_TURNS takes a whole number from 1/,
    );
    assert.throws(
      () => harnessNumbers({ THERMITE_EXPORT_MINUTES: "6O" }),
      /THERMITE_EXPORT_MINUTES/,
    );
    assert.deepEqual(brokerNumbers({}), { outboxGid: 10001, fatalHoldMs: 0 });
    assert.equal(brokerNumbers({ THERMITE_FATAL_HOLD_SECONDS: "900" }).fatalHoldMs, 600_000);
    assert.throws(
      () => brokerNumbers({ THERMITE_OUTBOX_GID: "group" }),
      /THERMITE_OUTBOX_GID takes a whole number/,
    );
  });
});
