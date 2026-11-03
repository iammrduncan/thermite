-- A ledger as Thermite v0.1.0 wrote it (src/harness/ledger.ts at the v0.1.0 tag): a hill climb
-- with its baseline, a win promoted, a wrong change judged invalid, a message to the review panel
-- and a model call by the merged by model, under v0.1.0's names; dumped by sqlite3.
-- tests/harness/ledger/migrations.test.ts migrates it.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE schema_migrations (version integer primary key);
INSERT INTO schema_migrations VALUES(1);
INSERT INTO schema_migrations VALUES(2);
INSERT INTO schema_migrations VALUES(3);
INSERT INTO schema_migrations VALUES(4);
INSERT INTO schema_migrations VALUES(5);
INSERT INTO schema_migrations VALUES(6);
INSERT INTO schema_migrations VALUES(7);
INSERT INTO schema_migrations VALUES(8);
INSERT INTO schema_migrations VALUES(9);
INSERT INTO schema_migrations VALUES(10);
INSERT INTO schema_migrations VALUES(11);
INSERT INTO schema_migrations VALUES(12);
INSERT INTO schema_migrations VALUES(13);
INSERT INTO schema_migrations VALUES(14);
INSERT INTO schema_migrations VALUES(15);
INSERT INTO schema_migrations VALUES(16);
INSERT INTO schema_migrations VALUES(17);
INSERT INTO schema_migrations VALUES(18);
INSERT INTO schema_migrations VALUES(19);
INSERT INTO schema_migrations VALUES(20);
INSERT INTO schema_migrations VALUES(21);
CREATE TABLE meta (key text primary key, value text not null);
INSERT INTO meta VALUES('ledger_id','83a46e19-8b9a-4161-8dde-88911d3873a1');
CREATE TABLE contract (
    campaign text not null,
    version integer not null,
    sha text not null,
    mode text not null,
    body text not null,
    created_at text not null,
    primary key (campaign, version)
  );
INSERT INTO contract VALUES('js-sum',1,'3acac73584977d616d257af693d88856b7d2bdf603e0fcf55a2b2f11833cfc29','hill_climb','{"acceptance":{"alpha_confirm":0.05,"alpha_screen":0.1,"audit":{"absolute":1000,"ratio_to_median":1000},"confirm_blocks":4,"equivalence_band":0.005,"looks":[3,6],"runs_per_cell":1},"budget":{"max_open_attempts":4},"campaign":"js-sum","cells":["small"],"editable_paths":["src/kernel/**"],"forbidden_patterns":[],"guards":[],"hard_constraints":[],"held_out_cells":[],"lanes":{"count":2,"trials_per_epoch":3},"mode":"hill_climb","models":[],"monitor_only":[],"objective":{"policy":"single","primary":{"direction":"max","metric":"ops_per_s","min_effect":0.05},"secondary":[]},"project":{"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","kit":{"commit":"204c39fff0e2a326174d1141d08367ad6028ccd4","repo":"js-kit"},"repo":"proj"},"schema_version":1,"target":{"class":"test","type":"cpu"},"title":"Speed up the sum","version":1}','2026-10-27T21:48:41.879Z');
CREATE TABLE IF NOT EXISTS "run" (
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
    updated_at text not null, agents integer not null default 1, promotion text check (promotion in ('auto', 'owner_approval')), ask_owner text,
    foreign key (campaign, version) references contract (campaign, version)
  );
INSERT INTO run VALUES('js-1','js-sum',1,'3acac73584977d616d257af693d88856b7d2bdf603e0fcf55a2b2f11833cfc29','hill_climb','proj','f34374b5a2b3fb71dd7da851d3273d1a0357a803',NULL,'running',NULL,'2026-10-27T21:48:41.880Z','2026-10-27T21:48:41.880Z',1,NULL,NULL);
CREATE TABLE champion (
    run text not null references "run" (id),
    seq integer not null,
    attempt text,
    commit_sha text not null,
    promoted_by text not null,
    promoted_at text not null,
    reopened integer not null default 0,
    primary key (run, seq)
  );
INSERT INTO champion VALUES('js-1',1,NULL,'f34374b5a2b3fb71dd7da851d3273d1a0357a803','control:owner:seed','2026-10-27T21:48:41.880Z',0);
INSERT INTO champion VALUES('js-1',2,'a-3a5f77456cc84802','acebca7c8a4298c1f1fbf74c8b9c586061cd2135','judge-test','2026-10-27T21:48:42.687Z',0);
CREATE TABLE lane (
    id text primary key,
    run text not null references "run" (id),
    family text,
    status text not null default 'active',
    lane_best_attempt text,
    created_at text not null
  );
CREATE TABLE attempt (
    id text primary key,
    run text not null references "run" (id),
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
  , family text, flaws_cleared_by text);
INSERT INTO attempt VALUES('a-56250d316d99442d','js-1',NULL,'local','commit:f34374b5a2b3fb71dd7da851d3273d1a0357a803','f34374b5a2b3fb71dd7da851d3273d1a0357a803',NULL,1,'52fb934690e1bf5e6e99219bd39f5c5ab0dd9776','refs/thermite/attempts/a-56250d316d99442d','8d29ec46060b9cf4a48926fe02fb9d80cab41c35bf46e270e2162954cbffa57c','e304219819398cbee75937c45366031073b1811049c1d2321bc2f5925f1135d6','judged','a wrong shortcut',NULL,'[]','{"ok":true,"violations":[]}',NULL,'2026-10-27T21:48:42.308Z','2026-10-27T21:48:42.590Z',NULL,NULL);
INSERT INTO attempt VALUES('a-3a5f77456cc84802','js-1',NULL,'local','commit:f34374b5a2b3fb71dd7da851d3273d1a0357a803','f34374b5a2b3fb71dd7da851d3273d1a0357a803',NULL,1,'acebca7c8a4298c1f1fbf74c8b9c586061cd2135','refs/thermite/attempts/a-3a5f77456cc84802','c6f85ae06dde1082b74bd927e1ae3b62a35e924fbce90948d9df23f87e456aba','0dd48d20c6d969a518d8458460f07f913ad5e22d45ee4f617fc6aa6be03d7811','promoted','drop the wasted inner loop',NULL,'[]','{"ok":true,"violations":[]}',NULL,'2026-10-27T21:48:42.542Z','2026-10-27T21:48:42.687Z',NULL,NULL);
CREATE TABLE job (
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
  , leased_at text);
