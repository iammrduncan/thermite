import { BRIEF, DIRECTIVES, RUNS, type RunRow } from "../../../core/api/harness/advisors.ts";
import type { AdvisorsConfig } from "../config.ts";
import { teacherRound } from "../teachers/index.ts";
import type { AdviseContext } from "./context.ts";
import { clip, harnessOf } from "./shared.ts";
import type { AdviseConfig, AdviseState } from "./state.ts";

/** The newest owner's message to the teachers a run has waiting (0: none). */
const newestForTeachers = (r: RunRow) => Math.max(0, ...(r.owner_messages_waiting?.teachers ?? []));

/** The newest time a run's queue fell below its target, while it still is (0: none, goal 081). */
const lowQueue = (r: RunRow) => r.queue_low?.event ?? 0;

/**
 * Whether the owner has written to the teachers of a running run since its last round, or the
 * run's queue fell below its target since (goal 081): the loop then starts the next round at
 * once instead of waiting out its pause.
 */
export async function teachersCalled(
  cfg: Pick<AdviseConfig, "harnessUrl" | "harnessToken" | "fetchImpl"> & {
    advisors?: Pick<AdvisorsConfig, "max_usd_per_day"> | undefined;
  },
  state: AdviseState,
): Promise<boolean> {
  // At the day's spending limit the teachers do not run, so a message cannot start a round.
  if (overSpendLimit(cfg.advisors, state)) return false;
  const { runs } = await harnessOf(cfg).call(RUNS);
  return runs.some(
    (r) =>
      r.status === "running" &&
      (newestForTeachers(r) > (state.ownerSeen?.[r.id] ?? 0) ||
        lowQueue(r) > (state.ideasSeen?.[r.id] ?? 0)),
  );
}

/** Whether the advisors have spent the day's limit (UTC), when the owner set one. */
export function overSpendLimit(
  advisors: Pick<AdvisorsConfig, "max_usd_per_day"> | undefined,
  state: AdviseState,
): boolean {
  const limit = advisors?.max_usd_per_day;
  const day = new Date().toISOString().slice(0, 10);
  return limit !== undefined && state.spend?.day === day && state.spend.usd >= limit;
}

/**
 * The teachers' part of a pass: a round for each running run on their cadence, and at once when
 * the owner wrote to them or its queue fell below its target; none past the day's spending limit.
 */
