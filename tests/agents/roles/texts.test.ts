import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { AUDITOR_SYSTEM } from "../../../src/agents/roles/auditor.ts";
import {
  ADVICE_GOES_ON,
  ADVISOR_CANNOT_READ,
  BODIES_LEFT_OUT,
  COMPACTION_SYSTEM,
  NO_TAIL,
  PLANNER_CANNOT_READ,
  PLANNING_GOES_ON,
  researchWorkerReadsKept,
  SUMMARY_HEAD,
  TAIL_FOLLOWS,
  TRIAL_GOES_ON,
  workerReadsKept,
} from "../../../src/agents/roles/compaction.ts";
import { FINAL_WRITER_SYSTEM, STE_SHORT_RULES } from "../../../src/agents/roles/final-writer.ts";
import {
  MERGED_BY_SYSTEM,
  RESEARCH_MERGED_BY_SYSTEM,
} from "../../../src/agents/roles/merged-by.ts";
import {
  MODEL_CHECK_PI_SYSTEM,
  modelCheckPiPrompt,
  modelCheckProgramPrompt,
} from "../../../src/agents/roles/model-check.ts";
import {
  PLAN_LIMITS_TEXT,
  PLANNER_ASK_SYSTEM,
  PLANNER_OWNER_TURN,
  PLANNER_PI_SYSTEM as PLANNER_SYSTEM,
  PLANNER_TASK,
} from "../../../src/agents/roles/planner.ts";
import {
  RESEARCH_PLAN_LIMITS_TEXT,
  RESEARCH_PLANNER_ASK_SYSTEM,
  RESEARCH_PLANNER_PI_SYSTEM as RESEARCH_PLANNER_SYSTEM,
  RESEARCH_PLANNER_TASK,
} from "../../../src/agents/roles/research-planner.ts";
import {
  RESEARCH_WORKER_GO_ON,
  RESEARCH_WORKER_NOTES,
  RESEARCH_WORKER_SYSTEM,
} from "../../../src/agents/roles/research-worker.ts";
import { RESEARCH_REVIEWER_SYSTEM, REVIEWER_SYSTEM } from "../../../src/agents/roles/reviewer.ts";
import {
  ADVISOR_NOTES,
  ADVISOR_OWNER_TURN,
  ADVISOR_OWNER_TURN_PI,
  AT_WORK_GUIDE,
  BRIEF_GUIDE,
  CONTEXT_FULL_TURN,
  CUT_OFF_TURN,
  FAILED_GO_ON,
  KB_GUIDE,
  kbWriteLine,
  OWNER_LINE_HEAD,
  OWNER_TURN_HEAD,
  PAST_GUIDE,
  RESEARCH_GUIDE,
  timeLeftWords,
} from "../../../src/agents/roles/shared.ts";
import { SYNTHESIZER_SYSTEM } from "../../../src/agents/roles/synthesizer.ts";
import { RESEARCH_TEACHER_SYSTEM, TEACHER_SYSTEM } from "../../../src/agents/roles/teacher.ts";
import {
  TRIAL_CUT_WHERE,
  WORKER_CLAUDE_CODE_SYSTEM,
  WORKER_CODEX_SYSTEM,
  WORKER_HOW_TO_WORK,
  WORKER_OPENCODE_SYSTEM,
  WORKER_PI_NOTES,
  WORKER_PI_NUDGE,
  WORKER_PI_SYSTEM,
  WORKER_PROGRAM_NUDGE,
  WORKER_SUBMIT_NOW,
} from "../../../src/agents/roles/worker.ts";

/**
 * The fixed text of every agent role (goal 166), held byte for byte against the files in
 * tests/agents/golden/. A change to a role's text changes its file in the same commit, on
 * purpose: run `UPDATE_GOLDEN=1 node scripts/test.mjs tests/agents/roles/texts.test.ts`, then
 * read the diff.
 */
