import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NoteLimit, type NoteRequest } from "../../../src/agents/tools/notes.ts";
import { laneLimits, parseContract } from "../../../src/core/contract.ts";
import { runTrial } from "../../../src/harness/agents/worker/index.ts";
import { prepareWorkspace } from "../../../src/harness/agents/workspace.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { hillClimbFixture } from "../../helpers/fixtures.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../helpers/judge-env.ts";

const said = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

describe("an optional limit on a worker's notes in one reply (goal 147)", () => {
  test("the contract takes notes_per_turn from 1 to 10,000, and none by default", () => {
    const withLimit = (n: unknown) =>
      parseContract({
        ...hillClimbFixture,
        lanes: { count: 1, trials_per_epoch: 1, limits: { notes_per_turn: n } },
      });
    const ok = withLimit(20);
    assert.ok(ok.ok);
    assert.equal(laneLimits(ok.contract).notesPerTurn, 20);
    for (const bad of [0, 10_001, 2.5]) assert.equal(withLimit(bad).ok, false, String(bad));
    const none = parseContract(hillClimbFixture);
    assert.ok(none.ok);
    assert.equal(laneLimits(none.contract).notesPerTurn, undefined);
  });

  test("past the limit a note is refused in words; a new reply counts from 0; without a limit all are kept", async () => {
    const kept: NoteRequest[] = [];
    const note = async (req: NoteRequest) => {
      kept.push(req);
      return { note: kept.length };
    };
    const limit = new NoteLimit(2);
    const write = (t: string) => limit.write(note, { kind: "observation", text: t });
    assert.match(said(await write("a")), /noted \(#1\)/);
    assert.match(said(await write("b")), /noted \(#2\)/);
    assert.equal(
      said(await write("c")),
      "not recorded: this campaign keeps at most 2 notes from one reply. Write the most important ones in your next reply. Your trial goes on.",
    );
    limit.reset();
    assert.match(said(await write("d")), /noted \(#3\)/);
    assert.deepEqual(
      kept.map((n) => n.text),
      ["a", "b", "d"],
    );
    assert.match(said(await new NoteLimit(1).write(note, { kind: "lesson", text: "x" })), /noted/);
    const free = new NoteLimit(undefined);
    for (let i = 0; i < 50; i++) await free.write(note, { kind: "lesson", text: `n${i}` });
    assert.equal(kept.length, 54);
  });

  test("a worker's reply with more note calls than the limit keeps the first ones, and its next reply keeps notes again", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const runner = new LocalRunner(env.paths.scratchDir);
    const champion = env.ledger.champions.current("js-1");
    const ws = await prepareWorkspace({
      runner,
      scratchDir: env.paths.scratchDir,
      mirror: env.service.mirrorFor("proj"),
      commit: champion.commit_sha,
      lane: "lane-1",
    });
    const answers: string[] = [];
    const n = (text: string) => ({ name: "note", args: { kind: "observation", text } });
    const fake = await startFakeModel(({ messages }) => {
      const tools = messages.filter((m) => m.role === "tool");
      answers.splice(0, answers.length, ...tools.map((m) => JSON.stringify(m.content)));
      // One reply with four notes; the next with one; then the change and its submission.
      if (tools.length === 0) return { toolCalls: [n("1"), n("2"), n("3"), n("4")] };
      if (tools.length === 4) return { toolCalls: [n("5")] };
      if (tools.length === 5)
        return {
          toolCalls: [
            { name: "write_file", args: { path: "src/kernel/work.mjs", content: FAST_KERNEL } },
          ],
        };
      if (tools.length === 6) return { toolCalls: [{ name: "submit", args: { hypothesis: "h" } }] };
      return { text: "done" };
    });
    const kept: NoteRequest[] = [];
    const r = await runTrial(
      {
        trialId: "t-notes",
        run: "js-1",
        lane: "lane-1",
        workspace: ws.repo,
        parentCommit: champion.commit_sha,
        editablePaths: ["src/kernel/**"],
        brief: "b",
        limits: { ...laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } }), notesPerTurn: 2 },
      },
      {
        runner,
        laneTool: [
          process.execPath,
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          fileURLToPath(new URL("../../../src/harness/agents/lanetool.ts", import.meta.url)),
        ],
        model: {
          baseUrl: fake.url,
          model: "t",
          apiKey: "k",
          contextWindow: 32000,
          maxTokens: 2000,
        },
        submit: (req) => env.service.submitAttempt({ ...req, lane: req.lane }, "proposer") as never,
        status: async (id) => env.service.attemptStatus(id),
        note: async (req) => {
          kept.push(req);
          return { note: kept.length };
        },
      },
    );
    await fake.close();
    assert.equal(r.stopped, "submitted", "refused notes do not end the trial");
    assert.deepEqual(
      kept.map((k) => k.text),
      ["1", "2", "5"],
    );
    assert.match(
      answers[2] ?? "",
      /not recorded: this campaign keeps at most 2 notes from one reply/,
    );
    assert.match(answers[3] ?? "", /not recorded/);
    assert.match(answers[4] ?? "", /noted \(#3\)/);
  });
});
