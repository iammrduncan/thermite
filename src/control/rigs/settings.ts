import { z } from "zod";
import { errorText } from "../../common/errors.ts";
import { CommandPayloads } from "../../core/commands.ts";
import { MAX_LANES } from "../../core/contract.ts";
import {
  PROGRAM_MODES,
  type ProgramMode,
  type RigSettings,
  type RigSettingsChange,
} from "../../core/rig-settings.ts";
import { prepareModeChange } from "../clusters/index.ts";
import { issueCommand } from "../issue/index.ts";
import type { ControlParts } from "../parts.ts";
import type { ControlStore } from "../store/index.ts";
import { rigSettingsOf } from "../views/index.ts";

/**
 * A rig's own settings from outside the dashboard (goal 029): REST's `POST /v1/rigs/<rig>/settings`
 * and MCP's `set_rig_settings` change them as Save changes on Edit rig does (its parts on or off,
 * workers at a time, a trial's length and turns, how its agent programs run, the promotion rule,
 * the GPU split);
 * `GET /v1/rigs/<rig>/settings` and MCP's `rig_settings` read what the rig reports. Edit rig and
 * its twins build the change here (rigSettingsChange): only what differs from what the rig
 * reports, checked against the rig's GPU split and the rig_settings payload, refused in the same
 * words. The change goes to the rig as one signed owner command, rig_settings, which the rig's
 * harness takes only from an `owner:` issuer. The agents' models are rigs/model.ts's. On a rig
 * control set up on a cluster, a new program_mode moves its supervisor's share of its memory, so
 * it changes the rig's size too, as set_cluster_rig_resources does (clusters/resize.ts).
 */

/** The parts of a rig that switch on and off, in Edit rig's order. */
export const RIG_PARTS = [
  "judge",
  "workers",
  "planner",
  "teachers",
  "auditor",
  "review",
  "exports",
] as const;
export type RigPart = (typeof RIG_PARTS)[number];

/** A rig configured with its GPU set: how many cards, and how many are the judge's now. */
export interface GpuSplit {
  set: number;
  judge: number;
}

/**
 * What a caller asks for, field by field; left out (undefined): as the rig has it. Values are as
 * given: the rig_settings payload checks them, so a bad one is refused in its words.
 */
export type RigSettingsWanted = { [P in RigPart]?: boolean | undefined } & {
  lanes?: number | undefined;
  /** null: no limit on a trial's length (goal 079). */
  trial_minutes?: number | null | undefined;
  /** null: no limit. */
  max_turns?: number | null | undefined;
  /** null: a quiet trial never asks the owner (goal 143). */
  quiet_minutes?: number | null | undefined;
  /** In its own terminal, or headless (goal 169). */
  program_mode?: string | undefined;
  promotion?: string | undefined;
  /** null: the rig's default split. */
  judge_gpus?: number | null | undefined;
};

/** Edit rig's description of the quiet setting (goal 143), beside its field. */
export const QUIET_TIP =
  "When a trial sends no line for this long, its lane is marked quiet and the trial waits for you under Needs you. Empty: never. Nothing ends the trial.";

/**
 * Edit rig's quiet field. A rig whose harness is older than goal 143 reports no quiet_minutes
 * and would refuse the whole change, so there the field is off and says why.
 */
export function quietField(u: { summary: unknown }, value: number | null): string {
  const reported = (u.summary as { settings?: Record<string, unknown> } | null)?.settings;
  const takes = !!reported && Object.hasOwn(reported, "quiet_minutes");
  return `<input name="quiet_minutes" type="number" min="1" max="1440" value="${value ?? ""}" placeholder="${takes ? "never" : "update the rig first"}" data-empty="never" data-unit=" minutes"${takes ? "" : " disabled"}>`;
}

/** Edit rig's description of how the agent programs run (goal 169), beside its field. */
export const PROGRAM_MODE_TIP =
  "How Claude Code, Codex, OpenCode and Pi run a worker's trial. In their own terminal (the default): the program's own screen, as you would run it, and Thermite follows its session log and its hooks; a worker in Pi draws Thermite's Pi view of its own session there. Headless: one command for each turn, and Thermite reads its output; a worker in Pi runs with no view. A trial that runs keeps its mode; the next trial takes the new one.";

/** Edit rig's choices of how the agent programs run, in its list's order: the default first. */
const PROGRAM_MODE_WORDS: Record<ProgramMode, string> = {
  terminal: "In their own terminal",
  headless: "Headless",
};

/**
 * Edit rig's field for how the agent programs run (goal 169). A rig whose harness is older reports
 * no program_mode and would refuse the whole change, so there the field is off and says why.
 * `moves`: a new mode restarts the rig's pods, as on a cluster rig with its CPUs and memory set,
 * whose supervisor's share follows it; the page's list of changes then says so (data-moves).
 */
