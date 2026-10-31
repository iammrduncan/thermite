import { z } from "zod";
import { COMMAND_KINDS, COMMAND_MAX_BYTES, type CommandKind } from "../../commands.ts";
import { RIG_ID, RIG_ID_WORDS } from "../../ids.ts";
import { ReachBody } from "../../reach.ts";
import { POD_CONFIG_ENV } from "../../tunnel.ts";
import type { Route } from "../route.ts";

/**
 * Control's API as the command line calls it, with the owner's token (src/control/api/ and the
 * modules it mounts answer it): rigs, their enrollment and tokens, RunPod's rigs, full resets,
 * commands, runs and campaigns, kits and MCP servers. Where REST and MCP share a request's fields
 * (campaigns/start-run.ts, campaigns/copy.ts, campaigns/context.ts and mcp-servers/routes.ts in src/control/),
 * control checks the body with them, and the route here takes an object.
 */

/** A body control checks with the fields its REST and MCP share. */
const SharedFields = z.record(z.string(), z.unknown());
/** A body that says nothing: the route's path says it all. */
const Nothing = z.object({});
/** The largest body of a route that takes a few short fields (a rig's name, a confirmation). */
const FEW_FIELDS_MAX_BYTES = 4 * 1024;

/** A build as control's rig list gives it. */
const ListedBuild = z.looseObject({
  version: z.string().nullable(),
  commit: z.string().nullable(),
  protocol: z.number().nullable(),
  oldest_protocol: z.number().nullable().optional(),
});
export type ListedBuild = z.input<typeof ListedBuild>;

/**
 * Every rig control knows, with its state and builds, the rigs it enrolled, and the rigs in pull
 * mode and on RunPod (core/api/control/runpod.ts has a RunPod rig's view). An older control sends
 * no versions.
 */
export const RigList = z.looseObject({
  control: ListedBuild.optional(),
  rigs: z.array(
    z.looseObject({
      id: z.string(),
      last_seen: z.string(),
      state: z.string().optional(),
      version: z
        .looseObject({
          state: z.string(),
          notice: z.string().nullable(),
          harness: ListedBuild.nullable(),
          supervisor: ListedBuild.nullable(),
        })
        .optional(),
    }),
  ),
  enrolled: z
    .array(z.looseObject({ rig: z.string(), retired_at: z.string().nullable() }))
    .optional(),
  /** The rigs the owner retired and has not brought back, by name. */
  retired: z.array(z.string()).optional(),
  runpod: z.array(z.unknown()).optional(),
});
export type RigList = z.input<typeof RigList>;

export const RIGS = { method: "GET", path: "/v1/rigs", answer: RigList } as const satisfies Route;

/** A rig's name, to enroll it: control makes its token and shows it once. */
export const RigName = z.strictObject({ rig: z.string().regex(RIG_ID, RIG_ID_WORDS) });

export const ENROLL = {
  method: "POST",
  path: "/v1/rigs",
  body: RigName,
  maxBytes: FEW_FIELDS_MAX_BYTES,
  answer: z.looseObject({
    rig: z.string(),
    token: z.string(),
    control_public_key: z.string(),
    control_fingerprint: z.string(),
    /**
     * The message bus as the rig reaches it, with the certificate of control's authority it trusts
     * the bus's server through; null: control has no address for rigs on its bus, and `thermite rig
     * add` writes no files, since a rig works only on the bus.
     */
    bus: z.object({ url: z.string(), ca: z.string() }).nullable().optional(),
  }),
} as const satisfies Route;

/** A new token for an enrolled rig: its old one no longer works. */
export const RIG_TOKEN = {
  method: "POST",
  path: "/v1/rigs/:rig/token",
  body: Nothing,
  answer: z.looseObject({ rig: z.string(), token: z.string() }),
} as const satisfies Route;

export const RETIRE = {
  method: "POST",
  path: "/v1/rigs/:rig/retire",
  body: Nothing,
  answer: z.unknown(),
} as const satisfies Route;

