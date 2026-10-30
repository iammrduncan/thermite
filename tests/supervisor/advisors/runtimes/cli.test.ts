import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { z } from "zod";
import { RunAsServer } from "../../../../src/common/run-as/index.ts";
import { ADVISOR_RUNS_ENV } from "../../../../src/core/advisor-runs.ts";
import { runCli } from "../../../../src/supervisor/advisors/runtimes/cli.ts";

/**
 * An advisor's command through the advisors' runner (src/common/run-as/), as the supervisor's
 * entry serves it; here the runner is the test's own user (not root), so it keeps every run in
 * its own process group without a user of its own. The command is a stand-in that says what it
 * was given, then answers.
 */

/** A runner on a socket of its own, and its runs' root, named in the supervisor's settings. */
async function runner() {
  const base = mkdtempSync(join(tmpdir(), "thermite-advisor-runner-"));
  const root = join(base, "runs");
  mkdirSync(root);
  chmodSync(root, 0o711);
  const socket = join(base, "runs.sock");
  const server = new RunAsServer({ socketPath: socket, root, callerGid: process.getgid?.() ?? 0 });
  server.listen();
  await new Promise((r) => server.server.once("listening", r));
  process.env[ADVISOR_RUNS_ENV.socket] = socket;
  process.env[ADVISOR_RUNS_ENV.root] = root;
  after(() => {
    delete process.env[ADVISOR_RUNS_ENV.socket];
    delete process.env[ADVISOR_RUNS_ENV.root];
    server.server.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { root };
}

/** Says its folder, prompt, token (fd 3), route and the file the supervisor wrote, then answers. */
const STAND_IN = [
  process.execPath,
  "-e",
  `const fs = require("node:fs");
let token = null;
try { token = fs.readFileSync(3, "utf8"); } catch {}
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync("left.txt", "what the run left");
console.log(JSON.stringify({ answer: { cwd: process.cwd(), home: process.env.HOME, prompt, token,
  route: process.env.ROUTE ?? null, config: fs.readFileSync("config.json", "utf8") } }));`,
];

const Answer = z.object({
  answer: z.object({
    cwd: z.string(),
    home: z.string(),
    prompt: z.string(),
    token: z.string().nullable(),
    route: z.string().nullable(),
    config: z.string(),
  }),
});

describe("an advisor's command through the advisors' runner", () => {
  test("it runs in a fresh folder of the runner's root, with only its prompt, settings, token and files; the folder goes after", async () => {
    const { root } = await runner();
    let left: string | undefined;
    const r = await runCli(
      {
        argv: STAND_IN,
        env: { ROUTE: "http://127.0.0.1:9/v1" },
        token: "a sign-in token",
        prepare: (home) => {
          writeFileSync(join(home, "config.json"), "the call's settings");
          return {};
        },
        collect: (home) => {
          left = readFileSync(join(home, "left.txt"), "utf8");
          return [];
        },
      },
      "the prompt",
      Answer,
    );
    assert.equal(r.error, undefined);
    const a = r.output?.answer;
    assert.ok(a);
    assert.equal(join(a.cwd, ".."), realpathSync(root), "a child of the runner's root");
    assert.equal(a.home, a.cwd);
    assert.equal(a.prompt, "the prompt");
    assert.equal(a.token, "a sign-in token");
    assert.equal(a.route, "http://127.0.0.1:9/v1");
    assert.equal(a.config, "the call's settings");
    assert.equal(left, "what the run left", "read before the folder goes");
    assert.equal(existsSync(a.cwd), false);
    assert.deepEqual(readdirSync(root), []);
  });

  test("a command that can't start, or runs past its time, is an error or no answer, and its folder goes", async () => {
    const { root } = await runner();
    const missing = await runCli({ argv: ["/nonexistent/advisor"] }, "", Answer);
    assert.match(missing.error ?? "", /ENOENT|nonexistent/);
    const slow = await runCli(
      { argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], timeout_s: 1 },
      "",
      Answer,
    );
    assert.match(slow.error ?? "", /no valid answer/);
    assert.deepEqual(readdirSync(root), []);
  });
});
