import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RESEARCH_TOOLS, researchTool } from "../../../src/agents/tools/index.ts";
import { GOLDEN } from "./capture.ts";

/**
 * The old ways to find past research are gone from every role (goal 175): no role is given the
 * past-research search or the research search that always refused, and no role's prompt points at
 * a copy of past research on the rig (the run's knowledge/ folder, or a past_research line). Past
 * research is searched in the knowledge base on control, with kb_search. The prompt files are, byte
 * for byte, what each role is sent, with its tools (the other tests here), and the role files are
 * each role's fixed texts (tests/agents/roles/texts.test.ts).
 */

const ROLE_TEXTS = join(GOLDEN, "..");

const files = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));

/** The tools a prompt file names after its "# tools" heading (a role in Pi), else none. */
function toolsOf(text: string): string[] {
  const at = text.lastIndexOf("\n# tools\n");
  if (at < 0) return [];
  return text
    .slice(at + "\n# tools\n".length)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

test("no role's tools hold the past-research search or the search that always refused", () => {
  const prompts = files(GOLDEN);
  const withTools = prompts.filter((p) => toolsOf(p.text).length > 0);
  assert.ok(withTools.length >= 15, `the prompts in Pi: ${withTools.length}`);
  for (const p of withTools) {
    const tools = toolsOf(p.text);
    assert.ok(!tools.includes("search_past_research"), `${p.name}: ${tools.join(", ")}`);
  }
  // The research tools have no search: a worker's own search (files in its worktree) is another.
  assert.equal(researchTool("search"), undefined);
  assert.ok(RESEARCH_TOOLS.every((t) => t.op !== "search"));
  // The roles in another program run the research tools as commands: none of them either.
  for (const p of prompts)
    assert.doesNotMatch(p.text, /search_past_research|thermite-trial research search /, p.name);
});

test("no role's prompt points at a copy of past research on the rig", () => {
  for (const p of [...files(GOLDEN), ...files(ROLE_TEXTS)]) {
    assert.doesNotMatch(p.text, /knowledge\//, p.name);
    assert.doesNotMatch(p.text, /past_research/, p.name);
  }
});