/** A restart of a rig's parts through its deployment driver: both, unless told. */
export const RESTART = {
  method: "POST",
  path: "/v1/rigs/:rig/restart",
  body: z.object({
    components: z
      .array(z.enum(["harness", "supervisor"]))
      .min(1)
      .default(["harness", "supervisor"]),
  }),
  answer: z.unknown(),
  maxBytes: FEW_FIELDS_MAX_BYTES,
} as const satisfies Route;

/** A request that names its rig to confirm: "reset <rig>", "terminate <rig>". */
export const Confirm = z.object({ confirm: z.string() });

/** A full reset of a rig: its runs pause and its results leave it; the owner confirms the wipe. */
export const RESET = {
  method: "POST",
  path: "/v1/rigs/:rig/reset",
  body: Confirm,
  answer: z.looseObject({ reset: z.number() }),
  maxBytes: FEW_FIELDS_MAX_BYTES,
} as const satisfies Route;

export const RESETS = {
  method: "GET",
  path: "/v1/resets",
  answer: z.looseObject({
    resets: z.array(z.looseObject({ id: z.number(), rig: z.string(), state: z.string() })),
  }),
} as const satisfies Route;

export const RESET_CONFIRM = {
  method: "POST",
  path: "/v1/resets/:id/confirm",
  body: Nothing,
  answer: z.unknown(),
} as const satisfies Route;

export const RESET_CANCEL = {
  method: "POST",
  path: "/v1/resets/:id/cancel",
  body: Nothing,
  answer: z.unknown(),
} as const satisfies Route;

/** A rig on RunPod, as control shows it (runpod.ts's RunpodRigView); 404 for any other rig. */
export const RUNPOD_RIG = {
  method: "GET",
  path: "/v1/rigs/:rig/runpod",
  answer: z.unknown(),
} as const satisfies Route;

/** A RunPod rig's stop, start and terminate; terminate names the rig to confirm. */
export const RUNPOD_STOP = {
  method: "POST",
  path: "/v1/rigs/:rig/runpod/stop",
  body: Nothing,
  answer: z.unknown(),
} as const satisfies Route;
export const RUNPOD_START = {
  method: "POST",
  path: "/v1/rigs/:rig/runpod/start",
  body: Nothing,
  answer: z.unknown(),
} as const satisfies Route;
export const RUNPOD_TERMINATE = {
  method: "POST",
  path: "/v1/rigs/:rig/runpod/terminate",
  body: z.strictObject({ confirm: z.string() }),
  answer: z.unknown(),
  maxBytes: FEW_FIELDS_MAX_BYTES,
} as const satisfies Route;

/** A RunPod rig's spending limit and idle stop: null takes one off. */
export const LimitsBody = z.strictObject({
  spend_limit_usd: z.number().positive().nullable().optional(),
  idle_stop_minutes: z.number().nullable().optional(),
});
export const RUNPOD_LIMITS = {
  method: "POST",
  path: "/v1/rigs/:rig/runpod/limits",
  body: LimitsBody,
  answer: z.unknown(),
  maxBytes: FEW_FIELDS_MAX_BYTES,
} as const satisfies Route;

/** A GPU cloud's rigs. */
export const CLOUD_RIGS = {
  method: "GET",
  path: "/v1/gpu-clouds/:name/rigs",
  answer: z.array(z.unknown()),
} as const satisfies Route;

/**
 * A rig to launch on a GPU cloud: by the owner alone, billed by the hour. Limits apply only when
 * the owner sets them.
 */
export const LaunchBody = z.strictObject({
  gpu: z.string().min(1),
  gpu_count: z.number().int().optional(),
  cloud_type: z.enum(["SECURE", "COMMUNITY"]).optional(),
  datacenter: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
  container_disk_gb: z.number().int().optional(),
  volume_gb: z.number().int().optional(),
  rig: z.string().min(1).optional(),
  enroll_within_minutes: z.number().positive().optional(),
  settings: z.partialRecord(z.enum(POD_CONFIG_ENV), z.string()).optional(),
  spend_limit_usd: z.number().positive().optional(),
  idle_stop_minutes: z.number().nullable().optional(),
});
export const CLOUD_LAUNCH = {
  method: "POST",
  path: "/v1/gpu-clouds/:name/rigs",
  body: LaunchBody,
  answer: z.unknown(),
  /** A pod's settings included. */
  maxBytes: 64 * 1024,
} as const satisfies Route;

