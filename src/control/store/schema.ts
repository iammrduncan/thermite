import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { copyBeforeMigration, keepCopyBefore, newerSchemaWords } from "../../common/db-copy.ts";
import { transaction } from "../../common/sqlite.ts";
import { auditRepeats } from "./audit.ts";
import { busKeyTables, busSealKeyColumn } from "./bus.ts";
import { commandRunAndCampaign } from "./commands.ts";
import {
  dropEventsTable,
  type EventsMoved,
  eventsInOrderIndex,
  eventsTableHoldsRows,
  eventsTableMayGo,
} from "./events.ts";
import { gitAccessHost } from "./git-access.ts";
import { knowledgeHierarchy, knowledgeSearch } from "./kb/index.ts";
import { synthesizerAndWriterSlots } from "./models.ts";
import { appliedPlacesTables } from "./positions.ts";
import { campaignProposalGrants, campaignProposalTable } from "./proposals.ts";
import { migrateModelRoutes } from "./providers.ts";
import { renameAgentRoles, renameUnitsToRigs } from "./renames.ts";
import { runRegistryTable } from "./runs.ts";

/**
 * Control's store's schema and its migrations, moved out of store.ts (goal 173). The store's
 * schema version is how many migrations have run; see migrateStore.
 */

type Row = Record<string, SQLInputValue>;

