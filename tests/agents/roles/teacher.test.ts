import assert from "node:assert/strict";
import { test } from "node:test";
import { messageText } from "../../../src/agents/prompt.ts";
import { renderAdvisorTurn, renderTeacher } from "../../../src/agents/roles/index.ts";
import { ADVISOR_SEARCH_TURN } from "../../../src/agents/roles/shared.ts";
import {
  RESEARCH_TEACHER_SYSTEM,
  RESEARCH_TEACHER_WEB,
  TEACHER_SYSTEM,
  TEACHER_WEB,
} from "../../../src/agents/roles/teacher.ts";

/**
 * A teacher with its program's own web search and fetch (goal 232; the owner's decision of
 * 2026-11-08): its instructions say to search the web every round, right after its own text, and
 * in its own terminal a turn that ended with no search sends it back to search.
 */

const brief = { research: false, run: "r-1", brief: {} };

test("a teacher with its program's web tools is told to search every round; one without is not", () => {
  for (const research of [false, true]) {
    const own = research ? RESEARCH_TEACHER_SYSTEM : TEACHER_SYSTEM;
    const rule = research ? RESEARCH_TEACHER_WEB : TEACHER_WEB;
    for (const program of ["claude-code", "codex"]) {
      const p = renderTeacher({ ...brief, research }, { program, mcpServers: [], web: true });
      const ids = p.message.map((s) => s.id);
      assert.equal(ids.indexOf("web"), ids.indexOf("system") + 1, `${program}: after its text`);
      assert.ok(messageText(p).includes(`${own}\n\n${rule}`), program);
    }
    const none = renderTeacher({ ...brief, research }, { program: "pi", mcpServers: [] });
    assert.ok(!none.system.some((s) => s.id === "web"));
    assert.ok(!none.message.some((s) => s.id === "web"));
  }
});

test("the turn that sends a teacher back to search says so, and asks for its whole answer again", () => {
  const p = renderAdvisorTurn("teacher", { kind: "search", program: "codex", turn: 1 });
  assert.equal(messageText(p), ADVISOR_SEARCH_TURN);
  assert.equal(p.turn, 1);
  assert.match(ADVISOR_SEARCH_TURN, /whole answer again, as one JSON object/);
});
