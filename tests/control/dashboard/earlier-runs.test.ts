import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * A run's pages, links and records stay whole wherever it ran (goal 170): when its rig is
 * retired, and when its rig's full reset starts a new ledger. Each such run is under its
 * campaign's Earlier runs, marked, and opens like any run: its page and tabs, its attempts, its
 * champion's patch and its Live; REST and MCP read it by its name; a command to it is refused in
 * words, since its rig takes none for it.
 */

const SEED = "a".repeat(40);
const PATCH = Buffer.from("diff --git a/sort.c b/sort.c\n+radix\n");
const SHA = createHash("sha256").update(PATCH).digest("hex");
const TOKENS = { "rig-a": "rig-token-aaaaaa", "rig-b": "rig-token-bbbbbb" };

type Ev = { kind: string; subject: string | null; body: Record<string, unknown> };

/** A run of the campaign sort, with one attempt that became its champion #2. */
function runEvents(run: string, attempt: string, hypothesis: string, status: string): Ev[] {
  return [
    {
      kind: "run_created",
      subject: run,
      body: { campaign: "sort", version: 1, mode: "hill_climb", seed: { repo: "p", commit: SEED } },
    },
    {
      kind: "attempt_recorded",
      subject: attempt,
      body: { run, lane: "lane-1", lifecycle: "queued", hypothesis },
    },
    { kind: "verdict", subject: attempt, body: { verdict: "win_confirmed", delta: 0.2 } },
    { kind: "champion_promoted", subject: run, body: { seq: 2, attempt, commit: "c".repeat(40) } },
    {
      kind: "champion_published",
      subject: run,
      body: { seq: 2, repo: "p", base_commit: "b".repeat(40), tree: "t", sha256: SHA },
    },
    { kind: "run_status", subject: run, body: { status, reason: null } },
  ];
}

