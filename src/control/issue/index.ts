import { randomUUID } from "node:crypto";
import { errorText, Refusal } from "../../common/errors.ts";
import { ADVISOR_ROLES, type AdvisorRole, teachersRoundRefusal } from "../../core/agents.ts";
import { canonicalJson } from "../../core/canonical.ts";
import {
  COMMAND_MAX_BYTES,
  type CommandKind,
  CommandPayloads,
  type SignedCommand,
  signEnvelope,
} from "../../core/commands.ts";
import { MAX_LANES } from "../../core/contract.ts";
import { RESEARCH_TASK_KINDS, researchDirectionRefusal } from "../../core/directions.ts";
import {
  COMMAND_RENEW_BEFORE_MS,
  COMMAND_RENEW_FOR_MS,
  COMMAND_STAGING_HOLD_HOURS,
} from "../../core/link/commands.ts";
import { McpUses, sameUses, usesWords } from "../../core/mcp.ts";
import { oldCommandKeys } from "../../core/names.ts";
import { typesIntoTerminals } from "../../core/terminal-input.ts";
import {
  campaignContextRefusal,
  keepAssignedCampaign,
  savedSettingsRefusal,
} from "../campaigns/index.ts";
import { takingModel } from "../command-progress.ts";
import { controlDiskOf } from "../disk.ts";
import { mcpRefusal } from "../mcp-servers/index.ts";
import { rigHasTeachers } from "../rigs/index.ts";
import { usedRunRefusal } from "../run-names.ts";
import type { ControlStore } from "../store/index.ts";
import {
  currentChampion,
  findRun,
  type RigView,
  type RunView,
  rigSettingsOf,
  rigView,
} from "../views/index.ts";
import { publishCommand, unpublishCommand } from "./bus.ts";
import { commandRig } from "./rig.ts";
import { agentAssignRefusal, gitAccessRefusal } from "./sources.ts";

export { COMMANDS_AGAIN_MS, type HeldCommand, heldCommands, sendCommandsOn } from "./bus.ts";
export { commandRig } from "./rig.ts";

/** Each advisor's name in a sentence (goal 074), and its verb. */
const ROLE_NAME: Record<AdvisorRole, { name: string; is: string }> = {
  teachers: { name: "teachers", is: "are" },
  auditor: { name: "auditor", is: "is" },
  review_panel: { name: "review panel", is: "is" },
};

/**
 * Why nothing on the rig would read an owner's message to `to` in this run, in plain words, or ""
 * when something would. The rig's settings (Edit rig, from its signed report) say whether the
 * planner and each advisor are on; the rig's supervisor says which advisors it has set up (the
 * roles it reports). A supervisor that has not reported its roles says nothing: the rig decides.
 * Live greys these recipients, and control refuses such a message before it signs it. Whether a
 * run has a goal the review panel reviews is the contract's: Live and the rig's harness check it.
 */
export function nobodyReads(
  u: Pick<RigView, "settings" | "supervisor">,
  to: string,
  r: Pick<RunView, "mode" | "has_agents">,
): string {
  const research = r.mode === "research";
  if (
    r.has_agents === false &&
    (to === "all" || to === "planner" || /^lane-\d+$/.test(to) || to.startsWith("trial:"))
  )
    return "This run has no agents (the judge alone tries the kit), so nothing would read it.";
  // A research run's planner reads them too (goals 047 and 117).
  if (to === "planner")
    return u.settings?.planner === false
      ? "The planner is off on this rig (Edit rig), so nothing would read it."
      : "";
  const sup = u.supervisor as { advisors?: { roles?: Record<string, unknown> } | null } | null;
  // None set up: the supervisor reports no advisors. Unknown: it has not reported its roles.
  const roles =
    sup && "advisors" in sup ? (sup.advisors === null ? {} : sup.advisors?.roles) : undefined;
  const unset = (x: AdvisorRole) =>
    roles !== undefined &&
    !(x === "teachers"
      ? Number(roles.teachers) > 0
      : x === "auditor"
        ? roles.auditor === true
        : Number(roles.review_panel) > 0);
  const role = (x: AdvisorRole): string => {
    if (research && x === "auditor") return "A research run has no attempts to audit.";
    if (u.settings?.[x === "review_panel" ? "review" : x] === false)
      return `The ${ROLE_NAME[x].name} ${ROLE_NAME[x].is} off on this rig (Edit rig), so nothing would read it.`;
    return unset(x)
      ? `This rig's supervisor has no ${ROLE_NAME[x].name} set up, so nothing would read it.`
      : "";
  };
  if (to === "teachers" || to === "auditor" || to === "review_panel") return role(to);
  if (to !== "advisors") return "";
  if (ADVISOR_ROLES.every(unset))
    return "This rig's supervisor has no advisors set up, so nothing would read it.";
  const why = ADVISOR_ROLES.map(role);
  return why.every(Boolean) ? `No advisor would read it. ${why.join(" ")}` : "";
}

