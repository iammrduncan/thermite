import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { copyCampaign } from "../../../../../src/control/campaigns/copy.ts";
import { ControlStore } from "../../../../../src/control/store/index.ts";
import { COPY_CORE_JS, COPY_JS } from "../../../../../src/control/ui/campaigns/copy/client.ts";
import { suggestCopyName } from "../../../../../src/control/ui/campaigns/copy/index.ts";
import { parseContract } from "../../../../../src/core/contract.ts";
import { canonicalUses, type McpUse } from "../../../../../src/core/mcp.ts";

/** The Copy panel's checks as you type, exactly as the browser runs them. */
const core = new Function(
  `${COPY_CORE_JS}; return { nameCheck, sameUses, perAgent, mcpProblems };`,
)() as {
  nameCheck: (
    value: string,
    taken: string[],
    folderOnly: string[],
  ) => { ok: boolean; cls: string; say: string; fix: string };
  sameUses: (a: unknown[], b: unknown[]) => boolean;
  perAgent: (uses: unknown[], kinds: string[], total: Record<string, number>) => string;
  mcpProblems: (uses: unknown[]) => string[];
};

const TAKEN = ["q4-gemv", "opus-simd", "rl-research-harness", "old-sweep"];

describe("the Copy panel's script (goal 069)", () => {
  test("a free name, a taken one, one only the knowledge base has, and one for rig checks", () => {
    assert.deepEqual(core.nameCheck("q4-gemv-b", TAKEN, ["old-sweep"]), {
      ok: true,
      cls: "ok",
      say: "✓ Free. Its runs are named q4-gemv-b-1, q4-gemv-b-2, and so on.",
      fix: "",
    });
    assert.equal(
      core.nameCheck("opus-simd", TAKEN, ["old-sweep"]).say,
      "There is a campaign named opus-simd already. Choose another name.",
    );
    assert.equal(
      core.nameCheck("old-sweep", TAKEN, ["old-sweep"]).say,
      "There is a campaign named old-sweep already. It has no runs now, but its collection is in the knowledge base. Choose another name.",
    );
    assert.deepEqual(core.nameCheck("rig-check-1", TAKEN, []), {
      ok: false,
      cls: "bad",
      say: "A name that starts with rig-check- is for rig checks. Choose another name.",
      fix: "",
    });
    assert.deepEqual(core.nameCheck("  ", TAKEN, []), {
      ok: false,
      cls: "",
      say: "Write a name for the copy.",
      fix: "",
    });
  });

  test("a name that is not valid gets control's words and a fixed name to use, when one is free", () => {
    const words =
      "A campaign's name is lowercase letters, digits, dashes and underscores, at most 64, starting with a letter or a digit.";
    assert.deepEqual(core.nameCheck("Q4 GEMV b", TAKEN, []), {
      ok: false,
      cls: "bad",
      say: words,
      fix: "q4-gemv-b",
    });
    // The fixed name is taken: none is offered.
    assert.equal(core.nameCheck("Q4 GEMV", TAKEN, []).fix, "");
    assert.equal(core.nameCheck("-x", TAKEN, []).fix, "x");
    assert.equal(core.nameCheck("x".repeat(70), TAKEN, []).fix, "x".repeat(64));
    assert.equal(core.nameCheck("!!!", TAKEN, []).fix, "");
  });

  test("the script refuses what control refuses, and lets through what control copies", () => {
    // Control is the judge of names: the same name, the same answer.
    const store = new ControlStore(":memory:");
    const example = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "../../../../../examples/contracts/goal-example.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const src = parseContract({ ...example, campaign: "src", version: 1 });
    assert.ok(src.ok);
    store.campaigns.put({
      campaign: "src",
      version: 1,
      contract: src.contract,
      sha: src.sha,
      sources: {},
      by: "owner:test",
    });
    for (const name of ["ok-name", "Bad", "rig-check-x", "src", "a".repeat(64), "a".repeat(65)]) {
      const panel = core.nameCheck(name, ["src"], []);
      const control = copyCampaign(store, { from: "src", name }, "owner:test", new Set(["src"]));
      if (control.state === "refused") {
        assert.equal(panel.ok, false, name);
        assert.equal(panel.say, control.error, name);
      } else assert.equal(panel.ok, true, name);
    }
  });

  test("lists of servers compare as control compares them, and their problems are named", () => {
    const a: McpUse[] = [
      { name: "gbrain", agents: ["advisors", "workers"], tools: { workers: ["query", "search"] } },
      { name: "arxiv", agents: ["advisors"] },
    ];
    const b = canonicalUses(a);
    assert.equal(core.sameUses(a, b), true);
    assert.equal(core.sameUses(a, [a[0]]), false);
    assert.equal(core.sameUses(a, [{ ...a[0], tools: { workers: ["search"] } }, a[1]]), false);
    assert.equal(
      core.perAgent(a, ["workers", "advisors"], { gbrain: 31, arxiv: 3 }),
      "The workers get 2 tools from gbrain (2 of 31); the advisors get 34 tools from gbrain and arxiv.",
    );
    assert.equal(
      core.perAgent([], ["workers", "advisors"], {}),
      "The workers get none; the advisors get none.",
    );
    assert.deepEqual(
      core.mcpProblems([
        { name: "gbrain", agents: [] },
        { name: "arxiv", agents: ["workers"], tools: { workers: [] } },
      ]),
      [
        "Choose the agents that get gbrain, or untick it.",
        "The workers get no tool of arxiv: give them one, or untick workers.",
      ],
    );
  });

  test("the whole script parses, and builds text with DOM text nodes", () => {
    assert.doesNotThrow(() => new Function(COPY_JS));
    assert.ok(!COPY_JS.includes("innerHTML"));
  });

  test("the name the panel offers: the source's and -b, or the next free letter", () => {
    assert.equal(suggestCopyName("q4-gemv", new Set(TAKEN)), "q4-gemv-b");
    assert.equal(suggestCopyName("q4-gemv", new Set([...TAKEN, "q4-gemv-b"])), "q4-gemv-c");
    assert.equal(suggestCopyName("q4-gemv-b", new Set(TAKEN)), "q4-gemv-c");
    assert.equal(suggestCopyName("x".repeat(63), new Set()), "");
  });
});
