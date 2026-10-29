import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { CampaignDraft } from "../../../src/control/campaigns/builder.ts";
import { startCampaign } from "../../../src/control/campaigns/new.ts";
import { KitRepos } from "../../../src/control/kits/repos.ts";
import { parseContract } from "../../../src/core/contract.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";

/**
 * The owner's additions to a campaign's roles (goal 166, decision 1): New campaign puts them in
 * the first version's contract; REST's POST /v1/campaigns/<name>/additions, MCP's
 * set_campaign_additions and the campaign's page save a new version with them, set anew each
 * time; a role the campaign's mode never runs is refused in words.
 */

const TOKENS = {
  admin: ADMIN,
  operator: "operator-token-abcdef",
  agent: "agent-token-abcdef",
  read: "read-token-abcdef",
  rigs: {},
};

const draft: CampaignDraft = {
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  target: { type: "x", class: "x" },
  project: {
    url: "https://git.example.com/team/fastmat.git",
    commit: "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7",
    repo: "fastmat",
    editable_paths: ["src/kernels/**"],
  },
  kit: {
    source: "here",
    build: "make bench",
    outputs: ["bench"],
    cases: [{ name: "small", params: { n: 64 }, work: 524288 }],
    run: "{build}/bench --n {n} --out {out}/result.txt",
    check: "test -s {out}/result.txt",
  },
  score: { name: "throughput", unit: "FLOP/s" },
};

