import assert from "node:assert/strict";
import { test } from "node:test";
import {
  log,
  logDebug,
  logError,
  logLevel,
  logLevelOf,
  logWarn,
  startLogging,
  switchLogLevel,
} from "../../src/common/log.ts";

test("one log: each line has its level, a part writes its level and above, and SIGUSR2 switches to debug (goal 125)", async (t) => {
  const lines: Record<string, unknown>[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => {
    lines.push(JSON.parse(chunk) as Record<string, unknown>);
    return true;
  });
  const taken: string[] = [];
  startLogging("test", { THERMITE_LOG_LEVEL: "warn" }, () => [{ kill: (s) => taken.push(s) }]);
  log("test", "routine", { run: "r-1" });
  logDebug("test", "detail");
  logWarn("test", "a call refused", { run: "r-1" });
  logError("test", "a job failed");
  assert.deepEqual(
    lines.map((l) => [l.level, l.msg]),
    [
      ["warn", "a call refused"],
      ["error", "a job failed"],
    ],
  );
  assert.equal(lines[0]?.run, "r-1");
  assert.equal(lines[0]?.component, "test");
  // What SIGUSR2 does: debug, said in a line; again: the configured level. (The test sends no
  // signal: in a test's process Node answers SIGUSR2 with a diagnostic report.)
  switchLogLevel("test");
  assert.equal(logLevel(), "debug");
  logDebug("test", "detail");
  switchLogLevel("test");
  assert.equal(logLevel(), "warn");
  t.mock.restoreAll();
  assert.deepEqual(
    lines.slice(2).map((l) => l.msg),
    ["log level now debug", "detail", "log level now warn"],
  );
  // The handler passes the signal on to the parts it was given.
  const handler = process.listeners("SIGUSR2").at(-1) as () => void;
  t.mock.method(process.stdout, "write", () => true);
  handler();
  handler();
  t.mock.restoreAll();
  assert.deepEqual(taken, ["SIGUSR2", "SIGUSR2"]);
  // A setting that is not a level stops the part at start, in words.
  assert.equal(logLevelOf({}), "info");
  assert.throws(
    () => logLevelOf({ THERMITE_LOG_LEVEL: "verbose" }),
    /^Error: THERMITE_LOG_LEVEL takes debug, info, warn, error, not "verbose"$/,
  );
  for (const l of process.listeners("SIGUSR2")) process.removeListener("SIGUSR2", l);
});

test("a line never holds a secret: every string field, at any depth, is redacted", (t) => {
  const lines: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => {
    lines.push(chunk);
    return true;
  });
  const secret = "s3cr3t-value-0123456789";
  logError("test", `fetch failed: https://user:${secret}@host.example/repo`, {
    error: `remote said: x-api-key: ${secret}`,
    detail: { url: `https://host.example/cb?access_token=${secret}`, tries: 2 },
    argv: ["git", "-c", `http.extraHeader=Authorization: Bearer ${secret}`],
  });
  t.mock.restoreAll();
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]?.includes(secret), lines[0]);
  const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal((line.detail as { tries: number }).tries, 2);
  assert.equal(line.msg, "fetch failed: https://***@host.example/repo");
});