/**
 * An owner's message (message_agent) as control sends it: its words trimmed, and refused in plain
 * words when it has none or when nothing on the rig would read it (nobodyReads). Every path that
 * sends one (the dashboard, MCP, the API) comes through issueCommand, so each refuses alike.
 */
async function checkedMessage(
  store: ControlStore,
  rig: string,
  payload: unknown,
): Promise<unknown> {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as { run?: unknown; to?: unknown; text?: unknown };
  const to = p.to;
  const text = typeof p.text === "string" ? p.text.trim() : p.text;
  if (text === "") throw new Error("Write a message first.");
  const u =
    typeof p.run === "string" && typeof to === "string" ? await rigView(store, rig) : undefined;
  const r = u?.runs.find((x) => x.id === p.run);
  const why = u && r ? nobodyReads(u, String(to), r) : "";
  if (why) throw new Error(why);
  // The run's campaign: as the rig reported it, or as control assigned it (before its report).
  const campaign =
    r?.campaign ||
    (typeof p.run === "string"
      ? (await store.runRegistry.assignedCampaigns(rig)).get(p.run)
      : undefined);
  if (to === "review_panel" && campaign && !(await panelReviews(store, campaign)))
    throw new Error("This run has no goal the review panel reviews, so nothing would read it.");
  return { ...p, to, text };
}

/**
 * Whether the review panel reviews a campaign's runs: a goal checked by review, or a research
 * campaign's questions (goal 112). The review panel reads only then. From the version saved on
 * control, or else the newest assignment.
 */
export async function panelReviews(store: ControlStore, campaign: string): Promise<boolean> {
  const contract = ((await store.campaigns.versions(campaign))[0]?.contract ??
    (await store.commands.latestAssignments()).get(campaign)?.payload.contract) as
    | { mode?: string; goals?: { verify?: { type?: string } }[] }
    | undefined;
  return (
    contract?.mode === "research" ||
    (contract?.goals ?? []).some((g) => g.verify?.type === "review")
  );
}

/**
 * Why a campaign's assignment could not run, in plain words, or "" when nothing here stops it.
 * A rig runs at most MAX_LANES lanes. The rig's harness checks the whole contract again (and
 * refuses more lanes too); refusing here keeps such a command from being signed at all.
 */
export function assignRefusal(payload: unknown): string {
  const count = (payload as { contract?: { lanes?: { count?: unknown } } } | null)?.contract?.lanes
    ?.count;
  if (typeof count === "number" && count > MAX_LANES)
    return `This contract asks for ${count} lanes. A rig runs ${MAX_LANES} at most: it has users for lanes 1 to ${MAX_LANES} only. Set lanes.count to ${MAX_LANES} or fewer.`;
  return "";
}

/**
 * Why a command that would start or resume a run is refused because its campaign is archived
 * (goal 077), or "". Archiving waits until no run is at work, so an archived campaign has none;
 * it starts none either until the owner unarchives it.
 */
export async function archivedRefusal(
  store: ControlStore,
  rig: string,
  kind: CommandKind,
  payload: unknown,
): Promise<string> {
  if (kind !== "assign_campaign" && kind !== "resume_run") return "";
  const p = payload as { run?: unknown; contract?: { campaign?: unknown } } | null;
  const campaign =
    kind === "assign_campaign"
      ? p?.contract?.campaign
      : typeof p?.run === "string"
        ? ((await store.runRegistry.assignedCampaigns(rig)).get(p.run) ??
          (await store.runRegistry.campaignOf(p.run, rig)))
        : undefined;
  if (typeof campaign !== "string" || !(await store.archive.get(campaign))) return "";
  return `${campaign} is archived. Unarchive it first.`;
}

