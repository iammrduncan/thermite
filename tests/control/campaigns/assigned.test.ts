import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { parseContract } from "../../../src/core/contract.ts";
import { controlOnly } from "../../helpers/control-stack.ts";
import { enrollRigs } from "../../helpers/control-store.ts";

/**
 * An assign_campaign issued by hand saves its campaign on control (goal 182): its contract as a
 * version, with the assignment's starting point and imports as its sources, so a grant, a copy and
 * Start a run find the campaign before its first run starts.
 */

const C = "c".repeat(40);
const example = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../examples/contracts/goal-example.json"), "utf8"),
) as Record<string, unknown>;
const contract = (fields: Record<string, unknown>) => {
  const r = parseContract({ ...example, ...fields });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r;
};

describe("an assignment issued by hand saves its campaign (goal 182)", () => {
  test("its contract becomes a version with the assignment's sources; a version control has stays as it is", () => {
    const { store, keys } = controlOnly({});
    enrollRigs(store, ["rig-a"]);
    const assign = (run: string, c: ReturnType<typeof contract>) =>
      issueCommand(store, keys.privateKeyPem, {
        rig: "rig-a",
        kind: "assign_campaign",
        payload: {
          run,
          contract: c.contract,
          contract_sha: c.sha,
          seed: { repo: "my-project", commit: C },
          promotion: "owner_approval",
        },
        issuedBy: "owner:mcp",
      });
    const first = contract({ campaign: "pn-prefill", version: 1 });
    assign("pn-prefill-1", first);
    const saved = store.campaigns.versions("pn-prefill");
    assert.deepEqual(
      saved.map((v) => [v.version, v.sha, v.sources]),
      [[1, first.sha, { assignment: { imports: [], seed: { repo: "my-project", commit: C } } }]],
      "the run's own fields stay with its run",
    );
    // Its collection is made with it: a grant may name the campaign before its first run starts.
    assert.ok(
      store
        .kb()
        .collections()
        .some((c) => c.campaign === "pn-prefill"),
    );
    assert.ok(
      store.auditLog
        .list(20)
        .some((a) => a.action === "campaign_version_created" && a.actor === "owner:mcp"),
    );
    // The same version again saves nothing; another contract under it leaves control's as it is.
    assign("pn-prefill-2", first);
    assign("pn-prefill-3", contract({ campaign: "pn-prefill", version: 1, title: "Another" }));
    assert.deepEqual(
      store.campaigns.versions("pn-prefill").map((v) => [v.version, v.sha]),
      [[1, first.sha]],
    );
    // A newer version is saved too.
    const second = contract({ campaign: "pn-prefill", version: 2, title: "Changed" });
    assign("pn-prefill-4", second);
    assert.deepEqual(
      store.campaigns.versions("pn-prefill").map((v) => [v.version, v.sha]),
      [
        [2, second.sha],
        [1, first.sha],
      ],
    );
    // A rig check's campaign is never kept.
    assign(
      "rig-check-smoke-cpu-1a2b3c4d-1",
      contract({ campaign: "rig-check-smoke-cpu-1a2b3c4d" }),
    );
    assert.deepEqual(store.campaigns.versions("rig-check-smoke-cpu-1a2b3c4d"), []);
  });
});
