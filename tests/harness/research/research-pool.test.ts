import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ResearchContract } from "../../../src/core/contract.ts";
import { indexEvent, type KbFields } from "../../../src/core/kb-index.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { ResearchFolder, SAVED_LANES_DIR } from "../../../src/harness/research/folder.ts";
import { NOTE_REPEATS } from "../../../src/harness/research/research/index.ts";
import { researchPackage } from "../../../src/harness/research/review/index.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";
import { researchEnv } from "../../helpers/research-run.ts";

/**
 * Goal 117's bounds on what research workers write: a note that repeats one of the run's newest
 * notes is refused, and hypotheses are a pool with a question, without twins.
 */

/** An open trial of a lane in run r-1, with its token. */
function openTrial(env: ReturnType<typeof makeHarnessEnv>, lane: string, id: string): string {
  const token = randomBytes(16).toString("hex");
  new Registry(env.service.ledger).startTrial({
    id,
    run: "r-1",
    lane,
    epoch: 1,
    family: "explore",
    parent: "research",
    token,
  });
  return token;
}

describe("a note that repeats one already written is refused (goal 117)", () => {
  test("a research note: the same words once folded are refused, with the note they repeat", async () => {
    const { env, research } = await researchEnv();
    const first = research.addNote("r-1", "lane-2", "Closed.");
    for (const again of ["Closed.", "closed", "  CLOSED!  ", "“Closed”"])
      assert.throws(
        () => research.addNote("r-1", "lane-2", again),
        new RegExp(
          `this note repeats note ${first.note} \\(by lane-2, [^)]+\\) word for word: it is not recorded again`,
        ),
      );
    // Other words are another note.
    research.addNote("r-1", "lane-2", "Closed the second question's gap on sources.");
    const n = Number(
      (
        env.service.ledger.db.prepare("select count(*) as n from note where run = 'r-1'").get() as {
          n: number;
        }
      ).n,
    );
    assert.equal(n, 2, "a refused note leaves no record");
  });

  test("only the run's newest notes count: a note older than the last NOTE_REPEATS may be written again", async () => {
    const { research } = await researchEnv();
    research.addNote("r-1", "lane-1", "Kernel launch overhead dominates small batches.");
    for (let i = 0; i < NOTE_REPEATS; i++)
      research.addNote("r-1", "lane-1", `Read source number ${i} for the second question.`);
    assert.doesNotThrow(() =>
      research.addNote("r-1", "lane-1", "Kernel launch overhead dominates small batches."),
    );
  });

  test("a research worker's field note: a repeat of the run's newest field notes is refused in words; other runs keep theirs", async () => {
    const { env } = await researchEnv();
    const token = openTrial(env, "lane-1", "t-1");
    const first = env.service.writeTrialNote(token, { kind: "note", text: "Closed." });
    assert.throws(
      () => env.service.writeTrialNote(token, { kind: "observation", text: "closed" }),
      new RegExp(
        `this note repeats field note #${first.note} \\(by lane-1, [^)]+\\) word for word`,
      ),
    );
    // Another lane's repeat is a repeat too: the run's notes, not the lane's.
    const other = openTrial(env, "lane-2", "t-2");
    assert.throws(() => env.service.writeTrialNote(other, { kind: "note", text: "Closed!" }));
    assert.ok(env.service.writeTrialNote(other, { kind: "note", text: "Closed question 2." }).note);
    // A hill-climb run's workers are not held to it.
    const hc = makeHarnessEnv();
    await hc.service.applyCommand(hc.sign("assign_campaign", hc.assignPayload({})));
    const runOf = hc.service.ledger.db.prepare("select id from run").get() as { id: string };
    const t = randomBytes(16).toString("hex");
    new Registry(hc.service.ledger).startTrial({
      id: "t-h",
      run: runOf.id,
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: hc.seedCommit,
      token: t,
    });
    hc.service.writeTrialNote(t, { kind: "note", text: "Baseline confirmed." });
    assert.doesNotThrow(() =>
      hc.service.writeTrialNote(t, { kind: "note", text: "Baseline confirmed." }),
    );
  });
});

const QUESTIONS = [
  "Which harness designs keep agents productive for days?",
  "What do they cost?",
  "What fails first?",
];
const AUTHORS = "Fresh workers lose nothing that matters.";

