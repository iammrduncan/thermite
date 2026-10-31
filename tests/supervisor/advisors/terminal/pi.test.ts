import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { VIEW_FLAG } from "../../../../src/agents/pi-view/index.ts";
import { renderAuditor } from "../../../../src/agents/roles/index.ts";
import type { RoleRunner, RoleRunOutcome, RoleRunRequest } from "../../../../src/agents/runner.ts";
import { TERMINAL_HOST, TERMINAL_SOCKET } from "../../../../src/agents/terminal/index.ts";
import { serveTerminal } from "../../../../src/agents/terminal/server.ts";
import type { SentPrompt } from "../../../../src/supervisor/advisors/call.ts";
import { AdvisorsConfig } from "../../../../src/supervisor/advisors/config.ts";
import { AuditAnswer, runAdvisor } from "../../../../src/supervisor/advisors/index.ts";
import {
  PI_ADVISOR_MAIN,
  PI_ADVISOR_SPEC_FILE,
  type PiAdvisorSpec,
} from "../../../../src/supervisor/advisors/pi/index.ts";
import {
  AdvisorConsoles,
  type AdvisorTerminals,
} from "../../../../src/supervisor/advisors/terminal/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";

/**
 * An advisor in Pi in its Pi view (goal 169): the real process (pi/main.ts), started by a stand-in
 * for the terminal host as the advisors' runner would start it, reaches the supervisor only over
 * its call's routes with its call's credential, and its model only through the call's proxy. An
 * owner's message for its role goes in before its next model call; the owner's words typed into
 * its console steer it; a command the Pi view does not take is refused in words; its tool runs in
 * the supervisor; its answer is checked there and given back as a headless advisor's is.
 */

// Short: a socket's path is at most 104 bytes on some systems.
const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "ap-"));
after(() => rmSync(root, { recursive: true, force: true }));
const keyFile = join(root, "key");
writeFileSync(keyFile, "the-route-key\n");

const ANSWER = Type.Object({
  decision: Type.String(),
  reasons: Type.String(),
  citations: Type.Array(Type.String()),
  answers: Type.Array(Type.Object({ message: Type.Number(), text: Type.String() })),
});

