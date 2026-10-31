import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ViewWait } from "../../../../src/agents/pi-view/index.ts";
import { renderAuditor } from "../../../../src/agents/roles/index.ts";
import { checkAnswer, piAdvisor } from "../../../../src/supervisor/advisors/pi/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";

/**
 * One Pi advisor's call (goal 169), as both the supervisor and an advisor's own process run it: in
 * its Pi view, a model call refused for a usage limit whose reset its provider's words give is
 * waited out and the call goes on in the same conversation, from its role's words; without a view,
 * the call ends at it, as before.
 */

const Answer = z.strictObject({ decision: z.string() });
const ANSWER = Type.Object({ decision: Type.String() });

async function callWith(waitOut?: (w: ViewWait) => void) {
  let n = 0;
  const said: string[] = [];
  const model = await startFakeModel(({ messages }) => {
    said.push(JSON.stringify(messages));
    if (++n === 1) return { fail: 429, failMessage: "usage limit reached: try again in 1s" };
    return { toolCalls: [{ name: "answer", args: { decision: "clear" } }] };
  });
  const later: unknown[] = [];
  const end = await piAdvisor({
    name: "auditor",
    cfg: { baseUrl: model.url, model: "scripted", apiKey: "k", contextWindow: 0, maxTokens: 0 },
    sent: renderAuditor({ pkg: { attempt: "a-1" } }, { program: "pi", mcpServers: [] }),
    tools: (mcp) => mcp,
    answerSchema: ANSWER,
    check: (a) => checkAnswer(Answer, undefined, a),
    keep: async () => "nowhere",
    compacted: () => undefined,
    later: (p) => later.push(p),
    usage: () => undefined,
    waitOut,
  });
  await model.close();
  return { end, said, later };
}

test("in its Pi view, a usage limit with a reset is waited out, and the call goes on from its role's words", async () => {
  const waits: ViewWait[] = [];
  const started = Date.now();
  const { end, said, later } = await callWith((w) => waits.push(w));
  assert.equal(end.answered, true, JSON.stringify(end));
  assert.equal(waits.length, 1);
  assert.match(waits[0]?.words ?? "", /try again in 1s/);
  assert.ok(Date.now() - started >= 900, "it waited for the reset");
  assert.equal(later.length, 1, "what it went on from is kept as a later turn");
  assert.match(said.at(-1) ?? "", /usage limit reached/);
});

test("without a view, the call ends at a usage limit, as a headless advisor's does", async () => {
  const { end, said } = await callWith();
  assert.equal(end.answered, false);
  assert.equal(end.error, "no answer");
  assert.equal(said.length, 1, "no second model call");
});