/**
 * Why control refuses a model check now, or "" (goal 191, issue 44): while the rig takes the model
 * control gave it, it has no route to check yet, and it checks the new one itself once it has it.
 */
export async function modelCheckRefusal(
  store: ControlStore,
  rig: string,
  p: { check: string },
): Promise<string> {
  if (p.check !== "model") return "";
  const want = (await store.agentModels.byRig())[rig];
  if (!takingModel((await rigView(store, rig))?.model ?? null, want)) return "";
  return want
    ? `${rig} is taking ${want.model} now: it checks the model itself once it has it, within a minute. Check it again after that.`
    : `${rig} is going back to its own settings now: it checks its model itself once it has them, within a minute. Check it again after that.`;
}

/**
 * Why control refuses a teachers' round before signing it, or "" (goal 194, issue 53): the run must
 * be running, on a rig with teachers, switched on. From the rig's reports; what they don't show
 * yet is the rig's to check, and its harness refuses a run that is not running.
 */
export async function teachersRoundAsked(
  store: ControlStore,
  rig: string,
  p: { run: string },
): Promise<string> {
  // A status the rig has not reported yet ("unknown") is the rig's to check.
  const status = (await rigView(store, rig))?.runs.find((x) => x.id === p.run)?.status;
  const refused =
    status === "paused" || status === "closed" ? teachersRoundRefusal(p.run, status) : "";
  if (refused) return refused;
  if ((await rigHasTeachers(store, rig)) === false)
    return `${rig} has no teachers: give them a model on Edit rig.`;
  if ((await rigSettingsOf(store, rig))?.settings?.teachers === false)
    return `${rig}'s teachers are off: switch them on on Edit rig.`;
  return "";
}

/** Why control refuses a command for a run its rig reports closed, or "" (goal 198). */
async function closedRefusal(
  store: ControlStore,
  rig: string,
  p: { run: string },
): Promise<string> {
  const run = (await rigView(store, rig))?.runs.find((x) => x.id === p.run);
  return run?.status === "closed"
    ? `${p.run} is closed: start a new run of its campaign instead.`
    : "";
}

/**
 * Why control refuses a set of rules (redirect) before signing it, or "". A rule may name a
 * direction the run doesn't have yet: the planner designs it (goal 066). A research run has no
 * planner, so there only its task kinds may be named. The rig's harness checks the same.
 */
export async function redirectRefusal(
  store: ControlStore,
  rig: string,
  payload: unknown,
): Promise<string> {
  const p = payload as { run?: unknown; directives?: { direction?: unknown }[] } | null;
  if (typeof p?.run !== "string") return "";
  const r = (await rigView(store, rig))?.runs.find((x) => x.id === p.run);
  if (r?.mode !== "research") return "";
  const kinds: readonly string[] = RESEARCH_TASK_KINDS;
  const unknown = [
    ...new Set(
      (p.directives ?? [])
        .map((d) => d.direction)
        .filter((f): f is string => typeof f === "string" && !kinds.includes(f)),
    ),
  ];
  return unknown.length ? researchDirectionRefusal(unknown) : "";
}

/**
 * Why control refuses a hypothesis_status before signing it, or "" (goal 117): only a research run
 * has hypotheses to promote, return or retire. From the rig's report; a run the report does not
 * show yet is the rig's to check, and its harness refuses the same.
 */
export async function hypothesisStatusRefusal(
  store: ControlStore,
  rig: string,
  payload: unknown,
): Promise<string> {
  const p = payload as { run?: unknown } | null;
  if (typeof p?.run !== "string") return "";
  const r = (await rigView(store, rig))?.runs.find((x) => x.id === p.run);
  if (!r || r.mode === "research") return "";
  return `Run ${p.run} is not a research run: only a research run has hypotheses to promote or retire.`;
}

/**
 * An assignment's MCP servers (goal 068): a research contract's own list (a research campaign
 * has no kit), filled in when the caller left it out. Refused, in words, when it differs from the
 * contract's, or when it names a server Settings lacks: such a campaign can't start.
 */
