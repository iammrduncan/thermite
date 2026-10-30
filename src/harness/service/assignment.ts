import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { z } from "zod";
import { BadInput, Refusal } from "../../common/errors.ts";
import type { CommandPayloads, ImportSpec } from "../../core/commands.ts";
import { contractSha, parseContract } from "../../core/contract.ts";
import { goalChecks } from "../../core/goal/index.ts";
import { type Kit, KitSchema, kitProblems } from "../../core/kit.ts";
import { canonicalUses, type McpUse, sameUses, usesWords } from "../../core/mcp.ts";
import { folderCommit, hasCommit, initMirror, showFile, updateRef } from "../git.ts";
import { importBundle, importFile, importRoom } from "../imports.ts";
import { ExperimentInput } from "../queue.ts";
import { startingHypotheses } from "../research/index.ts";
import type { HarnessService } from "./index.ts";
import { pauseOthers } from "./runs.ts";

/**
 * A campaign assigned to the rig: its imports checked and stored, its kit checked against its
 * contract, and its run made, with its champion ref, its MCP servers and the queue it starts with.
 */

async function runImport(
  svc: HarnessService,
  spec: ImportSpec,
  repoHint: string,
  actor: string,
  inboxDir = svc.paths.inboxDir,
): Promise<Record<string, string>> {
  const importId = randomUUID().slice(0, 12);
  switch (spec.kind) {
    case "repo_bundle":
    case "kit_bundle": {
      const repo = spec.kind === "kit_bundle" ? `kit-${spec.repo}` : spec.repo || repoHint;
      const mirror = svc.mirrorFor(repo);
      await initMirror(mirror);
      const r = await importBundle({
        inboxDir,
        rel: spec.path,
        mirror,
        scratchDir: join(svc.paths.scratchDir, "imports"),
        importId,
        expectedCommit: spec.commit,
        expectedSha256: spec.sha256,
        room: importRoom(svc.disk, `the bundle ${spec.path}`),
      });
      svc.ledger.imports.record({
        kind: spec.kind,
        name: repo,
        sha256: r.sha256,
        commitSha: r.commit,
        sourcePath: spec.path,
        storedPath: mirror,
        actor,
      });
      return { kind: spec.kind, repo, commit: r.commit };
    }
    case "model": {
      const stored = await importFile({
        inboxDir,
        rel: spec.path,
        expectedSha256: spec.sha256,
        storeDir: join(svc.paths.stateDir, "models"),
        room: importRoom(svc.disk, `the model ${spec.name}`),
      });
      svc.ledger.imports.record({
        kind: "model",
        name: spec.name,
        sha256: spec.sha256,
        sourcePath: spec.path,
        storedPath: stored,
        actor,
      });
      return { kind: "model", name: spec.name, sha256: spec.sha256 };
    }
    case "champion_patch":
      throw new BadInput("a champion patch comes only with a propagate command");
  }
}

/** A run on content the harness made itself: its contract, its seed, and its bundles in `dir`. */
export interface LocalAssignment {
  run: string;
  contract: unknown;
  seed: { repo: string; commit: string };
  bundles: ImportSpec[];
  dir: string;
}

/**
 * A run on content the harness made itself (a rig check's smoke campaign): its bundles come
 * from `dir` rather than the inbox, and everything else is checked as for a signed assignment.
 */
export async function assignLocal(
  svc: HarnessService,
  input: LocalAssignment,
  by: string,
): Promise<unknown> {
  const parsed = parseContract(input.contract);
  if (!parsed.ok) throw new BadInput(`invalid contract: ${parsed.errors.join("; ")}`);
  return assignCampaign(
    svc,
    {
      run: input.run,
      contract: input.contract,
      contract_sha: parsed.sha,
      seed: input.seed,
      imports: input.bundles,
      agents: false,
    },
    by,
    input.dir,
  );
}