export function programModeField(
  u: { summary: unknown },
  value: ProgramMode,
  moves = false,
): string {
  const reported = (u.summary as { settings?: Record<string, unknown> } | null)?.settings;
  const takes = !!reported && Object.hasOwn(reported, "program_mode");
  if (!takes)
    return `<select name="program_mode" disabled><option>update the rig first</option></select>`;
  const options = (Object.keys(PROGRAM_MODE_WORDS) as ProgramMode[])
    .map(
      (m) =>
        `<option value="${m}"${m === value ? " selected" : ""}>${PROGRAM_MODE_WORDS[m]}</option>`,
    )
    .join("");
  return `<select name="program_mode" data-label="how agent programs run"${moves ? " data-moves" : ""}>${options}</select>`;
}

/** Edit rig's words when a new GPU split is sent, as its page says them under the field. */
export const SPLIT_RESTARTS =
  "A new split restarts the rig's harness to regroup the GPUs: running trials and judge jobs start again.";

/** How Edit rig counts the settings it sent: "1 setting", "3 settings". */
export const settingsCount = (n: number): string => `${n} setting${n === 1 ? "" : "s"}`;

/**
 * The change a request makes to the settings a rig reports: each field given that differs from
 * the rig's, parsed as the rig_settings payload (in its order). undefined: nothing differs.
 * A judge's share is checked against the rig's GPU split first (1 to min(8, set - 1) for the
 * judge, at most 8 for the agents), as Edit rig checks it. Refusals start "Not saved:".
 */
export function rigSettingsChange(
  rig: string,
  now: RigSettings,
  split: GpuSplit | null,
  want: RigSettingsWanted,
): { change: RigSettingsChange | undefined } | { error: string } {
  const change: Record<string, unknown> = {};
  for (const p of RIG_PARTS) if (want[p] !== undefined && want[p] !== now[p]) change[p] = want[p];
  if (want.lanes !== undefined && want.lanes !== now.lanes) change.lanes = want.lanes;
  if (want.trial_minutes !== undefined && want.trial_minutes !== now.trial_minutes)
    change.trial_minutes = want.trial_minutes;
  if (want.max_turns !== undefined && want.max_turns !== now.max_turns)
    change.max_turns = want.max_turns;
  if (want.quiet_minutes !== undefined && want.quiet_minutes !== now.quiet_minutes)
    change.quiet_minutes = want.quiet_minutes;
  if (want.program_mode !== undefined && want.program_mode !== now.program_mode)
    change.program_mode = want.program_mode;
  if (want.promotion !== undefined && want.promotion !== now.promotion)
    change.promotion = want.promotion;
  const judge = want.judge_gpus;
  if (judge !== undefined) {
    if (!split || split.set < 2) {
      // A share on a rig with no GPU set to split; the rig's default there is no change.
      if (judge !== null)
        return {
          error: `Not saved: ${rig} has no GPU set to split: its GPUs are set where it is deployed.`,
        };
    } else if (judge === null ? now.judge_gpus !== null : judge !== split.judge) {
      if (judge !== null) {
        const top = Math.min(8, split.set - 1);
        if (!Number.isInteger(judge) || judge < 1 || judge > top || split.set - judge > 8)
          return {
            error: `Not saved: with ${split.set} GPUs the judge takes 1 to ${top} of them, and the agents at most 8.`,
          };
      }
      change.judge_gpus = judge;
    }
  }
  if (!Object.keys(change).length) return { change: undefined };
  const parsed = CommandPayloads.rig_settings.safeParse(change);
  if (!parsed.success)
    return {
      error: `Not saved: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  return { change: parsed.data };
}

/** What a call did: the command sent, nothing to send, or a refusal in words. */
export type RigSettingsOutcome =
  | {
      state: "sent";
      /** The rig_settings command's id. */
      id: string;
      sent: RigSettingsChange;
      /** True when the change carries a new GPU split, which restarts the rig's harness. */
      restarts: boolean;
      said: string;
    }
  | { state: "unchanged"; said: string }
  | { state: "refused"; error: string; status: 400 | 403 | 404 | 409 };

/**
 * Changes a rig's settings as Save changes on Edit rig does (REST and MCP): the change built by
 * rigSettingsChange, sent as one signed rig_settings command issued by `by`. `owner`: whether the
 * owner's token asks. Another token (an operator's, on MCP) may not change the promotion rule,
 * which decides whether a win waits for the owner, nor the GPU split, which restarts the rig's
 * harness: as start_run, it is refused in words when the change holds either. A new program_mode
 * on a rig control set up on a cluster with its CPUs and memory set moves its supervisor's share:
 * checked before anything is sent, refused in the same words as a size, and applied after the
 * command, its pods restarting (draining first while it works).
 */
export async function setRigSettings(
  parts: ControlParts,
  rig: string,
  want: RigSettingsWanted,
  by: string,
  owner: boolean,
): Promise<RigSettingsOutcome> {
  const { store, privateKeyPem } = parts;
  const refuse = (error: string, status: 400 | 403 | 404 | 409): RigSettingsOutcome => ({
    state: "refused",
    error,
    status,
  });
  const now = rigSettingsOf(store, rig);
  if (!now) return refuse(`no rig ${rig}`, 404);
  if (!now.settings)
    return refuse(
      `${rig}'s harness is older: it does not report its settings and cannot take them. They work after its next roll.`,
      409,
    );
  const out = rigSettingsChange(rig, now.settings, now.gpu_split, want);
  if ("error" in out) return refuse(out.error, 400);
  const change = out.change;
  if (!change) return { state: "unchanged", said: "Nothing changed." };
  if (!owner && change.promotion !== undefined)
    return refuse(
      "Only the owner's token changes a rig's promotion rule: leave out promotion.",
      403,
    );
  if (!owner && change.judge_gpus !== undefined)
    return refuse("Only the owner's token changes a rig's GPU split: leave out judge_gpus.", 403);
  const resize = change.program_mode
    ? await prepareModeChange(parts, rig, change.program_mode, by, { owner })
    : undefined;
  if (resize && "error" in resize) return refuse(`Not saved: ${resize.error}`, resize.status);
  let id: string;
  try {
    ({ id } = issueCommand(store, privateKeyPem, {
      rig,
      kind: "rig_settings",
      payload: change,
      issuedBy: by,
    }));
  } catch (err) {
    // A rig control refuses for its version, for example: nothing is sent.
    return refuse(errorText(err), 409);
  }
  const restarts = change.judge_gpus !== undefined;
  // Last, its supervisor's new share: its pods restart (or it drains first).
  const moved = resize ? await resize.go() : undefined;
  const sizeSaid = !moved
    ? ""
    : "error" in moved
      ? ` Its supervisor's memory did not change: ${moved.error}`
      : ` ${moved.ok}`;
  return {
    state: "sent",
    id,
    sent: change,
    restarts,
    said: `Control sent ${settingsCount(Object.keys(change).length)} to ${rig}. The rig takes the change in less than one minute.${restarts ? ` ${SPLIT_RESTARTS}` : ""}${sizeSaid}`,
  };
}