export async function teachRuns(ctx: AdviseContext): Promise<void> {
  const {
    cfg,
    harness,
    next,
    s,
    now,
    domains,
    toolsFor,
    kbFor,
    codeFor,
    researchFor,
    configFor,
    keeperFor,
    mcpFor,
    limit,
    overBudget,
    count,
    record,
    say,
    fail,
    usageOut,
    promptsOut,
    receipts,
    toQueue,
    notesOut,
  } = ctx;
  // The teachers, per running run, on their cadence, and at once for a new owner's message.
  // At the limit, an owner's message to the teachers waits for the next day: said once.
  if (cfg.advisors.teachers.length && overBudget()) {
    next.limitSaid ??= {};
    const { runs } = await harness.call(RUNS);
    for (const inst of runs.filter((i) => i.status === "running")) {
      const newest = newestForTeachers(inst);
      if (newest <= Math.max(next.ownerSeen[inst.id] ?? 0, next.limitSaid[inst.id] ?? 0)) continue;
      next.limitSaid[inst.id] = newest;
      say(
        inst.id,
        "status",
        `the advisors reached the day's spending limit (${limit} USD): the teachers read your message after midnight UTC`,
      );
    }
  }
  if (cfg.advisors.teachers.length && !overBudget()) {
    const { runs } = await harness.call(RUNS);
    for (const inst of runs.filter((i) => i.status === "running")) {
      const newest = newestForTeachers(inst);
      const called = newest > (next.ownerSeen[inst.id] ?? 0);
      // The planner's round left the queue below its target (goal 081): ideas are wanted now.
      const low = lowQueue(inst);
      const wanted = low > (next.ideasSeen[inst.id] ?? 0);
      const last = next.lastTeacherAt[inst.id];
      if (
        !called &&
        !wanted &&
        last &&
        now - Date.parse(last) < cfg.advisors.teacher_minutes * 60_000
      )
        continue;
      next.lastTeacherAt[inst.id] = new Date().toISOString();
      // An owner's message starts one round: a round that fails leaves it for the next one.
      if (newest) next.ownerSeen[inst.id] = Math.max(newest, next.ownerSeen[inst.id] ?? 0);
      // So does a queue below its target: the next one waits for a new planner's round.
      if (low) next.ideasSeen[inst.id] = Math.max(low, next.ideasSeen[inst.id] ?? 0);
      const q = inst.queue_low;
      const ideasNow =
        wanted && q
          ? `its queue has ${q.ready} of its target of ${q.target} experiments ready: ideas are wanted now`
          : undefined;
      say(
        inst.id,
        "status",
        called
          ? `the teachers review ${inst.id} now: the owner wrote to them`
          : ideasNow
            ? `the teachers review ${inst.id} now: ${ideasNow}`
            : `the teachers review ${inst.id}`,
      );
      try {
        const briefOf = () => harness.call(BRIEF, { query: { run: inst.id } });
        const brief = await briefOf();
        // Teachers with an open web fetch get no records of other campaigns: past research and
        // the briefing stay out of their brief (and its tool), as the knowledge-base search does.
        const openFetch = domains.includes("*");
        const closed = <T extends { background?: unknown; past_research?: unknown }>(b: T): T => {
          if (openFetch) {
            delete b.background;
            delete b.past_research;
          }
          return b;
        };
        closed(brief);
        const given = (brief.owner_messages ?? []).filter((m) => !m.read).map((m) => m.id);
        const round = `teachers ${new Date().toISOString()}`;
        // The run's code and evidence, read only (goal 081); none for teachers with an open
        // fetch: the code is private, and private reads never meet the open web in one advisor.
        // A research run has no code to withhold.
        if (openFetch && inst.mode !== "research") {
          next.codeOffSaid ??= {};
          if (!next.codeOffSaid[inst.id]) {
            next.codeOffSaid[inst.id] = true;
            say(
              inst.id,
              "status",
              `the teachers may fetch any web page (fetch_domains "*"), so they read no code, diffs or the judge's full findings: only their brief`,
            );
          }
        }
        // The run's own research, read only (goal 098), when its brief says it has some; none for
        // teachers with an open fetch either, said once.
        const research = Boolean(brief.research);
        if (openFetch && research) {
          next.researchOffSaid ??= {};
          if (!next.researchOffSaid[inst.id]) {
            next.researchOffSaid[inst.id] = true;
            say(
              inst.id,
              "status",
              `the teachers may fetch any web page (fetch_domains "*"), so they read none of the run's own sources, claims, hypotheses, findings, notes or files: only the summary in their brief`,
            );
          }
        }
        const run = await teacherRound({
          // With the campaign's own context settings, when it sets any (goal 070).
          config: await configFor(inst.id),
          run: inst.id,
          brief,
          why: ideasNow,
          keeper: keeperFor(inst.id),
          // A research run's teachers give research tasks, each for one question's gap (goal 117).
          research: inst.mode === "research",
          // The owner's additions to the teacher and the merged by model (goal 166).
          additions: inst.role_additions ?? undefined,
          // The merged by model's own slot, under the same rule.
          ...(openFetch ? {} : { mergedKb: await kbFor(inst.id, "merged-by") }),
          tools: {
            ...toolsFor(),
            // A research run has no code: its seed is a placeholder, with no repository on the
            // rig, so its teachers get none of the code tools.
            ...(openFetch || inst.mode === "research" ? {} : { code: codeFor(inst.id) }),
            // The run's own research: a research run's always, a hill-climb or goal run's when its
            // trials recorded some (the brief has `research`), never with an open fetch.
            ...(openFetch || !research ? {} : { research: researchFor(inst.id) }),
            // The run's MCP servers for its advisors (none with an open fetch: mcpFor says so).
            mcp: await mcpFor(inst.id),
            // Thermite's knowledge base (goal 175), from the run's scope; not for teachers with
            // an open fetch, so private records and the open web never meet in one agent.
            ...(openFetch ? {} : { kb: await kbFor(inst.id, "teacher") }),
            brief: async () => closed(await briefOf()),
          },
        });
        s.teacher_runs++;
        count({ tokensIn: run.tokens.in, tokensOut: run.tokens.out, usd: run.usd });
        for (const u of run.usage) await usageOut(inst.id, round, u.agent, u);
        await promptsOut(inst.id, round, run.sent);
        for (const r of run.reviews) {
          const recs = r.review?.recommendations ?? [];
          say(
            inst.id,
            r.review ? "text" : "status",
            r.review
              ? `teacher ${r.teacher}: ${clip(r.review.summary, 400)}${recs.length ? ` Suggests: ${recs.map((x) => `${x.kind}${x.family ? ` ${x.family}` : ""}`).join(", ")}.` : ""}`
              : `teacher ${r.teacher} gave no review: ${clip(r.error ?? "", 300)}`,
          );
        }
        // The teachers that reviewed had the owner's messages in their brief: they read them.
        if (run.reviews.some((r) => r.review))
          await receipts(inst.id, "teachers", given, run.answers);
        // Teachers' opportunities the merged by model left out, kept by code (goal 081).
        if (run.kept.length)
          say(inst.id, "status", `the teachers' portfolio: ${run.kept.join("; ")}`);
        // Their portfolio for the run's queue, as experiments, and moves of queued ones, before
        // the rules: a rule may then name the direction of an experiment they just added.
        const queued = await toQueue(inst.id, "teacher", run.experiments, run.moves);
        let posted: unknown;
        if (run.directives?.length) {
          const rules = { run: inst.id, directives: run.directives };
          const answer = await harness.call(DIRECTIVES, { body: rules });
          posted = answer;
          const left = answer.left_out ?? [];
          s.directive_sets++;
          s.directives += run.directives.length - left.length;
          say(
            inst.id,
            "text",
            `directives for the planner: ${run.directives
              .map(
                (d) =>
                  `${d.kind}${d.family ? ` ${d.family}` : ""}${d.value !== undefined ? ` ${String(d.value)}` : ""} (why: ${clip(d.rationale, 200)})`,
              )
              .join(
                "; ",
              )}${run.dropped.length ? `. Dropped: ${run.dropped.join("; ")}` : ""}${left.length ? `. Left out by the rig: ${left.map((l) => l.rule).join("; ")}: ${left[0]?.why ?? ""}` : ""}`,
          );
        } else if (run.error) {
          fail(`teachers for ${inst.id}`, run.error, inst.id);
        } else {
          // What the supervisor left out still shows: an opportunity, or a rule it refused.
          say(
            inst.id,
            "status",
            `the teachers set no directives${run.dropped.length ? `. Dropped: ${run.dropped.join("; ")}` : ""}`,
          );
        }
        // Then each teacher's (and the merged by model's) field notes, once the round's work is posted.
        const noted: unknown[] = [];
        for (const j of run.journal) noted.push(await notesOut(inst.id, "teachers", j.by, j.notes));
        record(`teachers-${inst.id}`, { ...run, posted, queued, noted });
      } catch (err) {
        fail(`teachers for ${inst.id}`, err, inst.id);
      }
    }
  }
}
