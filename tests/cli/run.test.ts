import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { runStartBody, runStartSaid } from "../../src/cli/run.ts";
import { issueCommand } from "../../src/control/issue/index.ts";
import type { ControlStore } from "../../src/control/store/index.ts";
import { controlOnly } from "../helpers/control-stack.ts";
import { enrollRigs, ingestReport } from "../helpers/control-store.ts";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../src/cli/thermite/main.ts");
/** Control's tokens: the owner's, as the token files below hold it, and no rigs. */
const TOKENS = { admin: "owner-token-abcdef", rigs: {} };

/** Runs the command line; a refusal comes back with its exit code instead of throwing. */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [
      "--experimental-strip-types",
      "--no-warnings",
      CLI,
      ...args,
    ]);
    return { code: 0, ...r };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** A rig whose runs reported these events, in order (subject: the run). */
async function report(
  store: ControlStore,
  rig: string,
  events: [string, string, Record<string, unknown>][],
  summary: object = {},
) {
  await ingestReport(store, {
    rig,
    ledger_id: `ledger-${rig}`,
    cursor: 0,
    next: events.length,
    generated_at: new Date().toISOString(),
    events: events.map(([subject, kind, body], i) => ({
      id: i + 1,
      at: new Date(Date.parse("2026-10-20T01:00:00Z") + i * 60_000).toISOString(),
      actor: "harness",
      kind,
      subject,
      body,
    })),
    summary,
  });
}

