import { advisorLiveSource } from "../core/live.ts";
import type { RigSettings } from "../core/rig-settings.ts";
import {
  type ConfiguredAgent,
  USAGE_HARNESSES,
  type UsageAgent,
  type UsageHarness,
} from "../core/usage.ts";
import { type AdvisorSetupView, advisorsFileOf, agentModelsOf } from "./rigs/index.ts";
import type { ControlStore } from "./store/index.ts";
import { rigSettingsOf, rigView } from "./views/index.ts";

/** When each agent calls its model: why one with a model may have made no call yet (goal 193). */
const WAITS: Record<UsageAgent, string> = {
  workers: "Workers start trials once the run's first round is planned.",
  planner: "It plans each round of the run.",
  teachers:
    "They review the run on their timer, and at once after your message to them or a request for a round.",
  merged_by:
    "It merges the teachers' reviews after a round of two teachers in which at least one gave a review.",
  auditor: "It works when an audit is asked for.",
  review_panel: "It works when a review is open.",
  synthesizer: "It writes a question's answer card when the question's evidence changes.",
  final_writer: "It writes the research paper when the run ends.",
};

/** Each agent's switch on Edit rig, and what its being off means; the writers have none. */
const OFF: Partial<Record<UsageAgent, [keyof RigSettings, string]>> = {
  workers: ["workers", "Workers are off on Edit rig: no new trial starts."],
  planner: ["planner", "The planner is off on Edit rig: the fixed rules plan each round."],
  teachers: ["teachers", "The teachers are off on Edit rig."],
  merged_by: ["teachers", "The teachers are off on Edit rig."],
  auditor: ["auditor", "The auditor is off on Edit rig: audits wait for you under Needs you."],
  review_panel: ["review", "The review panel is off on Edit rig."],
};

/** An agent's model, wherever it comes from, and its sources on Live when control knows them. */
interface Given {
  agent: UsageAgent;
  harness: string;
  provider: string | null;
  model: string | null;
  /** Its names on Live: control's names for the advisors it gives a model to (supervisor/advisors/routes.ts). */
  live?: string[];
}

const isHarness = (h: string): h is UsageHarness =>
  (USAGE_HARNESSES as readonly string[]).includes(h);

/**
 * The agents a run's rig gives a model to (goal 193, issue 52), as its usage table lists them:
 * each agent's model from control's record, else the rig's own (its report for the workers, its
 * advisors file for the advisors), with why it made no call where Thermite knows it: its part off
 * on Edit rig, its newest "has no answer" line on Live, else what it waits for. None for a closed
 * run, whose rig may have other agents now, or for a run without agents.
 */
export async function configuredAgents(
  store: ControlStore,
  rig: string,
  run: string,
): Promise<ConfiguredAgent[]> {
  const view = await rigView(store, rig);
  const r = view?.runs.find((x) => x.id === run);
  if (!r || r.status === "closed" || r.has_agents === false) return [];
  const control = await agentModelsOf(store, rig);
  const file = advisorsFileOf(await store.reportedRigs.supervisor(rig));
  const reported = view?.model;
  const workers: Given | null = control.workers
    ? { agent: "workers", ...control.workers }
    : reported && reported.source !== "none" && reported.model
      ? {
          agent: "workers",
          harness: reported.harness,
          provider: reported.source === "control" ? reported.name : null,
          model: reported.model,
        }
      : null;
  const research = r.mode === "research";
  const teachers: Given[] = control.teachers.models.length
    ? control.teachers.models.map((m, i) => ({
        agent: "teachers",
        ...m,
        live: [`teacher-${i + 1}`],
      }))
    : (file?.teachers ?? []).map((t) => ({ agent: "teachers", ...t }));
  // An agent's own model from control, with its name on Live, else another's: the workers' for
  // the planner, the first teacher's for the writers, the file's for an advisor. Another's lines
  // on Live are not this agent's.
  const one = (
    agent: UsageAgent,
    own: { harness: string; provider: string; model: string } | null,
    live: string[],
    fallback: Given | null | undefined,
  ): Given | null =>
    own ? { agent, ...own, live } : fallback ? { ...fallback, agent, live: [] } : null;
  const fileOf = (agent: UsageAgent, x: AdvisorSetupView | null | undefined): Given | null =>
    x ? { agent, ...x } : null;
  const reviewers = control.review_panel
    ? [
        {
          agent: "review_panel" as const,
          ...control.review_panel,
          live: ["reviewer-1", "reviewer-2", "reviewer-3"],
        },
      ]
    : (file?.review_panel ?? []).map((x) => ({ agent: "review_panel" as const, ...x }));
  const given: (Given | null)[] = [
    workers,
    research ? null : one("planner", control.planner, [], workers),
    ...teachers,
    teachers.length >= 2
      ? one(
          "merged_by",
          control.teachers.merged_by,
          ["merged-by"],
          fileOf("merged_by", file?.merged_by),
        )
      : null,
    one("auditor", control.auditor, ["auditor"], fileOf("auditor", file?.auditor)),
    ...(r.mode === "hill_climb" ? [] : reviewers),
    research ? one("synthesizer", control.synthesizer, ["synthesizer"], teachers[0]) : null,
    research ? one("final_writer", control.final_writer, ["final-writer"], teachers[0]) : null,
  ];
  const settings = (await rigSettingsOf(store, rig))?.settings ?? null;
  const sources = given.flatMap((g) => (g?.live ?? []).map(advisorLiveSource));
  const said = await store.liveLines.noAnswers(rig, run, sources);
  const seen = new Set<string>();
  return given.flatMap((g) => {
    if (!g?.model || !isHarness(g.harness)) return [];
    const key = JSON.stringify([g.agent, g.harness, g.model]);
    if (seen.has(key)) return [];
    seen.add(key);
    const off = OFF[g.agent];
    const live = (g.live ?? [])
      .map((n) => said.get(advisorLiveSource(n)))
      .filter((x) => x !== undefined)
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    const why =
      off && settings?.[off[0]] === false
        ? { why: off[1], why_at: null }
        : live
          ? { why: live.text, why_at: live.at }
          : { why: WAITS[g.agent], why_at: null };
    return [{ agent: g.agent, harness: g.harness, provider: g.provider, model: g.model, ...why }];
  });
}