const TEXTS: Record<string, string> = {
  "worker.pi.system": WORKER_PI_SYSTEM,
  "worker.pi.notes-and-sources": WORKER_PI_NOTES,
  "worker.opencode.system": WORKER_OPENCODE_SYSTEM,
  "worker.claude-code.system": WORKER_CLAUDE_CODE_SYSTEM,
  "worker.codex.system": WORKER_CODEX_SYSTEM,
  "worker.how-to-work": WORKER_HOW_TO_WORK.join("\n"),
  "worker.cut": TRIAL_CUT_WHERE,
  "research-worker.system": RESEARCH_WORKER_SYSTEM,
  "research-worker.notes": RESEARCH_WORKER_NOTES,
  "planner.task": PLANNER_TASK,
  "planner.limits": PLAN_LIMITS_TEXT,
  "planner.pi.system": PLANNER_SYSTEM,
  "planner.ask.system": PLANNER_ASK_SYSTEM,
  "planner.owner-terminal": PLANNER_OWNER_TURN,
  "research-planner.task": RESEARCH_PLANNER_TASK,
  "research-planner.limits": RESEARCH_PLAN_LIMITS_TEXT,
  "research-planner.pi.system": RESEARCH_PLANNER_SYSTEM,
  "research-planner.ask.system": RESEARCH_PLANNER_ASK_SYSTEM,
  "advisors.notes": ADVISOR_NOTES,
  "advisors.brief-guide": BRIEF_GUIDE,
  "advisors.at-work-guide": AT_WORK_GUIDE,
  "advisors.past-guide": PAST_GUIDE,
  "advisors.research-guide": RESEARCH_GUIDE,
  "advisors.owner-terminal": ADVISOR_OWNER_TURN,
  "advisors.owner-pi": ADVISOR_OWNER_TURN_PI,
  // The knowledge base's part of every role's prompt (goal 175), and kb_write's line.
  "shared.kb-guide": KB_GUIDE,
  "shared.kb-write": kbWriteLine(["note", "finding"]),
  "teacher.system": TEACHER_SYSTEM,
  "merged-by.system": MERGED_BY_SYSTEM,
  "research-teacher.system": RESEARCH_TEACHER_SYSTEM,
  "research-merged-by.system": RESEARCH_MERGED_BY_SYSTEM,
  "auditor.system": AUDITOR_SYSTEM,
  "reviewer.system": REVIEWER_SYSTEM,
  "research-reviewer.system": RESEARCH_REVIEWER_SYSTEM,
  "final-writer.system": FINAL_WRITER_SYSTEM,
  "final-writer.ste-short-rules": STE_SHORT_RULES,
  "synthesizer.system": SYNTHESIZER_SYSTEM,
  "compaction.system": COMPACTION_SYSTEM,
  "model-check.pi.system": MODEL_CHECK_PI_SYSTEM,
  "model-check.pi.prompt": modelCheckPiPrompt("WORD"),
  "model-check.program.prompt": modelCheckProgramPrompt("WORD"),
  "model-check.claude-code.prompt": modelCheckProgramPrompt("WORD", "Bash tool"),
  // The later turns inside a call (goal 166).
  "worker.nudge-pi": WORKER_PI_NUDGE,
  "worker.nudge-program": WORKER_PROGRAM_NUDGE,
  "worker.submit-now": WORKER_SUBMIT_NOW,
  "research-worker.go-on": RESEARCH_WORKER_GO_ON,
  "trials.cut-off": CUT_OFF_TURN,
  "trials.context-full": CONTEXT_FULL_TURN,
  "trials.failed": FAILED_GO_ON,
  "trials.owner-turn": OWNER_TURN_HEAD,
  "trials.owner-program": OWNER_LINE_HEAD,
  "trials.time-left": [1, 18].map((n) => timeLeftWords(n * 60_000)).join("\n"),
  "compaction.goes-on-trial": TRIAL_GOES_ON,
  "compaction.goes-on-planner": PLANNING_GOES_ON,
  "compaction.goes-on-advisor": ADVICE_GOES_ON,
  "compaction.read-worker": workerReadsKept("PATH"),
  "compaction.read-research-worker": researchWorkerReadsKept("PATH"),
  "compaction.read-planner": PLANNER_CANNOT_READ,
  "compaction.read-advisor": ADVISOR_CANNOT_READ,
  "compaction.summary": SUMMARY_HEAD,
  "compaction.tail": TAIL_FOLLOWS,
  "compaction.no-tail": NO_TAIL,
  "compaction.left-out": BODIES_LEFT_OUT,
};

const golden = (name: string) => new URL(`../golden/${name}.txt`, import.meta.url);

for (const [name, text] of Object.entries(TEXTS)) {
  test(`the ${name} text is unchanged`, () => {
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden(name), text);
    assert.equal(text, readFileSync(golden(name), "utf8"));
  });
}
