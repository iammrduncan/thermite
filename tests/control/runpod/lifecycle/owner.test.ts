import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RunpodRigView } from "../../../../src/control/runpod/rig-view.ts";
import { mcpClient } from "../../../helpers/control-stack.ts";
import { pendingOf } from "../../../helpers/rig-results.ts";
import { json, setup, TOKENS, text, working } from "./setup.ts";

/**
 * The lifecycle of RunPod rigs is the owner's alone: over REST any other token gets 401, and over
 * MCP only the owner has runpod_rig.
 */

describe("RunPod rigs' lifecycle: the owner's alone", () => {
  test("REST: any other token gets 401 and changes nothing", async () => {
    const s = setup();
    const rig = await working(s);
    for (const token of [TOKENS.operator, TOKENS.agent, TOKENS.read])
      for (const [path, body] of [
        [`/v1/rigs/${rig}/runpod/stop`, {}],
        [`/v1/rigs/${rig}/runpod/start`, {}],
        [`/v1/rigs/${rig}/runpod/terminate`, { confirm: `terminate ${rig}` }],
        [`/v1/rigs/${rig}/restart`, {}],
        [`/v1/rigs/${rig}/reset`, { confirm: `reset ${rig}` }],
      ] as const)
        assert.equal((await s.call(path, body, token)).status, 401, `${path} ${token}`);
    assert.deepEqual(s.cloud.actions(), []);
    assert.deepEqual(pendingOf(s.store, rig), []);
    assert.equal((await s.call("/v1/rigs/nope/runpod/stop", {})).status, 404);
    // The owner reads the rig's history with it.
    const one = await json<{ history: { step: string; words: string }[] }>(
      await s.call(`/v1/rigs/${rig}/runpod`),
    );
    assert.deepEqual(
      one.history.map((h) => [h.step, h.words]),
      [
        ["runpod_launched", "Launched on RunPod"],
        [
          "runpod_leaf_address",
          "Control's bus dials the pod's leaf node at the address RunPod gave it",
        ],
      ],
    );
  });

  test("MCP: runpod_rig for the owner only; rig_setup shows the history", async () => {
    const s = setup();
    const rig = await working(s);
    for (const token of [TOKENS.operator, TOKENS.read, TOKENS.agent]) {
      const tools = (await (await mcpClient(s.api, token)).listTools()).tools.map((t) => t.name);
      assert.ok(!tools.includes("runpod_rig"), token);
    }
    const owner = await mcpClient(s.api, TOKENS.admin);
    const stopped = await owner.callTool({
      name: "runpod_rig",
      arguments: { rig, action: "stop" },
    });
    const v = JSON.parse(text(stopped)) as RunpodRigView;
    assert.deepEqual([v.op?.kind, v.op?.by], ["stop", "owner:mcp"]);
    const refused = await owner.callTool({
      name: "runpod_rig",
      arguments: { rig, action: "terminate", confirm: `terminate ${rig}` },
    });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /a stop of .* is under way/);
    const setupView = JSON.parse(
      text(await owner.callTool({ name: "rig_setup", arguments: { rig } })),
    ) as { on: string; op: { kind: string }; steps: { step: string }[] };
    assert.equal(setupView.on, "runpod");
    assert.equal(setupView.op.kind, "stop");
    assert.deepEqual(
      setupView.steps.map((x) => x.step),
      ["runpod_launched", "runpod_leaf_address", "runpod_stopping"],
    );

    // A full reset over MCP: started, then confirmed, by the owner.
    const t = setup();
    const other = await working(t);
    const o = await mcpClient(t.api, TOKENS.admin);
    const noConfirm = await o.callTool({
      name: "runpod_rig",
      arguments: { rig: other, action: "reset" },
    });
    assert.equal(JSON.parse(text(noConfirm)).error, `confirm with "reset ${other}"`);
    const started = JSON.parse(
      text(
        await o.callTool({
          name: "runpod_rig",
          arguments: { rig: other, action: "reset", confirm: `reset ${other}` },
        }),
      ),
    ) as { reset: { state: string } };
    assert.equal(started.reset.state, "quiescing");
    const early = await o.callTool({
      name: "runpod_rig",
      arguments: { rig: other, action: "confirm_wipe" },
    });
    assert.match(text(early), /not waiting for confirmation/);
    const cancelled = JSON.parse(
      text(
        await o.callTool({ name: "runpod_rig", arguments: { rig: other, action: "cancel_reset" } }),
      ),
    ) as { reset: { state: string } };
    assert.equal(cancelled.reset.state, "cancelled");
    assert.deepEqual(t.steps(other).at(-1), ["reset_cancelled", true]);
  });
});
