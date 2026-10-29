import { randomBytes } from "node:crypto";
import { errorText } from "../../../../common/errors.ts";
import { log } from "../../../../common/log.ts";
import type { ResearchContract } from "../../../../core/contract.ts";
import { newTrialId } from "../../../../core/ids.ts";
import { workerSlot } from "../../../../core/kb.ts";
import { questionLabel } from "../../../../core/research-check.ts";
import { additionOf } from "../../../../core/role-additions.ts";
import type { Experiment, TaskYield } from "../../../queue.ts";
import { briefCards, briefGaps, type Research } from "../../../research/index.ts";
import { focusOf, limitsInForce, PLANNER } from "../../coordinator.ts";
import type { Assignment } from "../../registry.ts";
import type { ResearchTrialSpec } from "../../research/index.ts";
import type { TrialResult } from "../../worker/index.ts";
import { campaignBrief, notesAndPast, withOwnerSections } from "../briefs.ts";
import type { SchedulerContext } from "../context.ts";
import { afterTrial } from "../provider.ts";
import { finishExperiment, trialLine, withProgress } from "../trials.ts";
import { watch } from "../watch.ts";

/** A lane's research trial: its brief from the run's records, its worker, and its end. */
export function startResearchTrial(
  sched: SchedulerContext,
  run: string,
  contract: ResearchContract,
  epoch: number,
  round: Assignment,
  clock: { elapsed_ms: number; min_ms: number; max_ms: number | null },
  got: { x: Experiment; why: string },
): void {
  // A research task from the queue: its task kind is the trial's family, its text the focus.
  const a: Assignment = {
    ...round,
    family: got.x.family || "explore",
    focus: [focusOf(got.x), got.x.why ? `Why: ${got.x.why}` : ""].filter(Boolean).join("\n"),
    experiment: got.x.id,
    why: got.why,
  };
  const research = sched.o.research as Research;
  const id = newTrialId();
  const stats = research.stats(run);
  const frontier = research.frontier(run, 30);
  const brief = [
    `# Research assignment (epoch ${epoch}, ${a.lane})`,
    `Campaign: ${contract.title}`,
    `Topic: ${contract.topic}`,
    // Numbered from 1 for reading, with the index from 0 that a claim's, a hypothesis's or a
    // task's `question` field takes (goal 117).
    "Questions (a claim's or a hypothesis's `question` is the index):",
    ...contract.questions.map(
      (q, i) =>
        `${questionLabel(i)}: ${q.replace(/\n/g, "\n   ")} (${stats.questions[i]?.verified ?? 0} verified claims so far)`,
    ),
    "",
    // Each question's answer card (goal 117): its answer, certainty and open evidence gaps.
    briefCards(sched.ledger, run, contract),
    "",
    // The campaign's brief from its author (goal 078): whole, or cut with where the rest is.
    campaignBrief(sched, run, contract),
    "",
    `Your focus: ${a.focus}`,
    `Time: ${(clock.elapsed_ms / 3_600_000).toFixed(2)} h elapsed of at least ${(clock.min_ms / 3_600_000).toFixed(2)} h (the campaign continues after your trial).`,
    `Corpus: ${stats.sources} sources, ${stats.verified} verified claims, ${stats.drafts} drafts, ${stats.findings} findings.`,
    frontier.length ? `Links from archived sources not fetched yet: ${frontier.join(" ")}` : "",
    "",
    "Record claims only with exact quotes from archived sources, and give the question each answers by its index, in `question`.",
    // The hypotheses: which need a verdict, and the pool (goal 117).
    `\n${research.hypothesesBrief(run)}`,
    // What the newest failed review found missing (goal 112), until a newer review is decided.
    ...[briefGaps(sched.ledger, run)].filter((s) => s !== undefined).map((s) => `\n${s}`),
    ...notesAndPast(sched, run, a.lane, "research").map((s) => `\n${s}`),
  ]
    .filter((l) => l !== "")
    .join("\n");
  const token = randomBytes(32).toString("hex");
  sched.registry.startTrial({
    id,
    run,
    lane: a.lane,
    epoch,
    family: a.family,
    parent: "research",
    token,
    focus: a.focus,
  });
  sched.o.service.queue.assign(
    run,
    got.x.id,
    { lane: a.lane, trial: id, by: PLANNER, why: got.why },
    PLANNER,
  );
  trialLine(
    sched,
    id,
    run,
    a.lane,
    "status",
    `research trial on ${a.lane}: ${a.family}, ${got.x.title}`,
  );
  const fullBrief = withOwnerSections(sched, id, run, a.lane, brief);
  const limits = limitsInForce(sched.ledger, run, contract);
  const abort = new AbortController();
  sched.aborts.set(a.lane, abort);
  sched.laneRun.set(a.lane, run);
  watch(sched);
  const work = (async () => {
    let r: TrialResult = { stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
    try {
      r = await (
        sched.o.runResearchTrial as (
          s: ResearchTrialSpec,
          signal: AbortSignal,
        ) => Promise<TrialResult>
      )(
        {
          trialId: id,
          token,
          run,
          lane: a.lane,
          brief: fullBrief,
          wallMs: limits.trialMinutes ? limits.trialMinutes * 60_000 : sched.o.trialWallMs,
          maxTurns: sched.o.maxTurns,
          limits,
          mcpServers: sched.o.service.mcp.given(run, "workers").map((g) => g.name),
          // What the lane's worker may write in the knowledge base (goal 175).
          kbWrites: sched.o.service.kbTools.writes(run, workerSlot(a.lane)),
          // The owner's addition to the research worker, from the run's contract (goal 166).
          addition: additionOf(contract, "research-worker"),
        },
        abort.signal,
      );
    } catch (err) {
      r = { ...r, error: errorText(err) };
    } finally {
      if (abort.signal.aborted) r = { ...r, stopped: "interrupted" };
      r = withProgress(sched, id, r);
      sched.o.service.trialEnded(id, r.turns > 0 || r.tokensIn > 0);
      sched.registry.finishTrial(id, r, sched.o.owner);
      // What the task's trial added, kept with the task (goal 117).
      finishExperiment(sched, id, r, undefined, taskYield(sched, run, id));
      afterTrial(sched, id, run, r);
      trialLine(
        sched,
        id,
        run,
        a.lane,
        "status",
        `trial ended: ${r.stopped}${r.error ? ` (${r.error.slice(0, 200)})` : ""}`,
      );
    }
  })().finally(() => {
    sched.running.delete(a.lane);
    sched.aborts.delete(a.lane);
    sched.laneRun.delete(a.lane);
  });
  sched.running.set(a.lane, work);
}

/** What a research trial added (goal 117); undefined when it cannot be read (logged). */
function taskYield(sched: SchedulerContext, run: string, trial: string): TaskYield | undefined {
  try {
    return (sched.o.research as Research).trialYield(run, trial);
  } catch (err) {
    log("scheduler", "the research trial's yield was not read", { trial, error: String(err) });
    return undefined;
  }
}