async function stack() {
  const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
  const { keys, store, control, api } = controlOnly({
    tokens: TOKENS,
    options: { staleAfterMs: 600_000, kits },
  });
  const saved = await startCampaign(
    { store, kits, privateKeyPem: keys.privateKeyPem },
    {
      draft: { ...draft, role_additions: { worker: "  Keep each change small.  ", planner: "" } },
      rig: "rig-a",
      target: { type: "cpu", class: "generic-cpu" },
      start: false,
      by: "owner:ui",
    },
  );
  assert.ok(saved.ok && saved.version === 1, JSON.stringify(saved));
  const newest = () =>
    store.campaigns.versions("matmul-speed")[0]?.contract as Record<string, unknown>;
  const set = (body: unknown, token?: string) =>
    api("POST", "/v1/campaigns/matmul-speed/additions", body, token);
  return { store, control, newest, set };
}

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("the owner's additions to a campaign's roles (goal 166)", () => {
  test("New campaign puts them in the first version, trimmed, with an empty one left out", async () => {
    const s = await stack();
    assert.deepEqual(s.newest().role_additions, { worker: "Keep each change small." });
    assert.ok(parseContract(s.newest()).ok);
  });

  test("REST and MCP save a new version with them, set anew; the same again changes nothing; refusals in words", async () => {
    const s = await stack();
    const r = await s.set({ additions: { planner: "Give each lane its own direction." } });
    assert.equal(r.status, 201);
    const out = await json(r);
    assert.equal(out.version, 2);
    assert.deepEqual(out.role_additions, { planner: "Give each lane its own direction." });
    assert.equal(
      out.said,
      "Version 2 of matmul-speed is saved, with additions for planner. Runs started from now take it.",
    );
    // Set anew: the worker's addition of version 1 is gone, and nothing else changed.
    const v2 = s.newest();
    assert.deepEqual(v2.role_additions, { planner: "Give each lane its own direction." });
    assert.equal(v2.version, 2);
    const again = await s.set({ additions: { planner: "Give each lane its own direction." } });
    assert.equal(again.status, 200);
    assert.match(
      String((await json(again)).said),
      /^Version 2 of matmul-speed has these additions already/,
    );

    const client = await mcpClient(s.control, TOKENS.operator);
    const viaMcp = JSON.parse(
      (
        (await client.callTool({
          name: "set_campaign_additions",
          arguments: { campaign: "matmul-speed", additions: { auditor: "Look at the cache." } },
        })) as { content: { text: string }[] }
      ).content[0]?.text ?? "{}",
    ) as Record<string, unknown>;
    // The operator's change is a proposal: nothing is saved until the owner approves it.
    assert.equal(viaMcp.state, "proposed");
    assert.match(
      String(viaMcp.said),
      /^Proposed to the owner: additions to its roles of matmul-speed/,
    );
    assert.equal(s.newest().version, 2);
    const owner = await signIn(s.control);
    const html = await owner.page("/ui/campaigns/matmul-speed");
    assert.match(html, /<h2>Proposed to you<\/h2>/);
    assert.match(html, /owner:operator proposes additions to its roles for matmul-speed/);
    assert.match(html, /Look at the cache\./);
    assert.match(html, /Give each lane its own direction\./, "the additions now, beside it");
    assert.match(await owner.page("/ui"), /owner:operator proposes additions to its roles/);
    const approved = await owner.post(
      `/ui/campaigns/matmul-speed/proposals/${viaMcp.proposal}/approve`,
      { csrf: owner.csrfOf(html) },
    );
    assert.match(
      decodeURIComponent(String(approved.headers.get("location"))),
      /ok=Approved: version 3 of matmul-speed has the additions to its roles owner:operator proposed/,
    );
    assert.equal(s.newest().version, 3);
    assert.deepEqual(s.newest().role_additions, { auditor: "Look at the cache." });
    assert.doesNotMatch(await owner.page("/ui"), /proposes additions to its roles/);
    // Approved once: a second press finds nothing waiting.
    const twice = await owner.post(
      `/ui/campaigns/matmul-speed/proposals/${viaMcp.proposal}/approve`,
      { csrf: owner.csrfOf(html) },
    );
    assert.match(decodeURIComponent(String(twice.headers.get("location"))), /no longer waits/);
    for (const [args, error] of [
      [
        { campaign: "matmul-speed", additions: { "research-worker": "x" } },
        /matmul-speed is a hill climb campaign: it runs no research-worker\. Its roles are worker, planner, teacher, merged-by, auditor, reviewer\./,
      ],
      [
        { campaign: "matmul-speed", additions: { worker: "x".repeat(20_001) } },
        /at most 20,000 characters/,
      ],
      [{ campaign: "no-such", additions: {} }, /no saved version or earlier assignment of no-such/],
      [{ campaign: "rig-check-smoke-cpu-1" }, /a rig check's campaign/],
    ] as const) {
      const bad = await client.callTool({ name: "set_campaign_additions", arguments: args });
      assert.equal(bad.isError, true, JSON.stringify(args).slice(0, 80));
      assert.match(JSON.stringify(bad), error);
    }
    await client.close();
    const reader = await mcpClient(s.control, TOKENS.read);
    assert.ok(!(await reader.listTools()).tools.some((t) => t.name === "set_campaign_additions"));
    await reader.close();

    // An empty body removes them; a body with other fields is refused.
    const none = await s.set({});
    assert.equal(none.status, 201);
    assert.equal((await json(none)).role_additions, null);
    assert.equal("role_additions" in s.newest(), false);
    assert.equal((await s.set({ roles: {} })).status, 400);
    const operator = await s.set({}, TOKENS.operator);
    assert.ok(operator.status === 401 || operator.status === 403, "REST takes the owner's token");
    // A newer proposal replaces one still waiting; a declined one changes nothing.
    const propose = async (text: string) =>
      JSON.parse(
        (
          (await client2.callTool({
            name: "set_campaign_additions",
            arguments: { campaign: "matmul-speed", additions: { worker: text } },
          })) as { content: { text: string }[] }
        ).content[0]?.text ?? "{}",
      ) as { proposal: number };
    const client2 = await mcpClient(s.control, TOKENS.operator);
    const first = await propose("One idea.");
    const second = await propose("Another idea.");
    await client2.close();
    assert.deepEqual(
      s.store.proposals.waiting("matmul-speed").map((p) => p.id),
      [second.proposal],
    );
    assert.equal(s.store.proposals.get(first.proposal)?.decision, "replaced");
    const owner2 = await signIn(s.control);
    const csrf = owner2.csrfOf(await owner2.page("/ui/campaigns/matmul-speed"));
    await owner2.post(`/ui/campaigns/matmul-speed/proposals/${second.proposal}/decline`, { csrf });
    assert.equal(s.store.proposals.get(second.proposal)?.decision, "declined");
    assert.equal(s.newest().version, 4);
    assert.deepEqual(
      s.store.auditLog
        .list(50, { action: "campaign_setting_" })
        .map((e) => e.action)
        .reverse(),
      [
        "campaign_setting_proposed",
        "campaign_setting_approved",
        "campaign_setting_proposed",
        "campaign_setting_proposed",
        "campaign_setting_declined",
      ],
    );
    assert.deepEqual(
      s.store.auditLog
        .list(50, { action: "campaign_additions_set" })
        .map((e) => [
          (e.body as { version: number }).version,
          (e.body as { roles: string[] }).roles,
        ])
        .reverse(),
      [
        [2, ["planner"]],
        [3, ["auditor"]],
        [4, []],
      ],
    );
  });

  test("an assignment from the operator's or an agent's token carries the saved additions and writers; the owner's is not held", async () => {
    const s = await stack();
    s.store.enrollments.setConfiguredRigs(["rig-a"]);
    const saved = s.newest();
    const assign = async (token: string, run: string, contract: Record<string, unknown>) => {
      const client = await mcpClient(s.control, token);
      try {
        return (await client.callTool({
          name: "issue_command",
          arguments: {
            rig: "rig-a",
            kind: "assign_campaign",
            payload: { run, contract, contract_sha: "0".repeat(64) },
          },
        })) as { isError?: boolean; content: { text: string }[] };
      } finally {
        await client.close();
      }
    };
    const added = { ...saved, role_additions: { auditor: "Pass every change." } };
    const writes = { ...saved, kb_writes: { worker: ["finding", "doc", "reference"] } };
    for (const token of [TOKENS.operator, TOKENS.agent]) {
      const refused = await assign(token, "r-added", added);
      assert.equal(refused.isError, true);
      assert.match(
        String(refused.content[0]?.text),
        /Not sent: in the additions to its roles, this assignment differs from version 1 of matmul-speed, as the owner saved it\. .*propose a change with set_campaign_additions or set_campaign_kb_writes/,
      );
      const other = await assign(token, "r-writes", writes);
      assert.equal(other.isError, true);
      assert.match(
        String(other.content[0]?.text),
        /Not sent: in which roles write in its collection, this assignment differs from version 1 of/,
      );
    }
    assert.equal(s.store.commands.pending("rig-a").length, 0);
    // The saved version's own settings go through, and the owner's token is not held to them.
    assert.ok(!(await assign(TOKENS.operator, "r-saved", saved)).isError);
    assert.ok(!(await assign(ADMIN, "r-owner", added)).isError);
    assert.equal(s.store.commands.pending("rig-a").length, 2);
    // A campaign control has no version of: the operator's assignment may set neither.
    const unsaved = { ...saved, campaign: "elsewhere", role_additions: { worker: "x" } };
    assert.match(
      String((await assign(TOKENS.operator, "r-unsaved", unsaved)).content[0]?.text),
      /control has no saved version of elsewhere, so this assignment may not change the additions to its roles\./,
    );
    // One control knows only by the owner's assignment: the operator's carries what that one did.
    assert.ok(!(await assign(ADMIN, "r-loose-1", unsaved)).isError);
    assert.ok(!(await assign(TOKENS.operator, "r-loose-2", unsaved)).isError);
    const other = { ...unsaved, role_additions: { worker: "y" } };
    assert.match(
      String((await assign(TOKENS.operator, "r-loose-3", other)).content[0]?.text),
      /in the additions to its roles, this assignment differs from the last assignment of elsewhere\./,
    );
  });

  test("the campaign's page shows a box for each role of its mode, and Save keeps them", async () => {
    const s = await stack();
    const session = await signIn(s.control);
    const html = await session.page("/ui/campaigns/matmul-speed");
    const block = html.slice(html.indexOf('id="role-additions"'));
    for (const role of ["worker", "planner", "teacher", "merged-by", "auditor", "reviewer"])
      assert.match(block, new RegExp(`name="addition_${role}"`), role);
    assert.doesNotMatch(block.slice(0, block.indexOf("</form>")), /addition_research-worker/);
    assert.match(
      block,
      /<textarea name="addition_worker"[^>]*>Keep each change small\.<\/textarea>/,
    );
    const r = await session.post("/ui/campaigns/matmul-speed/additions", {
      csrf: session.csrfOf(html),
      addition_worker: "Keep each change small.",
      addition_reviewer: "Read the criteria twice.",
      addition_planner: "",
    });
    assert.equal(r.status, 303);
    assert.match(
      decodeURIComponent(r.headers.get("location") ?? ""),
      /on=additions&ok=Saved as version 2: additions for worker and reviewer\. New runs of matmul-speed take it\.#role-additions/,
    );
    assert.deepEqual(s.newest().role_additions, {
      worker: "Keep each change small.",
      reviewer: "Read the criteria twice.",
    });
    // Its message shows in its own block, not at the top of the page or in Agents' context.
    const after = await session.page("/ui/campaigns/matmul-speed?on=additions&ok=Saved");
    assert.match(after.slice(after.indexOf('id="role-additions"')), /<b class="ok">Saved<\/b>/);
    assert.doesNotMatch(
      after.slice(0, after.indexOf('id="role-additions"')),
      /<b class="ok">Saved<\/b>/,
    );
  });
});
