import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import {
  AdvisorsConfig,
  AuditAnswer,
  DirectiveSet,
  TeacherReview,
} from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  adviseOnce,
  emptyAdviseState,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
type Env = ReturnType<typeof makeJudgeEnv>;

function config(env: Env, advisors: AdvisorsConfig, lines: string[]): AdviseConfig {
  const api = createHarnessApi(env.service, tokens);
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      return api.request(`${url.pathname}${url.search}`, init as RequestInit);
    },
    live: (l) => lines.push(`${l.run ?? "-"} ${l.kind}: ${l.text}`),
  };
}

function runtime(url: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return { name, runtime: "openai", base_url: url, model: name, api_key_file: join(dir, "key") };
}

const events = (env: Env, kind: string) =>
  env.ledger.eventsAfter(0, 5000).events.filter((e) => e.kind === kind);

describe("the advisors and the run's queue", () => {
  test("an advisor's proposals that do not fit are left out; its review stands", () => {
    const r = TeacherReview.parse({
      summary: "s",
      recommendations: [],
      experiments: [
        { title: "ok", why: "because" },
        { title: "no why" },
        { title: "", why: "empty title" },
      ],
      moves: [
        { id: "x-0123456789ab", position: "top", why: "first" },
        { id: "not-an-id", position: "top", why: "?" },
      ],
    });
    assert.deepEqual(
      r.experiments.map((x) => x.title),
      ["ok"],
    );
    assert.equal(r.moves.length, 1);
    assert.deepEqual(TeacherReview.parse({ summary: "s", recommendations: [] }).experiments, []);
    assert.deepEqual(
      DirectiveSet.parse({ directives: [], experiments: "garbled" }).experiments,
      [],
      "a list that is not one is no list",
    );
    assert.equal(
      AuditAnswer.parse({ decision: "clear", reasons: "r", check: { title: "x" } }).check,
      undefined,
    );
  });

  test("the teachers' experiments and moves reach the queue, by the teachers; their brief has the queue", async (t: TestContext) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const first = env.service.queue.add("js-1", { title: "first", by: "owner" }, "o");
    env.service.queue.add("js-1", { title: "second", by: "owner" }, "o");
    const seen: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const all = JSON.stringify(messages);
      seen.push(all);
      if (all.includes("You merge the advice of two teachers"))
        return {
          toolCalls: [
            {
              name: "answer",
              args: {
                directives: [],
                experiments: [
                  { title: "wider loads", family: "memory", why: "both reviews: reads dominate" },
                ],
                moves: [{ id: first.id, position: "end", why: "it needs the loads first" }],
              },
            },
          ],
        };
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              summary: "reads dominate",
              recommendations: [],
              experiments: [{ title: "wider loads", why: "reads dominate" }],
            },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({
      teachers: [runtime(fake.url, "teacher-a"), runtime(fake.url, "teacher-b")],
      merged_by: runtime(fake.url, "merged-by"),
    });
    const lines: string[] = [];
    await adviseOnce(config(env, advisors, lines), emptyAdviseState());
    assert.ok(
      seen.some((s) => s.includes(first.id) && s.includes("up_next")),
      "the teachers' brief has the queue",
    );
    assert.deepEqual(
      env.service.queue.queued("js-1").map((x) => [x.title, x.added_by]),
      [
        ["second", "owner"],
        ["wider loads", "teacher"],
        ["first", "owner"],
      ],
    );
    const added = events(env, "experiment_added").at(-1);
    assert.equal(added?.actor, "supervisor:teacher");
    assert.equal((added?.body as { why: string } | undefined)?.why, "both reviews: reads dominate");
    assert.deepEqual(events(env, "experiment_moved").at(-1)?.body, {
      id: first.id,
      by: "teacher",
      position: "end",
      why: "it needs the loads first",
    });
    assert.match(
      lines.join("\n"),
      new RegExp(
        `js-1 text: the teachers added to the queue: wider loads\\. the teachers moved ${first.id}`,
      ),
    );
  });

  test("the auditor's doubt becomes a check at the top of the queue", async () => {
    const env = makeJudgeEnv({
      contract: {
        acceptance: {
          looks: [3, 6],
          confirm_blocks: 4,
          audit: { ratio_to_median: 3, absolute: 0.15 },
        },
      },
    });
    await env.service.applyCommand(env.assign);
    env.service.queue.add("js-1", { title: "already queued", by: "owner" }, "o");
    const id = (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(FAST_KERNEL), hypothesis: "h", known_flaws: [] },
        "t",
      )
    ).attempt;
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-"));
    const script = join(dir, "auditor.mjs");
    writeFileSync(
      script,
      `process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({decision:"needs_owner",reasons:"the gain is larger than the change explains",citations:["diff"],check:{title:"re-measure ${id} on the big cell",why:"the gain is larger than the change explains"}})));`,
    );
    const advisors = AdvisorsConfig.parse({
      auditor: {
        name: "cli-auditor",
        runtime: "cli",
        argv: [process.execPath, script],
        restricted: true,
      },
    });
    const lines: string[] = [];
    await adviseOnce(config(env, advisors, lines), emptyAdviseState());
    const top = env.service.queue.queued("js-1")[0];
    assert.equal(top?.title, `re-measure ${id} on the big cell`);
    assert.equal(top?.added_by, "auditor");
    assert.equal(top?.family, "check");
    assert.equal(events(env, "experiment_added").at(-1)?.actor, "supervisor:auditor");
    assert.match(lines.join("\n"), /the auditor added to the queue: re-measure/);
  });
});
