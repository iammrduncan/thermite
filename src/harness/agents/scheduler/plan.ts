import { briefData } from "../../../core/brief.ts";
import type { Contract } from "../../../core/contract.ts";
import { asToken } from "../../../core/directions.ts";
import { queueTarget } from "../../../core/queue-target.ts";
import { additionOf } from "../../../core/role-additions.ts";
import { notesData } from "../../journal.ts";
import { messageText } from "../../messages.ts";
import { type Experiment, inFamily } from "../../queue.ts";
import { type Handout, PLANNER } from "../coordinator.ts";
import {
  attribute,
  causeWords,
  fallbackPlan,
  lanesOf,
  type PlannerInput,
  plan,
  toDesign,
} from "../planner/index.ts";
import type { Assignment } from "../registry.ts";
import { directivesOf, laneCountOf, objectiveOf, type SchedulerContext } from "./context.ts";
import { goalReport } from "./goal.ts";
import { championGain } from "./lanes.ts";
import { plannerCompaction, plannerNotes, plannerRoute } from "./planner-call.ts";
import { watch } from "./watch.ts";

/**
 * A round of the plan, in a hill climb or a goal campaign: the planner's call, its answer applied
 * to the run's experiment queue, and every lane's experiment for the round.
 */
export async function planEpoch(
  sched: SchedulerContext,
  run: string,
  contract: Contract,
  n: number,
): Promise<void> {
  const input = plannerInput(sched, run, contract, n);
  const { laneCount } = input;
  const owner = input.ownerMessages ?? [];
  const lanes = lanesOf(laneCount);
  const live = sched.o.service.live;
  live.append({
    source: "planner",
    kind: "status",
    text: `planning round ${n} (${laneCount} lane${laneCount === 1 ? "" : "s"})`,
    run,
  });
  const ctrl = new AbortController();
  sched.planning = { run, ctrl };
  watch(sched);
  let p: Awaited<ReturnType<typeof plan>>;
  try {
    // An owner's message that goes in inside its turn in its terminal joins these (goal 169).
    input.ownerMessages ??= [];
    const r = await plannerRoute(sched, run, contract, n, {
      role: "planner",
      owner: input.ownerMessages,
    });
    input.pastResearch = r.pastLine;
    // The planner off on this rig: the fixed fallback plan, said so in the epoch's record.
    if (sched.o.plannerOn && !sched.o.plannerOn()) {
      const f = fallbackPlan(input);
      p = {
        source: "fallback",
        tries: 0,
        valid: false,
        rawViolations: [],
        notes: "the planner is off on this rig (Edit rig)",
        assignments: f.assignments,
        newFamilies: f.newFamilies,
      };
    } else
      p = await plan(
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
  // Paused or closed while planning: no epoch starts, and the owner's messages wait. The notes
  // the model already wrote are kept.
  if (ctrl.signal.aborted) {
    live.append({ source: "planner", kind: "status", text: "planning cancelled", run });
    plannerNotes(sched, run, p.journal);
    return;
  }
  // Read only when the model's plan was valid and used: a planner that is off, a model that
  // could not be reached, or plans refused on both tries leave them waiting for the next plan.
  // The read names this round, whose rules and notes answer them.
  if (owner.length && p.source === "planner")
    sched.o.service.messages.read(
      owner.map((m) => m.id),
      "planner",
      { round: n },
    );
  // New directions, with the rules that named them before the run had them, and the old rules
  // in words converted to them (goal 066).
  const waiting = toDesign(input);
  for (const f of p.newFamilies)
    sched.registry.addFamily(run, f.id, f.description, `planner:${p.source}`, [
      ...(waiting.find((d) => d.name === f.id)?.rules.map((r) => r.id) ?? []),
      ...(p.queue?.convert.filter((c) => c.family === f.id).map((c) => c.rule) ?? []),
    ]);
  // The hand-out: the model's answer applied to the queue, or the fixed rules. Every lane gets
  // an experiment for its next trial; none goes to two lanes.
  const given = new Set<string>();
  const handout: (Handout & { parent: "champion" | "lane_best" })[] = [];
  let skipped: string[] = [];
  let refs = new Map<string, string>();
  if (p.queue) {
    const r = sched.coordinator.apply(run, p.queue);
    skipped = r.skipped;
    refs = r.refs;
    for (const h of r.handout) {
      handout.push(h);
      given.add(h.experiment);
    }
  }
  // Rules the model just added (from the owner's messages) or converted (from old rules in
  // words) apply from this hand-out on.
  const directives =
    p.queue?.rules.length || p.queue?.convert.length ? directivesOf(sched, run) : input.directives;
  if (lanes.some((l) => !handout.some((h) => h.lane === l)))
    sched.coordinator.ensureMandates(run, directives);
  // The queue's target (goal 081): when up next would hold fewer than the target after the
  // hand-out, the lanes' distinct ideas go up next first, oldest first, as the planner's.
  const target = input.queueTarget ?? 0;
  const avoided = (x: Experiment) =>
    directives.some((d) => d.body.kind === "avoid" && d.body.family && inFamily(x, d.body.family));
  // The one count of ready ideas, which the teachers' brief and queue_low read too.
  const ready = () => sched.o.service.queue.ready(run, directives, given).length;
  const waitingLanes = lanes.filter((l) => !handout.some((h) => h.lane === l)).length;
  // A target of 0 asks for no ideas: the lanes' ideas then wait, as before (goal 081).
  const ideas =
    target > 0
      ? sched.coordinator.acceptIdeas(
          run,
          target + waitingLanes - ready(),
          avoided,
          `the queue had fewer than its target of ${target} experiments ready: a lane's distinct idea goes up next`,
        )
      : [];
  for (const lane of lanes) {
    if (handout.some((h) => h.lane === lane)) continue;
    const fixed = p.assignments.find((a) => a.lane === lane);
    let x = sched.coordinator.pick(run, lane, { directives, window: laneCount, exclude: given });
    let why = x ? sched.coordinator.whyPicked(run, lane, x, directives) : "";
    if (!x && fixed) {
      x = sched.coordinator.fill(
        run,
        fixed,
        `the queue was empty: the fixed plan's direction for ${lane} (${fixed.family})`,
      );
      why = "the queue was empty, so the fixed plan added it";
    }
    if (!x) continue;
    given.add(x.id);
    handout.push({
      lane,
      experiment: x.id,
      parent: fixed?.parent ?? (input.laneBests[lane] ? "lane_best" : "champion"),
      why,
    });
  }
  const assignments: Assignment[] = handout.flatMap((h) => {
    const x = sched.o.service.queue.get(h.experiment);
    if (!x) return [];
    return [
      {
        lane: h.lane,
        family: sched.coordinator.direction(run, x, p.newFamilies),
        focus: x.title,
        parent: h.parent,
        experiment: x.id,
        why: h.why,
      },
    ];
  });
  live.append({
    source: "planner",
    kind: "text",
    text: [
      `round ${n}: ${p.source === "planner" ? `planned by the model${p.tries > 1 ? ` (try ${p.tries})` : ""}` : `taken from the queue by the fixed rules${p.notes ? ` (${p.notes})` : p.rawViolations.length ? " (the model gave no usable plan)" : p.tries === 0 ? " (no model)" : ""}`}`,
      ...assignments.map(
        (a) =>
          `${a.lane}: ${a.family}, ${a.focus}${a.parent === "lane_best" ? " (from the lane's best)" : ""}`,
      ),
      ...(p.newFamilies.length
        ? [
            `new directions: ${p.newFamilies.map((f) => `${asToken(f.id)} (${f.description})`).join("; ")}`,
          ]
        : []),
      ...(p.queue?.convert.length
        ? [
            `old rules in words converted: ${p.queue.convert.map((c) => `rule ${c.rule} to ${asToken(c.family)}`).join("; ")}`,
          ]
        : []),
      // Why the model's tries gave no usable plan, each by its real cause (goal 079).
      ...(p.causes?.length
        ? [
            `no usable plan: ${p.causes
              .map((c) => `try ${c.try}: ${causeWords[c.cause]} (${c.detail.slice(0, 200)})`)
              .join("; ")}`,
          ]
        : p.rawViolations.length
          ? [`refused: ${p.rawViolations.slice(0, 3).join("; ")}`]
          : []),
      ...(skipped.length ? [`skipped: ${skipped.slice(0, 3).join("; ")}`] : []),
      ...(ideas.length
        ? [
            `the lanes' ideas queued to reach the target of ${target}: ${ideas.map((x) => x.title).join("; ")}`,
          ]
        : []),
    ].join("\n"),
    run,
  });
  sched.registry.startEpoch({
    run,
    n,
    source: p.source,
    tries: p.tries,
    valid: p.valid,
    rawViolations: p.rawViolations,
    causes: p.causes,
    assignments: attribute(assignments, directives),
    directives: directives.map((d) => d.id),
    notes: p.notes,
    by: sched.o.owner,
  });
  sched.coordinator.handout(
    run,
    n,
    handout,
    [
      p.source === "planner"
        ? (p.notes ?? "the planner's plan")
        : p.notes
          ? `${p.notes}: lanes took queued experiments in order`
          : p.rawViolations.length
            ? "the model gave no usable plan: lanes took queued experiments in order"
            : "lanes took queued experiments in order",
      ...(skipped.length ? [`skipped: ${skipped.join("; ")}`] : []),
    ].join(". "),
  );
  // Still below the target (goal 081): the planner could not top the queue up, so the teachers
  // are asked for ideas at once (the supervisor reads queue_low), not on their clock.
  const left = ready();
  if (target > 0 && left < target) {
    sched.ledger.appendEvent(PLANNER, "queue_low", run, {
      round: n,
      ready: left,
      target,
      lanes: laneCount,
      source: p.source,
    });
    live.append({
      source: "planner",
      kind: "status",
      text: `after round ${n} the queue has ${left} of its target of ${target} experiments ready: the teachers are asked for ideas now`,
      run,
    });
  }
  // The planner's field notes, also when the rest of its answer was refused; a note about an
  // experiment it added names the experiment's id, not the ref it used.
  plannerNotes(
    sched,
    run,
    p.journal?.map((j) =>
      j.about?.type === "experiment" && refs.has(j.about.id)
        ? { ...j, about: { type: "experiment", id: refs.get(j.about.id) as string } }
        : j,
    ),
  );
}

/** A round's planner input: what the planner is told of the run, read from its record only. */
export function plannerInput(
  sched: SchedulerContext,
  run: string,
  contract: Contract,
  n: number,
): PlannerInput {
  const laneCount = laneCountOf(sched, run, contract);
  // The owner's messages to the planner and to everyone working, not read yet.
  const owner = sched.o.service.messages.waitingForPlanner(run);
  const lanes = lanesOf(laneCount);
  const champion = sched.ledger.champions.current(run);
  return {
    run,
    epoch: n,
    laneCount,
    objective: objectiveOf(contract),
    editablePaths: "editable_paths" in contract ? contract.editable_paths : [],
    champion: { seq: champion.seq, gain: championGain(sched.ledger, run) },
    families: sched.registry.families(run),
    evidence: sched.registry.evidence(run, 30),
    queue: sched.o.service.queue.brief(run),
    laneState: sched.coordinator.laneState(run, lanes),
    directives: directivesOf(sched, run),
    directions: sched.o.service.queue.directions(run),
    laneBests: Object.fromEntries(lanes.map((l) => [l, sched.registry.laneBest(run, l)])),
    // The campaign's brief from its author, whole (goal 078).
    campaignBrief: briefData(contract),
    ownerMessages: owner.map((m) => ({ id: m.id, text: messageText(m) })),
    goalReport: contract.mode === "goal" ? goalReport(sched.ledger, run, champion.seq) : undefined,
    // The run's newest field notes, the owner's picks from past research, and where the run's
    // past research is: all data for the planner to weigh.
    notes: notesData(sched.o.service.journal.newest(run, 20)),
    briefing: sched.ledger.runs.briefing(run),
    // The queue's target (goal 081): the planner tops the queue up to it with distinct ideas.
    queueTarget: queueTarget(contract, laneCount),
    // The owner's addition to the planner, from the run's contract (goal 166).
    addition: additionOf(contract, "planner"),
  };
}
