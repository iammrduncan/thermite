import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import type { DirectionView } from "../../src/control/views/index.ts";
import { ADMIN, controlStack, mcpClient } from "../helpers/control-stack.ts";
import { ingestReport } from "../helpers/control-store.ts";

/**
 * Rules name directions (goal 066), over REST, MCP and the command line, against a real harness
 * through the relay: a direction in plain words or as :name:, a new one the planner designs, the
 * run's directions as a client reads them, and the plain-words refusals.
 */

const CLI = join(import.meta.dirname, "../../src/cli/thermite/main.ts");
const run = promisify(execFile);

async function stack() {
  const { env, store, control, relay: rounds, api } = controlStack();
  await env.service.applyCommand(env.assign);
  await rounds();
  /** The commands to the harness, then their events back to control. */
  const relay = async () => {
    await rounds(2);
  };
  /** The newest signed command's payload and what the rig answered. */
  const last = () => {
    const c = store.commands.list(1)[0];
    const row = store.db.prepare("select signed from command where id = ?").get(c?.id ?? "") as {
      signed: string;
    };
    return {
      payload: (JSON.parse(row.signed) as { envelope: { payload: Record<string, unknown> } })
        .envelope.payload,
      status: c?.status,
      outcome: c?.outcome as { result?: Record<string, unknown> } | null,
    };
  };
  return { env, store, control, relay, api, last };
}

const rule = (family: string, kind = "avoid") => ({
  run: "js-1",
  directives: [{ kind, family, rationale: "slower twice" }],
  replace: false,
});

