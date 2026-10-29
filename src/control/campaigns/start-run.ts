import { z } from "zod";
import { errorText } from "../../common/errors.ts";
import type { BriefingSeed } from "../../core/commands.ts";
import { AskOwner } from "../../core/commands.ts";
import { briefingSeedOf, type KbItem, PICKABLE, queueSeedOf } from "../kb/index.ts";
import type { KitRepos } from "../kits/index.ts";
import type { ControlParts } from "../parts.ts";
import { sameModel } from "../providers/index.ts";
import {
  agentsModelMissing,
  giveRigModel,
  harnessKept,
  opencodeOnlyModel,
  researchNeedsOpencode,
  sendSplit,
  splitFor,
} from "../rigs/index.ts";
import type { ControlStore } from "../store/index.ts";
import {
  type ContextApplies,
  campaignContract,
  contextApplies,
  contextAppliesWords,
} from "./context.ts";
import { type QueueSeed, startRun } from "./new.ts";
import { untriedOf } from "./queue-copy.ts";

/**
 * Start a run of a campaign control keeps (goal 029): the campaign page's Start a run panel,
 * REST's `POST /v1/campaigns/<name>/runs`, MCP's `start_run` and `thermite run start` all call
 * startARun, so they check and refuse alike. This module holds it, the request's fields, and the
 * answer.
 */

/** What Start a run takes: the panel's fields, in the dashboard's terms. */
export interface StartRunRequest {
  campaign: string;
  rig: string;
  /** False: a try, with no agents (only the judge works, and it measures the starting point). */
  agents: boolean;
  /** A model to give the rig's agents first, as the panel's "The agents' model". */
  model?: { provider: string; model: string } | undefined;
  promotion?: "auto" | "owner_approval" | undefined;
  /** What else the run asks the owner about (goal 079); unset: nothing. */
  askOwner?: AskOwner | undefined;
  /** How many of the rig's GPUs the judge measures on; empty: the rig's current split. */
  judgeGpus?: string | number | undefined;
  /**
   * A run of the campaign, by name, whose untried experiments start the new run's queue: any run
   * of it, an earlier one too (goal 170).
   */
  queueFrom?: string | undefined;
  /** Items of Thermite's knowledge base, by id: experiments join the queue, the rest the briefing. */
  past?: number[] | undefined;
}

/** What came of it: a run started, a model given first (start again later), or a refusal. */
export type StartRunOutcome =
  | {
      state: "started";
      campaign: string;
      rig: string;
      run: string;
      command: string;
      /** What control did to start the rig's stopped RunPod pod first, in words; null: nothing. */
      woke: string | null;
      /** The run at work on the rig, which pauses when this one starts (one run at a time). */
      pauses?: string | undefined;
      /** What else to know, in words: for example, a run to copy from had nothing untried. */
      notes: string[];
      /**
       * The campaign's own context settings and what each agent works with on the rig (goal 070),
       * when the campaign sets any; its words are one of the notes.
       */
      context?: ContextApplies | undefined;
    }
  | { state: "model_given"; said: string }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/** The request's fields over REST and MCP: the panel's, in snake case. */
export const startRunFields = {
  rig: z.string().min(1).describe("The rig the run starts on"),
  agents: z
    .boolean()
    .optional()
    .describe(
      "false: a try, with no agents; only the judge works, and it measures the starting point. Default: true",
    ),
  agents_model: z
    .strictObject({ provider: z.string().min(1), model: z.string().min(1) })
    .optional()
    .describe(
      "For a rig with no model for its agents: a model from a provider in Providers, given to the rig first. The run does not start yet: start it again once the rig has the model",
    ),
  promotion: z
    .enum(["auto", "owner_approval"])
    .optional()
    .describe(
      "When a change is confirmed better: keep it at once (auto: after an auditor's clear when the rig has an auditor and an audit is called for) or ask the owner every time (owner_approval). Default: the rig's, which is auto unless set",
    ),
  ask_owner: AskOwner.optional().describe(
    "What else the run asks the owner about; by default nothing (hands-off). above_gain: a confirmed gain above this fraction (0.15 is 15%) waits for the owner; declared_flaws: a win whose worker declared flaws waits; reviews: a review panel's pass of a subjective goal waits for the owner's acceptance; not_possible: a proposal to end a goal campaign as not possible waits",
  ),
  judge_gpus: z
    .number()
    .int()
    .optional()
    .describe(
      "For a rig with several GPUs: how many the judge measures on; the rest are the agents'. It changes the rig's split for every run on it, and the rig's harness restarts to apply it",
    ),
  queue_from: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Another run of the campaign, by name: its untried experiments (up next in order, then its lanes' ideas, at most 500) start the new run's queue. Any run of it, one of a retired rig or from before a full reset too",
    ),
  past: z
    .array(z.number().int())
    .optional()
    .describe(
      "Items of Thermite's knowledge base by id (kb_search gives them), from folders the campaign may read: experiments join the queue after the copied ones; findings, claims, notes and reports go to every agent's brief as background",
    ),
};