const SCHEMA = `
create table if not exists rig (
  id text primary key,
  first_seen text not null,
  last_seen text not null,
  last_cursor integer not null default 0,
  ledger_id text,
  summary text not null default '{}'
);
-- Event ids are unique only within one harness ledger, and a wiped or lost ledger starts again
-- at 1, so events are keyed by (rig, ledger_id, event_id). seq is control's own order.
create table if not exists rig_event (
  seq integer primary key autoincrement,
  rig text not null,
  ledger_id text not null,
  event_id integer not null,
  at text not null,
  actor text not null,
  kind text not null,
  subject text,
  body text not null,
  received_at text not null,
  unique (rig, ledger_id, event_id)
);
create index if not exists rig_event_kind on rig_event (rig, kind);
create table if not exists command (
  id text primary key,
  rig text not null,
  kind text not null,
  signed text not null,
  issued_by text not null,
  issued_at text not null,
  status text not null check (status in ('pending', 'delivered', 'rejected', 'failed', 'expired')),
  outcome text,
  acked_at text
);
create index if not exists command_pending on command (rig, status);
create table if not exists audit (
  id integer primary key autoincrement,
  at text not null,
  actor text not null,
  action text not null,
  body text not null
);
-- Every ledger a rig has reported from; a ledger it has left is never accepted again.
create table if not exists rig_ledger (
  rig text not null,
  ledger_id text not null,
  first_seen text not null,
  superseded_at text,
  primary key (rig, ledger_id)
);
create table if not exists rig_report (
  id integer primary key autoincrement,
  rig text not null,
  kind text not null,
  body text not null,
  at text not null
);
-- Dashboard sign-ins, kept across restarts. Only a hash of each session id is stored, with a
-- fingerprint of the admin token it was made with (a new token ends every session).
create table if not exists ui_session (
  id_hash text primary key,
  token_fp text not null,
  created_at text not null,
  expires_at integer not null
);

-- Full resets (owner only): pause, export, verify the push, wipe, restart. One open per rig.
create table if not exists reset (
  id integer primary key autoincrement,
  rig text not null,
  state text not null,
  requested_by text not null,
  command text,
  export_name text,
  through_event integer,
  detail text,
  created_at text not null,
  updated_at text not null
);
-- The live view: recent live-log lines per rig (harness lines signed; supervisor lines not).
create table if not exists rig_live (
  id integer primary key autoincrement,
  rig text not null,
  log_id text not null,
  seq integer not null,
  at text not null,
  source text not null,
  kind text not null,
  text text not null,
  lane text,
  run text,
  signed integer not null,
  received_at text not null
);
create unique index if not exists rig_live_seq on rig_live (rig, log_id, seq);
-- Champions' patches as each rig's supervisor uploaded them, kept only when they match the
-- sha256 the rig's signed champion_published event names: what an operator downloads.
create table if not exists champion_patch (
  rig text not null,
  run text not null,
  seq integer not null,
  sha256 text not null,
  base_commit text not null,
  patch blob not null,
  received_at text not null,
  primary key (rig, run, seq)
);
-- A model provider the owner set: its type, where it is, and its API key sealed (control's secret
-- box; never stored in clear). models is its own model list, as control last read it (plus any the
-- owner added by name). version moves on every change, so the rigs that use it pick it up.
create table if not exists model_provider (
  name text primary key,
  type text not null,
  base_url text not null,
  key_sealed text not null,
  key_hint text not null,
  version integer not null default 1,
  updated_at text not null,
  models text not null default '[]',
  models_at text,
  models_error text
);
-- The provider and model each rig's agents use. A rig with none keeps its own settings.
create table if not exists rig_model (
  rig text primary key,
  provider text not null,
  model text not null,
  assigned_at text not null
);
-- The model of each of a rig's other agents (the planner; the teachers' first and second model and
-- their merged by model; the auditor; the review panel), when the owner gave one; a role with none
-- follows the workers, or the rig default.
create table if not exists rig_role_model (
  rig text not null,
  role text not null check (role in ('planner', 'teachers', 'second_teacher', 'merged_by', 'auditor', 'review_panel')),
  provider text not null,
  model text not null,
  effort text,
  assigned_at text not null,
  primary key (rig, role)
);
-- Rigs enrolled through control (thermite rig add, or the API): each token only as its SHA-256.
-- A rig in the rig tokens file needs no row. A retired rig's token stops working.
create table if not exists rig_token (
  rig text primary key,
  token_sha256 text not null,
  created_at text not null,
  created_by text not null,
  rotated_at text,
  retired_at text
);
-- Git access for private repositories (Settings): an SSH deploy key control made (its public
-- half shown, its private half sealed) or an HTTPS token (sealed). Rigs get one only for a
-- campaign assigned to them that names it.
create table if not exists git_access (
  name text primary key,
  kind text not null check (kind in ('ssh', 'token')),
  public_key text,
  fingerprint text,
  secret_sealed text not null,
  hint text not null,
  username text,
  created_at text not null,
  created_by text not null
);
-- Machines control sets rigs up on, over SSH: the key sealed, the host keys the owner trusted
-- (none until then), and what the last read-only check found.
create table if not exists machine (
  name text primary key,
  address text not null,
  port integer not null,
  user text not null,
  key_sealed text not null,
  public_key text not null,
  key_fingerprint text not null,
  host_keys text not null default '[]',
  seen_host_keys text not null default '[]',
  facts text,
  checked_at text,
  check_error text,
  created_at text not null,
  created_by text not null
);
-- Installs on a machine: each one approved by the owner for one recipe's exact script, used
-- once, before it expires; then its outcome.
create table if not exists machine_install (
  id integer primary key,
  machine text not null,
  recipe text not null,
  script_sha text not null,
  approved_by text not null,
  approved_at text not null,
  expires_at text not null,
  started_at text,
  finished_at text,
  ok integer,
  output text
);
-- Kubernetes clusters control sets rigs up on: the kubeconfig sealed, the context, how rigs are
-- placed (namespaces control creates, or slots the cluster's operators made), what the last check
-- found.
create table if not exists cluster (
  name text primary key,
  kubeconfig_sealed text not null,
  context text not null default '',
  placement text not null check (placement in ('created', 'slot')),
  namespace_pattern text not null default 'thermite-{rig}',
  slots text not null default '[]',
  facts text,
  checked_at text,
  check_error text,
  created_at text not null,
  created_by text not null
);
-- Rigs the owner joins themself (join.ts): where, and the join command's hash, expiry and use.
create table if not exists joined_rig (
  rig text primary key,
  form text not null check (form in ('machine', 'namespace')),
  spec text not null,
  join_sha256 text,
  join_expires_at text,
  join_used_at text,
  status text not null,
  created_at text not null,
  created_by text not null
);
-- GPU clouds (RunPod) control reads with the owner's key, sealed: what the last read found.
create table if not exists gpu_cloud (
  name text primary key,
  kind text not null check (kind in ('runpod')),
  key_sealed text not null,
  key_hint text not null,
  facts text,
  checked_at text,
  check_error text,
  created_at text not null,
  created_by text not null
);
-- Rigs the owner retired: they leave the lists and Needs you, and their reports are refused,
-- until brought back. Their records stay.
create table if not exists rig_retired (
  rig text primary key,
  at text not null,
  by text not null
);
-- The build each part of a rig last reported (the harness in its signed report, the supervisor
-- in its calls' headers), and since when. No row: the part reported none (a build before versions).
create table if not exists rig_build (
  rig text not null,
  component text not null check (component in ('harness', 'supervisor')),
  version text,
  commit_sha text,
  protocol integer,
  oldest_protocol integer,
  since text not null,
  primary key (rig, component)
);
-- Rigs control refuses now because their protocol and control's do not meet, and why; how many
-- of the rig's calls control refused since, and when the last one came.
create table if not exists rig_refusal (
  rig text primary key,
  reason text not null,
  since text not null,
  calls integer not null default 0,
  last_at text
);
-- Control's own builds, each from when it first ran: a rig's page says since when the two differ.
create table if not exists control_build (
  version text not null,
  commit_sha text,
  since text not null
);
-- Rigs in pull mode, which control connects to through a public proxy (a RunPod pod): the pod
-- once launched, the tunnel's sealed secrets, the one-time enrollment code (spent: ''), the
-- rig's settings, and the pod's keys once enrolled (docs/plan/goals/_completed/019-rig-only-entry.goal).
create table if not exists tunnel_rig (
  rig text primary key,
  pod text,
  url text,
  port integer not null,
  prefix_sealed text not null,
  box_private_sealed text not null,
  box_public text not null,
  code_sealed text not null,
  code_expires_at text,
  config text not null,
  pod_sign_public text,
  pod_box_public text,
  enrolled_at text,
  last_exchange_at text,
  refused_total integer not null default 0,
  error text,
  created_at text not null,
  created_by text not null
);
-- Rigs the owner launched on a GPU cloud: the pod, what it was launched with, its price, what
-- control has seen it cost so far, and the owner's spend limit and idle stop, if set.
create table if not exists runpod_rig (
  rig text primary key,
  cloud text not null,
  pod text not null,
  active integer not null,
  state text not null,
  created_at text not null,
  created_by text not null
);
-- Test pods control started on a GPU cloud: what was asked, the pod, and what it found.
create table if not exists runpod_test (
  id text primary key,
  cloud text not null,
  active integer not null,
  state text not null,
  created_at text not null,
  created_by text not null
);
-- Rigs control set up on a cluster: where, how, and how it stands.
create table if not exists cluster_rig (
  rig text primary key,
  cluster text not null,
  namespace text not null,
  placement text not null,
  spec text not null,
  status text not null,
  created_at text not null,
  created_by text not null,
  -- A change to its GPUs, CPUs or memory that waits for its drain (JSON); null: none.
  pending text
);
-- Rigs control set up on a machine: where, on which GPUs, with which images, and how it stands.
create table if not exists machine_rig (
  rig text primary key,
  machine text not null,
  gpus text not null default '[]',
  images text not null,
  root integer not null default 0,
  status text not null,
  created_at text not null,
  created_by text not null
);
-- Each step of setting a rig up or managing it, for the rig's history: what, whether it worked.
create table if not exists rig_setup_event (
  id integer primary key,
  rig text not null,
  at text not null,
  step text not null,
  ok integer not null,
  detail text
);
-- Campaigns created on control (the new-campaign page): each version's contract as approved,
-- with its content hash. Runs are assigned from a version.
create table if not exists campaign_version (
  campaign text not null,
  version integer not null,
  contract text not null,
  sha text not null,
  -- Where its runs fetch the project and the kit from (URLs and Git access names, no secrets).
  sources text not null default '{}',
  created_at text not null,
  created_by text not null,
  approved_by text,
  -- A copy's source (goal 069): {campaign, version} or {campaign, rig, run}; null otherwise.
  copied_from text,
  primary key (campaign, version)
);
-- Exports a rig's supervisor sent to control because the rig has no results repository: each
-- export's manifest, the files it sends with their sizes and SHA-256 (from the manifest), which
-- of them arrived and matched, and when the last one did. The files are on disk (exports.ts).
create table if not exists rig_export (
  rig text not null,
  name text not null,
  manifest text not null,
  files text not null,
  done text not null default '[]',
  bytes integer not null,
  full integer not null default 0,
  from_event integer not null,
  through_event integer not null,
  created_at text not null,
  complete_at text,
  primary key (rig, name)
);
-- The agents' model usage (goal 075): each model_call event a rig reported, as its columns, kept
-- with the event's key (a ledger a rig left keeps its records), and its run's campaign from the
-- rig's run_created event. What the usage sums read. A figure the harness did not report is null.
create table if not exists model_call (
  rig text not null,
  ledger_id text not null,
  event_id integer not null,
  run text not null,
  campaign text,
  trial text,
  round text,
  agent text not null,
  harness text not null,
  provider text,
  model text not null,
  calls integer,
  at text not null,
  tokens_in integer not null,
  cached_in integer,
  tokens_out integer not null,
  reasoning integer,
  first_token_ms integer,
  call_ms integer,
  primary key (rig, ledger_id, event_id)
);
-- A model's price the owner set (goal 075), in US dollars per million tokens, for a provider's
-- model whose list gives none. cached_input null: the input price.
create table if not exists model_price (
  provider text not null,
  model text not null,
  input real not null,
  cached_input real,
  output real not null,
  set_by text not null,
  set_at text not null,
  primary key (provider, model)
);
-- A GPU cloud pod's spend as control counts it while it follows the pod (goal 075): each count's
-- spend since the one before, with the run its rig was running then (null: none) and that run's
-- campaign. A spend counted while the rig ran two runs is split evenly between them.
create table if not exists pod_spend (
  id integer primary key autoincrement,
  rig text not null,
  run text,
  campaign text,
  at text not null,
  usd real not null
);
-- Folders for campaigns in the dashboard's left navigation (goal 077): a name the owner gives,
-- unique whatever its case. They group campaigns there and nowhere else: they are not the
-- campaigns' folders in the knowledge base.
create table if not exists campaign_folder (
  id integer primary key autoincrement,
  name text not null unique collate nocase,
  created_at text not null,
  created_by text not null
);
-- The folder a campaign shows in (goal 077). A campaign in no folder has no row.
create table if not exists campaign_in_folder (
  campaign text primary key,
  folder integer not null references campaign_folder (id)
);
-- Archived campaigns (goal 077): out of the left navigation, Needs you and the Overview's
-- lists. Their runs, results and kits stay; unarchiving removes the row.
create table if not exists campaign_archived (
  campaign text primary key,
  archived_at text not null,
  archived_by text not null
);
create index if not exists pod_spend_run on pod_spend (run, at);
create index if not exists pod_spend_campaign on pod_spend (campaign, at);
create index if not exists model_call_run on model_call (run, at);
create index if not exists model_call_campaign on model_call (campaign, at);
create index if not exists model_call_at on model_call (at);
create index if not exists rig_live_rig on rig_live (rig, id);
create index if not exists rig_live_source on rig_live (rig, source, id);
-- A stuck trial the owner left running from its Needs you card (goal 143): by trial and kind
-- (quiet or repeating), since when it was stuck then. A new quiet spell or streak asks again.
create table if not exists trial_left (
  rig text not null,
  trial text not null,
  kind text not null,
  since text not null,
  at text not null,
  by text not null,
  primary key (rig, trial, kind)
);
`;

