-- A control store as Thermite v0.1.0 wrote it (src/control/store.ts at the v0.1.0 tag), with one
-- campaign folder in it, dumped by sqlite3. tests/control/store-migrations.test.ts migrates it.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE rig (
  id text primary key,
  first_seen text not null,
  last_seen text not null,
  last_cursor integer not null default 0,
  ledger_id text,
  summary text not null default '{}'
, pubkey text, pending_pubkey text, report_at text, supervisor text, supervisor_at text);
CREATE TABLE rig_event (
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
CREATE TABLE command (
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
CREATE TABLE audit (
  id integer primary key autoincrement,
  at text not null,
  actor text not null,
  action text not null,
  body text not null
);
CREATE TABLE rig_ledger (
  rig text not null,
  ledger_id text not null,
  first_seen text not null,
  superseded_at text,
  primary key (rig, ledger_id)
);
CREATE TABLE rig_report (
  id integer primary key autoincrement,
  rig text not null,
  kind text not null,
  body text not null,
  at text not null
);
CREATE TABLE ui_session (
  id_hash text primary key,
  token_fp text not null,
  created_at text not null,
  expires_at integer not null
);
CREATE TABLE reset (
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
CREATE TABLE rig_live (
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
CREATE TABLE champion_patch (
  rig text not null,
  run text not null,
  seq integer not null,
  sha256 text not null,
  base_commit text not null,
  patch blob not null,
  received_at text not null,
  primary key (rig, run, seq)
);
CREATE TABLE model_provider (
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
CREATE TABLE rig_model (
  rig text primary key,
  provider text not null,
  model text not null,
  assigned_at text not null
, harness text not null default 'pi', effort text, context_cap integer, compact_at integer);
CREATE TABLE rig_role_model (
  rig text not null,
  role text not null check (role in ('planner', 'teachers', 'second_teacher', 'merged_by', 'auditor', 'review_panel')),
  provider text not null,
  model text not null,
  effort text,
  assigned_at text not null, harness text, context_cap integer, compact_at integer,
  primary key (rig, role)
);
CREATE TABLE rig_token (
  rig text primary key,
  token_sha256 text not null,
  created_at text not null,
  created_by text not null,
  rotated_at text,
  retired_at text
);
CREATE TABLE git_access (
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
CREATE TABLE machine (
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
CREATE TABLE machine_install (
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
CREATE TABLE cluster (
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
CREATE TABLE joined_rig (
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
CREATE TABLE gpu_cloud (
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
CREATE TABLE rig_retired (
  rig text primary key,
  at text not null,
  by text not null
);
CREATE TABLE rig_build (
  rig text not null,
  component text not null check (component in ('harness', 'supervisor')),
  version text,
  commit_sha text,
  protocol integer,
  oldest_protocol integer,
  since text not null,
  primary key (rig, component)
);
CREATE TABLE rig_refusal (
  rig text primary key,
  reason text not null,
  since text not null,
  calls integer not null default 0,
  last_at text
);
CREATE TABLE control_build (
  version text not null,
  commit_sha text,
  since text not null
);
CREATE TABLE tunnel_rig (
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
CREATE TABLE runpod_rig (
  rig text primary key,
  cloud text not null,
  pod text not null,
  active integer not null,
  state text not null,
  created_at text not null,
  created_by text not null
);
CREATE TABLE runpod_test (
  id text primary key,
  cloud text not null,
  active integer not null,
  state text not null,
  created_at text not null,
  created_by text not null
);
CREATE TABLE cluster_rig (
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
CREATE TABLE machine_rig (
  rig text primary key,
  machine text not null,
  gpus text not null default '[]',
  images text not null,
  root integer not null default 0,
  status text not null,
  created_at text not null,
  created_by text not null
, judge_gpus integer);
CREATE TABLE rig_setup_event (
  id integer primary key,
  rig text not null,
  at text not null,
  step text not null,
  ok integer not null,
  detail text
);
CREATE TABLE campaign_version (
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
CREATE TABLE rig_export (
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
CREATE TABLE model_call (
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
CREATE TABLE model_price (
  provider text not null,
  model text not null,
  input real not null,
  cached_input real,
  output real not null,
  set_by text not null,
  set_at text not null,
  primary key (provider, model)
);
CREATE TABLE pod_spend (
  id integer primary key autoincrement,
  rig text not null,
  run text,
  campaign text,
  at text not null,
  usd real not null
);
CREATE TABLE campaign_folder (
  id integer primary key autoincrement,
  name text not null unique collate nocase,
  created_at text not null,
  created_by text not null
);
INSERT INTO campaign_folder VALUES(1,'speed','2026-10-26T00:00:00.000Z','owner');
CREATE TABLE campaign_in_folder (
  campaign text primary key,
  folder integer not null references campaign_folder (id)
);
CREATE TABLE campaign_archived (
  campaign text primary key,
  archived_at text not null,
  archived_by text not null
);
CREATE TABLE trial_left (
  rig text not null,
  trial text not null,
  kind text not null,
  since text not null,
  at text not null,
  by text not null,
  primary key (rig, trial, kind)
);
INSERT INTO sqlite_sequence VALUES('campaign_folder',1);
CREATE INDEX rig_event_kind on rig_event (rig, kind);
CREATE INDEX command_pending on command (rig, status);
CREATE UNIQUE INDEX rig_live_seq on rig_live (rig, log_id, seq);
CREATE INDEX pod_spend_run on pod_spend (run, at);
CREATE INDEX pod_spend_campaign on pod_spend (campaign, at);
CREATE INDEX model_call_run on model_call (run, at);
CREATE INDEX model_call_campaign on model_call (campaign, at);
CREATE INDEX model_call_at on model_call (at);
CREATE INDEX rig_live_rig on rig_live (rig, id);
CREATE INDEX rig_live_source on rig_live (rig, source, id);
COMMIT;