INSERT INTO job VALUES(1,NULL,'baseline','done',10,NULL,NULL,1,0,'{"champion_seq":1,"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","run":"js-1"}','{"baseline":true,"champion_seq":1,"summary":"ops_per_s small 4.441e+7 ±0.60% (median of 3 blocks)"}','2026-10-27T21:48:41.881Z','2026-10-27T21:48:42.092Z','2026-10-27T21:48:41.881Z');
INSERT INTO job VALUES(2,'a-56250d316d99442d','evaluate','done',100,NULL,NULL,1,0,'{"run":"js-1"}','{"verdict":"invalid"}','2026-10-27T21:48:42.308Z','2026-10-27T21:48:42.590Z','2026-10-27T21:48:42.542Z');
INSERT INTO job VALUES(3,'a-3a5f77456cc84802','evaluate','done',100,NULL,NULL,1,0,'{"run":"js-1"}','{"baseline_seq":1,"delta":7.949063688168657,"verdict":"win_screened"}','2026-10-27T21:48:42.542Z','2026-10-27T21:48:42.669Z','2026-10-27T21:48:42.590Z');
INSERT INTO job VALUES(4,'a-3a5f77456cc84802','confirm','done',50,NULL,NULL,1,0,'{"baseline_seq":1,"screen_job":3}','{"promoted":{"seq":2},"verdict":"win_confirmed"}','2026-10-27T21:48:42.669Z','2026-10-27T21:48:42.687Z','2026-10-27T21:48:42.669Z');
CREATE TABLE measurement (
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
  , arm text not null default 'candidate');
INSERT INTO measurement VALUES(1,1,1,'ops_per_s','small',1,44405654.89384248108,'op/s','2026-10-27T21:48:42.086Z','baseline');
INSERT INTO measurement VALUES(2,1,1,'ops_per_s','small',2,44138733.78222322464,'op/s','2026-10-27T21:48:42.089Z','baseline');
INSERT INTO measurement VALUES(3,1,1,'ops_per_s','small',3,44817192.27644826472,'op/s','2026-10-27T21:48:42.091Z','baseline');
INSERT INTO measurement VALUES(4,3,1,'ops_per_s','small',1,396608180.539848864,'op/s','2026-10-27T21:48:42.658Z','candidate');
INSERT INTO measurement VALUES(5,3,1,'ops_per_s','small',1,44469536.28719529509,'op/s','2026-10-27T21:48:42.658Z','champion');
INSERT INTO measurement VALUES(6,3,1,'ops_per_s','small',2,400335296.8331320286,'op/s','2026-10-27T21:48:42.664Z','candidate');
INSERT INTO measurement VALUES(7,3,1,'ops_per_s','small',2,44640437.10146253556,'op/s','2026-10-27T21:48:42.664Z','champion');
INSERT INTO measurement VALUES(8,3,1,'ops_per_s','small',3,399113481.3676002025,'op/s','2026-10-27T21:48:42.668Z','candidate');
INSERT INTO measurement VALUES(9,3,1,'ops_per_s','small',3,44540810.19608871638,'op/s','2026-10-27T21:48:42.668Z','champion');
INSERT INTO measurement VALUES(10,4,1,'ops_per_s','small',1,401931803.9158754348,'op/s','2026-10-27T21:48:42.674Z','candidate');
INSERT INTO measurement VALUES(11,4,1,'ops_per_s','small',1,44888699.90795256198,'op/s','2026-10-27T21:48:42.674Z','champion');
INSERT INTO measurement VALUES(12,4,1,'ops_per_s','small',2,402671063.749771297,'op/s','2026-10-27T21:48:42.677Z','candidate');
INSERT INTO measurement VALUES(13,4,1,'ops_per_s','small',2,44532057.40096435696,'op/s','2026-10-27T21:48:42.678Z','champion');
INSERT INTO measurement VALUES(14,4,1,'ops_per_s','small',3,397515867.8971371054,'op/s','2026-10-27T21:48:42.681Z','candidate');
INSERT INTO measurement VALUES(15,4,1,'ops_per_s','small',3,44430127.35019574314,'op/s','2026-10-27T21:48:42.681Z','champion');
INSERT INTO measurement VALUES(16,4,1,'ops_per_s','small',4,400208205.9380303025,'op/s','2026-10-27T21:48:42.684Z','candidate');
INSERT INTO measurement VALUES(17,4,1,'ops_per_s','small',4,44608347.350128524,'op/s','2026-10-27T21:48:42.684Z','champion');
CREATE TABLE receipt (
    id text primary key,
    job integer not null references job (id),
    fence integer not null,
    body text not null,
    created_at text not null
  );