async function earlierRuns() {
  const { store, control, api } = controlOnly({ tokens: { rigs: TOKENS } });
  const at = Date.now() - 3_600_000;
  const report = async (rig: string, ledger: string, events: Ev[], hour: number) => {
    await ingestReport(store, {
      rig,
      ledger_id: ledger,
      cursor: 0,
      next: events.length,
      events: events.map((e, i) => ({
        id: i + 1,
        at: new Date(at + hour * 600_000 + i * 1000).toISOString(),
        actor: "harness",
        ...e,
      })),
      summary: {},
    });
  };
  // sort-1 on rig-a, then rig-a's full reset; sort-2 on rig-b, then rig-b retired; sort-3 at work.
  await report("rig-a", "ledger-1", runEvents("sort-1", "a-1", "radix sort", "paused"), 0);
  const upload = await control.request("/v1/rigs/rig-a/champions/sort-1/2/patch", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKENS["rig-a"]}` },
    body: new Uint8Array(PATCH),
  });
  assert.equal(upload.status, 201);
  await report(
    "rig-b",
    "ledger-b",
    runEvents("sort-2", "a-2", "insertion sort below 16", "running"),
    1,
  );
  await report(
    "rig-a",
    "ledger-2",
    runEvents("sort-3", "a-3", "merge runs in place", "running"),
    2,
  );
  store.retired.add("rig-b", "owner:ui");
  const ui = await signIn(control);
  return { store, control, api, ui };
}

test("a run of a retired rig, and one from before its rig's full reset, are under Earlier runs, marked, and open like any run", async () => {
  const { ui } = await earlierRuns();
  const campaign = await ui.page("/ui/campaigns/sort");
  // At work now: only the run of the rig's current ledger.
  const atWork = campaign.slice(campaign.indexOf("At work now"), campaign.indexOf("Earlier runs"));
  assert.match(atWork, /sort-3/);
  assert.doesNotMatch(atWork, /sort-1|sort-2/);
  const earlier = campaign.slice(campaign.indexOf("<h2>Earlier runs</h2>"));
  assert.match(earlier, /<h2>Earlier runs<\/h2><span class="n">2<\/span>/);
  assert.match(
    earlier,
    /<td><span class="kst done">Stopped<\/span><\/td><td><a href="\/ui\/campaigns\/sort\/runs\/sort-2"><b>sort-2<\/b><\/a><\/td><td class="muted">on rig-b, retired<\/td>/,
  );
  assert.match(
    earlier,
    /<td><span class="kst done">Stopped<\/span><\/td><td><a href="\/ui\/campaigns\/sort\/runs\/sort-1"><b>sort-1<\/b><\/a><\/td><td class="muted">before rig-a's full reset<\/td>/,
  );
  // An earlier paused run offers no Resume: its rig takes no command for it.
  assert.doesNotMatch(earlier, /value="resume_run"/);

  for (const [run, where] of [
    ["sort-1", /before rig-a(&#39;|')s full reset/],
    ["sort-2", /on rig-b, retired/],
  ] as const) {
    const page = await ui.get(`/ui/campaigns/sort/runs/${run}`);
    assert.equal(page.status, 200, run);
    const html = await page.text();
    assert.match(html, where, run);
    assert.match(html, /<b>An earlier run\.<\/b>/, run);
    assert.match(html, /It runs no more, and it takes no commands\./, run);
    // Its state is Stopped, and it has none of a run's buttons: no Live, Message or Pause.
    assert.match(html, /<span class="label muted">Stopped<\/span>/, run);
    assert.doesNotMatch(html, /class="btn" href="[^"]*\/live/, run);
    for (const tab of ["attempts", "history", "experiments", "journal", "planner"]) {
      const r = await ui.get(`/ui/campaigns/sort/runs/${run}/${tab}`);
      assert.equal(r.status, 200, `${run} ${tab}`);
    }
    const live = await ui.page(`/ui/campaigns/sort/runs/${run}/live`);
    assert.match(live, /This is an earlier run \([^)]*\): its agents take no more messages\./, run);
  }
  // Its attempt's page, linked from the run's Attempts tab, and its champion's patch.
  const attempts = await ui.page("/ui/campaigns/sort/runs/sort-1/attempts");
  assert.match(attempts, /href="\/ui\/campaigns\/sort\/runs\/sort-1\/attempts\/a-1"/);
  const attempt = await ui.get("/ui/campaigns/sort/runs/sort-1/attempts/a-1");
  assert.equal(attempt.status, 200);
  const page = await attempt.text();
  assert.match(page, /radix sort/);
  // Nothing of an earlier run waits for the owner, so its attempt asks for no decision.
  assert.doesNotMatch(page, /Make it the champion/);
  const patch = await ui.get("/ui/campaigns/sort/runs/sort-1/champions/2.patch");
  assert.equal(patch.status, 200);
  assert.deepEqual(Buffer.from(await patch.arrayBuffer()), PATCH);
  // An attempt of another run is no attempt of this one.
  assert.equal((await ui.get("/ui/campaigns/sort/runs/sort-1/attempts/a-2")).status, 404);
  // A run is found under its own campaign only.
  assert.equal((await ui.get("/ui/campaigns/other/runs/sort-1")).status, 404);
});

test("REST and MCP read an earlier run and its attempts by name; a command to it is refused in words", async () => {
  const { control, api, store } = await earlierRuns();
  const run = (await (await api("GET", "/v1/runs/sort-1")).json()) as {
    id: string;
    attempts: { id: string }[];
  };
  assert.deepEqual([run.id, run.attempts.map((a) => a.id)], ["sort-1", ["a-1"]]);
  const read = await api("GET", "/v1/runs/sort-2/attempts/a-2");
  assert.equal(read.status, 200);
  const attempt = (await read.json()) as Record<string, unknown> & {
    attempt: { id: string; hypothesis: string; verdict: string };
  };
  assert.deepEqual(
    [attempt.run, attempt.campaign, attempt.rig, attempt.earlier, attempt.champion_seq],
    ["sort-2", "sort", "rig-b", "retired", 2],
  );
  assert.deepEqual(
    [attempt.attempt.id, attempt.attempt.hypothesis, attempt.attempt.verdict],
    ["a-2", "insertion sort below 16", "win_confirmed"],
  );
  const current = (await (await api("GET", "/v1/runs/sort-3/attempts/a-3")).json()) as {
    earlier: unknown;
  };
  assert.equal(current.earlier, null);
  assert.deepEqual(
    [
      (await api("GET", "/v1/runs/sort-1/attempts/a-9")).status,
      (await api("GET", "/v1/runs/nope/attempts/a-1")).status,
    ],
    [404, 404],
  );
  const patch = await api("GET", "/v1/runs/sort-1/champions/2/patch");
  assert.equal(patch.status, 200);
  assert.equal(patch.headers.get("x-thermite-sha256"), SHA);

  const client = await mcpClient(control, ADMIN);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    return { error: r.isError === true, body: JSON.parse(r.content[0]?.text ?? "null") };
  };
  assert.equal((await call("get_run", { run: "sort-1" })).body.id, "sort-1");
  const viaMcp = await call("get_attempt", { run: "sort-1", attempt: "a-1" });
  assert.deepEqual(
    [viaMcp.body.rig, viaMcp.body.earlier, viaMcp.body.attempt.id],
    ["rig-a", "reset", "a-1"],
  );
  const missing = await call("get_attempt", { run: "sort-1", attempt: "a-9" });
  assert.deepEqual(missing, { error: true, body: { error: "run sort-1 has no attempt a-9" } });

  // A command to an earlier run: refused before it is signed, with the rig named or not.
  const refused = async (body: Record<string, unknown>, words: string) => {
    const r = await api("POST", "/v1/commands", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(((await r.json()) as { error: string }).error, words);
  };
  await refused(
    { kind: "resume_run", payload: { run: "sort-1" } },
    "Run sort-1 is an earlier run: it ran on rig-a before the rig's full reset, so it takes no commands.",
  );
  await refused(
    { rig: "rig-a", kind: "resume_run", payload: { run: "sort-1" } },
    "Run sort-1 is an earlier run: it ran on rig-a before the rig's full reset, so it takes no commands.",
  );
  await refused(
    { kind: "pause_run", payload: { run: "sort-2", reason: "x" } },
    "Run sort-2 is an earlier run: rig-b is retired, so it takes no commands.",
  );
  // A run at work takes one with its rig left out: control sends it to the run's rig.
  const sent = await call("issue_command", {
    kind: "pause_run",
    payload: { run: "sort-3", reason: "named alone" },
  });
  assert.equal(sent.error, false, JSON.stringify(sent.body));
  const viaRest = await api("POST", "/v1/commands", {
    kind: "pause_run",
    payload: { run: "sort-3", reason: "named alone" },
  });
  assert.equal(viaRest.status, 201);
  // Each signed for the rig the run is on.
  assert.deepEqual(
    store.commands
      .list(5)
      .filter((c) => c.kind === "pause_run")
      .map((c) => c.rig),
    ["rig-a", "rig-a"],
  );
  await client.close();
});
