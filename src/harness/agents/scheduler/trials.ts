import { randomBytes } from "node:crypto";
import { errorText } from "../../../common/errors.ts";
import { log } from "../../../common/log.ts";
import type { Contract } from "../../../core/contract.ts";
import { newTrialId } from "../../../core/ids.ts";
import { workerSlot } from "../../../core/kb.ts";
import type { LiveKind } from "../../../core/live.ts";
import { additionOf } from "../../../core/role-additions.ts";
import type { Role } from "../../broker/index.ts";
import type { Experiment, TaskYield } from "../../queue.ts";
import { focusOf, limitsInForce, PLANNER, resultOf } from "../coordinator.ts";
import { failedTooLong } from "../provider-errors.ts";
import type { Assignment, EpochRecord } from "../registry.ts";
import type { TrialResult } from "../worker/index.ts";
import { prepareWorkspace } from "../workspace.ts";
import { brief, withOwnerSections } from "./briefs.ts";
import { directivesOf, type SchedulerContext } from "./context.ts";
import { afterTrial } from "./provider.ts";
import { heldHandouts } from "./rounds.ts";
import { watch } from "./watch.ts";

/**
 * A lane's trial in a hill climb or a goal campaign: the experiment it takes, its workspace and
 * worker, and what is recorded when it ends. A research trial (research/trial.ts) ends the same
 * way.
 */

/**
 * The experiment a lane's trial takes: the round's own for its first trial, while it can
 * still be given out; otherwise the next by the fixed rules (one hand-out of its own), and
 * when the queue has nothing for it, one in the round's direction, added by the planner.
 * Experiments other lanes were given this round, and have not started yet, are left to them.
 */
export function experimentFor(
  sched: SchedulerContext,
  run: string,
  epoch: EpochRecord,
  a: Assignment,
  k: number,
  o: {
    perEpoch: number;
    laneCount: number;
  },
): { x: Experiment; why: string } | undefined {
  const queue = sched.o.service.queue;
  const mine = k === 1 && a.experiment ? queue.get(a.experiment) : undefined;
  if (mine && mine.run === run && (mine.state === "queued" || mine.state === "proposed"))
    return { x: mine, why: a.why ?? "the round's hand-out" };
  const reserved = new Set(heldHandouts(sched.registry, run, epoch, a.lane, sched.running).held);
  const directives = directivesOf(sched, run);
  sched.coordinator.ensureMandates(run, directives);
  let x = sched.coordinator.pick(run, a.lane, {
    directives,
    window: o.laneCount,
    exclude: reserved,
  });
  let why = x ? sched.coordinator.whyPicked(run, a.lane, x, directives) : "";
  if (!x) {
    x = sched.coordinator.fill(
      run,
      a,
      `the queue had nothing for ${a.lane}: it goes on in its round's direction (${a.family})`,
    );
    why = "the queue had nothing for this lane, so it goes on in its round's direction";
  }
  if (!x) return undefined;
  sched.coordinator.handout(
    run,
    epoch.n,
    [{ lane: a.lane, experiment: x.id, why }],
    k === 1
      ? `${a.lane}'s first trial of round ${epoch.n}: the experiment the round gave it can no longer be given out`
      : `${a.lane}'s trial ${k} of ${o.perEpoch} in round ${epoch.n}`,
  );
  return { x, why };
}

