import { briefData } from "../../core/brief.ts";
import { isLegacyRule } from "../../core/directions.ts";
import type { StructuredDirective } from "../../core/directives.ts";
import { queueTarget, ruleRefusal } from "../../core/queue-target.ts";
import { handedOut, Registry, rulesInForce } from "../agents/index.ts";
import {
  listChampionFiles,
  oneAttempt,
  readAttemptDiff,
  readChampionFile,
  recentAttempts,
  triedCauses,
} from "../evidence.ts";
import { NOTES_ARE_DATA, notesData } from "../journal.ts";
import { LedgerError } from "../ledger/index.ts";
import { researchState, stateBrief } from "../research/index.ts";
import { backgroundFor } from "./decisions.ts";
import type { HarnessService } from "./index.ts";
import { requireRun } from "./runs.ts";

/**
 * What the teachers read of a run (goal 081), read only: its brief, its queue's depth against its
 * target, the champion's code, an attempt's diff and the judge's public findings.
 */

/**
 * A run's target queue depth now (goal 081): the target, the lanes it is counted for (the
 * current round's, else the contract's), and how many experiments are ready for a lane, counted
 * as the planner's round counts them: queued, not handed out in the newest round, and in no
 * direction an AVOID rule in force names.
 */
export function queueState(
  svc: HarnessService,
  run: string,
): { target: number; lanes: number; ready: number } {
  const contract = svc.contractFor(run);
  const epoch = new Registry(svc.ledger).currentEpoch(run);
  const lanes = epoch?.assignments.length || contract.lanes.count;
  return {
    target: queueTarget(contract, lanes),
    lanes,
    ready: svc.queue.ready(run, rulesInForce(svc.ledger, run), handedOut(svc.ledger, run)).length,
  };
}

/**
 * The newest time a planner's round left a run's queue below its target (goal 081), while it
 * still is: the supervisor then starts the teachers' round at once, not on the clock. None for
 * a run that is not running, has no agents or is a research run, or whose queue is at its
 * target again.
 */
export function queueLow(
  svc: HarnessService,
  run: string,
): { event: number; at: string; round: number; ready: number; target: number } | null {
  const inst = svc.ledger.runs.get(run);
  if (inst?.status !== "running" || !inst.agents || inst.mode === "research") return null;
  const e = svc.ledger.events.newest("queue_low", { subject: run });
  if (!e) return null;
  const now = svc.queueState(run);
  if (now.ready >= now.target) return null;
  return {
    event: e.id,
    at: e.at,
    round: e.body.round ?? 0,
    ready: now.ready,
    target: now.target,
  };
}

/**
 * The run's project mirror, for the teachers' code reads (goal 081). A research run has none: it
 * works on sources, not a repository, and its seed is a placeholder whose mirror was never made,
 * so Git would be started in a folder that does not exist.
 */
function codeMirror(svc: HarnessService, run: string): string {
  const inst = requireRun(svc.ledger, run);
  if (inst.mode === "research")
    throw new LedgerError(
      "invalid",
      `run ${run} is a research run: it has no code to read. Its work is the sources, claims and notes in its research folder`,
    );
  return svc.mirrorFor(inst.seed_repo);
}

/** The champion's commit and the run's project mirror, for the teachers' code reads (goal 081). */
function championCode(svc: HarnessService, run: string): { mirror: string; commit: string } {
  return { mirror: codeMirror(svc, run), commit: svc.ledger.champions.current(run).commit_sha };
}

/** The files of the champion's tree under a folder, for the teachers (goal 081). */
export function codeFiles(
  svc: HarnessService,
  run: string,
  folder: string,
): ReturnType<typeof listChampionFiles> {
  const c = championCode(svc, run);
  return listChampionFiles(c.mirror, c.commit, folder);
}

/** One file of the champion's tree, by lines, for the teachers (goal 081). */
export function codeFile(
  svc: HarnessService,
  run: string,
  path: string,
  offset?: number,
  limit?: number,
): ReturnType<typeof readChampionFile> {
  const c = championCode(svc, run);
  return readChampionFile(c.mirror, c.commit, path, offset, limit);
}

/** An attempt's diff, in parts, for the teachers (goal 081). */
export function attemptDiff(
  svc: HarnessService,
  run: string,
  attempt: string,
  offset?: number,
): ReturnType<typeof readAttemptDiff> {
  return readAttemptDiff(svc.ledger, codeMirror(svc, run), run, attempt, offset);
}

/**
 * The judge's public findings for the teachers (goal 081): one attempt in full, or the newest
 * attempts and the newest tried experiments, each with its cause. Never held-out results.
 */
export function evidence(svc: HarnessService, run: string, attempt?: string): unknown {
  requireRun(svc.ledger, run);
  if (attempt) return oneAttempt(svc.ledger, run, attempt);
  return {
    attempts: recentAttempts(svc.ledger, run, { limit: 40, reasonChars: 2000 }),
    tried: triedCauses(svc.ledger, svc.queue, run, { limit: 40, causeChars: 1200 }),
  };
}

/**
 * The deterministic snapshot the teachers review: the campaign, the champion and its commit,
 * the direction registry, recent attempts with the judge's public reasons, the causes of the
 * experiments tried, epochs, the directives in force, the queue and its target, and what the
 * teachers proposed before (goal 081). Nothing from held-out cells (evidence.ts says how), and
 * no worker text beyond hypotheses and ideas, the field notes, and the run's own research
 * (goal 098): its counts, each question's coverage and the newest report, marked as data.
 */
