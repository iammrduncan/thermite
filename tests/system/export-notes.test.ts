import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseContract } from "../../src/core/contract.ts";
import { Registry } from "../../src/harness/agents/registry.ts";
import { LocalRunner } from "../../src/harness/broker/runner.ts";
import { ResearchFolder } from "../../src/harness/research/folder.ts";
import { Research } from "../../src/harness/research/research/index.ts";
import { exportOnce } from "../../src/supervisor/git-export.ts";
import { controlStore, ingestReport } from "../helpers/control-store.ts";
import { researchFixture } from "../helpers/fixtures.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

const RUN = "smoke-1";
const BRIEFING = [
  {
    text: "Vector loads need 16-byte aligned pointers.",
    from: { campaign: "kernels", run: "kernels-7", kind: "note", ref: "12" },
  },
];
const lane = {
  by: "lane-1",
  actor: "trial:t-1",
  source: "trial:t-1",
  lane: "lane-1",
  trial: "t-1",
};

/** A hill climb with its research folder and research service wired as the controller does. */
async function setup() {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(
    env.sign("assign_campaign", env.assignPayload({ briefing: BRIEFING })),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  const { stateDir, scratchDir } = env.service.paths;
  const folder = new ResearchFolder({
    ledger: env.service.ledger,
    scratchRoot: join(scratchDir, "research"),
    stateRoot: join(stateDir, "research-work"),
    runner: new LocalRunner(scratchDir),
    knowledge: env.service.knowledge,
  });
  const research = new Research(env.service.ledger, stateDir, {
    onChange: (run) => void folder.sync(run),
  });
  env.service.researchFolder = (run) => folder.exportFiles(run);
  return { env, s: env.service, research };
}

const lines = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const manifestOf = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
    files: Record<string, string>;
  };

