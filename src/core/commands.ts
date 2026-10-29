import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import { CommitSchema, IdSchema, MAX_LANES, MAX_LANES_REASON, Sha256Schema } from "./contract.ts";
import { directionName } from "./directions.ts";
import { StructuredDirective } from "./directives.ts";
import { ExperimentId, inner, RunId, TRIAL_ID } from "./ids.ts";
import { InvalidateEvidence } from "./invalidation.ts";
import { McpUses } from "./mcp.ts";
import { PROGRAM_MODES } from "./rig-settings.ts";
import { TerminalInput } from "./terminal-input.ts";

/**
 * Control commands. Control signs every command with its Ed25519 key; the harness verifies
 * with control's public key, mounted read-only at deploy time. The supervisor relays signed
 * commands but cannot create or alter them.
 */

const InboxPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "relative inbox path");

/**
 * Where the supervisor fetches an import before relaying the command: a git repository
 * (https, ssh, git or file URLs) that has the commit, or a file URL for a model. The harness
 * never reads it: it checks the commit or the sha256 of what arrives, as for a file an
 * operator put in the inbox.
 */
const GitSource = z.union([
  z.object({
    git: z
      .string()
      .max(2000)
      .regex(/^(?:https:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[\w.-]+@[\w.-]+:)/, "a git URL"),
    /** Git access control keeps for a private repository, by name; the rig asks control for it. */
    access: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)
      .optional(),
  }),
  /** A kit control wrote and keeps itself; the supervisor fetches it from control. */
  z.object({ control: z.string().regex(/^kits\/[a-z0-9][a-z0-9._-]{0,63}$/, "kits/<name>") }),
]);
const FileSource = z.object({
  url: z
    .string()
    .max(4000)
    .regex(/^https?:\/\//, "an http(s) URL"),
});

export const ImportSpec = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repo_bundle"),
    path: InboxPath,
    repo: IdSchema,
    commit: CommitSchema,
    /** When given, the bundle file's sha256 must match as well as the commit. */
    sha256: Sha256Schema.optional(),
    source: GitSource.optional(),
  }),
  z.object({
    kind: z.literal("model"),
    path: InboxPath,
    name: z.string().min(1),
    sha256: Sha256Schema,
    source: FileSource.optional(),
  }),
  z.object({
    kind: z.literal("kit_bundle"),
    path: InboxPath,
    repo: IdSchema,
    commit: CommitSchema,
    sha256: Sha256Schema.optional(),
    source: GitSource.optional(),
  }),
  /**
   * Another rig's champion as a binary patch against a base commit both rigs have (the
   * campaign seed). The harness applies it to the base and accepts it only if the file's sha256
   * and the resulting git tree match: the supervisor transports bytes, it cannot change them.
   */
  z.object({
    kind: z.literal("champion_patch"),
    path: InboxPath,
    repo: IdSchema,
    base_commit: CommitSchema,
    tree: CommitSchema,
    sha256: Sha256Schema,
  }),
]);
export type ImportSpec = z.infer<typeof ImportSpec>;

export { ExperimentId };

/** Where an experiment goes among the queued ones: first, last, or at an index (0 first). */
export const QueuePosition = z.union([
  z.literal("top"),
  z.literal("end"),
  z.number().int().min(0).max(100_000),
]);
export type QueuePosition = z.infer<typeof QueuePosition>;

/** An experiment's text: what to try, its details, its direction and why it is worth trying. */
/** The most characters of an experiment's details. */
export const EXPERIMENT_DETAILS = 4000;

export const ExperimentText = {
  title: z.string().trim().min(1).max(200),
  details: z.string().max(EXPERIMENT_DETAILS),
  /**
   * The direction (approach family): a direction's name, or words, whose direction is the name
   * they make (directionOf). Written `:name:`, it is kept without the colons.
   */
  family: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((s) => {
      const inner = /^:(.+):$/.exec(s)?.[1]?.trim();
      return inner && directionName(inner) ? inner : s;
    }),
  why: z.string().max(2000),
};

/**
 * One experiment for a run's queue copied from another run (goal 064): what to try, who added it
 * and why, and where it came from. Text only: it never sets a verdict or the contract.
 */