async function withMcpServers(store: ControlStore, payload: unknown): Promise<unknown> {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as {
    contract?: { mode?: unknown; mcp_servers?: unknown };
    mcp_servers?: unknown;
  };
  let out = p;
  if (p.contract?.mode === "research" && p.contract.mcp_servers !== undefined) {
    if (p.mcp_servers === undefined) out = { ...p, mcp_servers: p.contract.mcp_servers };
    else {
      const a = McpUses.safeParse(p.mcp_servers);
      const b = McpUses.safeParse(p.contract.mcp_servers);
      if (a.success && b.success && !sameUses(a.data, b.data))
        throw new Error(
          `The assignment names the MCP servers ${usesWords(a.data)}, and the contract names ${usesWords(b.data)}. Leave mcp_servers out: control takes the contract's.`,
        );
    }
  }
  const uses = McpUses.safeParse(out.mcp_servers ?? []);
  const why = uses.success ? await mcpRefusal(store, uses.data) : "";
  if (why) throw new Error(why);
  return out;
}

/**
 * A rig's pending command in its newest form, as the rig's supervisor asks for it on the message
 * bus (core/link/asks.ts's `renew`): while its sources still stage, near its expiry, or once the
 * form it holds expired. One due within COMMAND_RENEW_BEFORE_MS is signed again with a later
 * expiry, COMMAND_RENEW_FOR_MS on, at most COMMAND_STAGING_HOLD_HOURS after it was issued, and
 * each renewal is in the audit log: a download longer than a command's life no longer expires its
 * assignment. Refused in words when control holds no such pending command for the rig.
 */
export async function renewCommand(
  store: ControlStore,
  privateKeyPem: string,
  rig: string,
  id: string,
): Promise<{ command: SignedCommand } | { refused: string }> {
  const c = (await store.commands.pending(rig)).find((p) => p.envelope.id === id);
  if (!c)
    return {
      refused: `control holds no pending command ${id} for ${rig}: it expired, was cancelled, or has its outcome`,
    };
  const e = c.envelope;
  const now = Date.now();
  const until = Math.min(
    now + COMMAND_RENEW_FOR_MS,
    Date.parse(e.issued_at) + COMMAND_STAGING_HOLD_HOURS * 3_600_000,
  );
  const expires = Date.parse(e.expires_at);
  if (expires - now > COMMAND_RENEW_BEFORE_MS || until <= expires) return { command: c };
  const renewed = signEnvelope({ ...e, expires_at: new Date(until).toISOString() }, privateKeyPem);
  await store.commands.renew(e.id, canonicalJson(renewed));
  await store.auditLog.add("control", "command_renewed", {
    id: e.id,
    rig,
    expires_at: renewed.envelope.expires_at,
    why: "its sources are still being fetched",
  });
  return { command: renewed };
}

/** A command outcome that came from the harness's signed report, not from the supervisor. */
export function harnessConfirmed(outcome: unknown): boolean {
  return (outcome as { source?: string } | null)?.source === "harness";
}

/**
 * What a command is issued with: the rig, its kind and payload, how long it lives, who asks. A
 * kind about one run may leave out the rig: control sends it to the run's (issue/rig.ts).
 */
export interface IssueInput {
  rig?: string | undefined;
  kind: CommandKind;
  payload: unknown;
  ttlMinutes?: number | undefined;
  issuedBy: string;
  /** Issued with an agent's token: it may not name a Git access, a source or MCP servers. */
  agent?: boolean | undefined;
  /**
   * False: issued with the operator's or an agent's token, so an assignment carries the role
   * additions and knowledge-base writers of the campaign's saved version. Control's own commands
   * leave it out.
   */
  owner?: boolean | undefined;
}

/**
 * Issues a signed command for a rig: the one path the API, the dashboard and MCP all use.
 * The payload is validated against its kind's schema before signing; the rig's harness
 * validates and verifies it again on arrival.
 */
export async function issueCommand(
  store: ControlStore,
  privateKeyPem: string,
  input: IssueInput,
): Promise<{ id: string }> {
  const signed = await prepareCommand(store, privateKeyPem, input);
  await store.commands.enqueue(signed);
  await keepAssignedCampaign(store, signed);
  await auditChange(store, signed);
  // On the bus once its record is kept: a command of a transaction that is dropped is not sent.
  store.onceKept(() => publishCommand(store, signed));
  return { id: signed.envelope.id };
}

/**
 * A teachers' round now (goal 194), as the MCP tool and the REST route ask for it: one signed
 * start_teachers_round to the run's rig, refused in words before signing (teachersRoundAsked).
 */