export async function assignCampaign(
  svc: HarnessService,
  p: z.infer<(typeof CommandPayloads)["assign_campaign"]>,
  by: string,
  inboxDir = svc.paths.inboxDir,
): Promise<unknown> {
  const parsed = parseContract(p.contract);
  if (!parsed.ok) throw new BadInput(`invalid contract: ${parsed.errors.join("; ")}`);
  if (parsed.sha !== p.contract_sha)
    throw new BadInput("contract hash does not match contract_sha");
  const contract = parsed.contract;
  // Validate everything before changing anything: a refused assign leaves no trace but events.
  if (svc.ledger.runs.get(p.run)) throw new Refusal(`run ${p.run} already exists`);
  // A run without agents (a try) has no queue: nothing would take its experiments.
  if (p.agents === false && p.queue?.length)
    throw new BadInput("a run without agents has no queue: leave out the experiments to copy");
  for (const [i, s] of (p.queue ?? []).entries()) {
    const ok = ExperimentInput.safeParse(s);
    if (!ok.success)
      throw new BadInput(`queue experiment ${i + 1}: ${ok.error.issues[0]?.message ?? "invalid"}`);
  }
  // A run without agents (a try) has no briefs: nothing would read the background.
  if (p.agents === false && p.briefing?.length)
    throw new Refusal(
      "a run without agents has no briefs: leave out the background from past research",
    );
  const existing = svc.ledger.contracts.get(contract.campaign, contract.version);
  if (existing && contractSha(existing) !== parsed.sha) {
    throw new Refusal(
      `contract ${contract.campaign} v${contract.version} exists with other content`,
    );
  }
  for (const spec of p.imports) {
    if (spec.kind === "model" && !contract.models.some((m) => m.sha256 === spec.sha256)) {
      throw new BadInput(`model ${spec.name} is not listed in the contract`);
    }
  }
  // Research campaigns work on a corpus, not a repository: they have no seed commit.
  const seed =
    p.seed ??
    (contract.mode === "research" ? { repo: "research", commit: "0".repeat(40) } : undefined);
  if (!seed) throw new BadInput(`a ${contract.mode} campaign needs a seed commit`);
  const imported = [];
  for (const spec of p.imports) imported.push(await runImport(svc, spec, seed.repo, by, inboxDir));
  for (const m of contract.models) {
    if (!svc.ledger.imports.find("model", { sha256: m.sha256 })) {
      throw new Refusal(`model ${m.name} (${m.sha256}) has not been imported`);
    }
  }
  // The kit is checked against the contract now, not when the judge first needs it.
  const kitRef = contract.mode !== "research" ? contract.project.kit : undefined;
  let named: McpUse[] = [];
  let checkedKit: Kit | undefined;
  if (kitRef) {
    const mirror = svc.mirrorFor(`kit-${kitRef.repo}`);
    if (!(await hasCommit(mirror, kitRef.commit))) {
      throw new Refusal(
        `kit commit ${kitRef.commit} is not in kit ${kitRef.repo}; import its bundle first`,
      );
    }
    let kit: Kit;
    try {
      kit = KitSchema.parse(JSON.parse(await showFile(mirror, kitRef.commit, "kit.json")));
    } catch (err) {
      throw new Refusal(
        `kit ${kitRef.repo} at ${kitRef.commit} has no valid kit.json: ${err instanceof Error ? err.message.slice(0, 500) : String(err)}`,
      );
    }
    const problems = kitProblems(contract, kit, svc.targetType);
    if (problems.length)
      throw new Refusal(`the kit does not fit the contract: ${problems.join("; ")}`);
    named = kit.mcp_servers ?? [];
    checkedKit = kit;
  }
  // The MCP servers the kit names (a research contract's), as the signed command says them:
  // control gives the rig only those servers, so the two must agree.
  if (contract.mode === "research") named = contract.mcp_servers ?? [];
  if (!sameUses(named, p.mcp_servers))
    throw new Refusal(
      `the ${contract.mode === "research" ? "contract" : "kit"} names the MCP servers ${usesWords(named)}, and the assignment names ${usesWords(p.mcp_servers)}: start the run from control, which reads the kit's servers, or give the kit's mcp_servers in the assignment`,
    );
  // A project in one folder of its repository starts from that folder: the run's first
  // champion is the folder's own commit, made from the signed commit (git.ts, folderCommit).
  const folder = contract.mode !== "research" ? contract.project.folder : undefined;
  let start = seed.commit;
  if (contract.mode !== "research") {
    const mirror = svc.mirrorFor(seed.repo);
    if (!(await hasCommit(mirror, seed.commit))) {
      throw new Refusal(
        `seed commit ${seed.commit} is not in ${seed.repo}; import its bundle first`,
      );
    }
    if (folder) start = await folderCommit(mirror, seed.commit, folder);
    // The ref first: if the ledger write below fails, a retry simply overwrites it.
    await updateRef(mirror, `refs/thermite/runs/${p.run}/champion`, start);
  }
  svc.ledger.tx(() => {
    svc.ledger.contracts.store(contract, parsed.sha, by);
    pauseOthers(svc.ledger, p.run, by);
    svc.ledger.runs.create({
      id: p.run,
      contract,
      contractSha: parsed.sha,
      seedRepo: seed.repo,
      seedCommit: start,
      ...(folder ? { seedFolder: { folder, commit: seed.commit } } : {}),
      direction: p.direction,
      agents: p.agents,
      promotion: p.promotion,
      askOwner: p.ask_owner,
      // The background the owner picked from past research: every agent's brief shows it.
      briefing: p.briefing?.map((b) => ({ text: b.text, from: b.from })),
      actor: by,
    });
    // A research run starts with its campaign's hypotheses as its own (goal 078).
    if (contract.mode === "research" && contract.hypotheses?.length)
      startingHypotheses(svc.ledger, p.run, contract.hypotheses, by);
    // The MCP servers the run's agents use, and which agents get each: what the gateway and
    // the advisors read from now on (goal 068).
    if (named.length)
      svc.ledger.appendEvent(by, "mcp_servers", p.run, { servers: canonicalUses(named) });
    // How each goal is really checked, as this rig's kit runs it (goal 082): control shows it
    // on the campaign's and the run's pages, also for a kit only the rig has.
    if (contract.mode === "goal" && checkedKit && kitRef)
      svc.ledger.appendEvent(
        by,
        "goal_checks",
        p.run,
        goalChecks(contract, { kit: checkedKit, repo: kitRef.repo, commit: kitRef.commit }),
      );
    // Another run's untried experiments start this run's queue, in order, each with who added
    // it, why, its state and where it came from.
    for (const s of p.queue ?? [])
      svc.queue.add(
        p.run,
        {
          title: s.title,
          details: s.details,
          family: s.family,
          why: s.why,
          by: s.by,
          state: s.state,
          from: s.from,
        },
        by,
      );
  });
  return {
    run: p.run,
    contract_sha: parsed.sha,
    ...(folder ? { start: { folder, commit: start } } : {}),
    imported,
    agents: p.agents !== false,
    ...(p.queue?.length ? { queue: p.queue.length } : {}),
    ...(p.briefing?.length ? { briefing: p.briefing.length } : {}),
  };
}