export const QueueSeed = z.strictObject({
  title: z.string().min(1).max(200),
  details: z.string().max(4000).optional(),
  family: z.string().min(1).max(80).optional(),
  why: z.string().max(2000).optional(),
  by: z.string().min(1).max(80),
  state: z.enum(["queued", "proposed"]),
  from: z.object({ run: RunId, id: z.string().min(1).max(64) }),
});
export type QueueSeed = z.infer<typeof QueueSeed>;

/**
 * Background the owner picked from past research when starting a run (goal 065): a finding, a
 * claim, a note or a report, with where it came from. Every agent's brief shows it as data.
 */
export const BriefingSeed = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  from: z.object({
    campaign: z.string().min(1).max(200),
    /** The rig the run ran on: a run's name is unique on its rig only (goal 162). */
    rig: z.string().min(1).max(200).optional(),
    run: RunId,
    kind: z.string().min(1).max(40),
    ref: z.string().min(1).max(200),
  }),
});
export type BriefingSeed = z.infer<typeof BriefingSeed>;

/**
 * Who an owner's message (message_agent) may go to: everyone working, the planner, the advisors
 * (all of them, the teachers, the auditor or the review panel), a lane or a worker's trial.
 * The lanes stop at MAX_LANES (lanes.test.ts checks it).
 */
export const MESSAGE_TARGET = new RegExp(
  `^(all|planner|advisors|teachers|auditor|review_panel|lane-([1-9]|1[0-6])|trial:${inner(TRIAL_ID)})$`,
);

/**
 * What a run asks the owner about (goal 079). Thermite is hands-off by default: a win the judge
 * confirms is promoted with no owner step (after its auditor's clear, when the rig has an
 * auditor and the campaign calls for an audit), a review panel's pass is accepted and a "not
 * possible" proposal is taken. Each switch here asks the owner instead: `above_gain`, a confirmed
 * gain above this fraction (0.15 is 15%); `declared_flaws`, a win whose worker declared flaws;
 * `reviews`, a review panel's pass of a subjective goal; `not_possible`, a proposal to end a goal
 * campaign as not possible. `promotion: "owner_approval"` asks about every win.
 */
export const AskOwner = z.strictObject({
  above_gain: z.number().positive().max(100).optional(),
  declared_flaws: z.boolean().optional(),
  reviews: z.boolean().optional(),
  not_possible: z.boolean().optional(),
});
export type AskOwner = z.infer<typeof AskOwner>;

/** The longest a drain may wait before its deadline, in minutes: a week. */
export const DRAIN_MINUTES_MAX = 10_080;