/** The longest life of a command control issues, in minutes: a week. */
export const COMMAND_TTL_MAX_MINUTES = 7 * 24 * 60;

/**
 * A signed command for a rig, which control makes and keeps until the rig takes it. A kind about
 * one run (RUN_KINDS) may leave out the rig: control knows the rig the run is on (goal 170).
 */
export const IssueBody = z.object({
  rig: z.string().min(1).optional(),
  kind: z.enum(COMMAND_KINDS as [CommandKind, ...CommandKind[]]),
  payload: z.unknown(),
  ttl_minutes: z.number().int().positive().max(COMMAND_TTL_MAX_MINUTES).default(60),
});

export const ISSUE = {
  method: "POST",
  path: "/v1/commands",
  body: IssueBody,
  answer: z.looseObject({ woke: z.string().optional() }),
  /** No larger body makes a command a rig can take. */
  maxBytes: COMMAND_MAX_BYTES,
} as const satisfies Route;

/**
 * One command: its delivery status and its outcome, with the rig's answer in `outcome.result`
 * (`outcome.source` is `harness` once the harness's signed report confirmed it).
 */
export const COMMAND = {
  method: "GET",
  path: "/v1/commands/:id",
  answer: z.looseObject({ status: z.string(), outcome: z.unknown() }),
} as const satisfies Route;

/**
 * A run (goal 170), addressed by its name alone, which is unique on control, wherever it ran: its
 * rig's current ledger, an earlier ledger or a retired rig. What hangs from it is addressed
 * under it. Control answers 404 for a run no rig created.
 */
export const RUN = {
  method: "GET",
  path: "/v1/runs/:run",
  answer: z.looseObject({ id: z.string() }),
} as const satisfies Route;

/** A run's untried experiments, as a new run of its campaign takes them into its queue. */
export const UNTRIED = {
  method: "GET",
  path: "/v1/runs/:run/untried",
  answer: z.looseObject({ queue: z.array(z.unknown()) }),
} as const satisfies Route;

/** A run's directions (goal 066), each with its counts and the rules naming it. */
export const RUN_DIRECTIONS = {
  method: "GET",
  path: "/v1/runs/:run/directions",
  answer: z.looseObject({ directions: z.array(z.unknown()) }),
} as const satisfies Route;

/** One attempt of a run: its record as the run's view has it, and the rig it ran on. */
export const RUN_ATTEMPT = {
  method: "GET",
  path: "/v1/runs/:run/attempts/:attempt",
  answer: z.looseObject({ run: z.string(), attempt: z.looseObject({ id: z.string() }) }),
} as const satisfies Route;

/**
 * One of a run's champions as a patch file (the body's bytes), once its rig has published it. The
 * rig's own upload of it stays the rig's (core/api/control/rigs.ts's CHAMPION_PATCH).
 */
export const RUN_CHAMPION_PATCH = {
  method: "GET",
  path: "/v1/runs/:run/champions/:seq/patch",
  answer: z.unknown(),
} as const satisfies Route;

/** One run's published champion sent to another run of its campaign, on another rig. */
export const PROPAGATE = {
  method: "POST",
  path: "/v1/propagate",
  body: z.strictObject({ run: z.string().min(1), to_run: z.string().min(1) }),
  answer: z.looseObject({ id: z.string(), seq: z.number() }),
  maxBytes: FEW_FIELDS_MAX_BYTES,
} as const satisfies Route;

/** Start a run of a campaign control keeps (control/start-run.ts checks the request). */
export const START_RUN = {
  method: "POST",
  path: "/v1/campaigns/:campaign/runs",
  body: SharedFields,
  answer: z.looseObject({
    started: z.boolean().optional(),
    said: z.string().optional(),
    woke: z.string().optional(),
    notes: z.array(z.string()).optional(),
  }),
} as const satisfies Route;

