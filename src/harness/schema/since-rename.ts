import type { DatabaseSync } from "node:sqlite";

/**
 * Migrations 10 to 21, in order: the owner's names of 2026-10-15 (an instance is a run, a unit is
 * a rig), and the migrations since, which use them.
 */
export const SINCE_THE_RENAME: readonly (string | ((db: DatabaseSync) => void))[] = [
  // 10: the owner's names (2026-10-15): an instance is a run, a unit is a rig. Every column
  // named instance (or source_instance) becomes run (source_run), source_unit becomes
  // source_rig, the instance table becomes run (indexes, triggers and references follow), and
  // job specs name their run. Events are append-only and keep the names they were recorded
  // with; readers see them under the new names (core/names.ts).
  (db) => {
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const cols = db.prepare(`pragma table_info(${name})`).all() as { name: string }[];
      for (const c of cols) {
        if (c.name === "instance") db.exec(`alter table ${name} rename column instance to run`);
        if (c.name === "source_instance")
          db.exec(`alter table ${name} rename column source_instance to source_run`);
        // measurement.unit is a metric's unit and keeps its name.
        if (c.name === "source_unit")
          db.exec(`alter table ${name} rename column source_unit to source_rig`);
      }
    }
    if (tables.some((t) => t.name === "instance")) db.exec("alter table instance rename to run");
    db.exec(
      "update job set spec = json_set(json_remove(spec, '$.instance'), '$.run', json_extract(spec, '$.instance')) where json_extract(spec, '$.instance') is not null",
    );
  },
  // 11: a run's own promotion policy, chosen when it is assigned (null: the rig's default).
  `
  alter table run add column promotion text check (promotion in ('auto', 'owner_approval'));
  `,
  // 12: research findings (a worker's conclusion, checked against verified claims) and the
  // record of the files each lane wrote in its research folder.
  `
  create table finding (
    id text primary key,
    run text not null,
    lane text,
    text text not null,
    summary text not null,
    why_it_matters text not null,
    supporting text not null default '[]',
    supported integer not null,
    problems text not null default '[]',
    created_at text not null
  );
  create table research_file (
    id integer primary key autoincrement,
    run text not null,
    lane text not null,
    trial text,
    path text not null,
    change text not null check (change in ('written', 'removed')),
    bytes integer,
    sha256 text,
    recorded_at text not null
  );
  create index research_file_run on research_file (run, lane, path);
  `,
  // 13: the owner's messages get read receipts and can be kept in force. A message can be read by
  // several readers (each lane, the planner, the teachers, the auditor, the review panel); a
  // message kept in force goes into every new trial's brief until it is unkept. Deliveries made
  // before this version become reads by the trial's lane (or the planner) at the time they
  // were made, and messages to the advisors become reads by each advisor role; nothing else is
  // assumed read.
  (db) => {
    db.exec(`
      alter table agent_message add column keep integer not null default 0;
      alter table agent_message add column unkept_at text;
      create table agent_message_read (
        id integer primary key autoincrement,
        message integer not null references agent_message (id),
        reader text not null,
        trial text,
        read_at text not null
      );
      create index agent_message_read_by on agent_message_read (message, reader);
    `);
    const delivered = db
      .prepare(
        "select id, target, delivered_at, delivered_to from agent_message where delivered_at is not null",
      )
      .all() as { id: number; target: string; delivered_at: string; delivered_to: string | null }[];
    const laneOf = db.prepare("select lane from trial where id = ?");
    const insert = db.prepare(
      "insert into agent_message_read (message, reader, trial, read_at) values (?, ?, ?, ?)",
    );
    for (const m of delivered) {
      const to = m.delivered_to ?? "";
      if (to === "planner") {
        insert.run(m.id, "planner", null, m.delivered_at);
        continue;
      }
      const trial = to.startsWith("trial:") ? to.slice("trial:".length) : null;
      const lane =
        (trial ? (laneOf.get(trial) as { lane: string } | undefined)?.lane : undefined) ??
        (m.target.startsWith("lane-") ? m.target : undefined);
      if (lane) insert.run(m.id, lane, trial, m.delivered_at);
    }
    // Messages to the advisors were shown in their briefs for a day under the earlier rules and
    // never marked: each advisor role has read them, so none is given again after the upgrade.
    const advisors = db
      .prepare("select id, created_at from agent_message where target = 'advisors'")
      .all() as { id: number; created_at: string }[];
    for (const m of advisors)
      for (const role of ["teachers", "auditor", "panel"])
        insert.run(m.id, role, null, m.created_at);
  },
  // 14: each run's experiment queue (goal 064): what to try, who added it and why, its state,
  // its place among the queued ones (0 first; null once it left the order or before it was
  // queued), and what became of it: the lane and trial that took it, the attempt and result, or
  // why it was dropped. Every change to a row is written with its event, in one transaction.
  `
  create table experiment (
    id text primary key,
    run text not null,
    title text not null,
    details text not null default '',
    family text not null default '',
    why text not null default '',
    added_by text not null,
    state text not null check (state in ('proposed', 'queued', 'assigned', 'done', 'dropped')),
    place integer,
    lane text,
    trial text,
    attempt text,
    result text,
    dropped_by text,
    dropped_why text,
    from_run text,
    from_id text,
    created_at text not null,
    updated_at text not null
  );
  create index experiment_run on experiment (run, state, place);
  create index experiment_trial on experiment (trial);
  `,
  // 15: field notes (goal 065): what the workers, the planner and the advisors write down as they
  // work, each with its kind, who wrote it and what it is about. Notes are append-only: no agent
  // edits or deletes one. Each run also keeps the background the owner picked from past research
  // when starting it, in order, with where each item came from.
  `
  create table journal_note (
    id integer primary key autoincrement,
    run text not null,
    by text not null,
    kind text not null
      check (kind in ('observation', 'decision', 'surprise', 'question', 'lesson', 'note')),
    text text not null check (length(text) between 1 and 2000),
    about_type text
      check (about_type in ('experiment', 'attempt', 'source', 'claim', 'finding', 'round', 'trial', 'message')),
    about_id text,
    lane text,
    trial text,
    at text not null,
    check ((about_type is null) = (about_id is null))
  );
  create index journal_note_run on journal_note (run, id);
  create index journal_note_lane on journal_note (run, lane, id);
  create trigger journal_note_no_update before update on journal_note begin select raise(abort, 'field notes are append-only'); end;
  create trigger journal_note_no_delete before delete on journal_note begin select raise(abort, 'field notes are append-only'); end;

  create table run_briefing (
    run text not null references run (id),
    seq integer not null,
    text text not null,
    from_campaign text not null,
    from_run text not null,
    from_kind text not null,
    from_ref text not null,
    primary key (run, seq)
  );
  create trigger run_briefing_no_update before update on run_briefing begin select raise(abort, 'a run''s briefing is fixed'); end;
  create trigger run_briefing_no_delete before delete on run_briefing begin select raise(abort, 'a run''s briefing is fixed'); end;
  `,
  // 16: every field note says what it is about. A note whose writer named nothing is about its
  // run (about_type 'run', about_id the run's id): the notes kept before say so too, and none
  // leaves it empty any more. The table is copied whole into its new form; no note is lost.
  `
  create table journal_note_v16 (
    id integer primary key autoincrement,
    run text not null,
    by text not null,
    kind text not null
      check (kind in ('observation', 'decision', 'surprise', 'question', 'lesson', 'note')),
    text text not null check (length(text) between 1 and 2000),
    about_type text not null
      check (about_type in ('run', 'experiment', 'attempt', 'source', 'claim', 'finding', 'round', 'trial', 'message')),
    about_id text not null,
    lane text,
    trial text,
    at text not null
  );
  insert into journal_note_v16 (id, run, by, kind, text, about_type, about_id, lane, trial, at)
    select id, run, by, kind, text, coalesce(about_type, 'run'), coalesce(about_id, run), lane, trial, at
    from journal_note order by id;
  drop table journal_note;
  alter table journal_note_v16 rename to journal_note;
  create index journal_note_run on journal_note (run, id);
  create index journal_note_lane on journal_note (run, lane, id);
  create trigger journal_note_no_update before update on journal_note begin select raise(abort, 'field notes are append-only'); end;
  create trigger journal_note_no_delete before delete on journal_note begin select raise(abort, 'field notes are append-only'); end;
  `,
  // 17: model usage (goal 075) is one model_call event for each call, many more events than
  // before: the reads of one kind of event (a run's newest of a kind, the knowledge base's part)
  // use an index instead of reading every event.
  `
  create index event_kind on event (kind, subject);
  `,
  // 18: an experiment whose trial never really tried it (the provider failed, the harness
  // restarted, the run was paused) goes back to the queue as the same row (goal 079): how many
  // times it came back, and why. A tried experiment keeps why its trial ended (its cause).
  `
  alter table experiment add column cause text;
  alter table experiment add column returns integer not null default 0;
  `,
  // 19: what a run asks the owner about (goal 079): hands-off by default, each switch asks.
  `
  alter table run add column ask_owner text;
  `,
  // 20: a goal run's champion has held-out records of its own (goal 086): the confirming
  // validation of a champion that met every required goal runs its held-out cells too. Such a
  // record names its run and champion and no attempt (the seed has none), so an attempt's own
  // records are never mixed with it. SQLite cannot drop a column's NOT NULL, so the table is
  // rebuilt: every row and id is kept, and it stays append-only.
  `
  create table held_out_v20 (
    id integer primary key autoincrement,
    job integer not null references job (id),
    fence integer not null,
    attempt text references attempt (id),
    run text,
    champion_seq integer,
    pass integer not null,
    detail text not null,
    created_at text not null,
    check (attempt is not null or (run is not null and champion_seq is not null))
  );
  insert into held_out_v20 (id, job, fence, attempt, pass, detail, created_at)
    select id, job, fence, attempt, pass, detail, created_at from held_out order by id;
  drop table held_out;
  alter table held_out_v20 rename to held_out;
  create trigger held_out_no_update before update on held_out begin select raise(abort, 'held_out is append-only'); end;
  create trigger held_out_no_delete before delete on held_out begin select raise(abort, 'held_out is append-only'); end;
  `,
  // 21: research that answers its questions (goal 117). A hypothesis has a question, a status
  // (the author's, the workers' pool, promoted by the owner or the plan, merged into another, or
  // retired) and can be revised; the brief's hypotheses, those with no lane, are the author's.
  // Each question has an answer card, kept as versions (the newest is the card). Each reviewer's
  // answer per item of a review, and the panel's decision per item, are kept; a decision stands
  // until a newer card. A research task names its question and records what its trial added.
  `
  alter table hypothesis add column question integer;
  alter table hypothesis add column status text not null default 'pool'
    check (status in ('author', 'pool', 'promoted', 'merged', 'retired'));
  alter table hypothesis add column merged_into text;
  alter table hypothesis add column updated_at text;
  update hypothesis set status = 'author' where lane is null;
  update hypothesis set updated_at = created_at;
  create table question_card (
    run text not null,
    question integer not null,
    version integer not null,
    answer text not null,
    certainty text not null check (certainty in ('high', 'moderate', 'low', 'insufficient', 'none')),
    claims text not null default '[]',
    gaps text not null default '[]',
    by text not null,
    created_at text not null,
    primary key (run, question, version)
  );
  create trigger question_card_no_update before update on question_card begin select raise(abort, 'question_card is append-only'); end;
  create trigger question_card_no_delete before delete on question_card begin select raise(abort, 'question_card is append-only'); end;
  create table review_item (
    id integer primary key autoincrement,
    review integer not null references review (id),
    reviewer text not null,
    kind text not null check (kind in ('question', 'hypothesis')),
    key text not null,
    card_version integer,
    verdict text not null,
    certainty text,
    reasons text not null default '',
    claims text not null default '[]',
    problems text not null default '[]',
    created_at text not null
  );
  create index review_item_review on review_item (review, kind, key);
  create table item_decision (
    id integer primary key autoincrement,
    run text not null,
    kind text not null check (kind in ('question', 'hypothesis')),
    key text not null,
    review integer not null references review (id),
    card_version integer,
    decision text not null,
    certainty text,
    dissent text not null default '[]',
    decided_at text not null
  );
  create index item_decision_run on item_decision (run, kind, key, id);
  create trigger item_decision_no_update before update on item_decision begin select raise(abort, 'item_decision is append-only'); end;
  create trigger item_decision_no_delete before delete on item_decision begin select raise(abort, 'item_decision is append-only'); end;
  alter table experiment add column question integer;
  alter table experiment add column yield text;
  `,
];