describe("a run's export holds its journal, its research notes and its briefing", () => {
  test("each export holds what was recorded since the last one", async () => {
    const { s, research } = await setup();
    const first = s.journal.write(RUN, { kind: "lesson", text: "Profile first." }, lane);
    research.addNote(RUN, "lane-1", "The guide says loads should be aligned.", [], "t-1");
    const one = await s.export("test");
    assert.deepEqual(lines(join(one.dir, "journal.jsonl")), [
      {
        id: first.id,
        run: RUN,
        by: "lane-1",
        kind: "lesson",
        text: "Profile first.",
        about: { type: "run", id: RUN },
        lane: "lane-1",
        trial: "t-1",
        at: first.at,
      },
    ]);
    assert.deepEqual(
      lines(join(one.dir, "research-notes.jsonl")).map((n) => [n.run, n.lane, n.text, n.sources]),
      [[RUN, "lane-1", "The guide says loads should be aligned.", []]],
    );
    assert.deepEqual(lines(join(one.dir, "briefing.jsonl")), [
      { run: RUN, seq: 1, ...BRIEFING[0] },
    ]);
    const files = manifestOf(one.dir).files;
    for (const f of ["journal.jsonl", "research-notes.jsonl", "briefing.jsonl"])
      assert.match(String(files[f]), /^[0-9a-f]{64}$/, f);
    // The next export: only the new note; the run's briefing went with its creation.
    const second = s.journal.write(RUN, { kind: "question", text: "Is it L2-bound?" }, lane);
    const two = await s.export("test");
    assert.deepEqual(
      lines(join(two.dir, "journal.jsonl")).map((n) => n.id),
      [second.id],
    );
    assert.ok(!existsSync(join(two.dir, "briefing.jsonl")));
    assert.ok(!existsSync(join(two.dir, "research-notes.jsonl")));
    // An export with no new note still holds an (empty) journal.
    const three = await s.export("test");
    assert.equal(readFileSync(join(three.dir, "journal.jsonl"), "utf8"), "");
  });

  test("a closed hill climb that recorded research exports its folder, without past research, and the supervisor pushes it", async () => {
    const { env, s, research } = await setup();
    s.journal.write(RUN, { kind: "observation", text: "The loop is memory bound." }, lane);
    research.addNote(RUN, "lane-1", "Aligned loads matter.", [], "t-1");
    s.writeKnowledge(RUN, [
      {
        seq: 1,
        campaign: "kernels",
        rig: "rig-b",
        run: "kernels-7",
        kind: "note",
        ref: "12",
        title: "aligned loads",
        body: "Vector loads need 16-byte aligned pointers.",
        by: "lane-2",
        url: null,
        sub: "lesson",
        at: "2026-10-16T00:00:00.000Z",
        updated_at: "2026-10-16T00:00:00.000Z",
      },
    ]);
    // A prompt a lane's worker was sent (goal 166): kept with the run, and pushed compressed.
    s.ledger.prompts.record("harness", RUN, {
      role: "worker",
      program: "pi",
      lane: "lane-1",
      trial: "t-1",
      call: null,
      sections: [{ id: "brief", source: "assignment", part: "message", text: "Make it faster." }],
    });
    s.ledger.runs.setStatus(RUN, "closed", "done", "test");
    const exp = await s.export("test");
    const files = Object.keys(manifestOf(exp.dir).files);
    assert.ok(files.includes(`research/${RUN}/folder/INDEX.md`), files.join(", "));
    assert.ok(files.includes(`research/${RUN}/folder/notes/note-00001.md`));
    assert.ok(!files.some((f) => f.includes("/knowledge/")), "past research is other runs'");

    const root = mkdtempSync(join(tmpdir(), "thermite-results-"));
    const remote = join(root, "remote.git");
    mkdirSync(remote);
    execFileSync("git", ["-C", remote, "init", "--bare", "--quiet"]);
    const state = await exportOnce(
      {
        rig: "rig-a",
        outboxDir: env.service.paths.outboxDir,
        workDir: join(root, "work"),
        remote: `file://${remote}`,
      },
      { done: [] },
    );
    assert.equal(state.lastError, undefined);
    const pushed = execFileSync(
      "git",
      ["-C", remote, "ls-tree", "-r", "--name-only", "thermite/rig-a/attempts"],
      { encoding: "utf8" },
    )
      .trim()
      .split("\n");
    const name = exp.dir.split("/").pop();
    for (const f of [
      `journal/${name}.jsonl`,
      `research-notes/${name}.jsonl`,
      `briefing/${name}.jsonl`,
      `knowledge/${name}.jsonl`,
      `prompts/${name}.jsonl.gz`,
      `research/${RUN}/folder/INDEX.md`,
    ])
      assert.ok(pushed.includes(f), `${f} in ${pushed.join(", ")}`);
  });

  test("a full export holds every run's research folder, finished or not; a normal one only finished runs'", async () => {
    const { env, s, research } = await setup();
    // A research run, still running, and the hill climb that recorded a note, not closed.
    const parsed = parseContract({ ...researchFixture, lanes: { count: 1, trials_per_epoch: 1 } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const out = await s.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    research.addNote("r-1", "lane-1", "The paper's table 3 has the numbers.", [], "t-9");
    research.addNote(RUN, "lane-1", "Aligned loads matter.", [], "t-1");
    assert.notEqual(s.ledger.runs.get("r-1")?.status, "closed");
    assert.notEqual(s.ledger.runs.get(RUN)?.status, "closed");
    const folderFiles = (dir: string, run: string) =>
      Object.keys(manifestOf(dir).files).filter((f) => f.startsWith(`research/${run}/folder`));

    const normal = await s.export("test");
    assert.deepEqual(folderFiles(normal.dir, "r-1"), [], "a normal export waits for the run's end");
    assert.deepEqual(folderFiles(normal.dir, RUN), []);

    const full = await s.export("test", { full: true });
    const name = full.dir.split("/").pop();
    const m = manifestOf(full.dir) as { full?: boolean; files: Record<string, string> };
    assert.equal(m.full, true);
    for (const run of ["r-1", RUN]) {
      // Beside the place the run's end exports to, under the export's name.
      const place = `research/${run}/folder-${name}`;
      const files = folderFiles(full.dir, run);
      assert.ok(
        files.length > 0 && files.every((f) => f.startsWith(`${place}/`)),
        files.join(", "),
      );
      assert.ok(files.includes(`${place}/INDEX.md`), `${run}: ${files.join(", ")}`);
      assert.ok(
        files.some((f) => f.startsWith(`${place}/notes/`)),
        `${run}'s notes: ${files.join(", ")}`,
      );
      for (const f of files) assert.ok(existsSync(join(full.dir, f)), f);
    }
    const notes = folderFiles(full.dir, "r-1").filter((f) => f.includes("/notes/"));
    assert.ok(
      notes.some((f) => readFileSync(join(full.dir, f), "utf8").includes("table 3")),
      notes.join(", "),
    );
    // The run's end still exports its folder at its own place.
    s.ledger.runs.setStatus(RUN, "closed", "done", "test");
    const last = await s.export("test");
    assert.ok(folderFiles(last.dir, RUN).includes(`research/${RUN}/folder/INDEX.md`));
  });

  test("a run's export holds that run alone, from its start, outside the rig's chain of exports (goal 103)", async () => {
    const { env, s, research } = await setup();
    const parsed = parseContract({ ...researchFixture, lanes: { count: 1, trials_per_epoch: 1 } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const out = await s.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    research.addNote("r-1", "lane-1", "The paper's table 3 has the numbers.", [], "t-9");
    research.addNote(RUN, "lane-1", "Aligned loads matter.", [], "t-1");
    // The chain: a normal export first.
    const before = await s.export("test");
    const chain = s.ledger.exports.last();

    // Through the command, as Export on the run's page sends it.
    const r = (await s.applyCommand(env.sign("export_now", { run: "r-1" }))) as {
      status: string;
      result?: { export: string; export_id: number };
    };
    assert.equal(r.status, "applied", JSON.stringify(r));
    const name = String(r.result?.export);
    const dir = join(s.paths.outboxDir, name);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      run?: string;
      full?: boolean;
      from_event: number;
      files: Record<string, string>;
    };
    assert.equal(m.run, "r-1");
    assert.equal(m.full, undefined);
    assert.equal(m.from_event, 0, "from the run's start");
    assert.equal(r.result?.export_id, 0, "not in the rig's chain");
    const files = Object.keys(m.files);
    assert.ok(!files.includes("ledger.sqlite"), "the ledger is every run's");
    assert.ok(!files.some((f) => f.startsWith(`research/${RUN}/`)), files.join(", "));
    assert.ok(files.includes(`research/r-1/folder-${name}/INDEX.md`), files.join(", "));
    // Its events and notes are the run's alone.
    const events = lines(join(dir, "events.jsonl"));
    assert.ok(events.length > 0);
    assert.ok(
      events.every(
        (e) => e.subject === "r-1" || (e.body as { run?: string } | null)?.run === "r-1",
      ),
      JSON.stringify(events.map((e) => [e.kind, e.subject])),
    );
    assert.ok(
      events.some((e) => e.kind === "run_created"),
      "from its start",
    );
    assert.deepEqual(
      lines(join(dir, "research-notes.jsonl")).map((n) => n.run),
      ["r-1"],
    );
    // The chain is as it was: the next export starts where the last of the chain ended.
    assert.deepEqual(s.ledger.exports.last(), chain);
    research.addNote(RUN, "lane-1", "After the run's export.", [], "t-1");
    const next = await s.export("test");
    const nm = manifestOf(next.dir) as { from_event?: number };
    assert.equal(
      nm.from_event,
      (manifestOf(before.dir) as { through_event?: number }).through_event,
    );

    // The supervisor pushes its research folder too, as a full export's.
    const root = mkdtempSync(join(tmpdir(), "thermite-results-"));
    const remote = join(root, "remote.git");
    mkdirSync(remote);
    execFileSync("git", ["-C", remote, "init", "--bare", "--quiet"]);
    const state = await exportOnce(
      {
        rig: "rig-a",
        outboxDir: s.paths.outboxDir,
        workDir: join(root, "work"),
        remote: `file://${remote}`,
      },
      { done: [] },
    );
    assert.equal(state.lastError, undefined);
    const pushed = execFileSync(
      "git",
      ["-C", remote, "ls-tree", "-r", "--name-only", "thermite/rig-a/attempts"],
      { encoding: "utf8" },
    );
    assert.match(pushed, new RegExp(`research/r-1/folder-${name}/INDEX\\.md`));
  });

  test("an export holds the run's part of its campaign's folder: the items control files, each with its origin", async () => {
    const { s, research } = await setup();
    const reg = new Registry(s.ledger);
    reg.startTrial({
      id: "t-1",
      run: RUN,
      lane: "lane-1",
      epoch: 1,
      family: "loads",
      parent: "p",
      focus: "align the loads",
    });
    const x = s.queue.add(RUN, { title: "Align the loads", by: "owner", why: "the guide" }, "t");
    s.journal.write(RUN, { kind: "lesson", text: "Profile first." }, lane);
    research.addNote(RUN, "lane-1", "The guide says loads should be aligned.", [], "t-1");
    reg.finishTrial(
      "t-1",
      { stopped: "no_submission", turns: 4, toolCalls: 2, tokensIn: 1000, tokensOut: 100 },
      "scheduler",
    );
    const one = await s.export("test");
    const part = lines(join(one.dir, "knowledge.jsonl"));
    assert.match(String(manifestOf(one.dir).files["knowledge.jsonl"]), /^[0-9a-f]{64}$/);
    assert.deepEqual(part.map((i) => `${i.kind} ${i.ref}`).sort(), [
      `experiment ${x.id}`,
      "note 1",
      "note rn-1",
      `run ${RUN}`,
      "trial t-1",
    ]);
    for (const i of part) {
      assert.equal(i.rig, s.rig);
      assert.equal(i.run, RUN);
      assert.equal(i.campaign, s.ledger.runs.get(RUN)?.campaign);
      assert.ok(i.by && i.at && i.updated_at, "who wrote it and when");
    }
    assert.match(
      String(part.find((i) => i.kind === "trial")?.body),
      /Ended: no submission; 4 turns/,
    );
    // The same items control files from the same events, field by field.
    const store = controlStore();
    const events = s.ledger.eventsAfter(0, 100_000).events;
    await ingestReport(store, {
      rig: s.rig,
      ledger_id: "l-1",
      cursor: 0,
      next: events.length,
      generated_at: new Date().toISOString(),
      events,
      summary: {},
    });
    const filed = store
      .kb()
      .changedAfter([String(s.ledger.runs.get(RUN)?.campaign)], 0)
      .map(({ campaign, rig, run, kind, ref, title, body, by, url, sub, at, updated_at }) => ({
        campaign,
        rig,
        run,
        kind,
        ref,
        title,
        body,
        by,
        url,
        sub,
        at,
        updated_at,
      }));
    const key = (i: Record<string, unknown>) => `${i.kind} ${i.ref}`;
    assert.deepEqual(
      [...part].sort((a, b) => key(a).localeCompare(key(b))),
      [...filed].sort((a, b) => key(a).localeCompare(key(b))),
    );
    // The next export holds only what changed since: the run's new status.
    s.ledger.runs.setStatus(RUN, "paused", "the owner paused it", "test");
    const two = await s.export("test");
    const changed = lines(join(two.dir, "knowledge.jsonl"));
    assert.deepEqual(
      changed.map((i) => `${i.kind} ${i.ref}`),
      [`run ${RUN}`],
    );
    assert.match(String(changed[0]?.body), /Status: paused \(the owner paused it\)$/);
    // Nothing changed: no part in the export.
    const three = await s.export("test");
    assert.ok(!existsSync(join(three.dir, "knowledge.jsonl")));
  });
});