export async function startTeachersRound(
  store: ControlStore,
  privateKeyPem: string,
  a: { run: string; issuedBy: string },
): Promise<{ started: true; id: string; rig: string; said: string }> {
  const payload = { run: a.run };
  const rig = await commandRig(store, "start_teachers_round", undefined, payload);
  const { id } = await issueCommand(store, privateKeyPem, {
    rig,
    kind: "start_teachers_round",
    payload,
    issuedBy: a.issuedBy,
  });
  const said = `${rig}'s teachers review ${a.run} within a minute, or when a round under way ends.`;
  return { started: true, id, rig, said };
}

/**
 * More hours of work for a run (goal 198), as the MCP tool and the REST route ask for them: one
 * signed add_run_hours to the run's rig, refused in words before signing for a closed run.
 */
export async function addRunHours(
  store: ControlStore,
  privateKeyPem: string,
  a: { run: string; hours: number; issuedBy: string },
): Promise<{ id: string; rig: string; said: string }> {
  const payload = { run: a.run, hours: a.hours };
  const rig = await commandRig(store, "add_run_hours", undefined, payload);
  const { id } = await issueCommand(store, privateKeyPem, {
    rig,
    kind: "add_run_hours",
    payload,
    issuedBy: a.issuedBy,
  });
  const said = `${rig} adds ${a.hours} hours to ${a.run} within a minute: a run whose hours ran out resumes.`;
  return { id, rig, said };
}

/**
 * A command that changes a rig part's setting says in the audit log what it changes, beside the
 * `command_issued` that every command gets: a `log_level` its part and level.
 */
async function auditChange(store: ControlStore, signed: SignedCommand): Promise<void> {
  const e = signed.envelope;
  if (e.kind !== "log_level") return;
  await store.auditLog.add(e.issued_by, "log_level_sent", {
    command: e.id,
    rig: e.rig,
    ...(e.payload as Record<string, unknown>),
  });
}

/**
 * The owner withdraws a command that has not been delivered: control records it failed, and,
 * with the message bus on, takes it off its rig's subject, so the rig's supervisor never delivers
 * it. False when it was not pending.
 */
export async function cancelCommand(
  store: ControlStore,
  id: string,
  actor: string,
): Promise<boolean> {
  const rig = (await store.commands.row(id))?.rig;
  if (!(await store.commands.cancel(id, actor))) return false;
  if (rig) store.onceKept(() => unpublishCommand(store, rig, id));
  return true;
}

/** The commands that start a run on a rig: on a stopped RunPod pod, they start the pod first. */
export const WAKING_KINDS: readonly CommandKind[] = ["assign_campaign", "resume_run"];

/** A command refused because its rig's pod on RunPod could not be started for it (a conflict). */
export class WakeRefused extends Error {}

/**
 * A run's assignment held while control's disk is at its floor (goal 173): refused for now, in
 * words, as a conflict, as a wake refused is.
 */
export class AssignmentHeld extends WakeRefused {}

/** What issueWaking needs of the rigs on RunPod (RunpodRigs, runpod/rigs.ts). */
export interface PodWaker {
  /** The rig's pod as control follows it, when the rig is one launched on RunPod. */
  view(
    rig: string,
  ): Promise<{ active: boolean; status: string; op?: { kind: string } | null } | undefined>;
  /** Starts the rig's pod when it is stopped: what it did in words, or null when nothing. */
  wake(rig: string, by: string, why?: string): Promise<string | null>;
}

/**
 * Issues a command that may start a run (WAKING_KINDS) on a rig launched on RunPod: when the
 * rig's pod is stopped, control starts it first, then queues the command, which waits until the
 * pod runs and the rig fetches it. The command is checked and signed before anything starts, so a
 * bad payload never starts a pod. A start that is refused (no free GPU, the spend limit reached,
 * a stop under way) refuses the command too, and nothing is queued. Only the owner starts a pod,
 * as for a launch and a start: for a stopped pod, another token's command is refused in words.
 * Other kinds, and other rigs, are issued as issueCommand issues them.
 */
