import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPlanner } from "../../../../src/agents/roles/index.ts";
import { PLANNER_OWNER_TURN } from "../../../../src/agents/roles/planner.ts";
import { OWNER_TURN_HEAD } from "../../../../src/agents/roles/shared.ts";
import { callPlanner } from "../../../../src/harness/agents/planner/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { HOLD_MS, MESSAGE, ownerWaits, TYPED } from "../../../helpers/owner-waits.ts";
import { model } from "./setup.ts";

/**
 * The planner in Pi as its own process calls it, in its Pi view (planner-main.ts, goal 169): the
 * owner's words typed into its view and an owner's message that wait together go into its next
 * model call, the message as its numbered turn with its id, and the message is posted as read,
 * though the planner sends its plan on that call.
 */

const PLAN = { assignments: [{ lane: "lane-1", experiment: "x-1", parent: "champion" }] };

test("the owner's words and an owner's message that wait together go into the planner's next model call, though it sends its plan on that call", async () => {
  const calls: string[] = [];
  const fake = await startFakeModel(({ messages }) => {
    calls.push(JSON.stringify(messages));
    return calls.length === 1
      ? { text: "I read the queue first.", delayMs: HOLD_MS }
      : { toolCalls: [{ name: "submit_plan", args: PLAN }] };
  });
  const owner = ownerWaits(fake);
  const planning = callPlanner(
    model(fake.url),
    renderPlanner({ program: "pi", context: "{}", mcpServers: [] }),
    { view: owner.inputs, link: owner.link, kept: owner.keep },
  );
  await owner.typeAndWrite();
  const plan = await planning;
  await owner.close();
  await fake.close();
  assert.deepEqual(plan, PLAN);
  assert.equal(calls.length, 2, "it sent its plan on the model call after the held reply");
  owner.heldBoth(calls[1], {
    typed: `${OWNER_TURN_HEAD}\n\n${TYPED}`,
    message: `${PLANNER_OWNER_TURN}\n\n${JSON.stringify(MESSAGE)}`,
  });
});