/** A campaign's own context settings (control/campaign-context.ts checks them). */
export const CAMPAIGN_CONTEXT = {
  method: "POST",
  path: "/v1/campaigns/:campaign/context",
  body: SharedFields,
  answer: z.looseObject({ said: z.string().optional() }),
} as const satisfies Route;

/** The owner's additions to a campaign's roles (goal 166; control/campaigns/additions.ts checks them). */
export const CAMPAIGN_ADDITIONS = {
  method: "POST",
  path: "/v1/campaigns/:campaign/additions",
  body: SharedFields,
  answer: z.looseObject({ said: z.string().optional() }),
} as const satisfies Route;

/** Which kinds each role may write in the campaign's knowledge base (goal 175): a new version. */
export const CAMPAIGN_KB_WRITES = {
  method: "POST",
  path: "/v1/campaigns/:campaign/kb-writes",
  body: SharedFields,
  answer: z.looseObject({ said: z.string().optional() }),
} as const satisfies Route;

/**
 * The owner's search of the knowledge base (goal 175): `q`, `collection` and `kind` (lists, with
 * commas), `limit`; and one item read whole by its `address`, at a `version`.
 */
export const KB_SEARCH = {
  method: "GET",
  path: "/v1/kb/search",
  what: "knowledge base search",
  answer: z.looseObject({ matched: z.number(), hits: z.array(z.looseObject({})) }),
} as const satisfies Route;
export const KB_ITEM = {
  method: "GET",
  path: "/v1/kb/item",
  what: "knowledge base item",
  answer: z.looseObject({ item: z.looseObject({ text: z.string() }) }),
} as const satisfies Route;
/**
 * A grant of another campaign's collection to a campaign's agents, read only (goal 176), and its
 * end: each answers the campaign's grants both ways after it, and what changed, in words.
 */
const GrantAnswer = z.looseObject({
  campaign: z.string(),
  changed: z.boolean(),
  reads: z.array(z.string()),
  read_by: z.array(z.string()),
  said: z.string(),
});
export const CAMPAIGN_KB_GRANT = {
  method: "POST",
  path: "/v1/campaigns/:campaign/kb-grants",
  what: "knowledge base grant",
  body: z.strictObject({ reads: z.string().max(200) }),
  answer: GrantAnswer,
  maxBytes: 4096,
} as const satisfies Route;
export const CAMPAIGN_KB_REVOKE = {
  method: "DELETE",
  path: "/v1/campaigns/:campaign/kb-grants/:reads",
  what: "knowledge base grant",
  answer: GrantAnswer,
} as const satisfies Route;
/**
 * One version's file of an item of the knowledge base (goal 176), by its `address` and `version`:
 * its bytes, as an attachment that no browser shows or runs.
 */
export const KB_FILE = {
  method: "GET",
  path: "/v1/kb/file",
  what: "knowledge base file",
  answer: z.unknown(),
} as const satisfies Route;
/**
 * The owner's list of one place of the knowledge base (goal 176): `at`, the filters `kind`,
 * `outcome`, `type` and `slot` (lists, with commas), `sort`, `order`, `offset` and `limit`.
 */
/** What the knowledge base stores (goal 176): its totals, collections, indexes, files and waits. */
export const KB_STORED = {
  method: "GET",
  path: "/v1/kb/stored",
  what: "knowledge base storage",
  answer: z.looseObject({
    totals: z.looseObject({ stored_bytes: z.number() }),
    collections: z.array(z.looseObject({})),
  }),
} as const satisfies Route;
export const KB_LIST = {
  method: "GET",
  path: "/v1/kb/list",
  what: "knowledge base list",
  answer: z.looseObject({
    folders: z.array(z.looseObject({})),
    matched: z.number(),
    items: z.array(z.looseObject({})),
  }),
} as const satisfies Route;

/** A copy of a campaign control keeps (control/copy-campaign.ts checks the request). */
export const CAMPAIGN_COPY = {
  method: "POST",
  path: "/v1/campaigns/:campaign/copy",
  body: SharedFields,
  answer: z.unknown(),
} as const satisfies Route;