/** The answer REST and MCP give: the command's id (null: nothing sent), what was sent, the words. */
export const rigSettingsAnswer = (
  rig: string,
  out: Exclude<RigSettingsOutcome, { state: "refused" }>,
) =>
  out.state === "sent"
    ? { rig, id: out.id, sent: out.sent, restarts: out.restarts, said: out.said }
    : { rig, id: null, sent: {}, restarts: false, said: out.said };

/** What the rig reports: its settings (null from an older harness) and its GPU split (null: none). */
export const rigSettingsRead = (store: ControlStore, rig: string) => {
  const now = rigSettingsOf(store, rig);
  return now ? { rig, settings: now.settings, gpu_split: now.gpu_split } : undefined;
};

const part = (does: string) => z.boolean().optional().describe(does);

/**
 * The request's fields over REST and MCP (MCP adds the rig): the rig_settings payload's, each
 * optional. Types only: a value out of range is refused in the payload's words.
 */
export const rigSettingsFields = {
  judge: part(
    "The judge builds and measures each change. Off: changes wait in its queue, and nothing becomes the champion",
  ),
  workers: part(
    "Workers start trials. Off: no new trial starts; a trial running goes on to its end",
  ),
  lanes: z
    .number()
    .int()
    .optional()
    .describe(`Workers at a time: how many trials run at once, 1 to ${MAX_LANES}`),
  planner: part(
    "The planner picks what each worker tries next. Off: lanes take queued experiments in order, by the fixed rules",
  ),
  teachers: part(
    "The teachers (used only if the rig has them). Off: the planner works without their suggestions",
  ),
  auditor: part(
    "The auditor (used only if the rig has one). Off: audits wait for the owner in Needs you",
  ),
  review: part(
    "The review panel (used only if the rig has one). Off: goals that need judgement stay open",
  ),
  exports: part(
    "Hourly exports of the rig's results. Off: results stay on the rig only; if the rig is lost, they are lost",
  ),
  trial_minutes: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "How long one trial lasts, in minutes (1 to 1440), when the campaign's contract sets no limit; null: no limit, a trial lasts until its worker submits or stops",
    ),
  max_turns: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "Turns per trial: model turns a worker may take in one trial (1 to 100000); null: no limit",
    ),
  quiet_minutes: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "After how many minutes without a line a trial asks the owner under Needs you (1 to 1440); null: never. It only shows: nothing ends the trial",
    ),
  program_mode: z
    .enum(PROGRAM_MODES)
    .optional()
    .describe(
      "How a trial's agent program runs: terminal (in its own terminal, as a person runs it, a worker in Pi in its Pi view; the default) or headless (one command for each turn; Pi with no view). The next trial takes it",
    ),
  promotion: z
    .enum(["auto", "owner_approval"])
    .optional()
    .describe(
      "When a confirmed change becomes the champion: auto (at once; an audit the campaign asks for still waits) or owner_approval (each waits for the owner). A campaign's own rule comes first for its runs",
    ),
  judge_gpus: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "On a rig set up with its set of GPUs: how many are the judge's, 1 to min(8, set - 1), the rest the agents' (at most 8). null: the rig's default. A new split restarts the rig's harness",
    ),
};

export const RigSettingsBody = z.strictObject(rigSettingsFields);
export type RigSettingsBody = z.infer<typeof RigSettingsBody>;