export const CommandPayloads = {
  assign_campaign: z.object({
    run: RunId,
    /** The full contract; the harness validates it and checks contract_sha. */
    contract: z.unknown(),
    contract_sha: Sha256Schema,
    /** The starting commit; research campaigns have none. */
    seed: z.object({ repo: IdSchema, commit: CommitSchema }).optional(),
    direction: z.string().min(1).optional(),
    imports: z.array(ImportSpec).default([]),
    /** False: a judge-only run. No worker agents run; the judge still works. */
    agents: z.boolean().optional(),
    /**
     * The run's promotion policy: "auto" (confirmed wins promote, after an auditor's clear when
     * the rig has one and the campaign calls for an audit) or "owner_approval" (every promotion
     * waits for the owner). Unset: the rig's default.
     */
    promotion: z.enum(["auto", "owner_approval"]).optional(),
    /** What else the run asks the owner about (goal 079); unset: nothing. */
    ask_owner: AskOwner.optional(),
    /** Experiments another run had not tried, to start this run's queue with, in order. */
    queue: z.array(QueueSeed).max(500).optional(),
    /** Background from past research for every agent's brief (goal 065), in order. */
    briefing: z.array(BriefingSeed).max(200).optional(),
    /**
     * The MCP servers the run's kit names (a research contract's, for a research run), with the
     * agents that get each one (goal 068). Control fills it in and refuses a server Settings
     * lacks; the harness refuses the run when it differs from what the kit names.
     */
    mcp_servers: McpUses.optional(),
  }),
  /**
   * A check of the rig itself, run by its harness: the model route (one tool-calling request),
   * the isolation selftest, or a judge-only smoke campaign on the rig's own target. The result
   * comes back as a rig_check_finished event.
   */
  rig_check: z.object({
    check: z.enum(["model", "isolation", "smoke"]),
    /** Isolation and smoke want an idle rig; force runs them anyway (trials may be killed). */
    force: z.boolean().optional(),
  }),
  pause_run: z.object({ run: RunId, reason: z.string().min(1) }),
  resume_run: z.object({ run: RunId }),
  /**
   * The owner closes a run by hand (goal 087, owner only): it ends for good, as a run that met its
   * goals does, with the owner's reason. Its trials stop, nothing new starts, its jobs waiting for
   * the judge never run, and it can't be resumed. Its records stay.
   */
  close_run: z.object({ run: RunId, reason: z.string().trim().min(1).max(2000) }),
  /** A directive set; by default it replaces this author's previous set. */
  redirect: z.object({
    run: RunId,
    directives: z.array(StructuredDirective).min(1).max(40),
    replace: z.boolean().default(true),
  }),
  reset_workers: z.object({ run: RunId, reseed_commit: CommitSchema.optional() }),
  /**
   * The owner's message to the run's agents (owner only). `to`: everyone working (`all`: every
   * lane, and the planner of a hill-climb or goal run), a lane, a running worker's trial, the
   * planner, or the advisors (`advisors`: all of them; `teachers`, `auditor` or `panel`). The
   * judge is code and takes no messages. `keep`, for `all` or a lane only, keeps the message in
   * force: it goes into every new trial's brief until an unkeep_message removes it.
   */
  message_agent: z
    .object({
      run: RunId,
      to: z.string().regex(MESSAGE_TARGET),
      text: z.string().min(1).max(4000),
      keep: z.boolean().optional(),
    })
    .refine((p) => !p.keep || p.to === "all" || p.to.startsWith("lane-"), {
      message: "only a message to everyone working (all) or to a lane can be kept in force",
      path: ["keep"],
    }),
  /** The owner ends a message kept in force (owner only): new briefs no longer carry it. */
  unkeep_message: z.object({ run: RunId, message: z.number().int().positive() }),
  /**
   * The run's experiment queue (goal 064), the owner's changes (owner only; an operator may issue
   * them for the owner). Add an experiment (by default at the end of up next), move a queued one,
   * edit or drop one still waiting, or queue a lane's proposed idea.
   */
  queue_add: z.strictObject({
    run: RunId,
    title: ExperimentText.title,
    details: ExperimentText.details.optional(),
    family: ExperimentText.family.optional(),
    why: ExperimentText.why.optional(),
    position: QueuePosition.default("end"),
  }),
  queue_move: z.strictObject({ run: RunId, id: ExperimentId, position: QueuePosition }),
  queue_edit: z
    .strictObject({
      run: RunId,
      id: ExperimentId,
      title: ExperimentText.title.optional(),
      details: ExperimentText.details.optional(),
      family: ExperimentText.family.optional(),
      why: ExperimentText.why.optional(),
    })
    .refine(
      (p) =>
        p.title !== undefined ||
        p.details !== undefined ||
        p.family !== undefined ||
        p.why !== undefined,
      { message: "change at least one of title, details, family and why" },
    ),
  queue_drop: z.strictObject({
    run: RunId,
    id: ExperimentId,
    why: z.string().trim().min(1).max(2000),
  }),
  queue_accept: z.strictObject({
    run: RunId,
    id: ExperimentId,
    position: QueuePosition.optional(),
  }),
  /** The owner removes a rule for the plan in force (a directive), whoever set it. */
  drop_directive: z.strictObject({ run: RunId, id: z.number().int().positive() }),
  /**
   * A research run's hypothesis (goal 117), the owner's to change: promote one of the pool, so it
   * needs a verdict from the review panel as the author's do; return a promoted one to the pool;
   * or retire one; each with why. The author's hypotheses can't be changed this way.
   */
  hypothesis_status: z.strictObject({
    run: RunId,
    id: z.string().trim().min(1).max(64),
    status: z.enum(["promoted", "pool", "retired"]),
    reason: z.string().trim().min(1).max(2000),
  }),
  /**
   * Another rig's champion as a candidate here: this rig's judge screens and confirms it
   * against its own champion. The supervisor stages the file from the results repository.
   */
  propagate: z.object({
    run: RunId,
    source_rig: z.string().min(1),
    source_run: RunId,
    source_seq: z.number().int().positive(),
    import: ImportSpec,
  }),
  /**
   * A full export (a full reset's) also carries the research archive and the ledger snapshot.
   * With `run`, an export of that run alone (goal 103), outside the rig's chain of exports.
   */
  export_now: z.object({ full: z.boolean().default(false), run: RunId.optional() }),
  /**
   * The rig drains before its images change (goal 079): no new trial, plan or judge job starts,
   * and those running end as they would. The rig's report says what still runs; control restarts
   * it once nothing does, or at once when the owner skips the wait. `drain: false` ends a drain.
   * A drain lasts until the harness restarts. It waits at most `deadline_minutes` (the update's;
   * left out: the rig's THERMITE_DRAIN_MINUTES): then it records that its deadline passed, starts
   * nothing new still, and the owner chooses (goal 173).
   */
  drain_rig: z.strictObject({
    drain: z.boolean(),
    reason: z.string().trim().min(1).max(500).optional(),
    deadline_minutes: z.number().int().min(1).max(DRAIN_MINUTES_MAX).optional(),
  }),
  /**
   * The owner (or an operator, for the owner) stops one running trial (goal 136), such as one a
   * drain waits for. It ends as interrupted, with its counters, sources and claims, and its
   * experiment goes back to the top of the run's queue, as a trial a restart interrupts does.
   * Nothing else stops.
   */
  stop_trial: z.strictObject({
    run: RunId,
    trial: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a trial's id"),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  /**
   * Owner-only full reset, after control verified that `export` (an export_now's result) was
   * pushed to the results repository. The harness refuses if research was recorded after it.
   */
  wipe_state: z.object({
    confirm: z.literal("wipe"),
    export: z.string().min(1).max(100),
    through_event: z.number().int().min(0),
  }),
  /**
   * The owner approves a confirmed win waiting for promotion (the rig's promotion policy), or overrides
   * an audit that is pending or blocked. The judge's verdict must still be promotable.
   */
  approve_promotion: z.object({ run: RunId, attempt: z.string().min(1).max(64) }),
  /** The rig's own settings from its Edit page (owner only): only the fields that change. */
  rig_settings: z.strictObject({
    judge: z.boolean().optional(),
    workers: z.boolean().optional(),
    lanes: z.number().int().min(1).max(MAX_LANES, MAX_LANES_REASON).optional(),
    planner: z.boolean().optional(),
    auditor: z.boolean().optional(),
    teachers: z.boolean().optional(),
    review: z.boolean().optional(),
    exports: z.boolean().optional(),
    /** A trial's length when its contract sets none; null: none (goal 079). */
    trial_minutes: z.number().int().min(1).max(1440).nullable().optional(),
    max_turns: z.number().int().min(1).max(100_000).nullable().optional(),
    /** After how many minutes without a line a trial asks the owner (goal 143); null: never. */
    quiet_minutes: z.number().int().min(1).max(1440).nullable().optional(),
    /** How a trial's agent program runs: in its own terminal, or headless (goal 169). */
    program_mode: z.enum(PROGRAM_MODES).optional(),
    promotion: z.enum(["auto", "owner_approval"]).optional(),
    /** How many of the rig's GPUs are the judge's (a rig configured with its GPU set). */
    judge_gpus: z.number().int().min(1).max(8).nullable().optional(),
  }),
  /**
   * The owner says no to a confirmed win that waits for approval, or to an attempt held for (or
   * blocked by) an audit: it never becomes the champion, and stays in the record as declined.
   */
  decline_promotion: z.object({
    run: RunId,
    attempt: z.string().min(1).max(64),
    note: z.string().max(2000).optional(),
  }),
  /** The owner's final acceptance (or rejection) of a goal the review panel passed. */
  accept_review: z.object({
    run: RunId,
    review: z.number().int().positive(),
    accept: z.boolean(),
    note: z.string().max(2000).optional(),
  }),
  /** The owner accepts or rejects the harness's "not possible" conclusion for a goal campaign. */
  conclude: z.object({
    run: RunId,
    proposal: z.number().int().positive(),
    accept: z.boolean(),
    note: z.string().max(2000).optional(),
  }),
  /** The owner withdraws bad evidence (goal 174; owner only): core/invalidation.ts. */
  invalidate_evidence: InvalidateEvidence,
  /** The owner types into a running trial's terminal (goal 169; owner only): core/terminal-input.ts. */
  terminal_input: TerminalInput,
} as const;

export type CommandKind = keyof typeof CommandPayloads;
export const COMMAND_KINDS = Object.keys(CommandPayloads) as CommandKind[];

// ------------------------------------------------------------------ who may issue each kind

/**
 * Kinds an agent may issue through control's MCP. Wiping state, full resets, accepting a
 * subjective goal and accepting a "not possible" ending stay with the owner (dashboard or REST):
 * no model is the final gate.
 */
export const MCP_AGENT_KINDS = [
  "assign_campaign",
  "pause_run",
  "resume_run",
  "redirect",
  "reset_workers",
  "export_now",
  "rig_check",
] as const satisfies readonly CommandKind[];
/**
 * An operator (a token the owner gives an operating agent) may also message the run's agents and
 * stop a trial (goal 136), on the owner's behalf; it never approves, accepts or wipes.
 */
export const MCP_OPERATOR_KINDS = [
  ...MCP_AGENT_KINDS,
  "message_agent",
  "unkeep_message",
  "stop_trial",
  // The experiment queue and the rules for the plan (goal 064): the owner's and operators'.
  "queue_add",
  "queue_move",
  "queue_edit",
  "queue_drop",
  "queue_accept",
  "drop_directive",
] as const satisfies readonly CommandKind[];
/**
 * The owner (admin token) may also approve or decline promotions over MCP, and close a run for
 * good (goal 087); operators and agents never may.
 */
export const MCP_OWNER_KINDS = [
  ...MCP_OPERATOR_KINDS,
  "approve_promotion",
  "decline_promotion",
  "close_run",
  // A research run's hypotheses (goal 117): which need the review panel's verdict.
  "hypothesis_status",
  "invalidate_evidence",
  "terminal_input",
] as const satisfies readonly CommandKind[];

/**
 * Kinds the harness takes only from the owner: control records the issuer in the signed envelope,
 * and the harness refuses these from anyone else.
 */
export const OWNER_ONLY_KINDS: ReadonlySet<string> = new Set<CommandKind>([
  "approve_promotion",
  "decline_promotion",
  "accept_review",
  "conclude",
  "close_run",
  "wipe_state",
  "message_agent",
  "unkeep_message",
  "rig_settings",
  "queue_add",
  "queue_move",
  "queue_edit",
  "queue_drop",
  "queue_accept",
  "drop_directive",
  "hypothesis_status",
  "stop_trial",
  "invalidate_evidence",
  "terminal_input",
]);

/**
 * The kinds about one run, which its payload's `run` names (goal 170): control sends each to the
 * rig the run is on, so a caller may name the run alone. An assignment names the rig it starts a
 * new run on, and every other kind is about the rig itself.
 */
export const RUN_KINDS: ReadonlySet<CommandKind> = new Set<CommandKind>([
  "pause_run",
  "resume_run",
  "close_run",
  "redirect",
  "reset_workers",
  "message_agent",
  "unkeep_message",
  "queue_add",
  "queue_move",
  "queue_edit",
  "queue_drop",
  "queue_accept",
  "drop_directive",
  "hypothesis_status",
  "propagate",
  "stop_trial",
  "approve_promotion",
  "decline_promotion",
  "accept_review",
  "conclude",
  "invalidate_evidence",
  "terminal_input",
]);

export const Envelope = z.object({
  v: z.literal(1),
  id: z.uuid(),
  rig: z.string().min(1),
  kind: z.enum(COMMAND_KINDS as [CommandKind, ...CommandKind[]]),
  issued_by: z.string().min(1),
  issued_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof Envelope>;

export const SignedCommand = z.object({
  envelope: Envelope,
  /** Base64 Ed25519 signature over the canonical JSON of the envelope. */
  signature: z.string().min(1),
});
export type SignedCommand = z.infer<typeof SignedCommand>;

/**
 * The largest signed command, in bytes of its JSON: control refuses to sign a larger one, and the
 * message bus takes none larger (core/link/commands.ts). The harness takes requests up to 4 MiB.
 */
export const COMMAND_MAX_BYTES = 3.5 * 1024 * 1024;

export interface KeyPairPem {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateSigningKeys(): KeyPairPem {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function signEnvelope(envelope: Envelope, privateKeyPem: string): SignedCommand {
  const key = createPrivateKey(privateKeyPem);
  const signature = edSign(null, Buffer.from(canonicalJson(envelope)), key).toString("base64");
  return { envelope, signature };
}

export type VerifyResult =
  | { ok: true; envelope: Envelope; payload: unknown }
  /**
   * `authenticId` is set when the signature and rig binding are valid and only a later check
   * failed (for example expiry), so a replay of an already-applied command can be recognised.
   */
  | { ok: false; reason: string; authenticId?: string };

/** Maximum allowed clock skew between control and the rig. */
const SKEW_MS = 5 * 60_000;

/**
 * Verifies a signed command for this rig: shape, signature, rig binding, validity window
 * and the per-kind payload schema. Replay protection (command ids already seen) is the
 * ledger's job.
 */
export function verifyCommand(
  input: unknown,
  publicKeyPem: string,
  rig: string,
  now: Date = new Date(),
): VerifyResult {
  // A command signed before the 2026-10-15 rename names its "unit" and "instance": its
  // signature is checked over the envelope as it was signed, then it is read under the new names.
  const legacy = legacyEnvelope(input);
  const parsed = SignedCommand.safeParse(legacy ? legacy.normalized : input);
  if (!parsed.success) return { ok: false, reason: "malformed command" };
  const { envelope, signature } = parsed.data;
  const signedForm = legacy ? legacy.signed : envelope;
  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return { ok: false, reason: "control public key unusable" };
  }
  let valid = false;
  try {
    valid = edVerify(
      null,
      Buffer.from(canonicalJson(signedForm)),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };
  if (envelope.rig !== rig) return { ok: false, reason: `command is for rig ${envelope.rig}` };
  const issued = Date.parse(envelope.issued_at);
  const expires = Date.parse(envelope.expires_at);
  const authenticId = envelope.id;
  if (issued - SKEW_MS > now.getTime()) {
    return { ok: false, reason: "issued in the future", authenticId };
  }
  if (expires < now.getTime()) return { ok: false, reason: "expired", authenticId };
  const payload = CommandPayloads[envelope.kind].safeParse(envelope.payload);
  if (!payload.success) {
    return {
      ok: false,
      reason: `bad payload: ${payload.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      authenticId,
    };
  }
  return { ok: true, envelope, payload: payload.data };
}

const LEGACY_KINDS: Record<string, string> = {
  pause_instance: "pause_run",
  resume_instance: "resume_run",
};
const LEGACY_KEYS: Record<string, string> = {
  instance: "run",
  source_instance: "source_run",
  source_unit: "source_rig",
};

/** An envelope from before the rename: as signed, and read under the new names. */
function legacyEnvelope(input: unknown): { signed: unknown; normalized: unknown } | undefined {
  const cmd = input as { envelope?: Record<string, unknown>; signature?: unknown } | undefined;
  const env = cmd?.envelope;
  if (!env || typeof env !== "object" || "rig" in env || !("unit" in env)) return undefined;
  const { unit, kind, payload, ...rest } = env;
  const p =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.fromEntries(
          Object.entries(payload as Record<string, unknown>).map(([k, v]) => [
            LEGACY_KEYS[k] ?? k,
            v,
          ]),
        )
      : payload;
  const k = typeof kind === "string" ? (LEGACY_KINDS[kind] ?? kind) : kind;
  return {
    signed: env,
    normalized: { ...cmd, envelope: { ...rest, rig: unit, kind: k, payload: p } },
  };
}

/** Signs any JSON value (canonical form) with an Ed25519 key. Returns base64. */
export function signJson(value: unknown, privateKeyPem: string): string {
  return edSign(null, Buffer.from(canonicalJson(value)), createPrivateKey(privateKeyPem)).toString(
    "base64",
  );
}

/** Verifies a base64 Ed25519 signature over the canonical JSON of a value. */
export function verifyJson(value: unknown, signature: string, publicKeyPem: string): boolean {
  try {
    return edVerify(
      null,
      Buffer.from(canonicalJson(value)),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/** The part of a harness snapshot its signature covers. */
export function reportBody(r: {
  rig: string;
  ledger_id: string;
  cursor: number;
  next: number;
  events: unknown[];
  summary: unknown;
  /** When the harness made the report, and its newest event: control refuses stale reports. */
  generated_at: string;
  latest_event: number;
}): unknown {
  return {
    rig: r.rig,
    ledger_id: r.ledger_id,
    cursor: r.cursor,
    next: r.next,
    events: r.events,
    summary: r.summary,
    generated_at: r.generated_at,
    latest_event: r.latest_event,
  };
}