INSERT INTO receipt VALUES('acb30d6fb77183b27f06bb66ebf54bbaa07fa8fa52ad7b3b8552f360ef725dce',1,1,'{"accepted":true,"after_block":[],"attempt":null,"block":1,"builds":{"a":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a"},"cpu_throttled_fraction":null,"env":{"cpu":{"cores":14,"model":"Apple M4 Pro"},"free_mem":112214016,"load":[6.1142578125,7.853515625,8.67626953125],"total_mem":25769803776},"job":1,"readiness":{"cores":14,"load1":6.1142578125},"runs":[{"arm":"baseline","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":450.3930872726146}],"separated":false,"target":{"class":"test","details":{"cores":14,"model":"Apple M4 Pro"},"id":"cpu-1caf767971fecb8b","type":"cpu"},"try":1,"worst_run_throttled_fraction":0}','2026-10-27T21:48:42.086Z');
INSERT INTO receipt VALUES('1fbbe4f9f27e4d78a4a2af13d437d834ba53eb90feccf505d475e69b8bd8ffed',1,1,'{"accepted":true,"after_block":[],"attempt":null,"block":2,"builds":{"a":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a"},"cpu_throttled_fraction":null,"env":{"cpu":{"cores":14,"model":"Apple M4 Pro"},"free_mem":109297664,"load":[6.1142578125,7.853515625,8.67626953125],"total_mem":25769803776},"job":1,"readiness":{"cores":14,"load1":6.1142578125},"runs":[{"arm":"baseline","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":453.1167590506404}],"separated":false,"target":{"class":"test","details":{"cores":14,"model":"Apple M4 Pro"},"id":"cpu-1caf767971fecb8b","type":"cpu"},"try":1,"worst_run_throttled_fraction":0}','2026-10-27T21:48:42.088Z');
INSERT INTO receipt VALUES('e7311234df27867a8baaf575bf767b77de7d0de9ddf6558c5a36db745913349d',1,1,'{"accepted":true,"after_block":[],"attempt":null,"block":3,"builds":{"a":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a"},"cpu_throttled_fraction":null,"env":{"cpu":{"cores":14,"model":"Apple M4 Pro"},"free_mem":123699200,"load":[6.1142578125,7.853515625,8.67626953125],"total_mem":25769803776},"job":1,"readiness":{"cores":14,"load1":6.1142578125},"runs":[{"arm":"baseline","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":446.2573174292789}],"separated":false,"target":{"class":"test","details":{"cores":14,"model":"Apple M4 Pro"},"id":"cpu-1caf767971fecb8b","type":"cpu"},"try":1,"worst_run_throttled_fraction":0}','2026-10-27T21:48:42.091Z');
INSERT INTO receipt VALUES('06ec4860aece4569fb7b4639553a2692b50e096060223fb73571d99f85be81c9',3,1,'{"accepted":true,"after_block":[],"attempt":"a-3a5f77456cc84802","block":1,"builds":{"a":"753bc26ec4df7d2d13bf26a2e61d5bcfaf56c1eda659618fbbea2c136c6d65ad","b":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a"},"cpu_throttled_fraction":null,"env":{"cpu":{"cores":14,"model":"Apple M4 Pro"},"free_mem":115097600,"load":[6.1142578125,7.853515625,8.67626953125],"total_mem":25769803776},"job":3,"readiness":{"cores":14,"load1":6.1142578125},"runs":[{"arm":"champion","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":449.7460884420975},{"arm":"candidate","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":50.4276033156369}],"separated":false,"target":{"class":"test","details":{"cores":14,"model":"Apple M4 Pro"},"id":"cpu-1caf767971fecb8b","type":"cpu"},"try":1,"worst_run_throttled_fraction":0}','2026-10-27T21:48:42.658Z');
INSERT INTO receipt VALUES('46bad62ce3de4d2561f621ea6d9d35efe34045d4b37185d51946879e0fb146a0',3,1,'{"accepted":true,"after_block":[],"attempt":"a-3a5f77456cc84802","block":2,"builds":{"a":"753bc26ec4df7d2d13bf26a2e61d5bcfaf56c1eda659618fbbea2c136c6d65ad","b":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a"},"cpu_throttled_fraction":null,"env":{"cpu":{"cores":14,"model":"Apple M4 Pro"},"free_mem":111280128,"load":[6.1142578125,7.853515625,8.67626953125],"total_mem":25769803776},"job":3,"readiness":{"cores":14,"load1":6.1142578125},"runs":[{"arm":"champion","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":448.0242869159708},{"arm":"candidate","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":49.9581229989231}],"separated":false,"target":{"class":"test","details":{"cores":14,"model":"Apple M4 Pro"},"id":"cpu-1caf767971fecb8b","type":"cpu"},"try":1,"worst_run_throttled_fraction":0}','2026-10-27T21:48:42.664Z');
INSERT INTO receipt VALUES('77108a19d9f3a5016f53847970404afecd9bd274bc5e2beb51c2c5a1e1a95463',3,1,'{"accepted":true,"after_block":[],"attempt":"a-3a5f77456cc84802","block":3,"builds":{"a":"753bc26ec4df7d2d13bf26a2e61d5bcfaf56c1eda659618fbbea2c136c6d65ad","b":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a"},"cpu_throttled_fraction":null,"env":{"cpu":{"cores":14,"model":"Apple M4 Pro"},"free_mem":116621312,"load":[6.1142578125,7.853515625,8.67626953125],"total_mem":25769803776},"job":3,"readiness":{"cores":14,"load1":6.1142578125},"runs":[{"arm":"champion","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":449.02640773598387},{"arm":"candidate","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":50.11106097310495}],"separated":false,"target":{"class":"test","details":{"cores":14,"model":"Apple M4 Pro"},"id":"cpu-1caf767971fecb8b","type":"cpu"},"try":1,"worst_run_throttled_fraction":0}','2026-10-27T21:48:42.668Z');
INSERT INTO receipt VALUES('3bb4b51cf2f1450b59c1cd064b6808635d607e650097ada20177caee114c65ea',4,1,'{"accepted":true,"after_block":[],"attempt":"a-3a5f77456cc84802","block":1,"builds":{"a":"753bc26ec4df7d2d13bf26a2e61d5bcfaf56c1eda659618fbbea2c136c6d65ad","b":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a"},"cpu_throttled_fraction":null,"env":{"cpu":{"cores":14,"model":"Apple M4 Pro"},"free_mem":116621312,"load":[6.1142578125,7.853515625,8.67626953125],"total_mem":25769803776},"job":4,"readiness":{"cores":14,"load1":6.1142578125},"runs":[{"arm":"champion","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":445.5464301931534},{"arm":"candidate","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":49.75968511361199}],"separated":false,"target":{"class":"test","details":{"cores":14,"model":"Apple M4 Pro"},"id":"cpu-1caf767971fecb8b","type":"cpu"},"try":1,"worst_run_throttled_fraction":0}','2026-10-27T21:48:42.674Z');
INSERT INTO receipt VALUES('f6185a2c773f227812f7fcc022b4a7472cafc895fa1beebff8fcceb2b1b9c7d9',4,1,'{"accepted":true,"after_block":[],"attempt":"a-3a5f77456cc84802","block":2,"builds":{"a":"753bc26ec4df7d2d13bf26a2e61d5bcfaf56c1eda659618fbbea2c136c6d65ad","b":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a"},"cpu_throttled_fraction":null,"env":{"cpu":{"cores":14,"model":"Apple M4 Pro"},"free_mem":116621312,"load":[6.1142578125,7.853515625,8.67626953125],"total_mem":25769803776},"job":4,"readiness":{"cores":14,"load1":6.1142578125},"runs":[{"arm":"champion","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":449.11466407044765},{"arm":"candidate","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":49.668331798553176}],"separated":false,"target":{"class":"test","details":{"cores":14,"model":"Apple M4 Pro"},"id":"cpu-1caf767971fecb8b","type":"cpu"},"try":1,"worst_run_throttled_fraction":0}','2026-10-27T21:48:42.677Z');
INSERT INTO receipt VALUES('34f77b5b4597cba0460d198abea1b891af587402114c4006c1586d6698713ec4',4,1,'{"accepted":true,"after_block":[],"attempt":"a-3a5f77456cc84802","block":3,"builds":{"a":"753bc26ec4df7d2d13bf26a2e61d5bcfaf56c1eda659618fbbea2c136c6d65ad","b":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a"},"cpu_throttled_fraction":null,"env":{"cpu":{"cores":14,"model":"Apple M4 Pro"},"free_mem":116621312,"load":[6.1142578125,7.853515625,8.67626953125],"total_mem":25769803776},"job":4,"readiness":{"cores":14,"load1":6.1142578125},"runs":[{"arm":"champion","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":450.14500729113684},{"arm":"candidate","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":50.31245697385667}],"separated":false,"target":{"class":"test","details":{"cores":14,"model":"Apple M4 Pro"},"id":"cpu-1caf767971fecb8b","type":"cpu"},"try":1,"worst_run_throttled_fraction":0}','2026-10-27T21:48:42.681Z');
INSERT INTO receipt VALUES('bc21e81ac603fb50feaacfff1c2c4b58dd416a781ad205877ff22f622f72df6f',4,1,'{"accepted":true,"after_block":[],"attempt":"a-3a5f77456cc84802","block":4,"builds":{"a":"753bc26ec4df7d2d13bf26a2e61d5bcfaf56c1eda659618fbbea2c136c6d65ad","b":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a"},"cpu_throttled_fraction":null,"env":{"cpu":{"cores":14,"model":"Apple M4 Pro"},"free_mem":116621312,"load":[6.1142578125,7.853515625,8.67626953125],"total_mem":25769803776},"job":4,"readiness":{"cores":14,"load1":6.1142578125},"runs":[{"arm":"champion","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":448.34658058549167},{"arm":"candidate","cell":"small","check":{"value":59999997},"cpu_throttled_fraction":0,"kind":"ok","leftovers":0,"peak_rss":41943040,"run":1,"swept":0,"wall_ms":49.97398779748378}],"separated":false,"target":{"class":"test","details":{"cores":14,"model":"Apple M4 Pro"},"id":"cpu-1caf767971fecb8b","type":"cpu"},"try":1,"worst_run_throttled_fraction":0}','2026-10-27T21:48:42.684Z');
CREATE TABLE verdict (
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
INSERT INTO verdict VALUES(1,'a-56250d316d99442d','invalid',NULL,NULL,NULL,'[]','[2]','wrong result 60000000, expected 59999997','judge-test',NULL,'2026-10-27T21:48:42.589Z');
INSERT INTO verdict VALUES(2,'a-3a5f77456cc84802','win_screened',7.949063688168656938,7.883129808912821445,8.015486953094548284,'[]','[3]','better beyond min_effect; ops_per_s 794.91% [788.31%, 801.55%] n=3; vs champion seq 1','judge-test',NULL,'2026-10-27T21:48:42.669Z');
INSERT INTO verdict VALUES(3,'a-3a5f77456cc84802','win_confirmed',7.978627276513295286,7.909617641238355646,8.048171427404117395,'[]','[4,3]','confirmed on fresh data; ops_per_s 797.86% [790.96%, 804.82%] n=4; vs champion seq 1','judge-test',NULL,'2026-10-27T21:48:42.687Z');
CREATE TABLE invalidation (
    id integer primary key autoincrement,
    subject_kind text not null check (subject_kind in ('job', 'attempt')),
    subject_id text not null,
    reason text not null,
    actor text not null,
    created_at text not null
  );
CREATE TABLE directive (
    id integer primary key autoincrement,
    run text not null,
    author text not null,
    body text not null,
    status text not null default 'active',
    created_at text not null
  , superseded_at text);
CREATE TABLE command (
    id text primary key,
    kind text not null,
    envelope text not null,
    signature text not null,
    accepted integer not null,
    result text not null,
    received_at text not null
  );
INSERT INTO command VALUES('069dac74-c4d0-4258-a64f-228921502b5a','assign_campaign','{"expires_at":"2026-10-27T22:48:41.654Z","id":"069dac74-c4d0-4258-a64f-228921502b5a","issued_at":"2026-10-27T21:48:40.654Z","issued_by":"owner","kind":"assign_campaign","payload":{"contract":{"acceptance":{"alpha_confirm":0.05,"alpha_screen":0.1,"audit":{"absolute":1000,"ratio_to_median":1000},"confirm_blocks":4,"equivalence_band":0.005,"looks":[3,6],"runs_per_cell":1},"budget":{"max_open_attempts":4},"campaign":"js-sum","cells":["small"],"editable_paths":["src/kernel/**"],"forbidden_patterns":[],"guards":[],"hard_constraints":[],"held_out_cells":[],"lanes":{"count":2,"trials_per_epoch":3},"mode":"hill_climb","models":[],"monitor_only":[],"objective":{"policy":"single","primary":{"direction":"max","metric":"ops_per_s","min_effect":0.05},"secondary":[]},"project":{"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","kit":{"commit":"204c39fff0e2a326174d1141d08367ad6028ccd4","repo":"js-kit"},"repo":"proj"},"schema_version":1,"target":{"class":"test","type":"cpu"},"title":"Speed up the sum","version":1},"contract_sha":"3acac73584977d616d257af693d88856b7d2bdf603e0fcf55a2b2f11833cfc29","imports":[{"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","kind":"repo_bundle","path":"repos/p.bundle","repo":"proj"},{"commit":"204c39fff0e2a326174d1141d08367ad6028ccd4","kind":"kit_bundle","path":"repos/k.bundle","repo":"js-kit"}],"run":"js-1","seed":{"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","repo":"proj"}},"rig":"rig-a","v":1}','RRz0DLHeTjOHJkbYAnYHXBxet1vlKP3/OJnMwrdqcfpmCZC3FGHCyIkJdOiCQiSIHA0L/ZRtu2ZD5TcU5uFuCQ==',1,'{"agents":true,"contract_sha":"3acac73584977d616d257af693d88856b7d2bdf603e0fcf55a2b2f11833cfc29","imported":[{"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","kind":"repo_bundle","repo":"proj"},{"commit":"204c39fff0e2a326174d1141d08367ad6028ccd4","kind":"kit_bundle","repo":"kit-js-kit"}],"run":"js-1"}','2026-10-27T21:48:41.880Z');
CREATE TABLE import (
    id integer primary key autoincrement,
    kind text not null,
    name text,
    sha256 text,
    commit_sha text,
    source_path text not null,
    stored_path text not null,
    verified_at text not null
  );
INSERT INTO import VALUES(1,'repo_bundle','proj','290f53c25d0e7f3f03b909a5575f84ff80c68a7be9ae51268dc87b5ef0bddd9b','f34374b5a2b3fb71dd7da851d3273d1a0357a803','repos/p.bundle','/tmp/thermite-fixture/thermite-judge-InAOzA/state/git/proj.git','2026-10-27T21:48:41.749Z');
INSERT INTO import VALUES(2,'kit_bundle','kit-js-kit','0246307c0a7ad7d8b1fe8c5d1e4d27d7cb22be6aa7f825ce736c3afa4096b8aa','204c39fff0e2a326174d1141d08367ad6028ccd4','repos/k.bundle','/tmp/thermite-fixture/thermite-judge-InAOzA/state/git/kit-js-kit.git','2026-10-27T21:48:41.833Z');
CREATE TABLE export (
    id integer primary key autoincrement,
    through_event integer not null,
    path text not null,
    manifest text not null,
    created_at text not null
  );
CREATE TABLE event (
    id integer primary key autoincrement,
    at text not null,
    actor text not null,
    kind text not null,
    subject text,
    body text not null
  );
INSERT INTO event VALUES(1,'2026-10-27T21:48:41.749Z','control:owner','import_verified','repo_bundle','{"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","name":"proj","sha256":"290f53c25d0e7f3f03b909a5575f84ff80c68a7be9ae51268dc87b5ef0bddd9b"}');
INSERT INTO event VALUES(2,'2026-10-27T21:48:41.833Z','control:owner','import_verified','kit_bundle','{"commit":"204c39fff0e2a326174d1141d08367ad6028ccd4","name":"kit-js-kit","sha256":"0246307c0a7ad7d8b1fe8c5d1e4d27d7cb22be6aa7f825ce736c3afa4096b8aa"}');
INSERT INTO event VALUES(3,'2026-10-27T21:48:41.879Z','control:owner','contract_stored','js-sum','{"mode":"hill_climb","sha":"3acac73584977d616d257af693d88856b7d2bdf603e0fcf55a2b2f11833cfc29","version":1}');
INSERT INTO event VALUES(4,'2026-10-27T21:48:41.880Z','control:owner','run_created','js-1','{"agents":true,"campaign":"js-sum","direction":null,"mode":"hill_climb","promotion":null,"seed":{"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","repo":"proj"},"version":1}');
INSERT INTO event VALUES(5,'2026-10-27T21:48:41.880Z','control:owner','command','069dac74-c4d0-4258-a64f-228921502b5a','{"accepted":true,"kind":"assign_campaign","result":{"agents":true,"contract_sha":"3acac73584977d616d257af693d88856b7d2bdf603e0fcf55a2b2f11833cfc29","imported":[{"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","kind":"repo_bundle","repo":"proj"},{"commit":"204c39fff0e2a326174d1141d08367ad6028ccd4","kind":"kit_bundle","repo":"kit-js-kit"}],"run":"js-1"}}');
INSERT INTO event VALUES(6,'2026-10-27T21:48:41.881Z','judge-test','job_queued','1','{"attempt":null,"kind":"baseline","run":"js-1"}');
INSERT INTO event VALUES(7,'2026-10-27T21:48:41.881Z','judge-test','job_leased','1','{"fence":1,"until":"2026-10-27T22:03:41.881Z"}');
INSERT INTO event VALUES(8,'2026-10-27T21:48:42.081Z','judge-test','build_recorded','412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a','{"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","kit_commit":"204c39fff0e2a326174d1141d08367ad6028ccd4","ok":true}');
INSERT INTO event VALUES(9,'2026-10-27T21:48:42.092Z','judge-test','baseline','js-1','{"attempt":null,"blocks":3,"bytes":0,"cells":{"small":{"ops_per_s":{"mad":266921.11161925644,"median":44405654.89384248,"n":3}}},"champion_seq":1,"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","files":[],"guards":[],"job":1,"primary":{"direction":"max","metric":"ops_per_s"},"run":"js-1","runs_per_cell":1,"summary":"ops_per_s small 4.441e+7 ±0.60% (median of 3 blocks)","units":{"ops_per_s":"op/s"}}');
INSERT INTO event VALUES(10,'2026-10-27T21:48:42.092Z','judge-test','job_finished','1','{"result":{"baseline":true,"champion_seq":1,"summary":"ops_per_s small 4.441e+7 ±0.60% (median of 3 blocks)"},"state":"done"}');
INSERT INTO event VALUES(11,'2026-10-27T21:48:42.308Z','proposer','attempt_recorded','a-56250d316d99442d','{"commit":"52fb934690e1bf5e6e99219bd39f5c5ab0dd9776","files":[{"added":1,"path":"src/kernel/work.mjs","removed":7}],"files_total":1,"hypothesis":"a wrong shortcut","known_flaws":[],"lane":null,"lifecycle":"queued","parent":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","run":"js-1"}');
INSERT INTO event VALUES(12,'2026-10-27T21:48:42.308Z','proposer','job_queued','2','{"attempt":"a-56250d316d99442d","kind":"evaluate","run":"js-1"}');
INSERT INTO event VALUES(13,'2026-10-27T21:48:42.542Z','proposer','attempt_recorded','a-3a5f77456cc84802','{"commit":"acebca7c8a4298c1f1fbf74c8b9c586061cd2135","files":[{"added":0,"path":"src/kernel/work.mjs","removed":4}],"files_total":1,"hypothesis":"drop the wasted inner loop","known_flaws":[],"lane":null,"lifecycle":"queued","parent":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","run":"js-1"}');
INSERT INTO event VALUES(14,'2026-10-27T21:48:42.542Z','proposer','job_queued','3','{"attempt":"a-3a5f77456cc84802","kind":"evaluate","run":"js-1"}');
INSERT INTO event VALUES(15,'2026-10-27T21:48:42.542Z','judge-test','job_leased','2','{"fence":1,"until":"2026-10-27T22:03:42.542Z"}');
INSERT INTO event VALUES(16,'2026-10-27T21:48:42.543Z','judge-test','attempt_lifecycle','a-56250d316d99442d','{"lifecycle":"building"}');
INSERT INTO event VALUES(17,'2026-10-27T21:48:42.586Z','judge-test','build_recorded','19464f76c542507e3b7ce329a45e50ac97689e204a4daa03360b8e2e2069a0a3','{"commit":"52fb934690e1bf5e6e99219bd39f5c5ab0dd9776","kit_commit":"204c39fff0e2a326174d1141d08367ad6028ccd4","ok":true}');
INSERT INTO event VALUES(18,'2026-10-27T21:48:42.587Z','judge-test','attempt_lifecycle','a-56250d316d99442d','{"lifecycle":"gating"}');
INSERT INTO event VALUES(19,'2026-10-27T21:48:42.589Z','judge-test','verdict','a-56250d316d99442d','{"ci_high":null,"ci_low":null,"delta":null,"id":1,"reasons":"wrong result 60000000, expected 59999997","supersedes":null,"verdict":"invalid"}');
INSERT INTO event VALUES(20,'2026-10-27T21:48:42.590Z','judge-test','attempt_lifecycle','a-56250d316d99442d','{"lifecycle":"judged"}');
INSERT INTO event VALUES(21,'2026-10-27T21:48:42.590Z','judge-test','job_finished','2','{"result":{"verdict":"invalid"},"state":"done"}');
INSERT INTO event VALUES(22,'2026-10-27T21:48:42.590Z','judge-test','job_leased','3','{"fence":1,"until":"2026-10-27T22:03:42.590Z"}');
INSERT INTO event VALUES(23,'2026-10-27T21:48:42.590Z','judge-test','attempt_lifecycle','a-3a5f77456cc84802','{"lifecycle":"building"}');
INSERT INTO event VALUES(24,'2026-10-27T21:48:42.648Z','judge-test','build_recorded','753bc26ec4df7d2d13bf26a2e61d5bcfaf56c1eda659618fbbea2c136c6d65ad','{"commit":"acebca7c8a4298c1f1fbf74c8b9c586061cd2135","kit_commit":"204c39fff0e2a326174d1141d08367ad6028ccd4","ok":true}');
INSERT INTO event VALUES(25,'2026-10-27T21:48:42.650Z','judge-test','attempt_lifecycle','a-3a5f77456cc84802','{"lifecycle":"gating"}');
INSERT INTO event VALUES(26,'2026-10-27T21:48:42.655Z','judge-test','attempt_lifecycle','a-3a5f77456cc84802','{"lifecycle":"screening"}');
INSERT INTO event VALUES(27,'2026-10-27T21:48:42.669Z','judge-test','verdict','a-3a5f77456cc84802','{"ci_high":8.015486953094548,"ci_low":7.8831298089128214,"delta":7.949063688168657,"id":2,"reasons":"better beyond min_effect; ops_per_s 794.91% [788.31%, 801.55%] n=3; vs champion seq 1","supersedes":null,"values":{"cells":[{"candidate":399113481.3676002,"cell":"small","reference":44540810.19608872}],"metric":"ops_per_s"},"verdict":"win_screened"}');
INSERT INTO event VALUES(28,'2026-10-27T21:48:42.669Z','judge-test','job_queued','4','{"attempt":"a-3a5f77456cc84802","kind":"confirm"}');
INSERT INTO event VALUES(29,'2026-10-27T21:48:42.669Z','judge-test','attempt_lifecycle','a-3a5f77456cc84802','{"lifecycle":"confirming"}');
INSERT INTO event VALUES(30,'2026-10-27T21:48:42.669Z','judge-test','job_finished','3','{"result":{"baseline_seq":1,"delta":7.949063688168657,"verdict":"win_screened"},"state":"done"}');
INSERT INTO event VALUES(31,'2026-10-27T21:48:42.669Z','judge-test','job_leased','4','{"fence":1,"until":"2026-10-27T22:03:42.669Z"}');
INSERT INTO event VALUES(32,'2026-10-27T21:48:42.687Z','judge-test','verdict','a-3a5f77456cc84802','{"ci_high":8.048171427404117,"ci_low":7.909617641238356,"delta":7.978627276513295,"id":3,"reasons":"confirmed on fresh data; ops_per_s 797.86% [790.96%, 804.82%] n=4; vs champion seq 1","supersedes":null,"values":{"cells":[{"candidate":401070004.92695284,"cell":"small","reference":44570202.37554644}],"metric":"ops_per_s"},"verdict":"win_confirmed"}');
INSERT INTO event VALUES(33,'2026-10-27T21:48:42.687Z','judge-test','champion_promoted','js-1','{"attempt":"a-3a5f77456cc84802","commit":"acebca7c8a4298c1f1fbf74c8b9c586061cd2135","seq":2}');
INSERT INTO event VALUES(34,'2026-10-27T21:48:42.687Z','judge-test','attempt_lifecycle','a-3a5f77456cc84802','{"lifecycle":"promoted"}');
INSERT INTO event VALUES(35,'2026-10-27T21:48:42.687Z','judge-test','job_finished','4','{"result":{"promoted":{"seq":2},"verdict":"win_confirmed"},"state":"done"}');
INSERT INTO event VALUES(36,'2026-10-27T21:48:42.701Z','owner','agent_message','js-1','{"chars":21,"id":1,"keep":false,"text":"check the loop bounds","to":"panel"}');
INSERT INTO event VALUES(37,'2026-10-27T21:48:42.702Z','supervisor','model_call','js-1','{"agent":"combiner","input_tokens":10,"model":"test-model","output_tokens":5}');
CREATE TABLE budget_ledger (
    id integer primary key autoincrement,
    run text not null,
    resource text not null,
    delta real not null,
    reason text not null,
    at text not null
  );
CREATE TABLE invocation (
    id text primary key,
    run text,
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
CREATE TABLE goal (
    run text not null references "run" (id),
    id text not null,
    parent text,
    priority integer not null,
    required integer not null,
    verify text not null,
    status text not null default 'untouched'
      check (status in ('untouched', 'attempted', 'verified', 'blocked', 'unmet', 'not_runnable')),
    primary key (run, id)
  );
CREATE TABLE build (
    key text primary key,
    repo text not null,
    commit_sha text not null,
    kit_commit text not null,
    ok integer not null,
    manifest text not null,
    created_at text not null
  );
INSERT INTO build VALUES('412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a','proj','f34374b5a2b3fb71dd7da851d3273d1a0357a803','204c39fff0e2a326174d1141d08367ad6028ccd4',1,'{"build_ms":42,"commit":"f34374b5a2b3fb71dd7da851d3273d1a0357a803","files":{"out/run.mjs":"8098662fe9d02225b15f3ca4fd2b880885ac4aec1550827481d177f211d24142","out/work.mjs":"d3bbabb8b3811ca2c6d1937a946986ec5e35cce7c85efe7c58c71db5250de8a8"},"key":"412b82e3242b0532be20cad57a56ab3accf5d947787bc9a4d1d1c770633aed6a","kit_commit":"204c39fff0e2a326174d1141d08367ad6028ccd4"}','2026-10-27T21:48:42.081Z');
INSERT INTO build VALUES('19464f76c542507e3b7ce329a45e50ac97689e204a4daa03360b8e2e2069a0a3','proj','52fb934690e1bf5e6e99219bd39f5c5ab0dd9776','204c39fff0e2a326174d1141d08367ad6028ccd4',1,'{"build_ms":26,"commit":"52fb934690e1bf5e6e99219bd39f5c5ab0dd9776","files":{"out/run.mjs":"8098662fe9d02225b15f3ca4fd2b880885ac4aec1550827481d177f211d24142","out/work.mjs":"cc8cb764f4d506a6dc948ec8eac94e8024287fb97cd4b6eae08bec11617560bd"},"key":"19464f76c542507e3b7ce329a45e50ac97689e204a4daa03360b8e2e2069a0a3","kit_commit":"204c39fff0e2a326174d1141d08367ad6028ccd4"}','2026-10-27T21:48:42.586Z');
INSERT INTO build VALUES('753bc26ec4df7d2d13bf26a2e61d5bcfaf56c1eda659618fbbea2c136c6d65ad','proj','acebca7c8a4298c1f1fbf74c8b9c586061cd2135','204c39fff0e2a326174d1141d08367ad6028ccd4',1,'{"build_ms":40,"commit":"acebca7c8a4298c1f1fbf74c8b9c586061cd2135","files":{"out/run.mjs":"8098662fe9d02225b15f3ca4fd2b880885ac4aec1550827481d177f211d24142","out/work.mjs":"15bafab2b598301e66dd5eb93e2515b889e248a99f48c89ebcf3f01f43730954"},"key":"753bc26ec4df7d2d13bf26a2e61d5bcfaf56c1eda659618fbbea2c136c6d65ad","kit_commit":"204c39fff0e2a326174d1141d08367ad6028ccd4"}','2026-10-27T21:48:42.648Z');
CREATE TABLE family (
    run text not null,
    id text not null,
    description text not null,
    status text not null default 'live' check (status in ('live', 'blocked', 'exhausted')),
    created_by text not null,
    created_at text not null,
    primary key (run, id)
  );
CREATE TABLE epoch (
    run text not null,
    n integer not null,
    source text not null check (source in ('planner', 'fallback')),
    planner_tries integer not null,
    planner_valid integer not null,
    raw_violations text not null default '[]',
    assignments text not null,
    notes text,
    started_at text not null,
    ended_at text, directives text not null default '[]',
    primary key (run, n)
  );
CREATE TABLE trial (
    id text primary key,
    run text not null,
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
  , token_sha text);
CREATE TABLE goal_check (
    id integer primary key autoincrement,
    run text not null,
    goal text not null,
    attempt text,
    job integer not null,
    commit_sha text not null,
    result text not null check (result in ('met', 'unmet', 'inconclusive', 'not_runnable')),
    detail text not null,
    created_at text not null
  );
CREATE TABLE source (
    id text primary key,
    run text not null,
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
CREATE TABLE claim (
    id text primary key,
    run text not null,
    lane text,
    question integer,
    text text not null,
    quotes text not null,
    verified integer not null,
    problems text not null default '[]',
    confidence real,
    created_at text not null
  );
CREATE TABLE note (
    id integer primary key autoincrement,
    run text not null,
    lane text,
    text text not null,
    sources text not null default '[]',
    created_at text not null
  );
CREATE TABLE hypothesis (
    id text primary key,
    run text not null,
    lane text,
    text text not null,
    supporting text not null default '[]',
    contradicting text not null default '[]',
    created_at text not null
  , question integer, status text not null default 'pool'
    check (status in ('author', 'pool', 'promoted', 'merged', 'retired')), merged_into text, updated_at text);
CREATE TABLE report_section (
    run text not null,
    name text not null,
    body text not null,
    updated_by text not null,
    updated_at text not null,
    primary key (run, name)
  );
CREATE TABLE report_version (
    id integer primary key autoincrement,
    run text not null,
    kind text not null check (kind in ('digest', 'final')),
    body text not null,
    created_at text not null
  );
CREATE TABLE research_query (
    id integer primary key autoincrement,
    run text not null,
    lane text,
    query text not null,
    allowed integer not null,
    reason text,
    created_at text not null
  );
CREATE TABLE audit (
    id integer primary key autoincrement,
    attempt text not null references attempt (id),
    confirm_job integer not null,
    run text not null,
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
CREATE TABLE propagation (
    attempt text primary key references attempt (id),
    run text not null,
    source_rig text not null,
    source_run text not null,
    source_seq integer not null,
    tree text not null,
    created_at text not null,
    result text,
    decided_at text
  );
CREATE TABLE review (
    id integer primary key autoincrement,
    run text not null,
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
CREATE TABLE conclusion (
    id integer primary key autoincrement,
    run text not null,
    kind text not null check (kind in ('not_possible')),
    evidence text not null,
    proposed_at text not null,
    decision text check (decision in ('accepted', 'rejected')),
    note text,
    decided_at text
  );
CREATE TABLE agent_message (
    id integer primary key autoincrement,
    run text not null,
    target text not null,
    text text not null,
    issued_by text not null,
    created_at text not null,
    delivered_at text,
    delivered_to text
  , keep integer not null default 0, unkept_at text);
INSERT INTO agent_message VALUES(1,'js-1','panel','check the loop bounds','owner','2026-10-27T21:48:42.701Z',NULL,NULL,0,NULL);
CREATE TABLE finding (
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
CREATE TABLE research_file (
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
CREATE TABLE agent_message_read (
        id integer primary key autoincrement,
        message integer not null references agent_message (id),
        reader text not null,
        trial text,
        read_at text not null
      );
CREATE TABLE experiment (
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
  , cause text, returns integer not null default 0, question integer, yield text);
CREATE TABLE run_briefing (
    run text not null references run (id),
    seq integer not null,
    text text not null,
    from_campaign text not null,
    from_run text not null,
    from_kind text not null,
    from_ref text not null,
    primary key (run, seq)
  );
CREATE TABLE IF NOT EXISTS "journal_note" (
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
CREATE TABLE IF NOT EXISTS "held_out" (
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
CREATE TABLE question_card (
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
CREATE TABLE review_item (
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
CREATE TABLE item_decision (
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
INSERT INTO sqlite_sequence VALUES('journal_note',0);
INSERT INTO sqlite_sequence VALUES('held_out',0);
INSERT INTO sqlite_sequence VALUES('import',2);
INSERT INTO sqlite_sequence VALUES('event',37);
INSERT INTO sqlite_sequence VALUES('job',4);
INSERT INTO sqlite_sequence VALUES('measurement',17);
INSERT INTO sqlite_sequence VALUES('verdict',3);
INSERT INTO sqlite_sequence VALUES('agent_message',1);
CREATE TRIGGER event_no_update before update on event begin select raise(abort, 'event is append-only'); end;
CREATE TRIGGER event_no_delete before delete on event begin select raise(abort, 'event is append-only'); end;
CREATE TRIGGER verdict_no_update before update on verdict begin select raise(abort, 'verdict is append-only'); end;
CREATE TRIGGER verdict_no_delete before delete on verdict begin select raise(abort, 'verdict is append-only'); end;
CREATE TRIGGER measurement_no_update before update on measurement begin select raise(abort, 'measurement is append-only'); end;
CREATE TRIGGER measurement_no_delete before delete on measurement begin select raise(abort, 'measurement is append-only'); end;
CREATE TRIGGER receipt_no_update before update on receipt begin select raise(abort, 'receipt is append-only'); end;
CREATE TRIGGER receipt_no_delete before delete on receipt begin select raise(abort, 'receipt is append-only'); end;
CREATE TRIGGER contract_no_update before update on contract begin select raise(abort, 'contract versions are immutable'); end;
CREATE TRIGGER contract_no_delete before delete on contract begin select raise(abort, 'contract versions are immutable'); end;
CREATE TRIGGER invalidation_no_update before update on invalidation begin select raise(abort, 'invalidation is append-only'); end;
CREATE TRIGGER invalidation_no_delete before delete on invalidation begin select raise(abort, 'invalidation is append-only'); end;
CREATE TRIGGER champion_no_delete before delete on champion begin select raise(abort, 'champion history is append-only'); end;
CREATE TRIGGER goal_check_no_update before update on goal_check begin select raise(abort, 'goal_check is append-only'); end;
CREATE TRIGGER goal_check_no_delete before delete on goal_check begin select raise(abort, 'goal_check is append-only'); end;
CREATE TRIGGER audit_decided_once before update on audit
    when old.decision is not null begin select raise(abort, 'audit decision is final'); end;
CREATE TRIGGER audit_no_delete before delete on audit begin select raise(abort, 'audit is append-only'); end;
CREATE TRIGGER run_briefing_no_update before update on run_briefing begin select raise(abort, 'a run''s briefing is fixed'); end;
CREATE TRIGGER run_briefing_no_delete before delete on run_briefing begin select raise(abort, 'a run''s briefing is fixed'); end;
CREATE TRIGGER journal_note_no_update before update on journal_note begin select raise(abort, 'field notes are append-only'); end;
CREATE TRIGGER journal_note_no_delete before delete on journal_note begin select raise(abort, 'field notes are append-only'); end;
CREATE TRIGGER held_out_no_update before update on held_out begin select raise(abort, 'held_out is append-only'); end;
CREATE TRIGGER held_out_no_delete before delete on held_out begin select raise(abort, 'held_out is append-only'); end;
CREATE TRIGGER question_card_no_update before update on question_card begin select raise(abort, 'question_card is append-only'); end;
CREATE TRIGGER question_card_no_delete before delete on question_card begin select raise(abort, 'question_card is append-only'); end;
CREATE TRIGGER item_decision_no_update before update on item_decision begin select raise(abort, 'item_decision is append-only'); end;
CREATE TRIGGER item_decision_no_delete before delete on item_decision begin select raise(abort, 'item_decision is append-only'); end;
CREATE INDEX attempt_instance on attempt (run);
CREATE INDEX attempt_parent on attempt (parent_attempt);
CREATE INDEX attempt_commit on attempt (run, commit_sha);
CREATE INDEX attempt_norm on attempt (run, normalized_diff_sha);
CREATE INDEX job_state on job (state, priority, id);
CREATE INDEX verdict_attempt on verdict (attempt);
CREATE INDEX measurement_job on measurement (job, fence);
CREATE INDEX trial_lane on trial (run, lane, epoch);
CREATE INDEX goal_check_instance on goal_check (run, goal);
CREATE UNIQUE INDEX source_url on source (run, url);
CREATE INDEX source_sha on source (run, sha256);
CREATE INDEX trial_token on trial (token_sha);
CREATE UNIQUE INDEX audit_attempt_job on audit (attempt, confirm_job);
CREATE UNIQUE INDEX review_goal_commit on review (run, goal, commit_sha);
CREATE INDEX agent_message_pending on agent_message (run, target) where delivered_at is null;
CREATE INDEX research_file_run on research_file (run, lane, path);
CREATE INDEX agent_message_read_by on agent_message_read (message, reader);
CREATE INDEX experiment_run on experiment (run, state, place);
CREATE INDEX experiment_trial on experiment (trial);
CREATE INDEX journal_note_run on journal_note (run, id);
CREATE INDEX journal_note_lane on journal_note (run, lane, id);
CREATE INDEX event_kind on event (kind, subject);
CREATE INDEX review_item_review on review_item (review, kind, key);
CREATE INDEX item_decision_run on item_decision (run, kind, key, id);
COMMIT;