/** The REST body: the fields above, and nothing else. */
export const StartRunBody = z.strictObject(startRunFields);
export type StartRunBody = z.infer<typeof StartRunBody>;

/** The request from a REST body or an MCP call's arguments. */
export function startRunRequest(campaign: string, b: StartRunBody): StartRunRequest {
  return {
    campaign,
    rig: b.rig,
    agents: b.agents ?? true,
    model: b.agents_model,
    promotion: b.promotion,
    askOwner: b.ask_owner,
    judgeGpus: b.judge_gpus,
    queueFrom: b.queue_from,
    past: b.past,
  };
}

/** A body that does not fit the fields, in words: each field and what is wrong with it. */
export function bodyRefusal(err: z.ZodError): string {
  return `bad request: ${err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
}

/**
 * The answer REST and MCP give: the new run and its command, with what else to know in words, or
 * `started: false` and what control said when it gave the rig a model first.
 */
export function startRunAnswer(
  out: Exclude<StartRunOutcome, { state: "refused" }>,
): Record<string, unknown> {
  if (out.state === "model_given") return { started: false, said: out.said };
  const notes = [
    ...(out.pauses
      ? [
          `${out.pauses} is at work on ${out.rig}, and pauses when this run starts (a rig runs one run at a time).`,
        ]
      : []),
    ...out.notes,
  ];
  return {
    started: true,
    campaign: out.campaign,
    rig: out.rig,
    run: out.run,
    command: out.command,
    status: "pending",
    ...(out.woke ? { woke: out.woke } : {}),
    ...(notes.length ? { notes } : {}),
    // What applies to the run's agents, when the campaign sets its own context (goal 070).
    ...(out.context ? { agents_context: out.context } : {}),
  };
}

/**
 * Whether control can start a run of a campaign: a saved version it can sign (with the kits it
 * keeps, or an earlier assignment's imports), or an earlier assignment to assign again.
 */
export function startable(store: ControlStore, campaign: string, kits: unknown): boolean {
  const v = store.campaigns.versions(campaign)[0];
  if (v && (kits || v.sources.assignment)) return true;
  return store.commands.latestAssignments().has(campaign);
}

/**
 * Starts a run of a campaign on a rig, with every check and refusal in words. `by` is who asks;
 * `owner`, whether the owner's token asks, which alone starts a stopped RunPod pod.
 */
export async function startARun(
  parts: ControlParts,
  req: StartRunRequest,
  by: string,
  owner: boolean,
): Promise<StartRunOutcome> {
  const { store } = parts;
  const refuse = (error: string, status: 400 | 404 | 409 = 409): StartRunOutcome => ({
    state: "refused",
    error,
    status,
  });
  const { campaign, agents } = req;
  if (!startable(store, campaign, parts.kits))
    return refuse("Control has no saved version or earlier assignment of this campaign.", 404);
  const vs = parts.views();
  const rig = vs.find((u) => u.id === req.rig);
  if (!rig)
    return req.rig
      ? refuse(`No rig is called ${req.rig}. Choose a rig.`, 404)
      : refuse("Choose a rig.", 400);
  // The panel shows these only with agents on; a try (agents off) has no agents and no queue.
  if (!agents && (req.model || req.queueFrom || req.past?.length))
    return refuse(
      "A try (agents off) takes no model, no experiments and no background: leave them out, or start the run with agents.",
      400,
    );
  const chosen = req.model
    ? `${encodeURIComponent(req.model.provider)}|${encodeURIComponent(req.model.model)}`
    : "";
  const mode =
    (store.campaigns.versions(campaign)[0]?.contract as { mode?: string } | undefined)?.mode ??
    (
      store.commands.latestAssignments().get(campaign)?.payload.contract as
        | { mode?: string }
        | undefined
    )?.mode;
  const researchModel =
    mode === "research" && agents ? opencodeOnlyModel(store, rig, chosen || undefined) : undefined;
  if (researchModel) return refuse(researchNeedsOpencode(rig.id, researchModel));
  if (agents && req.model) {
    // The rig gets the model first; it arrives within a minute, and the run starts after that.
    const given = giveRigModel(
      store,
      rig.id,
      chosen,
      harnessKept(store, rig.id, chosen, ""),
      undefined,
      by,
    );
    if ("error" in given) return refuse(given.error, 400);
    const model = req.model.model;
    if (!sameModel(rig.model?.model, model))
      return {
        state: "model_given",
        said: `${rig.id} takes ${model} within a minute; Settings › Providers shows it taking the model until then. Then start the run again.`,
      };
  }
  // Control gave the rig a model it has not taken yet: the agents would start with none.
  const given = store.agentModels.byRig()[rig.id];
  if (agents && !req.model && given && !sameModel(rig.model?.model, given.model))
    return refuse(
      `${rig.id} has not taken ${given.model} yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then): start the run after that.`,
    );
  if (agents && !req.model && agentsModelMissing(store, rig))
    return refuse(
      `${rig.id} has no model for its agents, so they could not work: choose one under "The agents' model", or give it one on its Edit rig page.`,
    );
  const split = splitFor(rig, String(req.judgeGpus ?? ""));
  if (typeof split === "string") return refuse(split, 400);
  // From past research (goal 065): only items of collections this campaign may read, looked up
  // here by id. Experiments join the queue; findings, claims, notes and reports brief the agents.
  const kb = store.kb();
  const readable = new Set(kb.readable(campaign));
  const picked = (req.past ?? []).map((x) => kb.item(x));
  if (picked.some((x) => !x || !readable.has(x.campaign) || !PICKABLE[x.kind]))
    return refuse(
      "An item from past research is not one this campaign may read and start from: search again.",
      400,
    );
  const past = picked.filter((x): x is KbItem => x !== undefined);
  const pastQueue = past
    .filter((x) => PICKABLE[x.kind] === "queue")
    .map((x) => queueSeedOf(x, kb.resultOf(x)))
    .filter((x): x is QueueSeed => x !== undefined);
  const briefing = past
    .filter((x) => PICKABLE[x.kind] === "briefing")
    .map(briefingSeedOf)
    .filter((x): x is BriefingSeed => x !== undefined);
  // The untried experiments of another run of this campaign, as the panel lists them.
  const notes: string[] = [];
  let copied: QueueSeed[] = [];
  if (req.queueFrom) {
    const run = req.queueFrom;
    const from = (await parts.run(run))?.run;
    if (from?.campaign !== campaign)
      return refuse(`${campaign} has no run ${run}: copy from a run of this campaign.`, 404);
    copied = untriedOf(from);
    if (!copied.length)
      notes.push(`${run} has no untried experiments: the new run's queue starts empty.`);
  }
  const busy = rig.runs.find((r) => r.status === "running");
  let r: Awaited<ReturnType<typeof startRun>>;
  try {
    r = await startRun(
      {
        store,
        kits: parts.kits as KitRepos,
        privateKeyPem: parts.privateKeyPem,
        runpodRigs: parts.runpodRigs,
      },
      {
        campaign,
        rig: rig.id,
        target: rig.hardware?.target
          ? { type: rig.hardware.target.type, class: rig.hardware.target.class }
          : undefined,
        agents,
        promotion: req.promotion,
        askOwner: req.askOwner,
        by,
        owner,
        // A command carries at most 500 experiments.
        queue:
          copied.length + pastQueue.length ? [...copied, ...pastQueue].slice(0, 500) : undefined,
        briefing: briefing.length ? briefing : undefined,
      },
    );
  } catch (err) {
    r = { ok: false, errors: [errorText(err)] };
  }
  if (!r.ok) return refuse(r.errors.join(" "));
  if (split !== undefined) sendSplit(store, parts.privateKeyPem, rig.id, split, by);
  // The campaign's own context settings, and what each agent works with on this rig (goal 070).
  const context = agents
    ? contextApplies(store, rig.id, campaignContract(store, campaign))
    : undefined;
  if (context) notes.push(contextAppliesWords(context, rig.id));
  return {
    state: "started",
    campaign,
    rig: rig.id,
    run: r.run,
    command: r.command,
    woke: r.woke,
    pauses: busy?.id,
    notes,
    ...(context ? { context } : {}),
  };
}