export async function issueWaking(
  store: ControlStore,
  privateKeyPem: string,
  pods: PodWaker | undefined,
  input: IssueInput & { owner: boolean },
): Promise<{ id: string; woke: string | null }> {
  // Control's disk at its floor holds new runs; what runs already goes on.
  const held = input.kind === "assign_campaign" ? controlDiskOf(store)?.held : undefined;
  if (held) throw new AssignmentHeld(held);
  const signed = await prepareCommand(store, privateKeyPem, input);
  const rig = signed.envelope.rig;
  let woke: string | null = null;
  if (pods && WAKING_KINDS.includes(input.kind)) {
    const pod = await pods.view(rig);
    if (pod?.active && pod.status === "EXITED" && !pod.op && !input.owner)
      throw new WakeRefused(
        `${rig}'s pod on RunPod is stopped, and only the owner can start it: start the pod from the rig's page, or start the run with the owner's token`,
      );
    const run = (input.payload as { run?: unknown } | null)?.run;
    const why =
      typeof run === "string"
        ? `to ${input.kind === "assign_campaign" ? "assign" : "resume"} run ${run}`
        : undefined;
    try {
      woke = await pods.wake(rig, input.issuedBy, why);
    } catch (err) {
      throw new WakeRefused(
        `Not sent: control could not start ${rig}'s pod on RunPod for it. ${errorText(err)}`,
      );
    }
  }
  await store.commands.enqueue(signed);
  await keepAssignedCampaign(store, signed);
  await auditChange(store, signed);
  // On the bus once its record is kept: a command of a transaction that is dropped is not sent.
  store.onceKept(() => publishCommand(store, signed));
  return { id: signed.envelope.id, woke };
}

/**
 * Checks and signs a command for a rig without queueing it: the rig is known and not refused, the
 * payload fits its kind's schema, and the signed command is small enough to deliver. Throws, in
 * words, otherwise. issueCommand and issueWaking queue what it returns.
 */
export async function prepareCommand(
  store: ControlStore,
  privateKeyPem: string,
  input: IssueInput,
): Promise<SignedCommand> {
  // A kind about one run goes to the run's rig, which the caller may leave out (goal 170).
  const rig = await commandRig(store, input.kind, input.rig, input.payload);
  if (
    !(await store.reportedRigs.list()).some((u) => u.id === rig) &&
    !(await store.enrollments.knownRig(rig))
  ) {
    throw new Error(`unknown rig ${rig}`);
  }
  // A rig control refuses would never fetch it: say why now, not when it expires.
  const refused = await store.refusals.get(rig);
  if (refused) throw new Error(`Control sends no commands to ${rig}. ${refused.reason}`);
  const assigns = input.kind === "assign_campaign";
  const unrunnable = assigns
    ? (input.agent ? agentAssignRefusal(input.payload) : "") ||
      (input.owner === false ? await savedSettingsRefusal(store, input.payload) : "") ||
      assignRefusal(input.payload) ||
      (await gitAccessRefusal(store, input.payload))
    : "";
  if (unrunnable) throw new Error(unrunnable);
  const shelved = await archivedRefusal(store, rig, input.kind, input.payload);
  if (shelved) throw new Error(shelved);
  // Typing into an agent's terminal is the owner's own (goal 169): never an operator's or an agent's.
  if (input.kind === "terminal_input" && !typesIntoTerminals(input.issuedBy))
    throw new Error("Only the owner types into an agent's terminal: send the agents a message.");
  // A campaign's own context window above what a provider lists for one of the rig's agents'
  // models (goal 070): refused before signing, on every path that starts a run. A try has no agents.
  const assigned = input.payload as { contract?: unknown; agents?: unknown } | null;
  const tooWide =
    input.kind === "assign_campaign" && assigned?.agents !== false
      ? await campaignContextRefusal(store, rig, assigned?.contract)
      : "";
  if (tooWide) throw new Error(tooWide);
  // The old names a command took before v0.1.1 are refused in words (core/names.ts).
  const old = oldCommandKeys(input.kind, input.payload);
  if (old.length) throw new Error(`bad ${input.kind} payload: ${old.join("; ")}`);
  const parsed = CommandPayloads[input.kind].safeParse(
    input.kind === "message_agent"
      ? await checkedMessage(store, rig, input.payload)
      : input.kind === "assign_campaign"
        ? await withMcpServers(store, input.payload)
        : input.payload,
  );
  if (!parsed.success) {
    throw new Error(
      `bad ${input.kind} payload: ${parsed.error.issues.map((i) => `${i.path.join(".") || "payload"}: ${i.message}`).join("; ")}`,
    );
  }
  const payload = parsed.data;
  const ruled =
    input.kind === "redirect"
      ? await redirectRefusal(store, rig, payload)
      : input.kind === "hypothesis_status"
        ? await hypothesisStatusRefusal(store, rig, payload)
        : input.kind === "assign_campaign"
          ? await usedRunRefusal(store, payload as { run: string })
          : input.kind === "rig_check"
            ? await modelCheckRefusal(store, rig, payload as { check: string })
            : input.kind === "start_teachers_round"
              ? await teachersRoundAsked(store, rig, payload as { run: string })
              : input.kind === "add_run_hours"
                ? await closedRefusal(store, rig, payload as { run: string })
                : "";
  if (ruled) throw new Error(ruled);
  const now = Date.now();
  const signed = signEnvelope(
    {
      v: 1,
      id: randomUUID(),
      rig,
      kind: input.kind,
      issued_by: input.issuedBy,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + (input.ttlMinutes ?? 60) * 60_000).toISOString(),
      payload,
    },
    privateKeyPem,
  );
  // A bigger one could never be delivered on the message bus.
  if (Buffer.byteLength(JSON.stringify(signed)) > COMMAND_MAX_BYTES)
    throw new Error(`the ${input.kind} command is too large to deliver`);
  return signed;
}