/** The advisors' runner's stand-in: the host is a stand-in that runs the real process. */
function runner() {
  const seen = { argv: [] as string[], env: {} as Record<string, string>, folders: [] as string[] };
  const r: RoleRunner = {
    run: async (req: RoleRunRequest) => {
      if (!seen.folders.includes(req.cwd)) seen.folders.push(req.cwd);
      assert.equal(req.argv[1], TERMINAL_HOST, "only the terminal host runs");
      seen.env = req.env ?? {};
      const start = JSON.parse(req.stdin ?? "{}") as { secret: string; argv: string[] };
      seen.argv = start.argv;
      // The process from its entry on, as the host starts it, with only the run's environment.
      const from = start.argv.indexOf(PI_ADVISOR_MAIN);
      const child: ChildProcess = spawn(process.execPath, start.argv.slice(from), {
        cwd: req.cwd,
        env: { PATH: process.env.PATH ?? "", HOME: req.cwd, ...seen.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.resume();
      let err = "";
      child.stderr?.on("data", (d) => {
        err += d;
      });
      const screen = { cols: 120, rows: 40 };
      const host = {
        status: async () => ({ state: "running", ...screen, output: 1 }),
        type: async () => undefined,
        sendKeys: async () => undefined,
        interrupt: async () => undefined,
        screenText: async () => ({
          ...screen,
          cursor: { x: 0, y: 0 },
          alternate: false,
          lines: [],
        }),
        screenSnapshot: async () => ({ ...screen, data: "the advisor's Pi view" }),
        end: async () => {
          child.kill("SIGTERM");
          return { how: "sigterm", code: null, signal: "SIGTERM" };
        },
      };
      const server = serveTerminal(
        host as unknown as Parameters<typeof serveTerminal>[0],
        join(req.cwd, TERMINAL_SOCKET),
        start.secret,
      );
      return new Promise<RoleRunOutcome>((resolve) =>
        child.on("exit", (code, signal) => {
          server.close();
          resolve({
            exitCode: 0,
            signal: null,
            killedFor: null,
            stdout: `${JSON.stringify({ msg: "the program ended", how: "own", code, signal })}\n`,
            stderr: err,
          });
        }),
      );
    },
    handOver: async () => undefined,
    remove: async (path) => rmSync(path, { recursive: true, force: true }),
    killRole: async () => 0,
  };
  return { r, seen };
}

test("an advisor in Pi in its Pi view: an owner's message before its next call, the owner's words steer it, its tool runs here, its answer", async () => {
  let typedSeen = false;
  let ownerSeen = false;
  const model = await startFakeModel(({ messages }) => {
    const said = JSON.stringify(messages);
    ownerSeen ||= said.includes("answer it in answers with the others when you call answer");
    typedSeen ||= said.includes("Look at the timer.");
    // The owner's message and words in: its answer, with an answer for message 7.
    if (ownerSeen && typedSeen)
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              decision: "needs_owner",
              reasons: "the owner asked about the timer",
              citations: [],
              answers: [{ message: 7, text: "The timer is the judge's own." }],
            },
          },
        ],
      };
    // Meanwhile it reads its brief again, a turn at a time.
    return { toolCalls: [{ name: "brief", args: {} }], delayMs: 50 };
  });
  const { r, seen } = runner();
  const consoles = new AdvisorConsoles();
  const lines: { kind: string; text: string; run: string }[] = [];
  const terminals: AdvisorTerminals = {
    runner: r,
    root,
    consoles,
    waiting: async (run, role) =>
      run === "js-1" && role === "auditor" ? [{ id: 7, text: "Is the timer real?" }] : [],
    live: (l) => lines.push(l),
    pollMs: 25,
  };
  const { auditor } = AdvisorsConfig.parse({
    teachers: [],
    auditor: {
      name: "auditor",
      runtime: "openai",
      base_url: model.url,
      model: "scripted",
      api_key_file: keyFile,
    },
  });
  assert.ok(auditor);
  let briefs = 0;
  const running = runAdvisor({
    runtime: auditor,
    prompt: (f) => renderAuditor({ pkg: { attempt: "a-1" } }, f),
    schema: AuditAnswer,
    answerSchema: ANSWER,
    tools: {
      brief: async () => {
        briefs++;
        return { brief: "the run's brief" };
      },
    },
    terminal: { terminals, run: "js-1", role: "auditor", given: [] },
  });
  for (let i = 0; i < 500 && !consoles.calls().length; i++)
    await new Promise((res) => setTimeout(res, 10));
  const [call] = consoles.calls();
  assert.ok(call, "its console is set while its view runs");
  assert.match(call.id, /^advisor-auditor-js-1-\d+$/);
  // Its spec, in its folder: the call's routes on localhost and its credential, and no key.
  const spec = JSON.parse(
    readFileSync(join(seen.folders[0] ?? "", PI_ADVISOR_SPEC_FILE), "utf8"),
  ) as PiAdvisorSpec;
  assert.match(spec.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(spec.auth, /^call\.[0-9a-f]{48}$/);
  assert.deepEqual(
    spec.tools.map((t) => t.name),
    ["brief"],
  );
  const [frame] = await consoles.frames([call.id]);
  assert.equal(frame?.pi_view, true, "Live draws it as a Pi view");
  // A command the Pi view does not take is refused in words, before it reaches the process.
  await assert.rejects(
    consoles.input({ id: "i-0", call: call.id, text: "/model x", wait: "now" }, () => undefined),
    /\/model is not a command of the Pi view/,
  );
  // The owner's words, typed into its console: they steer it before its next model call.
  for (let i = 0; i < 500 && briefs < 1; i++) await new Promise((res) => setTimeout(res, 10));
  const now = await consoles.input(
    { id: "i-1", call: call.id, text: "Look at the timer.", wait: "now" },
    () => undefined,
  );
  assert.deepEqual(now, { outcome: "typed" });
  const res = await running;
  await model.close();
  assert.equal(res.error, undefined, JSON.stringify(res));
  assert.equal(res.output?.decision, "needs_owner");
  assert.deepEqual(res.given, [7], "the owner's message went in, for its receipt");
  assert.ok(briefs >= 1, "its tool ran in the supervisor");
  assert.ok((res.usage?.calls.length ?? 0) >= 2, "its usage came over its call's route");
  assert.ok(res.tokensIn > 0);
  // Its prompts: its first message, the owner's message and the owner's words as its role put them.
  const sent: SentPrompt[] = res.sent ?? [];
  assert.equal(sent[0]?.role, "auditor");
  const later = sent.slice(1).map((p) => ("sections" in p ? p : undefined));
  assert.ok(later.length >= 2 && later.every((p) => p?.program === "pi" && p.role === "auditor"));
  assert.ok(later.some((p) => p?.sections.some((s) => s.text.includes('"id":7'))));
  assert.ok(later.some((p) => p?.sections.some((s) => s.text.includes("Look at the timer."))));
  // Its model only through the call's proxy: the route's key is in nothing the process got.
  assert.match(
    seen.env.THERMITE_MODEL_BASE_URL ?? "",
    /^http:\/\/127\.0\.0\.1:\d+\/v1\/model-proxy$/,
  );
  assert.match(seen.env.THERMITE_MODEL_API_KEY ?? "", /^proxy\./);
  assert.ok(!JSON.stringify(seen).includes("the-route-key"));
  assert.ok(seen.argv.includes(VIEW_FLAG));
  // Its lines in the run's live view, named for it; its console gone, its last screen kept.
  assert.ok(
    lines.length > 0 && lines.every((l) => l.run === "js-1" && l.text.startsWith("auditor: ")),
  );
  assert.deepEqual(consoles.calls(), []);
  const [last] = await consoles.frames([call.id]);
  assert.equal(last?.state, "ended");
  // Its folder was one of the runs' root's children, and is gone.
  assert.match(seen.folders[0] ?? "", new RegExp(`^${root}/thermite-advisor-`));
  assert.equal(existsSync(seen.folders[0] ?? ""), false);
  assert.deepEqual(
    readdirSync(root).filter((f) => f !== "key"),
    [],
  );
});
