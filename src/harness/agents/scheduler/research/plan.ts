import { briefData } from "../../../../core/brief.ts";
import type { ResearchContract } from "../../../../core/contract.ts";
import { additionOf } from "../../../../core/role-additions.ts";
import { notesData } from "../../../journal.ts";
import { LedgerError } from "../../../ledger/index.ts";
import { messageText } from "../../../messages.ts";
import type { Experiment } from "../../../queue.ts";
import { type Research, researchState, stateWords, took } from "../../../research/index.ts";
import { focusOf, type Handout, PLANNER } from "../../coordinator.ts";
import { attribute, causeWords, lanesOf } from "../../planner/index.ts";
import type { Assignment } from "../../registry.ts";
import {
  plannerHypotheses,
  planResearch,
  type ResearchPlannerInput,
  type ResearchPlanResult,
} from "../../research/index.ts";
import { directivesOf, laneCountOf, type SchedulerContext } from "../context.ts";
import { plannerCompaction, plannerNotes, plannerRoute } from "../planner-call.ts";
import { watch } from "../watch.ts";
import { nextResearchTask, RESEARCH_TASKS } from "./tasks.ts";

/**
 * A research round (goals 047 and 117): research tasks are the run's experiments, each about one
 * question and one evidence gap. With the planner on, the model plans the round from the answer
 * cards and their gaps (planResearch); code checks every task, and applies its queue changes and
 * the hypotheses it promotes or retires (through the owner's command's function). A lane the
 * model gives no task that can still be given out, and every lane when the planner is off or
 * gave no usable plan, gets its task by the gap-driven rules (nextResearchTask). One hand-out in
 * the planner's log.
 */