/**
 * Propagates one run's published champion to another run of the same campaign, on another rig;
 * each run is named alone, and control knows the rig each ran on (goal 170). The command carries
 * the patch's sha256 and the tree, from the source's own signed report, so the receiving harness
 * can check what the supervisors transport. The receiving rig's judge decides; a win there marks
 * the source champion cross-verified.
 */
export async function propagateChampion(
  store: ControlStore,
  privateKeyPem: string,
  input: {
    run: string;
    toRun: string;
    issuedBy: string;
    staleAfterMs: number;
    /** Sent with an agent's token, which does not steer a rig during the owner's full reset. */
    agent?: boolean | undefined;
  },
): Promise<{ id: string; seq: number }> {
  const opts = { staleAfterMs: input.staleAfterMs };
  const from = await findRun(store, input.run, opts);
  const src = from?.run;
  if (!from || !src) throw new Refusal(`no run ${input.run}`);
  const to = await findRun(store, input.toRun, opts);
  const dst = to?.run;
  if (!to || !dst) throw new Refusal(`no run ${input.toRun}`);
  if (input.agent && (await store.fullResets.open(to.rig.id)))
    throw new Refusal(`${to.rig.id} is being reset by the owner`);
  if (to.rig.id === from.rig.id)
    throw new Refusal(`${input.run} and ${input.toRun} are on one rig: propagate between two rigs`);
  const champ = currentChampion(src);
  const pub = src.published;
  if (!champ || champ.seq <= 1) throw new Refusal("the source run has no champion beyond its seed");
  if (!pub || pub.seq !== champ.seq) {
    throw new Refusal(
      `champion seq ${champ.seq} is not published yet: the run's export at its end publishes it, or a full export of ${from.rig.id} does now (Export on its page)`,
    );
  }
  if (dst.campaign !== src.campaign) {
    throw new Refusal(`${input.toRun} runs ${dst.campaign}, not ${src.campaign}`);
  }
  if (!pub.repo || dst.seed_repo !== pub.repo) {
    throw new Refusal(`the target works on ${dst.seed_repo}, the champion is in ${pub.repo}`);
  }
  // The receiving supervisor fetches the patch from the source rig's results: where it ran.
  const { id } = await issueCommand(store, privateKeyPem, {
    rig: to.rig.id,
    kind: "propagate",
    payload: {
      run: input.toRun,
      source_rig: from.rig.id,
      source_run: input.run,
      source_seq: pub.seq,
      import: {
        kind: "champion_patch",
        path: `propagate/${from.rig.id}/${input.run}/${pub.seq}.patch`,
        repo: pub.repo,
        base_commit: pub.base_commit,
        tree: pub.tree,
        sha256: pub.sha256,
      },
    },
    // The source's export may still be on its way to the results repository.
    ttlMinutes: 24 * 60,
    issuedBy: input.issuedBy,
  });
  return { id, seq: pub.seq };
}