/** A run with three questions, the author's hypothesis, and two verified claims to cite. */
async function poolEnv() {
  const { env, research } = await researchEnv({ questions: QUESTIONS, hypotheses: [AUTHORS] });
  const dir = join(env.service.paths.stateDir, "test-archive");
  mkdirSync(dir, { recursive: true });
  const quote = "Workers that start fresh from the ledger keep every result they recorded.";
  const claims: string[] = [];
  for (const [i, host] of ["docs.example.org", "www.example.net"].entries()) {
    const id = `s-00000000000${i}`;
    const path = join(dir, `${id}.txt`);
    writeFileSync(path, `A page: ${quote}`);
    env.service.ledger.db
      .prepare(
        `insert into source (id, run, url, final_url, domain, fetched_at, http_status, content_type, bytes, sha256,
           title, raw_path, text_path, fetched_by) values (?, 'r-1', ?, ?, ?, ?, 200, 'text/plain', 1, ?, null, ?, ?, 'lane-1')`,
      )
      .run(
        id,
        `https://${host}/a`,
        `https://${host}/a`,
        host,
        new Date().toISOString(),
        id,
        path,
        path,
      );
    const c = research.addClaim("r-1", "lane-1", {
      text: i ? "Fresh workers keep every result they recorded." : "Workers keep every result.",
      quotes: [{ source: id, quote }],
      question: 0,
    });
    assert.equal(c.verified, true, JSON.stringify(c.problems));
    claims.push(c.claim);
  }
  const row = (id: string) =>
    env.service.ledger.db.prepare("select * from hypothesis where id = ?").get(id) as Record<
      string,
      unknown
    >;
  const author = String(
    (
      env.service.ledger.db
        .prepare("select id from hypothesis where run = 'r-1' and status = 'author'")
        .get() as { id: string }
    ).id,
  );
  const events = (kind: string) =>
    (
      env.service.ledger.db
        .prepare("select body from event where kind = ? order by id")
        .all(kind) as { body: string }[]
    ).map((e) => JSON.parse(e.body) as Record<string, unknown>);
  return { env, research, claims, row, author, events };
}

