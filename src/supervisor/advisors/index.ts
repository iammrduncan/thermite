/**
 * The advisors, which the supervisor runs (goal 074 names them): the teachers (one or two, and the
 * model that merges the advice of two, `merged_by`), the auditor and the review panel. They
 * advise; they never judge. Their outputs are structured and checked here, then checked again by
 * the harness: the teachers' portfolio of opportunities becomes experiments in the run's queue
 * (goal 081); directives (with citations) steer the planner; an auditor's clear is the last step
 * before a promotion and its block stops it; a pass of the review panel is accepted unless the
 * run asks the owner (goal 079: hands-off by default). The synthesizer (goal 117) writes a
 * research run's answer cards, and the final writer (goal 112) its paper, which the harness
 * checks and accepts or refuses; each with its own model from control, else the first teacher's
 * (goal 166).
 *
 * Runtimes (the operator's choice, per role, or the model and harness control gives the role): an
 * OpenAI-compatible or Anthropic model route run here in Pi with read-only tools (the campaign
 * brief, the teachers' reads of the run's code and evidence and of its own research, a guarded web
 * fetch, the run's past research, an optional knowledge-base search); Claude Code for a Claude
 * subscription (only Claude Code may use one), with none of its own tools and only the
 * past-research search, the teachers' reads and the kit's MCP tools, served to it over MCP on
 * localhost (tools/mcp.ts); OpenCode v2 or the Codex CLI (goal 073), set up the same way, each
 * through a key-adding proxy for the call (cli.ts, proxy.ts); or a command-line agent given the
 * prompt on stdin and expected to print one JSON object. None gets a shell or file tools from
 * Thermite: the supervisor holds git and model credentials, and anything an advisor reads may be
 * prompt-injected.
 *
 * Each part is a module in advisors/: the advisors file and each advisor's runtime (config.ts);
 * the models control gives the advisors (routes.ts); what a call takes and gives (call.ts); one
 * call (run.ts), in Pi, Claude Code, OpenCode, Codex or a command-line agent (runtimes/), with
 * OpenCode's and Codex's settings and model proxy for the call (cli.ts, proxy.ts); the advisors'
 * tools (tools/); the prompt (prompt.ts); each role with its answer: the teachers and their
 * merged by model (teachers/), the auditor, the review panel, the final writer and the
 * synthesizer, with the answers to the owner's messages that they share (owner-answers.ts); the
 * guarded web fetch (fetcher.ts); the pass, which runs each role's part in turn (pass/); and which
 * advisors decide, as the harness is told (harness.ts). The rest of the supervisor imports them
 * from this file.
 */

export { AuditAnswer, auditOne } from "./auditor.ts";
export type {
  AdvisorCompaction,
  AdvisorKeeper,
  AdvisorMcp,
  AdvisorResult,
  AdvisorTools,
  AdvisorUsage,
} from "./call.ts";
export {
  type AdvisorRuntime,
  type AdvisorSetup,
  AdvisorsConfig,
  AdvisorsFile,
  type AdvisorsFileReport,
  advisorRoute,
  advisorSetup,
  advisorsFileReport,
  advisorWindow,
  packageFit,
  type RunningAdvisors,
  withRunContext,
} from "./config.ts";
export { advisorFetcher } from "./fetcher.ts";
export { WriterAnswer, writePaper } from "./final-writer.ts";
export { harnessAdvisors } from "./harness.ts";
export {
  type AdviseState,
  adviseOnce,
  emptyAdviseState,
  teachersCalled,
} from "./pass/index.ts";
export {
  isResearchPackage,
  leftOut,
  PanelAnswer,
  ResearchPanelAnswer,
  type ResearchReviewAnswers,
  type ReviewOutput,
  reviewOne,
} from "./review-panel.ts";
export {
  advisorsOf,
  type ControlAdvisors,
  mergeAdvisors,
} from "./routes.ts";
export { runAdvisor } from "./run.ts";
export { lastJsonObject } from "./runtimes/index.ts";
export { SynthesizerAnswer, synthesisProblems, synthesizeCards } from "./synthesizer.ts";
export {
  DirectiveSet,
  Opportunity,
  opportunityExperiment,
  type ProposedExperiment,
  ResearchOpportunity,
  researchOpportunityExperiment,
  TeacherReview,
  type TeacherRun,
  teacherRound,
} from "./teachers/index.ts";
