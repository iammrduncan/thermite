/**
 * Migrations 2 to 9, in order. They were written before the owner's names of 2026-10-15, so their
 * statements name a run `instance` and a rig `unit`; migration 10 renames them.
 */
export const BEFORE_THE_RENAME: readonly string[] = [
  // 2: the judge (M2). Measurements name the arm they belong to. Held-out results live in their
  // own table, which never appears in events, snapshots or exports: only promotion reads it.
  `
  alter table measurement add column arm text not null default 'candidate';
  create index measurement_job on measurement (job, fence);

  create table held_out (
    id integer primary key autoincrement,
    job integer not null references job (id),
    fence integer not null,
    attempt text not null references attempt (id),
    pass integer not null,
    detail text not null,
    created_at text not null
  );
  create trigger held_out_no_update before update on held_out begin select raise(abort, 'held_out is append-only'); end;
  create trigger held_out_no_delete before delete on held_out begin select raise(abort, 'held_out is append-only'); end;

  create table build (
    key text primary key,
    repo text not null,
    commit_sha text not null,
    kit_commit text not null,
    ok integer not null,
    manifest text not null,
    created_at text not null
  );
  `,
  // 3: agents (M4). The direction registry, planner epochs and worker trials. The family check
  // names `blocked`, which nothing sets (a family is live or exhausted): it stays as written, as
  // every migration that has run does, and old ledgers keep it.
  `
  create table family (
    instance text not null,
    id text not null,
    description text not null,
    status text not null default 'live' check (status in ('live', 'blocked', 'exhausted')),
    created_by text not null,
    created_at text not null,
    primary key (instance, id)
  );
  create table epoch (
    instance text not null,
    n integer not null,
    source text not null check (source in ('planner', 'fallback')),
    planner_tries integer not null,
    planner_valid integer not null,
    raw_violations text not null default '[]',
    assignments text not null,
    notes text,
    started_at text not null,
    ended_at text,
    primary key (instance, n)
  );
  create table trial (
    id text primary key,
    instance text not null,
    lane text not null,
    epoch integer not null,
    family text,
    parent_commit text not null,
    attempt text,
    stopped text,
    turns integer,
    tool_calls integer,
    tokens_in integer,
    tokens_out integer,
    error text,
    started_at text not null,
    ended_at text
  );
  create index trial_lane on trial (instance, lane, epoch);
  alter table attempt add column family text;
  `,
  // 4: goal checks record "inconclusive" (a threshold whose interval straddles the bar) honestly.
  // goal_check never held rows before this version, so it is recreated.
  `
  drop table goal_check;
  create table goal_check (
    id integer primary key autoincrement,
    instance text not null,
    goal text not null,
    attempt text,
    job integer not null,
    commit_sha text not null,
    result text not null check (result in ('met', 'unmet', 'inconclusive', 'not_runnable')),
    detail text not null,
    created_at text not null
  );
  create index goal_check_instance on goal_check (instance, goal);
  create trigger goal_check_no_update before update on goal_check begin select raise(abort, 'goal_check is append-only'); end;
  create trigger goal_check_no_delete before delete on goal_check begin select raise(abort, 'goal_check is append-only'); end;
  `,
  // 5: research mode (M4). The tables from version 1 were never used; they are rebuilt with what
  // the fetcher, the claim check and the report need.
  `
  drop table source;
  drop table claim;
  drop table hypothesis;
  drop table report_version;
  drop table research_task;
  create table source (
    id text primary key,
    instance text not null,
    url text not null,
    final_url text not null,
    domain text not null,
    fetched_at text not null,
    http_status integer not null,
    content_type text,
    bytes integer not null,
    sha256 text not null,
    title text,
    raw_path text not null,
    text_path text not null,
    fetched_by text not null
  );
  create unique index source_url on source (instance, url);
  create index source_sha on source (instance, sha256);
  create table claim (
    id text primary key,
    instance text not null,
    lane text,
    question integer,
    text text not null,
    quotes text not null,
    verified integer not null,
    problems text not null default '[]',
    confidence real,
    created_at text not null
  );
  create table note (
    id integer primary key autoincrement,
    instance text not null,
    lane text,
    text text not null,
    sources text not null default '[]',
    created_at text not null
  );
  create table hypothesis (
    id text primary key,
    instance text not null,
    lane text,
    text text not null,
    supporting text not null default '[]',
    contradicting text not null default '[]',
    created_at text not null
  );
  create table report_section (
    instance text not null,
    name text not null,
    body text not null,
    updated_by text not null,
    updated_at text not null,
    primary key (instance, name)
  );
  create table report_version (
    id integer primary key autoincrement,
    instance text not null,
    kind text not null check (kind in ('digest', 'final')),
    body text not null,
    created_at text not null
  );
  create table research_query (
    id integer primary key autoincrement,
    instance text not null,
    lane text,
    query text not null,
    allowed integer not null,
    reason text,
    created_at text not null
  );
  `,
  // 6: M4 review fixes. Each trial gets its own token (stored hashed), which binds API calls to
  // the trial's instance and lane and stops working when the trial ends. Jobs record when they
  // were leased, for the device-hours budget.
  `
  alter table trial add column token_sha text;
  create index trial_token on trial (token_sha);
  alter table job add column leased_at text;
  `,
  // 7: M5. Directive sets replace their author's previous set; epochs record the directives in
  // force. Audits (an audit can block, never pass), propagated candidates, the subjective-goal
  // review panel and "not possible" proposals. Decisions are written once.
  `
  alter table directive add column superseded_at text;
  alter table epoch add column directives text not null default '[]';
  alter table attempt add column flaws_cleared_by text;

  -- One audit per confirmation of an attempt: if the champion moves while a result waits and the
  -- attempt is confirmed again, it gets a new audit against the new champion.
  create table audit (
    id integer primary key autoincrement,
    attempt text not null references attempt (id),
    confirm_job integer not null,
    instance text not null,
    trigger text not null check (trigger in ('absolute', 'ratio', 'known_flaws', 'adversarial_checklist')),
    reason text not null,
    expected_seq integer,
    requested_at text not null,
    decision text check (decision in ('clear', 'block', 'needs_owner')),
    reasons text,
    citations text,
    auditor text,
    decided_at text
  );
  create unique index audit_attempt_job on audit (attempt, confirm_job);
  create trigger audit_decided_once before update on audit
    when old.decision is not null begin select raise(abort, 'audit decision is final'); end;
  create trigger audit_no_delete before delete on audit begin select raise(abort, 'audit is append-only'); end;

  create table propagation (
    attempt text primary key references attempt (id),
    instance text not null,
    source_unit text not null,
    source_instance text not null,
    source_seq integer not null,
    tree text not null,
    created_at text not null,
    result text,
    decided_at text
  );

  create table review (
    id integer primary key autoincrement,
    instance text not null,
    goal text not null,
    attempt text,
    commit_sha text not null,
    package text not null,
    requested_at text not null,
    panel text,
    panel_result text check (panel_result in ('review_passed', 'review_failed')),
    panel_at text,
    owner_decision text check (owner_decision in ('accepted', 'rejected')),
    owner_note text,
    owner_at text
  );
  create unique index review_goal_commit on review (instance, goal, commit_sha);

  create table conclusion (
    id integer primary key autoincrement,
    instance text not null,
    kind text not null check (kind in ('not_possible')),
    evidence text not null,
    proposed_at text not null,
    decision text check (decision in ('accepted', 'rejected')),
    note text,
    decided_at text
  );
  `,
  // 8: an instance may run with its worker agents off (a judge-only run, such as a kit's dry
  // run on the unmodified project): the judge calibrates, validates and judges submissions.
  `
  alter table instance add column agents integer not null default 1;
  `,
  // 9: the owner's messages to agent sessions (message_agent), kept until delivered.
  `
  create table agent_message (
    id integer primary key autoincrement,
    instance text not null,
    target text not null,
    text text not null,
    issued_by text not null,
    created_at text not null,
    delivered_at text,
    delivered_to text
  );
  create index agent_message_pending on agent_message (instance, target) where delivered_at is null;
  `,
];