/** A kit control keeps, as the command line lists it. */
const KitLine = z.looseObject({
  name: z.string(),
  head: z.string(),
  commits: z.number(),
  kit: z.looseObject({ name: z.string(), target: z.string() }).nullable(),
  kit_error: z.string().optional(),
});
export const KITS = {
  method: "GET",
  path: "/v1/kits",
  answer: z.looseObject({ kits: z.array(KitLine) }),
} as const satisfies Route;

/** The largest kit bundle control takes, over REST (MCP's requests are smaller). */
export const KIT_BUNDLE_MAX = 64 * 1024 * 1024;

/** A kit repository as a git bundle, in the body's bytes (`?ref=`, `?force=`). */
export const KIT_ADD = {
  method: "POST",
  path: "/v1/kits/:name",
  answer: z.looseObject({ said: z.string().optional() }),
  maxBytes: KIT_BUNDLE_MAX,
} as const satisfies Route;

/** An MCP server as control lists it (never a secret): its state, last error and tools. */
const McpServerLine = z.looseObject({
  name: z.string(),
  url: z.string(),
  auth: z.string(),
  status: z.string(),
  last_error: z.string().nullable(),
  secret_hint: z.string().nullable(),
  tools: z.array(z.looseObject({ name: z.string(), reads: z.boolean() })).nullable(),
  named_by: z.array(z.string()).optional(),
});
export type McpServerLine = z.input<typeof McpServerLine>;
/** What a change of an MCP server comes to: the server, a sign-in to open, or why its tools were not read. */
const McpServerSaid = z.looseObject({
  server: McpServerLine.optional(),
  sign_in_url: z.string().optional(),
  check_error: z.string().optional(),
  error: z.string().optional(),
});

export const MCP_SERVERS = {
  method: "GET",
  path: "/v1/mcp-servers",
  answer: z.looseObject({ servers: z.array(McpServerLine) }),
} as const satisfies Route;

/** An MCP server's settings (control/mcp-server-routes.ts checks them); secrets from files. */
export const MCP_SERVER_ADD = {
  method: "POST",
  path: "/v1/mcp-servers",
  body: SharedFields,
  answer: McpServerSaid,
} as const satisfies Route;
export const MCP_SERVER_CHANGE = {
  method: "PUT",
  path: "/v1/mcp-servers/:name",
  body: SharedFields,
  answer: McpServerSaid,
} as const satisfies Route;
export const MCP_SERVER_CHECK = {
  method: "POST",
  path: "/v1/mcp-servers/:name/check",
  body: Nothing,
  answer: McpServerSaid,
} as const satisfies Route;
export const MCP_SERVER_SIGN_IN = {
  method: "POST",
  path: "/v1/mcp-servers/:name/sign-in",
  body: Nothing,
  answer: z.looseObject({ url: z.string() }),
} as const satisfies Route;
export const MCP_SERVER_DELETE = {
  method: "DELETE",
  path: "/v1/mcp-servers/:name",
  answer: z.unknown(),
} as const satisfies Route;

/** An entry of the list of addresses cluster rigs may reach, as control keeps it. */
const ReachableAddress = z.looseObject({
  address: z.string(),
  ports: z.array(z.number()),
  note: z.string(),
  set_at: z.string(),
  set_by: z.string(),
});

/** The addresses cluster rigs' harnesses may reach beside the internet (core/reach.ts). */
export const REACHABLE_ADDRESSES = {
  method: "GET",
  path: "/v1/reachable-addresses",
  answer: z.looseObject({ addresses: z.array(ReachableAddress) }),
} as const satisfies Route;

/** The list as it is to be from now on, whole: control checks it with core/reach.ts's rules. */
export const SET_REACHABLE_ADDRESSES = {
  method: "PUT",
  path: "/v1/reachable-addresses",
  body: ReachBody,
  answer: z.looseObject({ addresses: z.array(ReachableAddress), said: z.string() }),
  maxBytes: 64 * 1024,
} as const satisfies Route;
