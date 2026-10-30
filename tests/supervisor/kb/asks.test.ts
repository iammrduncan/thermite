import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import { harnessClient } from "../../../src/common/api/harness.ts";
import { answerKbAsk } from "../../../src/control/kb/index.ts";
import type { SignedCommand } from "../../../src/core/commands.ts";
import { kbAskOf } from "../../../src/core/link/kb.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import { askControl, relayKbAsks } from "../../../src/supervisor/kb/index.ts";
import { controlStore } from "../../helpers/control-store.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * The supervisor's part in the agents' searches and reads (goal 175): it takes them from the
 * harness, asks control on the rig's own subject on the bus, and hands the answers back; when
 * control can't be reached, the agent is told so in words.
 */

const RUN = "js-1";
const tokens = { supervisor: "sup-token-abcdef" };

describe("the supervisor asks control for the agents", () => {
  test("on the bus: the rig's own subject; with control away, the answer says so in words", async () => {
    const subjects: string[] = [];
    const answer = {
      note: "data",
      scope: { collection: "c", fresh: false, granted: [] },
      matched: 0,
      next_offset: null,
      counts: { kind: {}, outcome: {}, run: {}, slot: {}, collection: {} },
      words: [{ word: "x", items: 0 }],
      did_you_mean: [],
      hits: [],
    };
    const bus = {
      request: async (subject: string) => {
        subjects.push(subject);
        return new TextEncoder().encode(JSON.stringify(answer));
      },
    };
    const ok = await askControl({ rig: "rig-a", bus }, "search", { run: RUN, q: "x" });
    assert.deepEqual(ok, answer);
    assert.deepEqual(subjects, ["thermite.kb.search.rig-a"]);
    const down = {
      request: async () => {
        throw new Error("no one answers on thermite.kb.search.rig-a now");
      },
    };
    const away = await askControl({ rig: "rig-a", bus: down }, "search", { run: RUN, q: "x" });
    assert.match(
      (away as { refused: string }).refused,
      /^control can't be reached on the message bus now \(no one answers .*\): the knowledge base can't be searched or read\. Go on without it/,
    );
  });

  test("a worker's kb_search goes from the harness through the supervisor to control, and back with the run's scope", async () => {
    // Control, which assigned the run to the rig, with an item in the run's collection.
    const store = controlStore();
    store.commands.enqueue({
      envelope: {
        v: 1,
        id: "c-1",
        rig: "rig-a",
        kind: "assign_campaign",
        issued_by: "owner:api",
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload: { run: RUN, contract: { campaign: "js-sum" } },
      },
      signature: "not checked by the store",
    } as unknown as SignedCommand);
    const RIG = { rig: "rig-a", ledger: "ledger-a" };
    const at = "2026-10-29T10:00:00.000Z";
    store.kb().index(RIG, {
      at,
      actor: "harness",
      kind: "run_created",
      subject: RUN,
      body: { campaign: "js-sum" },
    });
    store.kb().index(RIG, {
      at,
      actor: "harness",
      kind: "journal_note",
      subject: RUN,
      body: { id: 1, kind: "lesson", text: "Vector loads need aligned pointers.", by: "lane-1" },
    });
    // The bus: each request answered by control as its subject names the rig.
    const bus = {
      request: async (subject: string, data: string | Uint8Array) => {
        const at = kbAskOf(subject);
        assert.ok(at);
        return new TextEncoder().encode(
          JSON.stringify(answerKbAsk(store, at.rig, at.kind, JSON.parse(String(data)))),
        );
      },
    };
    // The harness, with a worker's trial.
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const api = createHarnessApi(env.service, tokens);
    const token = randomBytes(16).toString("hex");
    new Registry(env.service.ledger).startTrial({
      id: "t-0001",
      run: RUN,
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seed,
      token,
    });
    const harness = harnessClient({
      url: "http://harness",
      token: tokens.supervisor,
      fetchImpl: async (u, init) => await api.request(String(u), init),
    });
    let stopping = false;
    const relaying = relayKbAsks({
      harness,
      control: { rig: "rig-a", bus },
      stopping: () => stopping,
    });
    try {
      const r = (await (
        await api.request("/v1/mcp-call", {
          method: "POST",
          headers: { authorization: `Bearer trial.${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            server: "thermite",
            tool: "kb_search",
            arguments: { query: "aligned vector" },
          }),
        })
      ).json()) as { isError?: boolean; content: { text: string }[] };
      assert.equal(r.isError, undefined, r.content[0]?.text);
      const found = JSON.parse(r.content[0]?.text ?? "{}") as {
        scope: { collection: string };
        hits: { address: string; excerpt: string; why: string }[];
      };
      assert.equal(found.scope.collection, "js-sum");
      assert.equal(found.hits[0]?.address, "js-sum/js-1/records/note:1");
      assert.match(
        found.hits[0]?.excerpt ?? "",
        /\*\*Vector\*\* loads need \*\*aligned\*\* pointers/,
      );
      assert.match(found.hits[0]?.why ?? "", /the text has vector, aligned/);
    } finally {
      stopping = true;
      await relaying;
    }
  });
});