export function brief(svc: HarnessService, run: string): unknown {
  const inst = requireRun(svc.ledger, run);
  const contract = svc.contractFor(run);
  const registry = new Registry(svc.ledger);
  const champion = svc.ledger.champions.current(run);
  const epochs = svc.ledger.trials.newestEpochs(run, 5).map((e) => ({
    n: Number(e.n),
    // A research run's rounds: by its planner (goals 047 and 117), or by its research plan in code.
    source:
      contract.mode === "research" && String(e.source) !== "planner"
        ? "research plan"
        : String(e.source),
    planner_valid: Number(e.planner_valid) === 1,
    violations: (JSON.parse(String(e.raw_violations)) as unknown[]).length,
    directives: JSON.parse(String(e.directives ?? "[]")) as number[],
    assignments: (
      JSON.parse(String(e.assignments)) as { lane: string; family: string; directive?: number }[]
    ).map((a) => ({ lane: a.lane, family: a.family, directive: a.directive ?? null })),
  }));
  const goals =
    contract.mode === "goal"
      ? [...svc.ledger.goals.statuses(run)].map(([id, status]) => ({ id, status }))
      : undefined;
  const brief = briefData(contract);
  const research = svc.runResearch.summary(run);
  return {
    rig: svc.rig,
    run,
    campaign: inst.campaign,
    status: inst.status,
    mode: contract.mode,
    title: contract.title,
    objective:
      contract.mode === "hill_climb"
        ? contract.objective
        : contract.mode === "goal"
          ? contract.goals.map((g) => ({
              id: g.id,
              description: g.description,
              required: g.required,
            }))
          : { topic: contract.topic, questions: contract.questions },
    // What the run's own research holds (goal 098): a research run's always, a hill-climb or
    // goal run's when its trials recorded some. Short, before the long parts a window may cut;
    // the teachers' research tools read the rest.
    ...(research ? { research } : {}),
    // Where each question stands for the plan (goal 117): decided, saturated, the weight its card
    // gives it and its share of the last tasks. The teachers propose for the open ones.
    ...(contract.mode === "research"
      ? {
          question_state: stateBrief(
            researchState(svc.ledger, run, contract, { lanes: contract.lanes.count }),
          ),
        }
      : {}),
    // The campaign's brief from its author, whole (goal 078): ahead of the long parts, so a
    // brief cut to the teacher's window loses the evidence first.
    ...(brief ? { campaign_brief: brief } : {}),
    editable_paths: "editable_paths" in contract ? contract.editable_paths : [],
    // Its commit: the tree the teachers read with their code tools (goal 081).
    champion: { seq: champion.seq, attempt: champion.attempt, commit: champion.commit_sha },
    families: registry.families(run),
    // The run's directions (goal 066). A rule may also name a new one: the planner designs it.
    directions: svc.queue.directions(run),
    // The target the teachers keep the queue at, and how far below it the queue is now
    // (goal 081). Short, so it comes before the long parts, which a window may cut.
    queue_target: (() => {
      const q = svc.queueState(run);
      return { ...q, below: q.ready < q.target, wanted: Math.max(0, q.target - q.ready) };
    })(),
    // What the teachers proposed before and what became of it: their portfolio is new since.
    teacher_ideas: svc.queue
      .all(run)
      .filter((x) => x.added_by === "teacher")
      .slice(-30)
      .reverse()
      .map((x) => ({
        id: x.id,
        title: x.title,
        state: x.state,
        ...(x.result ? { result: x.result } : {}),
        ...(x.dropped_why ? { dropped: x.dropped_why.slice(0, 200) } : {}),
      })),
    // The newest attempts: the planner's evidence, with a refused change's violations and a
    // held-out failure's kind (goal 082), and the judge's public reasons (goal 081); the
    // teachers read each in full with their tools.
    evidence: recentAttempts(svc.ledger, run, { limit: 20, reasonChars: 400 }),
    // Each lane's trial now (goal 143): when it last sent a line, its open model call, and a
    // streak of the same calls. A trial quiet for long, or repeating, is worth a note.
    at_work: (svc.work().open ?? [])
      .filter((t) => t.run === run)
      .map(({ lane, trial, task, started_at, last_line_at, reply, repeating }) => ({
        lane,
        trial,
        task,
        started_at,
        last_line_at,
        reply,
        repeating,
      })),
    epochs,
    // A teachers' rule that freezes the queue or pins an experiment, set before code refused
    // them, is marked: it no longer reaches the planner (goal 081).
    directives: svc.ledger.directives.active(run).map((d) => {
      const refused = d.author.startsWith("supervisor")
        ? ruleRefusal(d.body as StructuredDirective)
        : undefined;
      return {
        ...d,
        ...(isLegacyRule(d.body) ? { legacy: true } : {}),
        ...(refused ? { refused: refused.why } : {}),
      };
    }),
    // The run's experiment queue: the teachers may add experiments and move queued ones.
    queue: svc.queue.brief(run),
    // Why each experiment tried ended as it did (goal 081).
    causes: triedCauses(svc.ledger, svc.queue, run, { limit: 20, causeChars: 400 }),
    ...(goals ? { goals } : {}),
    budget: {
      ...contract.budget,
      device_hours_used: svc.ledger.jobs.deviceHours(run),
      tokens: registry.tokensUsed(run),
    },
    // The owner's messages to the teachers (to them, or to all the advisors): those they have not
    // read, to answer, and those they read in the last day.
    owner_messages: svc.messages
      .forTeachers(run)
      .map((m) => ({ id: m.id, at: m.at, text: m.text, read: m.read })),
    // The run's newest field notes, by every writer: the agents' own words, as data.
    field_notes: { note: NOTES_ARE_DATA, notes: notesData(svc.journal.newest(run, 20)) },
    ...backgroundFor(svc, run),
  };
}
