import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { afterEach, describe, test } from "node:test";
import { HEALTH_WATCH, watchHealth } from "../../../src/harness/broker/watch.ts";

/**
 * The one-container rig image's watch of its parts (goal 173). A stand-in part runs in its own
 * process group, as the broker starts each part, and answers its health route with the statuses
 * it is given, the last one again and again. The watch asks it every 20 ms here (30 s in the
 * image) and ends the group after the third failure in a row; the broker's exit handler then
 * starts the part again, which the rig image acceptance checks.
 */

const PART = `const n={asked:0};const a=process.argv[1].split(",").map(Number);
require("node:http").createServer((q,r)=>{const s=a[Math.min(n.asked,a.length-1)];n.asked++;process.stdout.write("asked\\n");r.writeHead(s).end()}).listen(0,"127.0.0.1",function(){process.stdout.write("port "+this.address().port+"\\n")})`;
const QUIET = "setInterval(()=>{},60000)";

const started: ChildProcess[] = [];
afterEach(() => {
  for (const p of started.splice(0))
    try {
      if (p.pid) process.kill(-p.pid, "SIGKILL");
    } catch {
      // ended already
    }
});

interface StandIn {
  proc: ChildProcess;
  url: string;
  asked: () => number;
  /** The signal that ended it, once its output is read to the end. */
  ended: Promise<NodeJS.Signals | null>;
}

/** A stand-in part answering `answers` in turn; with none, it listens nowhere (`url` refuses). */
async function standIn(answers: number[]): Promise<StandIn> {
  const proc = spawn(process.execPath, ["-e", answers.length ? PART : QUIET, answers.join(",")], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  started.push(proc);
  const ended = new Promise<NodeJS.Signals | null>((resolve) =>
    proc.once("close", (_code, signal) => resolve(signal)),
  );
  let out = "";
  proc.stdout?.on("data", (d) => {
    out += String(d);
  });
  const asked = () => out.split("\n").filter((l) => l === "asked").length;
  if (!answers.length)
    return { proc, url: `http://127.0.0.1:${await closedPort()}/`, asked, ended };
  for (let i = 0; i < 200 && !/^port \d+$/m.test(out); i++)
    await new Promise((r) => setTimeout(r, 10));
  const port = /^port (\d+)$/m.exec(out)?.[1];
  assert.ok(port, `the stand-in listens: ${out}`);
  return { proc, url: `http://127.0.0.1:${port}/v1/health`, asked, ended };
}

/** A port nothing listens on. */
function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const watch = (part: StandIn, startMs = 0, stopping = () => false) =>
  watchHealth(part.proc, { part: "stand-in", url: part.url, startMs, stopping, everyMs: 20 });

describe("the broker's watch of a part's health route", () => {
  test("a part whose route answers 503 is ended after the third in a row, not before", {
    timeout: 10_000,
  }, async () => {
    const part = await standIn([503]);
    watch(part);
    assert.equal(await part.ended, "SIGKILL");
    assert.equal(part.asked(), HEALTH_WATCH.failures);
  });

  test("a 2xx answer starts the count again", { timeout: 10_000 }, async () => {
    const part = await standIn([503, 503, 200, 503, 503, 503]);
    watch(part);
    assert.equal(await part.ended, "SIGKILL");
    assert.equal(part.asked(), 6);
  });

  test("a part still starting: its failures count only after its first 2xx", {
    timeout: 10_000,
  }, async () => {
    const part = await standIn([503, 503, 503, 503, 200, 503, 503, 503]);
    watch(part, 60_000);
    assert.equal(await part.ended, "SIGKILL");
    assert.equal(part.asked(), 8);
  });

  test("a part that never answers 2xx is ended once its time to start is over", {
    timeout: 10_000,
  }, async () => {
    const part = await standIn([503]);
    const t0 = Date.now();
    watch(part, 300);
    assert.equal(await part.ended, "SIGKILL");
    assert.ok(Date.now() - t0 >= 300, `ended after ${Date.now() - t0} ms`);
    assert.ok(part.asked() > HEALTH_WATCH.failures, `asked ${part.asked()} times`);
  });

  test("no answer counts as a failure", { timeout: 10_000 }, async () => {
    const part = await standIn([]);
    watch(part);
    assert.equal(await part.ended, "SIGKILL");
  });

  test("while the broker stops, the watch ends and ends no part", { timeout: 10_000 }, async () => {
    const part = await standIn([503]);
    watch(part, 0, () => true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(part.asked(), 1);
    assert.equal(part.proc.exitCode, null);
    assert.equal(part.proc.signalCode, null);
  });
});