/**
 * The schema as v0.1.0 left it: the tables, and the steps that brought older stores to them. Each
 * step checks before it changes anything, so it is safe on a store of any age before versions.
 */
function schemaOne(db: DatabaseSync): void {
  renameUnitsToRigs(db);
  // The first table of rigs in pull mode (2026-10-19) had no launch port and needed its pod
  // up front; nothing launched one. An empty one makes way, a filled one is kept aside.
  const tunnelCols = (db.prepare("pragma table_info(tunnel_rig)").all() as Row[]).map(
    (r) => r.name,
  );
  if (tunnelCols.length && !tunnelCols.includes("port")) {
    const n = db.prepare("select count(*) as n from tunnel_rig").get() as Row;
    db.exec(
      Number(n.n)
        ? "alter table tunnel_rig rename to tunnel_rig_2026_10_19"
        : "drop table tunnel_rig",
    );
  }
  db.exec(SCHEMA);
  const cols = (db.prepare("pragma table_info(rig)").all() as Row[]).map((r) => r.name);
  if (!cols.includes("pubkey")) db.exec("alter table rig add column pubkey text");
  if (!cols.includes("pending_pubkey")) db.exec("alter table rig add column pending_pubkey text");
  if (!cols.includes("report_at")) db.exec("alter table rig add column report_at text");
  migrateModelRoutes(db);
  const versionCols = (db.prepare("pragma table_info(campaign_version)").all() as Row[]).map(
    (r) => r.name,
  );
  if (!versionCols.includes("sources"))
    db.exec("alter table campaign_version add column sources text not null default '{}'");
  if (!versionCols.includes("copied_from"))
    db.exec("alter table campaign_version add column copied_from text");
  const rigModelCols = (db.prepare("pragma table_info(rig_model)").all() as Row[]).map(
    (r) => r.name,
  );
  if (!rigModelCols.includes("harness"))
    db.exec("alter table rig_model add column harness text not null default 'pi'");
  if (!rigModelCols.includes("effort")) db.exec("alter table rig_model add column effort text");
  if (!rigModelCols.includes("context_cap"))
    db.exec("alter table rig_model add column context_cap integer");
  if (!rigModelCols.includes("compact_at"))
    db.exec("alter table rig_model add column compact_at integer");
  // Each agent's own harness (goal 073); null: what its model needs.
  const roleModelCols = (db.prepare("pragma table_info(rig_role_model)").all() as Row[]).map(
    (r) => r.name,
  );
  if (!roleModelCols.includes("harness"))
    db.exec("alter table rig_role_model add column harness text");
  // Every agent's own cap and compaction point (goal 070), as the workers' are kept above.
  if (!roleModelCols.includes("context_cap"))
    db.exec("alter table rig_role_model add column context_cap integer");
  if (!roleModelCols.includes("compact_at"))
    db.exec("alter table rig_role_model add column compact_at integer");
  renameAgentRoles(db);
  const machineRigCols = (db.prepare("pragma table_info(machine_rig)").all() as Row[]).map(
    (r) => r.name,
  );
  if (!machineRigCols.includes("judge_gpus"))
    db.exec("alter table machine_rig add column judge_gpus integer");
  const clusterRigCols = (db.prepare("pragma table_info(cluster_rig)").all() as Row[]).map(
    (r) => r.name,
  );
  if (!clusterRigCols.includes("pending"))
    db.exec("alter table cluster_rig add column pending text");
  const refusalCols = (db.prepare("pragma table_info(rig_refusal)").all() as Row[]).map(
    (r) => r.name,
  );
  if (!refusalCols.includes("calls")) {
    db.exec("alter table rig_refusal add column calls integer not null default 0");
    db.exec("alter table rig_refusal add column last_at text");
  }
  if (!cols.includes("supervisor")) {
    db.exec("alter table rig add column supervisor text");
    db.exec("alter table rig add column supervisor_at text");
  }
}

