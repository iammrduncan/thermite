import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { messageText, type Prompt, systemText } from "../../../src/agents/prompt.ts";
import {
  renderAuditor,
  renderFinalWriter,
  renderMergedBy,
  renderPlanner,
  renderResearchPlanner,
  renderResearchReviewer,
  renderResearchWorker,
  renderReviewer,
  renderSynthesizer,
  renderTeacher,
  renderWorker,
} from "../../../src/agents/roles/index.ts";
import { laneLimits } from "../../../src/core/contract.ts";

/**
 * Each role's render function takes the owner's addition for its campaign (goal 166, decision 1):
 * a section of its own, from "owner's addition", after the role's own text, which stays whole and
 * first. In Pi it ends the system text; in another program it follows the role's text in the one
 * message. Without one, the prompt has no such section.
 */

const addition = { text: "Say what each claim rests on.", version: 4 };
const limits = laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
const trial = (id: string) => ({ id, name: id, turnWords: "each reply is one" });
const advisor = (program: string) => ({ program, mcpServers: [] });

/** Every role's prompt, in Pi and in a program, with `a` as its addition. */
function prompts(a: typeof addition | undefined): Prompt[] {
  const work = (program: string) => [
    renderWorker({
      program: trial(program),
      brief: "the brief",
      mcpServers: [],
      limits,
      editablePaths: ["src/**"],
      addition: a,
    }),
    renderResearchWorker({
      program: trial(program),
      brief: "the brief",
      mcpServers: [],
      limits,
      addition: a,
    }),
    renderPlanner({ program, context: "{}", mcpServers: [], addition: a }),
    renderResearchPlanner({ program, context: "{}", mcpServers: [], addition: a }),
  ];
  const advisors = (program: string) => {
    const f = advisor(program);
    const brief = { research: false, run: "r-1", brief: {}, addition: a };
    return [
      renderTeacher(brief, f),
      renderTeacher({ ...brief, research: true }, f),
      renderMergedBy({ ...brief, reviews: [] }, f),
      renderAuditor({ pkg: {}, addition: a }, f),
      renderReviewer({ pkg: {}, addition: a }, f),
      renderResearchReviewer({ pkg: {}, addition: a }, f),
      renderSynthesizer({ pkg: {}, addition: a }, f),
      renderFinalWriter({ pkg: {}, addition: a }, f),
    ];
  };
  return [...work("pi"), ...work("opencode"), ...advisors("pi"), ...advisors("claude-code")];
}

describe("the owner's addition in each role's prompt (goal 166)", () => {
  test("a section of its own, labelled as the owner's, after the role's text", () => {
    for (const p of prompts(addition)) {
      const where = `${p.role} in ${p.program}`;
      const part = p.program === "pi" ? p.system : p.message;
      const i = part.findIndex((s) => s.id === "owner-addition");
      assert.ok(i > 0, `${where}: no owner's addition`);
      const s = part[i];
      assert.equal(s?.source, "owner's addition", where);
      assert.equal(
        s?.text,
        "# The campaign owner's addition (contract version 4)\nThe campaign's owner adds this to your instructions for this campaign. It adds to them and replaces none of them: where the two differ, the instructions above come first.\n\nSay what each claim rests on.",
        where,
      );
      // The role's own text comes first, whole; in Pi the addition is in no first message.
      assert.equal(part[0]?.source, "role", where);
      assert.ok(
        part.slice(0, i).some((x) => x.source === "role"),
        where,
      );
      if (p.program === "pi") {
        assert.ok(systemText(p).includes(addition.text), where);
        assert.ok(!messageText(p).includes(addition.text), where);
      }
    }
  });

  test("without one, no section and the same text as before", () => {
    for (const p of prompts(undefined)) {
      assert.ok(
        ![...p.system, ...p.message].some((s) => s.source === "owner's addition"),
        `${p.role} in ${p.program}`,
      );
      assert.ok(!messageText(p).includes("owner's addition"), p.role);
    }
  });
});