describe("rules name directions over REST, MCP and the command line (goal 066)", () => {
  test("REST: a direction in plain words or :name:, a new one the planner designs, and the run's directions", async () => {
    const s = await stack();
    const add = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "queue_add",
      payload: { run: "js-1", title: "stage the tiles", family: ":Shared memory tiling:" },
    });
    assert.equal(add.status, 201);
    await s.relay();
    // :name: with spaces names the experiment's direction.
    const named = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "redirect",
      payload: rule(":shared memory tiling:", "try"),
    });
    assert.equal(named.status, 201, await named.clone().text());
    assert.deepEqual(s.last().payload.directives, [
      { kind: "try", family: "shared-memory-tiling", rationale: "slower twice", citations: [] },
    ]);
    await s.relay();
    assert.equal(s.last().status, "delivered");
    // A direction the run doesn't have is taken: the planner designs it at its next round.
    const fresh = await s.api("POST", "/v1/commands", {
      rig: "rig-a",
      kind: "redirect",
      payload: rule("Timer code"),
    });
    assert.equal(fresh.status, 201);
    await s.relay();
    assert.deepEqual(s.last().outcome?.result?.new_directions, ["timer-code"]);
    // Words are no longer a rule, nor is text that can't be a direction's name.
    for (const [payload, why] of [
      [
        { run: "js-1", directives: [{ kind: "avoid", match: "anything slow", rationale: "r" }] },
        /^bad redirect payload: directives\.0: a rule no longer takes match: name its direction in family, in plain words or as :name:/,
      ],
      [
        rule("anything with $hared memory!"),
        /directives\.0\.family: "anything with \$hared memory!" is not a direction's name/,
      ],
    ] as const) {
      const r = await s.api("POST", "/v1/commands", { rig: "rig-a", kind: "redirect", payload });
      assert.equal(r.status, 400);
      assert.match(((await r.json()) as { error: string }).error, why);
    }
    // The run's directions, as a picker reads them, with the rules in force.
    const got = await s.api("GET", "/v1/runs/js-1/directions");
    assert.equal(got.status, 200);
    const body = (await got.json()) as {
      run: string;
      directions: DirectionView[];
      rules: { id: number; legacy: boolean; body: { family?: string } }[];
    };
    assert.deepEqual(
      body.directions.map((d) => [d.name, d.queued, d.to_design, d.rules.map((x) => x.kind)]),
      [
        ["shared-memory-tiling", 1, false, ["try"]],
        ["timer-code", 0, true, ["avoid"]],
      ],
    );
    assert.deepEqual(
      body.rules.map((r) => [r.body.family, r.legacy]),
      [
        ["shared-memory-tiling", false],
        ["timer-code", false],
      ],
    );
    assert.equal((await s.api("GET", "/v1/runs/nope/directions")).status, 404);
    // The run itself over REST, as MCP's get_run gives it (goal 128): each list cut to its newest
    // entries, with what was cut said; one list on its own, paged; a wrong argument refused.
    const run = (await (await s.api("GET", "/v1/runs/js-1?limit=1")).json()) as {
      id: string;
      rules: unknown[];
      cut: string[];
    };
    assert.equal(run.id, "js-1");
    assert.equal(run.rules.length, 1);
    assert.ok(
      run.cut.includes(
        'rules: the newest 1 of 2 entries (list "rules" with offset reads older ones)',
      ),
    );
    const page = (await (
      await s.api("GET", "/v1/runs/js-1?list=rules&limit=1&offset=1")
    ).json()) as {
      total: number;
      from: number;
      to: number;
      entries: { body: { family?: string } }[];
    };
    assert.deepEqual(
      [page.total, page.from, page.to, page.entries.map((r) => r.body.family)],
      [2, 0, 1, ["shared-memory-tiling"]],
    );
    assert.equal((await s.api("GET", "/v1/runs/js-1?limit=0")).status, 400);
    assert.equal((await s.api("GET", "/v1/runs/js-1?list=nope")).status, 400);
    assert.equal((await s.api("GET", "/v1/runs/nope")).status, 404);
  });

  test("MCP: issue_command takes :name: and refuses words; run_queue lists the run's directions", async () => {
    const s = await stack();
    const client = await mcpClient(s.control);
    const call = (name: string, args: Record<string, unknown>) =>
      client.callTool({ name, arguments: args }) as Promise<{
        isError?: boolean;
        content: { text: string }[];
      }>;
    const ok = await call("issue_command", {
      rig: "rig-a",
      kind: "redirect",
      payload: rule(":vector loads:", "mandate"),
    });
    assert.ok(!ok.isError, ok.content[0]?.text);
    assert.equal((s.last().payload.directives as { family: string }[])[0]?.family, "vector-loads");
    const words = await call("issue_command", {
      rig: "rig-a",
      kind: "redirect",
      payload: { run: "js-1", directives: [{ kind: "try", match: "loads", rationale: "r" }] },
    });
    assert.ok(words.isError);
    assert.match(words.content[0]?.text ?? "", /a rule no longer takes match/);
    await s.relay();
    const queue = JSON.parse(
      (await call("run_queue", { run: "js-1" })).content[0]?.text ?? "{}",
    ) as {
      directions: DirectionView[];
    };
    assert.deepEqual(queue.directions, [
      {
        name: "vector-loads",
        description: null,
        tried: 0,
        wins: 0,
        queued: 0,
        lanes: [],
        rules: [{ id: 1, kind: "mandate" }],
        to_design: true,
      },
    ]);
    await client.close();
  });

  test("the command line: thermite command sends a rule with :name:, and says why words are refused", async () => {
    const s = await stack();
    const server = serve({ fetch: s.control.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "thermite-rule-"));
      const token = join(dir, "owner-token");
      writeFileSync(token, `${ADMIN}\n`, { mode: 0o600 });
      const cli = async (payload: unknown) => {
        try {
          const r = await run(process.execPath, [
            "--experimental-strip-types",
            "--no-warnings",
            CLI,
            "command",
            "--control",
            url,
            "--token-file",
            token,
            "--rig",
            "rig-a",
            "--kind",
            "redirect",
            "--payload",
            JSON.stringify(payload),
          ]);
          return { code: 0, ...r };
        } catch (err) {
          const e = err as { code: number; stdout: string; stderr: string };
          return { code: e.code, stdout: e.stdout, stderr: e.stderr };
        }
      };
      const sent = await cli(rule(":loop tiling:"));
      assert.equal(sent.code, 0, sent.stderr);
      assert.match(sent.stdout, /"status":"pending"/);
      assert.equal((s.last().payload.directives as { family: string }[])[0]?.family, "loop-tiling");
      const refused = await cli({
        run: "js-1",
        directives: [{ kind: "avoid", match: "anything with loops", rationale: "r" }],
      });
      assert.equal(refused.code, 2);
      assert.match(refused.stderr, /a rule no longer takes match/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test("control refuses a research run a rule for another direction than its task kinds", async () => {
    const { store, api } = controlStack({ tokens: { rigs: {} } });
    await ingestReport(store, {
      rig: "rig-r",
      ledger_id: "ledger-r",
      cursor: 0,
      next: 1,
      generated_at: new Date().toISOString(),
      events: [
        {
          id: 1,
          at: new Date().toISOString(),
          actor: "harness",
          kind: "run_created",
          subject: "r-1",
          body: { campaign: "survey", mode: "research", version: 1, agents: true },
        },
      ],
      summary: {},
    });
    const post = (family: string) =>
      api("POST", "/v1/commands", {
        rig: "rig-r",
        kind: "redirect",
        payload: { run: "r-1", directives: [{ kind: "avoid", family, rationale: "r" }] },
      });
    const bad = await post("blog posts");
    assert.equal(bad.status, 400);
    assert.match(
      ((await bad.json()) as { error: string }).error,
      /^A research run's directions are its task kinds: :explore:, :primary:, :contradict:, :consolidate:\. Its planner designs no new direction, so a rule for :blog-posts: would do nothing\./,
    );
    assert.equal((await post(":contradict:")).status, 201);
  });
});