describe("the hypothesis pool (goal 117)", () => {
  test("propose_hypothesis: a question the run has, words that are new, verified claims only; each refusal in words", async () => {
    const { research, claims, row, author, events } = await poolEnv();
    const h = research.proposeHypothesis("r-1", "lane-1", {
      text: "  Stateless planners scale to many lanes.  ",
      question: 1,
      supporting: [claims[0], "c-none", claims[0]],
    });
    assert.equal(h.status, "pool");
    assert.equal(h.question, 1);
    assert.deepEqual(h.supporting, [claims[0]]);
    assert.deepEqual(h.ignored, ["c-none"]);
    assert.match(h.note, /only the author's hypotheses and promoted ones need a verdict/);
    const r = row(h.hypothesis);
    assert.deepEqual(
      [r.status, r.question, r.text, r.lane],
      ["pool", 1, "Stateless planners scale to many lanes.", "lane-1"],
    );
    assert.deepEqual(events("hypothesis_added").at(-1), {
      hypothesis: h.hypothesis,
      lane: "lane-1",
      text: "Stateless planners scale to many lanes.",
      supporting: [claims[0]],
      question: 1,
      status: "pool",
    });
    // The brief's own: the author's, about the whole run.
    assert.deepEqual(events("hypothesis_added")[0], {
      hypothesis: author,
      lane: null,
      text: AUTHORS,
      supporting: [],
      from: "brief",
      question: null,
      status: "author",
    });
    // Repeats, once folded, are refused with the one they repeat.
    assert.throws(
      () =>
        research.proposeHypothesis("r-1", "lane-2", {
          text: "stateless planners scale to MANY lanes!",
        }),
      new RegExp(
        `this hypothesis repeats ${h.hypothesis} \\(proposed by lane-1\\): change that one with revise_hypothesis \\(id ${h.hypothesis}\\)`,
      ),
    );
    assert.throws(
      () =>
        research.proposeHypothesis("r-1", "lane-2", {
          text: "Fresh workers lose nothing that matters",
        }),
      new RegExp(
        `this hypothesis repeats ${author}, one of the author's: the review panel gives it a verdict already`,
      ),
    );
    assert.throws(
      () => research.proposeHypothesis("r-1", "lane-2", { text: "   " }),
      /a hypothesis needs its text/,
    );
    assert.throws(
      () => research.proposeHypothesis("r-1", "lane-2", { text: "Another idea.", question: 3 }),
      /no question 3: "question" is the index of one of the campaign's 3 questions, from 0 to 2/,
    );
    assert.throws(
      () => research.proposeHypothesis("r-1", "lane-2", { text: "Another idea.", question: 1.5 }),
      /a hypothesis is \{"text", "question"\?: the index of a campaign question, from 0/,
    );
    assert.equal(events("hypothesis_added").length, 2, "nothing refused was recorded");
  });

  test("revise_hypothesis: a pool hypothesis's words, question and claims change; the author's, merged and retired ones are refused", async () => {
    const { env, research, claims, row, author, events } = await poolEnv();
    const a = research.proposeHypothesis("r-1", "lane-1", { text: "Caches help.", question: 0 });
    const b = research.proposeHypothesis("r-1", "lane-2", { text: "Long contexts hurt." });
    const before = String(row(a.hypothesis).updated_at);
    const revised = research.reviseHypothesis("r-1", "lane-2", {
      id: a.hypothesis,
      text: "Caches help long runs most.",
      question: 2,
      supporting: [claims[1], "c-none"],
    });
    assert.deepEqual(
      [revised.status, revised.text, revised.question, revised.supporting, revised.ignored],
      ["pool", "Caches help long runs most.", 2, [claims[1]], ["c-none"]],
    );
    const r = row(a.hypothesis);
    assert.deepEqual(
      [r.text, r.question, r.supporting, r.lane],
      ["Caches help long runs most.", 2, JSON.stringify([claims[1]]), "lane-1"],
      "who proposed it stays",
    );
    assert.ok(String(r.updated_at) >= before);
    assert.deepEqual(events("hypothesis_revised").at(-1), {
      hypothesis: a.hypothesis,
      lane: "lane-2",
      text: "Caches help long runs most.",
      question: 2,
      supporting: [claims[1]],
      status: "pool",
    });
    // The question alone, back to the whole run; then nothing to change.
    assert.equal(
      research.reviseHypothesis("r-1", "lane-1", { id: a.hypothesis, question: null }).question,
      null,
    );
    assert.equal(
      research.reviseHypothesis("r-1", "lane-1", { id: a.hypothesis, question: null }).note,
      "nothing changed",
    );
    assert.throws(
      () => research.reviseHypothesis("r-1", "lane-1", { id: a.hypothesis }),
      /a revision needs what changes: text, question or supporting/,
    );
    assert.throws(
      () =>
        research.reviseHypothesis("r-1", "lane-1", { id: a.hypothesis, supporting: ["c-none"] }),
      /none of c-none is a verified claim of this run: the supporting claims stay as they were/,
    );
    assert.throws(
      () => research.reviseHypothesis("r-1", "lane-1", { id: author, text: "Something else." }),
      new RegExp(
        `hypothesis ${author} is one of the author's: only the campaign's brief changes it`,
      ),
    );
    assert.throws(
      () => research.reviseHypothesis("r-1", "lane-1", { id: "h-nope", text: "x" }),
      /no hypothesis h-nope in this run/,
    );
    // New words that repeat another live hypothesis merge this one into it.
    const merged = research.reviseHypothesis("r-1", "lane-1", {
      id: b.hypothesis,
      text: "caches help long runs most",
    });
    assert.deepEqual([merged.status, merged.merged_into], ["merged", a.hypothesis]);
    assert.match(String(merged.note), new RegExp(`work on ${a.hypothesis} from now on`));
    assert.deepEqual(
      [row(b.hypothesis).status, row(b.hypothesis).merged_into],
      ["merged", a.hypothesis],
    );
    assert.deepEqual(events("hypothesis_merged").at(-1), {
      hypothesis: b.hypothesis,
      into: a.hypothesis,
      lane: "lane-1",
      text: "caches help long runs most",
      question: null,
      supporting: [],
    });
    assert.throws(
      () => research.reviseHypothesis("r-1", "lane-2", { id: b.hypothesis, text: "Back again." }),
      new RegExp(
        `hypothesis ${b.hypothesis} was merged into ${a.hypothesis}: revise ${a.hypothesis} instead`,
      ),
    );
    // A merged hypothesis is not live: its first words may be proposed again.
    assert.ok(
      research.proposeHypothesis("r-1", "lane-2", { text: "Long contexts hurt." }).hypothesis,
    );
    env.service.ledger.db
      .prepare("update hypothesis set status = 'retired' where id = ?")
      .run(a.hypothesis);
    assert.throws(
      () => research.reviseHypothesis("r-1", "lane-2", { id: a.hypothesis, text: "x y z" }),
      new RegExp(`hypothesis ${a.hypothesis} is retired`),
    );
  });

  test("at the scale of a long run: hundreds proposed, every repeat refused, the review package holds only those that need a verdict", async () => {
    const { env, research, author } = await poolEnv();
    const ids: string[] = [];
    for (let i = 0; i < 300; i++)
      ids.push(
        research.proposeHypothesis("r-1", `lane-${(i % 4) + 1}`, {
          text: `Hypothesis number ${i}: tiling ${i} helps.`,
          question: i % 3,
        }).hypothesis,
      );
    let refused = 0;
    for (let i = 0; i < 300; i++) {
      try {
        research.proposeHypothesis("r-1", "lane-1", {
          text: `hypothesis number ${i} tiling ${i} helps`,
        });
      } catch (err) {
        assert.match(String(err), new RegExp(`repeats ${ids[i]}`));
        refused++;
      }
    }
    assert.equal(refused, 300, "every twin is refused");
    const n = (sql: string) =>
      Number((env.service.ledger.db.prepare(sql).get() as { n: number }).n);
    assert.equal(n("select count(*) as n from hypothesis where run = 'r-1'"), 301);
    // A promoted one needs a verdict too; the pool does not.
    env.service.ledger.db
      .prepare("update hypothesis set status = 'promoted' where id = ?")
      .run(ids[7] as string);
    const contract = env.service.contractFor("r-1") as ResearchContract;
    const pkg = researchPackage(env.service.ledger, "r-1", contract);
    assert.deepEqual(
      pkg.hypotheses.map((h) => h.id),
      [author, ids[7]],
    );
  });

  test("the folder, the brief and the knowledge base show each hypothesis's status and question, the author's first", async () => {
    const { env, research, claims, author, events } = await poolEnv();
    const folder = new ResearchFolder({
      ledger: env.service.ledger,
      scratchRoot: join(env.service.paths.scratchDir, "research"),
      stateRoot: join(env.service.paths.stateDir, SAVED_LANES_DIR),
      runner: new LocalRunner(env.service.paths.scratchDir),
    });
    const p = research.proposeHypothesis("r-1", "lane-1", {
      text: "Caches help.",
      question: 1,
      supporting: [claims[0]],
    });
    const root = folder.sync("r-1");
    const file = () => readFileSync(join(root, "hypotheses", `${p.hypothesis}.md`), "utf8");
    assert.match(
      file(),
      new RegExp(
        `^# Hypothesis ${p.hypothesis}: in the pool\\n\\nCaches help\\.\\n\\nAbout: Question 2 \\(index 1\\): What do they cost\\?`,
      ),
    );
    assert.match(
      file(),
      /Only the author's hypotheses and promoted ones need a verdict from the review panel/,
    );
    assert.match(
      readFileSync(join(root, "hypotheses", `${author}.md`), "utf8"),
      /: the author's, which needs a verdict\n[\s\S]*About: the whole run[\s\S]*by the campaign's author/,
    );
    const index = readFileSync(join(root, "INDEX.md"), "utf8");
    assert.match(index, /- hypotheses\/: 2 \(1 that need a verdict, 1 in the pool\)/);
    const listed = index.split("## Hypotheses\n\n")[1] ?? "";
    assert.match(listed, /^Only the author's hypotheses and promoted ones need a verdict/);
    assert.ok(listed.indexOf(author) < listed.indexOf(p.hypothesis), "the author's first");
    assert.match(
      listed,
      new RegExp(`- ${p.hypothesis} \\(in the pool; Question 2 \\(index 1\\)\\): Caches help\\.`),
    );
    // A revision changes its file.
    research.reviseHypothesis("r-1", "lane-2", { id: p.hypothesis, text: "Caches help most." });
    folder.sync("r-1");
    assert.match(file(), /Caches help most\.[\s\S]*Changed: /);
    // The brief: the rule, those that need a verdict, the pool.
    const brief = research.hypothesesBrief("r-1");
    assert.match(
      brief,
      /^# Hypotheses\nOnly the author's hypotheses and promoted ones need a verdict/,
    );
    assert.match(
      brief,
      new RegExp(
        `They need a verdict:\\n- ${author} \\(the author's, which needs a verdict; the whole run\\): Fresh workers`,
      ),
    );
    assert.match(
      brief,
      new RegExp(
        `The pool has 1:\\n- ${p.hypothesis} \\(in the pool; Question 2 \\(index 1\\)\\): Caches help most\\.`,
      ),
    );
    // The knowledge base: each event changes the hypothesis's item.
    const items = new Map<string, KbFields>();
    const target = {
      runCreated: () => {},
      item: (_r: string, _k: string, ref: string) => {
        const x = items.get(ref);
        return x?.body === undefined ? undefined : { body: x.body, meta: x.meta ?? {} };
      },
      attempt: () => undefined,
      put: (_r: string, _k: string, ref: string, f: KbFields) => {
        items.set(ref, { ...items.get(ref), ...f });
      },
    };
    const kinds = ["hypothesis_added", "hypothesis_revised", "hypothesis_merged"];
    for (const kind of kinds)
      for (const body of events(kind))
        indexEvent(target, {
          at: "t",
          actor: String(body.lane ?? "x"),
          kind,
          subject: "r-1",
          body,
        });
    assert.equal(
      items.get(p.hypothesis)?.body,
      [
        "Caches help most.",
        "Question 2 (index 1)",
        "Status: in the pool",
        `Supporting claims: ${claims[0]}`,
        "Changed by lane-2.",
      ].join("\n"),
    );
    assert.equal(items.get(p.hypothesis)?.by, "lane-1", "who proposed it");
    assert.match(String(items.get(author)?.body), /Status: the author's, which needs a verdict/);
  });
});

describe("measurements stay out of a research run's queue (goal 117)", () => {
  test("a worker's idea that asks for a measurement is refused in words; one sources can answer is proposed", async () => {
    const { env } = await researchEnv();
    const token = openTrial(env, "lane-1", "t-1");
    assert.throws(
      () =>
        env.service.proposeIdea(token, {
          title: "Check preemption",
          details: "Run the litmus tests on the card and compare",
        }),
      /this asks for a measurement \("Run the litmus tests on the card"\), and a research run measures nothing: record it as a next experiment in a report section or a note/,
    );
    const ok = env.service.proposeIdea(token, {
      title: "Find the vendor's documentation of compute preemption",
    });
    assert.equal(ok.state, "proposed");
    assert.equal(
      env.service.queue.all("r-1").filter((x) => x.added_by === "lane-1").length,
      1,
      "the refused idea left no record",
    );
  });

  test("a teacher's item that asks for a measurement, or names no question, is refused, the others are added; a hill-climb run's teachers keep theirs", async () => {
    const { env } = await researchEnv();
    const out = env.service.advisorQueue({
      run: "r-1",
      role: "teacher",
      add: [
        {
          title: "Shared-memory bank conflicts on Maxwell",
          details:
            "Mechanism: … Smallest discriminating experiment: profile the kernel with Nsight",
          why: "it may explain the stalls",
        },
        {
          title: "Primary sources on Maxwell's shared memory banks",
          details: "Find NVIDIA's own documentation and papers that describe the bank layout",
          why: "the second question has one source",
          question: 0,
        },
        // A task names its question (goal 117): in its field, or in a labelled title.
        {
          title: "Question 1 (index 0): vendor talks on the bank layout",
          why: "a talk names it",
        },
        { title: "Any source on banks", why: "more is better" },
      ],
      move: [],
    });
    assert.equal(out.added.length, 2);
    assert.deepEqual(
      out.added.map((id) => env.service.queue.get(id)?.question),
      [0, 0],
    );
    assert.deepEqual(out.refused, [
      `add "Shared-memory bank conflicts on Maxwell": this asks for a measurement ("Smallest discriminating experiment"), and a research run measures nothing: record it as a next experiment in a report section or a note (what it would settle, and how), and propose only work that sources can answer`,
      `add "Any source on banks": a research run's task names the question it serves (question, an index from 0)`,
    ]);
    const hc = makeHarnessEnv();
    await hc.service.applyCommand(hc.sign("assign_campaign", hc.assignPayload({})));
    const run = (hc.service.ledger.db.prepare("select id from run").get() as { id: string }).id;
    const kept = hc.service.advisorQueue({
      run,
      role: "teacher",
      add: [{ title: "Profile the kernel and time each tile size", why: "find the bottleneck" }],
      move: [],
    });
    assert.equal(kept.added.length, 1, "a hill climb measures: its teachers' items stand");
  });
});

/** A source archived for the run, as fetched by a lane now. */
function archive(
  env: ReturnType<typeof makeHarnessEnv>,
  id: string,
  host: string,
  text: string,
  lane: string,
): void {
  const dir = join(env.service.paths.stateDir, "test-archive");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.txt`);
  writeFileSync(path, text);
  env.service.ledger.db
    .prepare(
      `insert into source (id, run, url, final_url, domain, fetched_at, http_status, content_type, bytes, sha256,
         title, raw_path, text_path, fetched_by) values (?, 'r-1', ?, ?, ?, ?, 200, 'text/plain', 1, ?, null, ?, ?, ?)`,
    )
    .run(
      id,
      `https://${host}/p`,
      `https://${host}/p`,
      host,
      new Date().toISOString(),
      id,
      path,
      path,
      lane,
    );
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("a research task's question and yield (goal 117)", () => {
  test("a task keeps its question: given, or from a 'Question N (index K)' title; a question the run lacks is refused", async () => {
    const { env } = await poolEnv();
    const q = env.service.queue;
    const given = q.add("r-1", { title: "Primary sources", by: "owner", question: 2 }, "owner");
    assert.equal(given.question, 2);
    const titled = q.add(
      "r-1",
      { title: "Question 2 (index 1): find a second site", by: "teacher" },
      "teacher",
    );
    assert.equal(titled.question, 1);
    assert.equal(
      q.add("r-1", { title: "Question 9 (index 8): x", by: "teacher" }, "t").question,
      null,
    );
    assert.equal(q.add("r-1", { title: "Read more", by: "owner" }, "owner").question, null);
    assert.throws(
      () => q.add("r-1", { title: "Out of range", by: "owner", question: 3 }, "owner"),
      /no question 3: a task's "question" is the index of one of the campaign's 3 questions, from 0 to 2/,
    );
    // An advisor's item and a worker's idea take one too; a wrong one is refused in words.
    const out = env.service.advisorQueue({
      run: "r-1",
      role: "teacher",
      add: [
        { title: "Costs in vendor docs", why: "q2 has one source", question: 1 },
        { title: "Nothing there", why: "x", question: 7 },
      ],
      move: [],
    });
    assert.equal(q.get(out.added[0] as string)?.question, 1);
    assert.match(String(out.refused[0]), /^add "Nothing there": no question 7/);
    const token = openTrial(env, "lane-1", "t-q");
    const idea = env.service.proposeIdea(token, { title: "Failure reports", question: 2 });
    assert.equal(q.get(idea.experiment)?.question, 2);
    assert.deepEqual(
      q
        .brief("r-1")
        .up_next.filter((x) => x.id === given.id)
        .map((x) => x.question),
      [2],
    );
    // Another mode's experiments name no question.
    const hc = makeHarnessEnv();
    await hc.service.applyCommand(hc.sign("assign_campaign", hc.assignPayload({})));
    const run = (hc.service.ledger.db.prepare("select id from run").get() as { id: string }).id;
    assert.throws(
      () => hc.service.queue.add(run, { title: "x", by: "owner", question: 0 }, "owner"),
      /only a research run's tasks name a question/,
    );
  });

  test("a trial's yield: its verified claims by question, sites new to each question and to the run, its findings", async () => {
    const { env, research, claims } = await poolEnv();
    await tick();
    new Registry(env.service.ledger).startTrial({
      id: "t-y",
      run: "r-1",
      lane: "lane-2",
      epoch: 2,
      family: "primary",
      parent: "research",
    });
    await tick();
    const quote = "A second page says the workers keep every result they recorded.";
    // example.org is cited for question 0 already (docs.example.org); example.com is new.
    archive(env, "s-0000000000b1", "blog.example.org", `Text: ${quote}`, "lane-2");
    archive(env, "s-0000000000b2", "www.example.com", `Text: ${quote}`, "lane-2");
    const claim = (text: string, source: string, question?: number) =>
      research.addClaim("r-1", "lane-2", {
        text,
        quotes: [{ source, quote }],
        ...(question === undefined ? {} : { question }),
      });
    assert.equal(
      claim("A second page says workers keep results.", "s-0000000000b1", 0).verified,
      true,
    );
    assert.equal(claim("Workers keep every recorded result.", "s-0000000000b1", 1).verified, true);
    // The run has three questions: a claim names the one it answers, or it is not recorded.
    assert.throws(
      () => claim("The workers keep every result they recorded.", "s-0000000000b2"),
      /give "question": the index of the campaign question this claim answers, from 0 to 2/,
    );
    assert.throws(
      () => claim("The workers keep every result they recorded.", "s-0000000000b2", 3),
      /no question 3/,
    );
    assert.equal(
      claim("The workers keep every result they recorded.", "s-0000000000b2", 1).verified,
      true,
    );
    assert.equal(claim("Workers keep 9 results.", "s-0000000000b2", 2).verified, false, "a draft");
    research.addFinding("r-1", "lane-2", {
      text: "Workers keep what they record.",
      summary: "Two sites say so.",
      why_it_matters: "Nothing is lost.",
      supporting: [claims[0] as string],
    });
    // Another lane's work in the same time is not this trial's.
    research.addNote("r-1", "lane-1", "A note of another lane.");
    const y = research.trialYield("r-1", "t-y");
    assert.deepEqual(y, {
      verified_claims: 3,
      by_question: [
        { question: 0, verified_claims: 1, new_domain_claims: 0 },
        { question: 1, verified_claims: 2, new_domain_claims: 2 },
      ],
      new_domains: 1,
      domains: ["example.com"],
      findings: 1,
      card_changes: 0,
    });
    assert.equal(research.trialYield("r-1", "t-none"), undefined);
    // Kept with the task when its trial ends, in its event, and in the queue's brief.
    const q = env.service.queue;
    const task = q.add("r-1", { title: "Primary sources", by: "planner", question: 0 }, "planner");
    q.assign("r-1", task.id, { lane: "lane-2", trial: "t-y", by: "planner" }, "planner");
    q.finish("t-y", { result: "finished", yield: y }, "planner");
    assert.deepEqual(JSON.parse(String(q.get(task.id)?.yield)), y);
    const finished = env.service.ledger.db
      .prepare("select body from event where kind = 'experiment_finished' order by id desc limit 1")
      .get() as { body: string };
    assert.deepEqual(JSON.parse(finished.body).yield, y);
    const tried = q.brief("r-1").tried.find((x) => x.id === task.id);
    assert.deepEqual([tried?.question, tried?.yield], [0, y]);
    // The knowledge base's item for it says what it added.
    const items = new Map<string, KbFields>();
    const target = {
      runCreated: () => {},
      item: (_r: string, _k: string, ref: string) => {
        const x = items.get(ref);
        return x?.body === undefined ? undefined : { body: x.body, meta: x.meta ?? {} };
      },
      attempt: () => undefined,
      put: (_r: string, _k: string, ref: string, f: KbFields) => {
        items.set(ref, { ...items.get(ref), ...f });
      },
    };
    for (const kind of ["experiment_added", "experiment_finished"])
      for (const e of env.service.ledger.db
        .prepare("select actor, body from event where kind = ? order by id")
        .all(kind) as { actor: string; body: string }[])
        indexEvent(target, {
          at: "t",
          actor: e.actor,
          kind,
          subject: "r-1",
          body: JSON.parse(e.body),
        });
    assert.equal(
      items.get(task.id)?.body,
      "About: Question 1 (index 0)\nResult: no attempt (finished); it added 3 verified claims, 1 new domains and 1 findings",
    );
  });
});