describe("thermite run start (goal 029)", () => {
  test("starts a run as the campaign page's Start a run does, and says its refusals", async () => {
    const { keys, store, control: api } = controlOnly({ tokens: TOKENS });
    enrollRigs(store, ["rig-a"]);
    // sort-speed was assigned over the API before: Start a run assigns it again.
    issueCommand(store, keys.privateKeyPem, {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: {
        run: "sort-speed-1",
        contract: { campaign: "sort-speed", mode: "hill_climb" },
        contract_sha: "c".repeat(64),
        imports: [],
      },
      issuedBy: "owner:api",
    });
    await report(store, "rig-a", [
      ["sort-speed-1", "run_created", { campaign: "sort-speed", mode: "hill_climb", agents: true }],
      ["sort-speed-1", "experiment_added", { id: "x-1", title: "radix sort", by: "planner" }],
      [
        "sort-speed-1",
        "experiment_added",
        { id: "x-2", title: "insertion sort below 16", by: "lane-1", state: "proposed" },
      ],
    ]);
    await report(
      store,
      "rig-b",
      [["notes-1", "run_created", { campaign: "notes", mode: "research" }]],
      {
        model: { source: "none", harness: "pi" },
      },
    );
    store.modelProviders.put({
      name: "zen",
      type: "opencode",
      base_url: "https://opencode.ai/zen/v1",
    });
    store.modelProviders.setModels("zen", [{ id: "glm-5.3-flash-free" }]);
    const server = serve({ fetch: api.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const control = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "thermite-run-start-"));
      const owner = join(dir, "owner-token");
      writeFileSync(owner, "owner-token-abcdef\n", { mode: 0o600 });
      const at = ["--control", control, "--token-file", owner];

      const started = await cli(
        "run",
        "start",
        "sort-speed",
        "--rig",
        "rig-a",
        "--queue-from",
        "sort-speed-1",
        "--promotion",
        "owner",
        ...at,
      );
      assert.equal(started.code, 0, started.stderr);
      const out = JSON.parse(started.stdout) as Record<string, unknown>;
      assert.deepEqual(
        [out.started, out.campaign, out.rig, out.run, out.status],
        [true, "sort-speed", "rig-a", "sort-speed-2", "pending"],
      );
      assert.equal(
        started.stderr,
        "sort-speed-1 is at work on rig-a, and pauses when this run starts (a rig runs one run at a time).\n",
      );
      const signed = store.db
        .prepare("select issued_by, signed from command where id = ?")
        .get(String(out.command)) as { issued_by: string; signed: string };
      assert.equal(signed.issued_by, "owner:api");
      const payload = (
        JSON.parse(signed.signed) as {
          envelope: { payload: { run: string; promotion: string; queue: { title: string }[] } };
        }
      ).envelope.payload;
      assert.deepEqual(
        [payload.run, payload.promotion, payload.queue.map((x) => x.title)],
        ["sort-speed-2", "owner_approval", ["radix sort", "insertion sort below 16"]],
      );

      // A model given first: not started, exit 1, and what control said on standard error.
      const given = await cli(
        "run",
        "start",
        "sort-speed",
        "--rig",
        "rig-b",
        "--provider",
        "zen",
        "--model",
        "glm-5.3-flash-free",
        ...at,
      );
      assert.equal(given.code, 1);
      assert.equal(JSON.parse(given.stdout).started, false);
      assert.match(given.stderr, /^rig-b takes glm-5\.3-flash-free within a minute/);

      // Control's refusals, in its words.
      const noRig = await cli("run", "start", "sort-speed", "--rig", "nope", ...at);
      assert.equal(noRig.code, 2);
      assert.match(noRig.stderr, /-> 404 \{"error":"No rig is called nope\. Choose a rig\."\}/);
      const tryCopy = await cli(
        "run",
        "start",
        "sort-speed",
        "--rig",
        "rig-a",
        "--agents",
        "off",
        "--queue-from",
        "sort-speed-1",
        ...at,
      );
      assert.equal(tryCopy.code, 2);
      assert.match(tryCopy.stderr, /-> 400 .*A try \(agents off\) takes no model, no experiments/);
      const unknown = await cli("run", "start", "nope", "--rig", "rig-a", ...at);
      assert.match(unknown.stderr, /-> 404 .*Control has no saved version or earlier assignment/);
      // The command line's own: before anything is sent.
      for (const [args, said] of [
        [["--rig", "rig-a", "--provider", "zen"], "--provider and --model go together"],
        [["--rig", "rig-a", "--agents", "maybe"], "--agents is on or off"],
        [["--rig", "rig-a", "--past", "x-1"], '--past takes a whole number, not "x-1"'],
        [["--rig", "rig-a", "--judge-gpus", "two"], '--judge-gpus takes a whole number, not "two"'],
        [[], "--rig names the rig the run starts on"],
      ] as const) {
        const r = await cli("run", "start", "sort-speed", ...args, ...at);
        assert.equal(r.code, 2, r.stderr);
        assert.match(r.stderr, new RegExp(`^${said.replace(/[()]/g, "\\$&")}`));
      }
      const noControl = await cli("run", "start", "sort-speed", "--rig", "rig-a");
      assert.deepEqual(
        [noControl.code, noControl.stderr.trim()],
        [2, "give --control and --token-file: control starts the run"],
      );
      const usage = await cli("run", "start", "--rig", "rig-a", ...at);
      assert.equal(usage.code, 2);
      assert.match(usage.stderr, /^usage: thermite/);
      // Nothing more was signed than the one run.
      assert.equal(store.commands.list(50).filter((c) => c.kind === "assign_campaign").length, 2);
    } finally {
      server.close();
    }
  });

  test("the body and the words: the options as the route takes them", () => {
    assert.deepEqual(
      runStartBody({
        rig: "rig-1",
        agents: "on",
        provider: "zen",
        model: "glm-5.3-flash-free",
        promotion: "auto",
        ask: ["gain:15", "flaws", "reviews", "not-possible"],
        "judge-gpus": "2",
        "queue-from": "sort-speed-1",
        past: ["12", "40"],
      }),
      {
        rig: "rig-1",
        agents_model: { provider: "zen", model: "glm-5.3-flash-free" },
        promotion: "auto",
        ask_owner: { above_gain: 0.15, declared_flaws: true, reviews: true, not_possible: true },
        judge_gpus: 2,
        queue_from: "sort-speed-1",
        past: [12, 40],
      },
    );
    assert.deepEqual(runStartBody({ rig: "rig-1", agents: "off" }), {
      rig: "rig-1",
      agents: false,
    });
    assert.throws(() => runStartBody({ rig: "rig-1", "queue-from": "" }), /names a run/);
    assert.throws(
      () => runStartBody({ rig: "rig-1", ask: ["always"] }),
      /--ask is gain:PERCENT, flaws, reviews or not-possible/,
    );
    assert.equal(
      runStartSaid({ started: true, woke: "rig-1's pod was stopped.", notes: ["a", "b"] }),
      "rig-1's pod was stopped.\na\nb\n",
    );
    assert.equal(runStartSaid({ started: false, said: "rig-1 takes m." }), "rig-1 takes m.\n");
    assert.equal(runStartSaid({ started: true }), "");
  });
});