/**
 * The updates to control's version under way (goal 165): their step and the runs they paused, so
 * that a control restarted in the middle of one ends it and resumes those runs.
 */
function schemaTwo(db: DatabaseSync): void {
  db.exec(`create table if not exists rig_update (
  rig text primary key,
  phase text not null,
  paused text not null default '[]',
  requested_by text not null,
  started_at text not null,
  updated_at text not null
)`);
}

/**
 * Run names used once on control (goal 170): an index to find a run's name on any rig, and a
 * champion's patch kept by ledger, so a run of the same name in another ledger (before a full
 * reset) never stands in for it. A row kept before takes the ledger of the event it matches.
 */
function schemaThree(db: DatabaseSync): void {
  db.exec("create index if not exists rig_event_subject on rig_event (kind, subject)");
  db.exec(`create table champion_patch_170 (
  rig text not null,
  ledger_id text not null,
  run text not null,
  seq integer not null,
  sha256 text not null,
  base_commit text not null,
  patch blob not null,
  received_at text not null,
  primary key (rig, ledger_id, run, seq)
)`);
  db.exec(`insert or ignore into champion_patch_170
  select c.rig, coalesce((select e.ledger_id from rig_event e
      where e.rig = c.rig and e.kind = 'champion_published' and e.subject = c.run
        and json_extract(e.body, '$.seq') = c.seq and json_extract(e.body, '$.sha256') = c.sha256
      order by e.seq desc limit 1), ''),
    c.run, c.seq, c.sha256, c.base_commit, c.patch, c.received_at
  from champion_patch c`);
  db.exec("drop table champion_patch");
  db.exec("alter table champion_patch_170 rename to champion_patch");
}

