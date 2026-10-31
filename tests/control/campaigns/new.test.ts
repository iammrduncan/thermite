import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { CampaignDraft } from "../../../src/control/campaigns/builder.ts";
import { startCampaign, startRun } from "../../../src/control/campaigns/new.ts";
import { issueCommand } from "../../../src/control/issue/index.ts";
import { KitRepos } from "../../../src/control/kits/repos.ts";
import { ControlStore } from "../../../src/control/store/index.ts";
import { generateSigningKeys, verifyCommand } from "../../../src/core/commands.ts";
import { enrollRigs } from "../../helpers/control-store.ts";

const C = "9a41c07e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const draft: CampaignDraft = {
  mode: "hill_climb",
  campaign: "matmul-speed",
  title: "Make the matrix multiply faster",
  target: { type: "x", class: "x" },
  project: {
    url: "https://git.example.com/team/fastmat.git",
    commit: C,
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

describe("starting a campaign from the page", () => {
  test("the kit is kept on control, the contract stored, and the first run assigned with both sources", async () => {
    const keys = generateSigningKeys();
    const store = new ControlStore(":memory:");
    enrollRigs(store, ["rig-a"]);
    const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
    const deps = { store, kits, privateKeyPem: keys.privateKeyPem };
    const target = { type: "cpu", class: "generic-cpu" };
    const r = await startCampaign(deps, {
      draft,
      rig: "rig-a",
      target,
      start: true,
      by: "owner:ui",
    });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
    if (!r.ok) return;
    assert.equal(r.version, 1);
    assert.equal(r.run, "matmul-speed-1");
    const head = kits.head("matmul-speed-kit");
    assert.match(String(head), /^[0-9a-f]{40}$/);
    const [stored] = store.campaigns.versions("matmul-speed");
    assert.equal(stored?.sha, r.sha);
    const contract = stored?.contract as { target: unknown; project: { kit: { commit: string } } };
    assert.deepEqual(contract.target, target);
    assert.equal(contract.project.kit.commit, head);
    // The assignment is signed by control, and names where each source comes from.
    const row = store.db
      .prepare("select signed from command where id = ?")
      .get(String(r.command)) as {
      signed: string;
    };
    const cmd = JSON.parse(row.signed);
    assert.ok(verifyCommand(cmd, keys.publicKeyPem, "rig-a").ok);
    const payload = cmd.envelope.payload as {
      run: string;
      contract_sha: string;
      seed: { repo: string; commit: string };
      imports: { kind: string; commit: string; source: Record<string, string> }[];
    };
    assert.equal(payload.contract_sha, r.sha);
    assert.deepEqual(payload.seed, { repo: "fastmat", commit: C });
    assert.deepEqual(
      payload.imports.map((i) => [i.kind, i.commit, i.source]),
      [
        ["repo_bundle", C, { git: "https://git.example.com/team/fastmat.git" }],
        ["kit_bundle", head, { control: "kits/matmul-speed-kit" }],
      ],
    );
    // Again: a new version, the same kit commit (nothing changed), the next run's name.
    const again = await startCampaign(deps, {
      draft,
      rig: "rig-a",
      target,
      start: true,
      by: "owner:ui",
    });
    assert.ok(again.ok);
    if (again.ok) {
      assert.equal(again.version, 2);
      assert.equal(again.run, "matmul-speed-2");
    }
    assert.equal(kits.head("matmul-speed-kit"), head);
    // Saved only: stored, nothing assigned.
    const saved = await startCampaign(deps, {
      draft,
      rig: "rig-a",
      target,
      start: false,
      by: "owner:ui",
    });
    assert.ok(saved.ok && saved.run === undefined && saved.version === 3);
  });

  test("a try runs the kit with no agents; a later run starts from the saved version and its sources", async () => {
    const keys = generateSigningKeys();
    const store = new ControlStore(":memory:");
    enrollRigs(store, ["rig-a", "rig-b"]);
    const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
    const deps = { store, kits, privateKeyPem: keys.privateKeyPem };
    const target = { type: "cpu", class: "generic-cpu" };
    const payloadOf = (id: string) =>
      (
        JSON.parse(
          (
            store.db.prepare("select signed from command where id = ?").get(id) as {
              signed: string;
            }
          ).signed,
        ) as { envelope: { payload: { run: string; agents?: boolean; imports: unknown[] } } }
      ).envelope.payload;
    const tried = await startCampaign(deps, {
      draft,
      rig: "rig-a",
      target,
      start: "try",
      by: "owner:ui",
    });
    assert.ok(tried.ok && tried.run === "matmul-speed-try-1", JSON.stringify(tried));
    if (!tried.ok) return;
    assert.equal(payloadOf(String(tried.command)).agents, false);
    const real = await startRun(deps, {
      campaign: "matmul-speed",
      rig: "rig-b",
      target,
      agents: true,
      by: "owner:ui",
    });
    assert.ok(real.ok && real.run === "matmul-speed-1", JSON.stringify(real));
    if (!real.ok) return;
    const p = payloadOf(real.command);
    assert.equal(p.agents, undefined);
    assert.deepEqual(p.imports, payloadOf(String(tried.command)).imports);
    // A rig with other hardware is refused, and an unknown campaign too.
    const gpu = await startRun(deps, {
      campaign: "matmul-speed",
      rig: "rig-b",
      target: { type: "cuda-gpu", class: "p100" },
      agents: true,
      by: "owner:ui",
    });
    assert.match(JSON.stringify(gpu), /measures on cuda-gpu/);
    assert.equal(
      (await startRun(deps, { campaign: "nothing", rig: "rig-a", agents: true, by: "owner:ui" }))
        .ok,
      false,
    );
  });

  test("a campaign assigned outside the page starts again from its newest assignment", async () => {
    const keys = generateSigningKeys();
    const store = new ControlStore(":memory:");
    enrollRigs(store, ["rig-a", "rig-b"]);
    const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
    const deps = { store, kits, privateKeyPem: keys.privateKeyPem };
    // No version on control: nothing to start from yet.
    const none = await startRun(deps, {
      campaign: "cli-made",
      rig: "rig-b",
      agents: true,
      by: "owner:ui",
    });
    assert.equal(none.ok, false);
    // An assignment issued over the API or the CLI.
    const contract = { campaign: "cli-made", mode: "hill_climb", target: { type: "cpu" } };
    const imports = [
      {
        kind: "repo_bundle",
        path: "repos/p.bundle",
        repo: "p",
        commit: C,
        source: { git: "https://git.example.com/p.git" },
      },
    ];
    issueCommand(store, keys.privateKeyPem, {
      rig: "rig-a",
      kind: "assign_campaign",
      payload: {
        run: "cli-made-1",
        contract,
        contract_sha: "a".repeat(64),
        seed: { repo: "p", commit: C },
        imports,
      },
      issuedBy: "owner:mcp",
    });
    // Other hardware is refused, with why.
    const gpu = await startRun(deps, {
      campaign: "cli-made",
      rig: "rig-b",
      target: { type: "cuda", class: "p100" },
      agents: true,
      by: "owner:ui",
    });
    assert.equal(gpu.ok, false);
    if (!gpu.ok) assert.match(gpu.errors.join(" "), /measures on cpu/);
    const r = await startRun(deps, {
      campaign: "cli-made",
      rig: "rig-b",
      target: { type: "cpu", class: "x" },
      agents: true,
      promotion: "owner_approval",
      by: "owner:ui",
    });
    assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
    if (!r.ok) return;
    // Numbered across every rig: rig-a's cli-made-1 is taken (goal 170).
    assert.equal(r.run, "cli-made-2");
    const row = store.db.prepare("select rig, signed from command where id = ?").get(r.command) as {
      rig: string;
      signed: string;
    };
    assert.equal(row.rig, "rig-b");
    const payload = (JSON.parse(row.signed) as { envelope: { payload: Record<string, unknown> } })
      .envelope.payload;
    assert.deepEqual(payload.contract, contract);
    assert.deepEqual(payload.imports, imports);
    assert.deepEqual(payload.seed, { repo: "p", commit: C });
    assert.equal(payload.promotion, "owner_approval");
    assert.equal(payload.run, "cli-made-2");
    // Another run's untried experiments go into the new run's queue, in order, with their origin.
    const seed = [
      {
        title: "vector loads",
        family: "memory-layout",
        why: "the guide",
        by: "teacher",
        state: "queued" as const,
        from: { run: "cli-made-1", id: "x-2" },
      },
      {
        title: "a unit test",
        by: "lane-2",
        state: "proposed" as const,
        from: { run: "cli-made-1", id: "x-4" },
      },
    ];
    const q = await startRun(deps, {
      campaign: "cli-made",
      rig: "rig-a",
      agents: true,
      by: "owner:ui",
      queue: seed,
    });
    assert.ok(q.ok);
    if (!q.ok) return;
    const qp = (
      JSON.parse(
        (
          store.db.prepare("select signed from command where id = ?").get(q.command) as {
            signed: string;
          }
        ).signed,
      ) as { envelope: { payload: Record<string, unknown> } }
    ).envelope.payload;
    assert.deepEqual(qp.queue, seed);
    // A try (no agents) has no queue.
    const t = await startRun(deps, {
      campaign: "cli-made",
      rig: "rig-a",
      agents: false,
      by: "owner:ui",
      queue: seed,
    });
    assert.ok(t.ok);
    if (!t.ok) return;
    const tp = (
      JSON.parse(
        (
          store.db.prepare("select signed from command where id = ?").get(t.command) as {
            signed: string;
          }
        ).signed,
      ) as { envelope: { payload: Record<string, unknown> } }
    ).envelope.payload;
    assert.equal(tp.queue, undefined);
  });

  test("a draft with mistakes changes nothing and says why", async () => {
    const store = new ControlStore(":memory:");
    enrollRigs(store, ["rig-a"]);
    const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
    const r = await startCampaign(
      { store, kits, privateKeyPem: generateSigningKeys().privateKeyPem },
      {
        draft: { ...draft, kit: { ...(draft.kit as object), run: "{build}/bench {size}" } },
        rig: "rig-a",
        target: { type: "cpu", class: "generic-cpu" },
        start: true,
        by: "owner:ui",
      },
    );
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(!r.ok && r.errors), /\{size\} is not a placeholder/);
    assert.equal(store.campaigns.versions().length, 0);
    assert.equal(kits.head("matmul-speed-kit"), undefined);
  });
});
