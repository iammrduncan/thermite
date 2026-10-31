import { withAgentsContext } from "../../../agents/model/index.ts";
import type { Prompt } from "../../../agents/prompt.ts";
import { renderPlanner, renderWorker, windowFit } from "../../../agents/roles/index.ts";
import { workerSlot } from "../../../core/kb.ts";
import { additionOf } from "../../../core/role-additions.ts";
import { LedgerError } from "../../ledger/index.ts";
import type { PreviewAsk } from "../../prompts.ts";
import { focusOf, limitsInForce } from "../coordinator.ts";
import { plannerContext } from "../planner/index.ts";
import { isCliProgram, programOf } from "../programs.ts";
import { brief, pastResearch, withOwnerSections } from "./briefs.ts";
import { modelNow, type SchedulerContext } from "./context.ts";
import { plannerInput } from "./plan.ts";
import { plannerHarness } from "./planner-call.ts";

/**
 * A role's next prompt in a run, rendered now with no side effect (goal 166): what the rig's API
 * previews. Nothing is kept, no owner's message is marked as given and no file is written. A
 * worker's is for one lane and one experiment (the first one up next unless named), as the
 * lane's first trial of the round would get it, in the program the workers run in now; a
 * planner's is for the run's next round. A research run's are not previewed yet.
 */
export function previewPrompt(sched: SchedulerContext, run: string, ask: PreviewAsk): Prompt {
  const contract = sched.o.service.contractFor(run);
  if (contract.mode === "research")
    throw new LedgerError("invalid", "a research run's prompts are not previewed yet");
  const n = (sched.registry.currentEpoch(run)?.n ?? 0) + 1;
  const m = withAgentsContext(modelNow(sched), contract.agents_context);
  if (ask.role === "planner") {
    const own = sched.o.plannerModel?.();
    const via = plannerHarness(own ?? m, own !== undefined);
    const input = plannerInput(sched, run, contract, n);
    const past = pastResearch(sched, run, isCliProgram(via) ? "files" : "tool");
    input.pastResearch = past;
    return renderPlanner({
      program: via,
      context: plannerContext(input),
      read: isCliProgram(via) && past ? sched.o.service.knowledge.dir(run) : undefined,
      mcpServers: sched.o.service.mcp.given(run, "planner").map((g) => g.name),
      kbWrites: sched.o.service.kbTools.writes(run, "planner"),
      fit: windowFit((own ?? m)?.contextWindow, (own ?? m)?.compactAt),
      addition: input.addition,
    });
  }
  const lane = ask.lane ?? "lane-1";
  const queue = sched.o.service.queue;
  const x = ask.experiment ? queue.get(ask.experiment) : queue.queued(run)[0];
  if (!x || x.run !== run)
    throw new LedgerError(
      "not_found",
      ask.experiment ? `no experiment ${ask.experiment} in ${run}` : `${run} has nothing queued`,
    );
  const champion = sched.ledger.champions.current(run);
  const sections = withOwnerSections(
    sched,
    "preview",
    run,
    lane,
    brief(
      sched,
      run,
      contract,
      n,
      {
        lane,
        family: sched.coordinator.direction(run, x),
        focus: focusOf(x),
        experiment: x.id,
        parent: "champion",
      },
      x,
      1,
      contract.lanes.trials_per_epoch,
      `the champion (seq ${champion.seq})`,
      true,
    ),
    true,
  );
  const limits = limitsInForce(sched.ledger, run, contract);
  const wallMs = limits.trialMinutes ? limits.trialMinutes * 60_000 : sched.o.trialWallMs;
  return renderWorker({
    program: programOf(m).trial,
    brief: sections,
    mcpServers: sched.o.service.mcp.given(run, "workers").map((g) => g.name),
    kbWrites: sched.o.service.kbTools.writes(run, workerSlot(lane)),
    limits,
    editablePaths: "editable_paths" in contract ? contract.editable_paths : [],
    minutes: wallMs !== undefined ? Math.round(wallMs / 60_000) : undefined,
    maxTurns: sched.o.maxTurns,
    endsAt: wallMs !== undefined ? Date.now() + wallMs : undefined,
    fit: windowFit(m?.contextWindow, m?.compactAt),
    addition: additionOf(contract, "worker"),
  });
}
