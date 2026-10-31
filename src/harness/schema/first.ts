/**
 * Migration 1: the ledger's first tables. Their statements name a run `instance`, as the ledger
 * did until migration 10. The goal table's check names the status `blocked`, which nothing sets
 * (a goal's status follows its checks, ledger/goals.ts): it stays as written, as every migration
 * that has run does, and old ledgers keep it.
 */
export const FIRST_TABLES = `
  create table meta (key text primary key, value text not null);

  create table contract (
    campaign text not null,
    version integer not null,
    sha text not null,
    mode text not null,
    body text not null,
    created_at text not null,
    primary key (campaign, version)
  );

  create table instance (
    id text primary key,
    campaign text not null,
    version integer not null,
    contract_sha text not null,
    mode text not null,
    seed_repo text not null,
    seed_commit text not null,
    direction text,
    status text not null check (status in ('running', 'paused', 'closed')),
    pause_reason text,
    created_at text not null,
    updated_at text not null,
    foreign key (campaign, version) references contract (campaign, version)
  );

  create table champion (
    instance text not null references instance (id),
    seq integer not null,
    attempt text,
    commit_sha text not null,
    promoted_by text not null,
    promoted_at text not null,
    reopened integer not null default 0,
    primary key (instance, seq)
  );

  create table lane (
    id text primary key,
    instance text not null references instance (id),
    family text,
    status text not null default 'active',
    lane_best_attempt text,
    created_at text not null
  );

  create table attempt (
    id text primary key,
    instance text not null references instance (id),
    lane text,
    origin text not null default 'local',
    parent_ref text not null,
    parent_commit text not null,
    -- The attempt whose commit this one was built on, when there is one (lineage for invalidation).
    parent_attempt text references attempt (id),
    baseline_champion_seq integer,
    commit_sha text not null,
    ref text not null,
    diff_sha text not null,
    normalized_diff_sha text not null,
    lifecycle text not null,
    hypothesis text,
    claim text,
    known_flaws text not null default '[]',
    v0 text,
    -- Set when the attempt itself, or an attempt it derives from, was invalidated. Permanent.
    invalidated_by integer references invalidation (id),
    created_at text not null,
    updated_at text not null
  );
  create index attempt_instance on attempt (instance);
  create index attempt_parent on attempt (parent_attempt);
  create index attempt_commit on attempt (instance, commit_sha);
  create index attempt_norm on attempt (instance, normalized_diff_sha);

  create table job (
    id integer primary key autoincrement,
    attempt text references attempt (id),
    kind text not null,
    state text not null check (state in ('queued', 'leased', 'done', 'failed', 'blocked', 'cancelled')),
    priority integer not null default 100,
    lease_owner text,
    lease_until text,
    fence integer not null default 0,
    expiries integer not null default 0,
    spec text not null default '{}',
    result text,
    created_at text not null,
    updated_at text not null
  );
  create index job_state on job (state, priority, id);

  create table measurement (
    id integer primary key autoincrement,
    job integer not null references job (id),
    -- The lease that wrote it: only the fence that completed the job counts.
    fence integer not null,
    metric text not null,
    cell text not null,
    rep integer not null,
    value real not null
      check (typeof(value) in ('real', 'integer') and value = value and abs(value) < 1e300),
    unit text not null,
    created_at text not null
  );

  create table receipt (
    id text primary key,
    job integer not null references job (id),
    fence integer not null,
    body text not null,
    created_at text not null
  );

  create table verdict (
    id integer primary key autoincrement,
    attempt text not null references attempt (id),
    verdict text not null,
    delta real,
    ci_low real,
    ci_high real,
    guards text not null default '[]',
    depends_on_jobs text not null default '[]',
    reasons text not null,
    judged_by text not null,
    supersedes integer references verdict (id),
    created_at text not null
  );
  create index verdict_attempt on verdict (attempt);

  create table invalidation (
    id integer primary key autoincrement,
    subject_kind text not null check (subject_kind in ('job', 'attempt')),
    subject_id text not null,
    reason text not null,
    actor text not null,
    created_at text not null
  );

  create table directive (
    id integer primary key autoincrement,
    instance text not null,
    author text not null,
    body text not null,
    status text not null default 'active',
    created_at text not null
  );

  create table command (
    id text primary key,
    kind text not null,
    envelope text not null,
    signature text not null,
    accepted integer not null,
    result text not null,
    received_at text not null
  );

  create table import (
    id integer primary key autoincrement,
    kind text not null,
    name text,
    sha256 text,
    commit_sha text,
    source_path text not null,
    stored_path text not null,
    verified_at text not null
  );

  create table export (
    id integer primary key autoincrement,
    through_event integer not null,
    path text not null,
    manifest text not null,
    created_at text not null
  );

  create table event (
    id integer primary key autoincrement,
    at text not null,
    actor text not null,
    kind text not null,
    subject text,
    body text not null
  );

  create table budget_ledger (
    id integer primary key autoincrement,
    instance text not null,
    resource text not null,
    delta real not null,
    reason text not null,
    at text not null
  );

  create table invocation (
    id text primary key,
    instance text,
    lane text,
    role text not null,
    model text,
    tokens_in integer,
    tokens_out integer,
    cost_usd real,
    submissions integer not null default 0,
    outcome text,
    started_at text not null,
    ended_at text
  );

  -- goal mode
  create table goal (
    instance text not null references instance (id),
    id text not null,
    parent text,
    priority integer not null,
    required integer not null,
    verify text not null,
    status text not null default 'untouched'
      check (status in ('untouched', 'attempted', 'verified', 'blocked', 'unmet', 'not_runnable')),
    primary key (instance, id)
  );
  create table goal_check (
    id integer primary key autoincrement,
    instance text not null,
    goal text not null,
    attempt text,
    result text not null check (result in ('met', 'unmet', 'not_runnable', 'error')),
    detail text,
    receipt text,
    created_at text not null
  );

  -- research mode
  create table source (
    id text primary key,
    instance text not null,
    url text not null,
    fetched_at text not null,
    http_status integer,
    sha256 text not null,
    content_path text not null,
    domain text
  );
  create table claim (
    id text primary key,
    instance text not null,
    text text not null,
    quotes text not null,
    sources text not null,
    verified integer not null default 0,
    confidence real,
    created_at text not null
  );
  create table hypothesis (
    id text primary key,
    instance text not null,
    text text not null,
    status text not null default 'open',
    supporting text not null default '[]',
    contradicting text not null default '[]',
    created_at text not null
  );
  create table report_version (
    id integer primary key autoincrement,
    instance text not null,
    body text not null,
    created_at text not null
  );
  create table research_task (
    id text primary key,
    instance text not null,
    lane text,
    body text not null,
    status text not null default 'open',
    created_at text not null
  );

  create trigger event_no_update before update on event begin select raise(abort, 'event is append-only'); end;
  create trigger event_no_delete before delete on event begin select raise(abort, 'event is append-only'); end;
  create trigger verdict_no_update before update on verdict begin select raise(abort, 'verdict is append-only'); end;
  create trigger verdict_no_delete before delete on verdict begin select raise(abort, 'verdict is append-only'); end;
  create trigger measurement_no_update before update on measurement begin select raise(abort, 'measurement is append-only'); end;
  create trigger measurement_no_delete before delete on measurement begin select raise(abort, 'measurement is append-only'); end;
  create trigger receipt_no_update before update on receipt begin select raise(abort, 'receipt is append-only'); end;
  create trigger receipt_no_delete before delete on receipt begin select raise(abort, 'receipt is append-only'); end;
  create trigger contract_no_update before update on contract begin select raise(abort, 'contract versions are immutable'); end;
  create trigger contract_no_delete before delete on contract begin select raise(abort, 'contract versions are immutable'); end;
  create trigger invalidation_no_update before update on invalidation begin select raise(abort, 'invalidation is append-only'); end;
  create trigger invalidation_no_delete before delete on invalidation begin select raise(abort, 'invalidation is append-only'); end;
  create trigger champion_no_delete before delete on champion begin select raise(abort, 'champion history is append-only'); end;
  `;