export async function planResearchEpoch(
  sched: SchedulerContext,
  run: string,
  contract: ResearchContract,
  n: number,
): Promise<void> {
  for (const t of RESEARCH_TASKS)
    sched.registry.addFamily(run, t.id, t.description, "research-plan");
  const directives = directivesOf(sched, run);
  const lanes = lanesOf(laneCountOf(sched, run, contract));
  const state = researchState(sched.ledger, run, contract, { lanes: lanes.length, epoch: n });
  const live = sched.o.service.live;
  const research = sched.o.research as Research;
  const plannerOn = !sched.o.plannerOn || sched.o.plannerOn();
  // The owner's messages to the planner and to everyone working, not read yet.
  const owner = plannerOn ? sched.o.service.messages.waitingForPlanner(run) : [];
  let p: ResearchPlanResult | undefined;
  if (plannerOn) {
    live.append({
      source: "planner",
      kind: "status",
      text: `planning round ${n} (${lanes.length} lane${lanes.length === 1 ? "" : "s"}) from the answer cards`,
      run,
    });
    const input: ResearchPlannerInput = {
      run,
      epoch: n,
      laneCount: lanes.length,
      title: contract.title,
      topic: contract.topic,
      state,
      queue: sched.o.service.queue.brief(run),
      hypotheses: plannerHypotheses(sched.ledger, run),
      directives,
      ownerMessages: owner.map((m) => ({ id: m.id, text: messageText(m) })),
      campaignBrief: briefData(contract),
      notes: notesData(sched.o.service.journal.newest(run, 20)),
      briefing: sched.ledger.runs.briefing(run),
      // The owner's addition to the research planner, from the run's contract (goal 166).
      addition: additionOf(contract, "research-planner"),
    };
    const ctrl = new AbortController();
    sched.planning = { run, ctrl };
    watch(sched);
    try {
      // An owner's message that goes in inside its turn in its terminal joins these (goal 169).
      input.ownerMessages ??= [];
      const r = await plannerRoute(sched, run, contract, n, {
        role: "research-planner",
        owner: input.ownerMessages,
      });
      input.pastResearch = r.pastLine;
      p = await planResearch(
        input,
        r.m,
        ctrl.signal,
        r.ask,
        r.past,
        r.mcp,
        plannerCompaction(sched, run),
        r.usage,
        r.sent,
        r.view,
      );
    } finally {
      sched.planning = undefined;
    }
    // Paused or closed while planning: no round starts, and the owner's messages wait. The notes
    // the model already wrote are kept.
    if (ctrl.signal.aborted) {
      live.append({ source: "planner", kind: "status", text: "planning cancelled", run });
      plannerNotes(sched, run, p.journal);
      return;
    }
  }
  const given = new Set<string>();
  const handout: Handout[] = [];
  const assignments: Assignment[] = [];
  const skipped: string[] = [];
  const changed: string[] = [];
  let refs = new Map<string, string>();
  const give = (lane: string, x: Experiment, why: string) => {
    given.add(x.id);
    handout.push({ lane, experiment: x.id, why });
    assignments.push({
      lane,
      family: x.family || "explore",
      focus: focusOf(x),
      parent: "champion",
      experiment: x.id,
      why,
    });
  };
  const plan = p?.plan;
  if (plan) {
    const r = sched.coordinator.apply(run, plan.queue);
    skipped.push(...r.skipped);
    refs = r.refs;
    // The hypotheses it promoted or retired, through the function the owner's command uses: a
    // change the records no longer allow (the owner changed it meanwhile) is skipped and said.
    for (const [list, status] of [
      [plan.promote, "promoted"],
      [plan.retire, "retired"],
    ] as const)
      for (const x of list)
        try {
          const done = research.hypothesisStatus(run, { id: x.id, status, reason: x.why }, PLANNER);
          if (done.changed) changed.push(`${status} ${x.id}`);
        } catch (err) {
          if (!(err instanceof LedgerError)) throw err;
          skipped.push(`${status === "promoted" ? "promote" : "retire"} ${x.id}: ${err.message}`);
        }
    // Read only when the model's plan was used; the read names this round.
    if (owner.length)
      sched.o.service.messages.read(
        owner.map((m) => m.id),
        "planner",
        { round: n },
      );
    for (const h of r.handout) {
      const x = sched.o.service.queue.get(h.experiment);
      if (!x) continue;
      if (typeof x.question === "number") took(state, x.question);
      give(h.lane, x, h.why);
    }
  }
  // Each lane with no task yet: the gap-driven rules.
  let stalled = false;
  for (const lane of lanes) {
    if (handout.some((h) => h.lane === lane)) continue;
    const got = nextResearchTask(sched, run, contract, n, lane, state, given, directives);
    if (!got) continue;
    stalled ||= got.stalled;
    give(lane, got.x, got.why);
  }
  const where = state.questions.map(stateWords).join("; ");
  const deeper = stalled ? "; novelty fell, so primary sources and contradictions first" : "";
  const notes = plan
    ? (plan.notes ?? "the planner's research plan, from the answer cards")
    : plannerOn
      ? `the gap-driven plan${deeper}: ${where}`
      : `research plan, gap-driven${deeper}: ${where}`;
  const why = p?.causes?.length
    ? p.causes
        .map((c) => `try ${c.try}: ${causeWords[c.cause]} (${c.detail.slice(0, 200)})`)
        .join("; ")
    : "";
  live.append({
    source: "planner",
    kind: "text",
    text: [
      `round ${n}: ${
        plan
          ? `planned by the model${(p?.tries ?? 1) > 1 ? ` (try ${p?.tries})` : ""}`
          : plannerOn
            ? "set by the gap-driven plan (the model gave no usable plan)"
            : "set by the gap-driven plan (the planner is off on this rig (Edit rig))"
      }`,
      ...assignments.map((a) => {
        const x = sched.o.service.queue.get(a.experiment ?? "");
        return `${a.lane}: ${a.family}, ${x?.title ?? a.focus}`;
      }),
      ...(changed.length ? [`hypotheses: ${changed.join("; ")}`] : []),
      ...(why ? [`no usable plan: ${why}`] : []),
      ...(skipped.length ? [`skipped: ${skipped.slice(0, 3).join("; ")}`] : []),
    ].join("\n"),
    run,
  });
  sched.registry.startEpoch({
    run,
    n,
    source: plan ? "planner" : "fallback",
    tries: p?.tries ?? 0,
    valid: plan !== undefined,
    rawViolations: p?.rawViolations ?? [],
    causes: p?.causes,
    assignments: attribute(assignments, directives),
    directives: directives.map((d) => d.id),
    notes,
    // The code plan by choice (the planner is off): a research round, not a fallback.
    ...(plannerOn ? {} : { plan: "research" as const }),
    by: sched.o.owner,
  });
  sched.coordinator.handout(
    run,
    n,
    handout,
    [
      plan
        ? (plan.notes ?? "the planner's research plan, from the answer cards")
        : `${plannerOn ? "the model gave no usable plan: " : "research plan, "}gap-driven: each lane takes the owner's tasks first, else the question its gaps weigh for (its queued task, or a new one)`,
      ...(changed.length ? [`hypotheses: ${changed.join("; ")}`] : []),
      ...(skipped.length ? [`skipped: ${skipped.join("; ")}`] : []),
    ].join(". "),
  );
  // The planner's field notes, also when the rest of its answer was refused; a note about a task
  // it added names the task's id, not the ref it used.
  plannerNotes(
    sched,
    run,
    p?.journal?.map((j) =>
      j.about?.type === "experiment" && refs.has(j.about.id)
        ? { ...j, about: { type: "experiment", id: refs.get(j.about.id) as string } }
        : j,
    ),
  );
}