/**
 * The agents' public names in every row control keeps (goal 125, T1): the merged by model was
 * `combiner` and the review panel `panel` in the model usage of v0.1.0. The rigs' events keep
 * their words; core/names.ts reads them under these.
 */
function schemaFour(db: DatabaseSync): void {
  db.exec(`update model_call set agent = case agent when 'combiner' then 'merged_by'
  else 'review_panel' end where agent in ('combiner', 'panel')`);
}

/**
 * Each event's run as the rig's ledger recorded it (goal 170), for the views by run. Events
 * received before keep none: their readers work their run out as before.
 */
function schemaFive(db: DatabaseSync): void {
  const columns = db.prepare("pragma table_info(rig_event)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "run")) db.exec("alter table rig_event add column run text");
  db.exec("create index if not exists rig_event_run on rig_event (run, seq)");
}

/**
 * Control's migrations, in order: the store's schema version is how many have run. A change to
 * the schema is a new function at the end, never an edit of one that has run.
 */
const STORE_MIGRATIONS: readonly ((db: DatabaseSync) => void)[] = [
  schemaOne,
  schemaTwo,
  schemaThree,
  schemaFour,
  schemaFive,
  // Control's run registry (goal 170), with its rows from what the store already holds.
  runRegistryTable,
  // The message bus's keys (goal 168): each rig's registered key, and control's own, sealed.
  busKeyTables,
  // A rig's events by ledger in control's order, for the views' pages (goal 168).
  eventsInOrderIndex,
  // The key control seals a rig's config to on the message bus, beside its user key (goal 168).
  busSealKeyColumn,
  // The synthesizer's and the final writer's own models (goal 166).
  synthesizerAndWriterSlots,
  // How far the store applied the events stream, and each rig ledger's held cursor (goal 168).
  appliedPlacesTables,
  // Control's events table goes, once the events stream holds it whole (EVENTS_TABLE_GOES).
  dropEventsTable,
  // The run and the campaign each command names, in columns of their own (goal 168).
  commandRunAndCampaign,
  // The knowledge base's hierarchy: a collection for each campaign, slots, versions (goal 175).
  knowledgeHierarchy,
  // Each Git access bound to the host it is for.
  gitAccessHost,
  // The changes the operator proposes to a campaign's settings, for the owner to approve.
  campaignProposalTable,
  // The knowledge base's words index anew: passages, each item's outcome and context (goal 175).
  knowledgeSearch,
  // The operator may propose a grant of another campaign's collection too.
  campaignProposalGrants,
  // A refusal that repeats is one audit entry, with its count and its first and last time.
  auditRepeats,
];

/**
 * The migration that drops control's events table (goal 168). It waits until the move of the
 * table's rows to the events stream has checked them there (control/events/move.ts), which needs
 * the bus, and so runs after the store is open: control then migrates again, given what the move
 * found (ControlStore.migrate). The migrations after it wait with it. The copy before it is kept
 * outside the copies' rotation, until the owner removes it: it is the last copy of the table.
 */
const EVENTS_TABLE_GOES = 12;

/** What control gives a migration that waits for what it does outside the store. */
export interface MigrateGiven {
  /** The move's check of the events stream against control's events table. */
  eventsMoved?: EventsMoved | undefined;
}

/**
 * Brings the store to this code's schema, as far as it may go now (EVENTS_TABLE_GOES). A store
 * with tables in it is copied first (goal 173), so an update that migrates can be undone; a store
 * newer than this code is refused, with the copy to restore. Returns the path of a copy kept
 * outside the rotation, made now.
 */
export function migrateStore(
  db: DatabaseSync,
  path: string,
  given: MigrateGiven = {},
): string | undefined {
  // Read before anything is created, so the copy below is the store exactly as it was.
  const versioned = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'schema_migrations'")
    .get();
  const row = versioned
    ? (db.prepare("select max(version) as v from schema_migrations").get() as { v: number | null })
    : undefined;
  const current = row?.v ?? 0;
  const known = STORE_MIGRATIONS.length;
  if (current > known) throw new Error(newerSchemaWords("control store", path, current, known));
  const waits = current < EVENTS_TABLE_GOES && !eventsTableMayGo(db, given.eventsMoved);
  const to = waits ? EVENTS_TABLE_GOES - 1 : known;
  if (current >= to) return undefined;
  const tables = db
    .prepare(
      "select count(*) as n from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != 'schema_migrations'",
    )
    .get() as { n: number };
  let kept: string | undefined;
  if (path !== ":memory:" && tables.n > 0) {
    if (to >= EVENTS_TABLE_GOES && eventsTableHoldsRows(db))
      kept = keepCopyBefore(db, path, current, to, "the last copy of control's events table");
    else copyBeforeMigration(db, path, current, to);
  }
  db.exec("create table if not exists schema_migrations (version integer primary key)");
  // Each migration in a transaction of its own, as the ledger's: all of it, or none.
  for (let version = current + 1; version <= to; version++)
    transaction(db, () => {
      STORE_MIGRATIONS[version - 1]?.(db);
      db.prepare("insert into schema_migrations (version) values (?)").run(version);
    });
  return kept;
}