export function startTrial(
  sched: SchedulerContext,
  run: string,
  contract: Contract,
  epoch: number,
  round: Assignment,
  k: number,
  perEpoch: number,
  got: { x: Experiment; why: string },
): void {
  // The trial works on its experiment: its direction and its text are the trial's.
  const a: Assignment = {
    ...round,
    family: sched.coordinator.direction(run, got.x),
    focus: focusOf(got.x),
    experiment: got.x.id,
    why: got.why,
  };
  const lane = a.lane as Role;
  const id = newTrialId();
  const token = randomBytes(32).toString("hex");
  const abort = new AbortController();
  sched.aborts.set(a.lane, abort);
  sched.laneRun.set(a.lane, run);
  watch(sched);
  const work = (async () => {
    const inst = sched.ledger.runs.get(run);
    if (!inst) return;
    const champion = sched.ledger.champions.current(run);
    const best = sched.registry.laneBest(run, a.lane);
    const parent =
      a.parent === "lane_best" && best
        ? String(sched.ledger.attempts.get(best)?.commit_sha)
        : champion.commit_sha;
    sched.registry.startTrial({
      id,
      run,
      lane: a.lane,
      epoch,
      family: a.family,
      parent,
      token,
      focus: a.focus,
    });
    // The experiment is the trial's now: no other lane can be given it.
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
      `trial on ${a.lane}: ${a.family}, ${got.x.title} (from ${parent === champion.commit_sha ? `the champion, seq ${champion.seq}` : `the lane's best, ${best}`})`,
    );
    const limits = limitsInForce(sched.ledger, run, contract);
    let ws: { dir: string; repo: string } | undefined;
    let r: TrialResult = { stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
    try {
      ws = await prepareWorkspace({
        runner: sched.o.runner,
        scratchDir: sched.o.service.paths.scratchDir,
        mirror: sched.o.service.mirrorFor(inst.seed_repo),
        commit: parent,
        lane,
      });
      // The worker's tools reach this workspace through the API, for this trial only.
      sched.o.service.trialWorkspaces.set(id, { lane: a.lane, repo: ws.repo, root: ws.dir });
      // Reset while the workspace was being prepared: the trial never starts.
      if (abort.signal.aborted) throw new Error("reset before the trial started");
      r = await sched.o.runTrial(
        {
          trialId: id,
          token,
          run,
          lane,
          workspace: ws.repo,
          workspaceRoot: ws.dir,
          parentCommit: parent,
          editablePaths: "editable_paths" in contract ? contract.editable_paths : [],
          brief: withOwnerSections(
            sched,
            id,
            run,
            a.lane,
            brief(
              sched,
              run,
              contract,
              epoch,
              a,
              got.x,
              k,
              perEpoch,
              parent === champion.commit_sha
                ? `the champion (seq ${champion.seq})`
                : `your lane's best attempt ${best}`,
            ),
          ),
          wallMs: limits.trialMinutes ? limits.trialMinutes * 60_000 : sched.o.trialWallMs,
          maxTurns: sched.o.maxTurns,
          limits,
          // The MCP servers the run's kit gives its workers (goal 068).
          mcpServers: sched.o.service.mcp.given(run, "workers").map((g) => g.name),
          // What the lane's worker may write in the knowledge base (goal 175).
          kbWrites: sched.o.service.kbTools.writes(run, workerSlot(a.lane)),
          // The owner's addition to the worker, from the run's contract (goal 166).
          addition: additionOf(contract, "worker"),
        },
        abort.signal,
      );
    } catch (err) {
      r = { ...r, stopped: "error", error: errorText(err) };
    } finally {
      if (abort.signal.aborted && r.stopped !== "submitted") r = { ...r, stopped: "interrupted" };
      r = withProgress(sched, id, r);
      sched.o.service.trialEnded(id, r.turns > 0 || r.tokensIn > 0);
      // Its attempt is the one the harness linked to the trial as it submitted, never the one its
      // worker names: the worker runs as the lane's agent user. Also when its worker was stopped
      // before it could say so (goal 079): an interrupted Pi trial that submitted has its attempt
      // with the judge, and its experiment is done, not back in the queue.
      const attempt = sched.registry.attemptOf(id);
      if (attempt) sched.registry.tagAttempt(attempt, a.family);
      // The trial ends first (its token stops working), then its processes and dev runs.
      sched.o.service.trialWorkspaces.delete(id);
      sched.registry.finishTrial(id, r, sched.o.owner);
      finishExperiment(sched, id, r, attempt);
      afterTrial(sched, id, run, r);
      trialLine(
        sched,
        id,
        run,
        a.lane,
        "status",
        `trial ended: ${attempt ? `submitted ${attempt}${r.submitted ? "" : ` (then ${r.stopped})`}` : r.stopped}${r.error ? ` (${r.error.slice(0, 200)})` : ""}`,
      );
      await sched.o.runner.killRole(lane).catch(() => 0);
      await sched.o.devRuns?.settle(lane).catch(() => undefined);
      await sched.o.runner.killRole(lane).catch(() => 0);
      if (ws) await sched.o.runner.remove(ws.dir).catch(() => undefined);
    }
  })().finally(() => {
    sched.running.delete(a.lane);
    sched.aborts.delete(a.lane);
    sched.laneRun.delete(a.lane);
  });
  sched.running.set(a.lane, work);
}

/**
 * A trial ended: its experiment is done, with how its trial ended in words, or goes back to the
 * top of the queue when the trial never really tried it (interrupted, or the provider's error:
 * goal 079). Only an error that came from a call to the provider counts as the provider's: its
 * kind (`errorKind`) is set where the call was made, never read from a local failure's words. A
 * failure here is logged; the trial's own record stands.
 */
export function finishExperiment(
  sched: SchedulerContext,
  trial: string,
  r: TrialResult,
  attempt?: string | undefined,
  taskYield?: TaskYield | undefined,
): void {
  try {
    sched.coordinator.finish(
      trial,
      {
        result: resultOf(r.stopped, attempt),
        attempt,
        cause: r.error ?? (r.stopped === "interrupted" ? "its trial was stopped" : undefined),
        kind: r.errorKind,
        // Its calls failed until the run's agents stopped: it never really tried it either.
        agentsStopped: r.stopped === "error" && !!r.failing && failedTooLong(r.failing.since),
        yield: taskYield,
      },
      sched.o.owner,
    );
  } catch (err) {
    log("scheduler", "the trial's experiment was not finished", { trial, error: String(err) });
  }
}

/**
 * A trial's result with the counters its worker last reported, when the worker died before
 * reporting its own (an interrupt kills it): an interrupted trial keeps the work it did.
 */
export function withProgress(sched: SchedulerContext, id: string, r: TrialResult): TrialResult {
  const p = sched.o.service.trialProgress.get(id);
  sched.o.service.trialProgress.delete(id);
  if (!p || r.turns >= p.turns) return r;
  return {
    ...r,
    turns: p.turns,
    toolCalls: Math.max(r.toolCalls, p.tool_calls),
    tokensIn: Math.max(r.tokensIn, p.tokens_in),
    tokensOut: Math.max(r.tokensOut, p.tokens_out),
  };
}

/** A line in a trial's live session (control's live view). */
export function trialLine(
  sched: SchedulerContext,
  id: string,
  run: string,
  lane: string,
  kind: LiveKind,
  text: string,
): void {
  sched.o.service.live.append({ source: `trial:${id}`, kind, text, lane, run });
}
