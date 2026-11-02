import { z } from "zod";
import { SupervisorFigures } from "../../core/api/control/rigs.ts";
import { parseContract } from "../../core/contract.ts";
import { isRigCheck, NAME_PATTERN, NAME_WORDS } from "../../core/ids.ts";
import type { ControlParts } from "../parts.ts";
import type { CampaignResults, CampaignSources, ControlStore } from "../store/index.ts";
import { campaignModes } from "../views/index.ts";
import { startARun } from "./start-run.ts";

/**
 * A new campaign from another run's champion (goal 185): its starting point is the champion's
 * commit on the run's champion branch in git (`thermite/<run>/champion`), its contract the run's
 * own or one the owner changed, its kit and MCP servers the run's, and its work going where the
 * run's went. The dashboard's **Start a campaign from #n**, REST and MCP's `start_campaign` share
 * it. A champion its rig has not pushed yet can't be a starting point: no other rig could fetch it.
 */

/** One run's branches as its rig's supervisor last reported them. */
type RunBranchesView = NonNullable<
  NonNullable<z.infer<typeof SupervisorFigures>["run_branches"]>[string]
>;

/** A run's branches from its rig's supervisor figures; null when it has none. */
export function runBranchesOf(
  supervisor: Record<string, unknown> | null,
  run: string,
): RunBranchesView | null {
  const all = SupervisorFigures.shape.run_branches.safeParse(supervisor?.run_branches);
  return (all.success && all.data?.[run]) || null;
}

interface FromChampionRequest {
  /** The run the champion is of, and its number. */
  run: string;
  champion: number;
  /** The new campaign's name. */
  name: string;
  /** A changed contract; none: the run's own. Its `campaign` and `version` are the new one's. */
  contract?: unknown;
  /** Whether the new campaign's runs may read the run's campaign's collection, read only. */
  grant?: boolean | undefined;
}

type FromChampionOutcome =
  | { ok: true; campaign: string; version: number; sha: string; commit: string; from: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

type Payload = {
  contract?: unknown;
  seed?: { repo: string; commit: string };
  imports?: {
    kind: string;
    repo?: string;
    commit?: string;
    source?: { git?: string; access?: string; control?: string };
  }[];
  results?: { git: string; access?: string };
  mcp_servers?: unknown;
};

/**
 * Saves the new campaign's first version: the champion's commit as its starting point. Starting a
 * run of it is Start a run's (startRun), with the rig the caller chose.
 */
function campaignFromChampion(
  store: ControlStore,
  req: FromChampionRequest,
  by: string,
  known: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): FromChampionOutcome {
  const refuse = (error: string, status: 400 | 404 | 409 = 409): FromChampionOutcome => ({
    ok: false,
    status,
    error,
  });
  const { run, champion, name } = req;
  if (!NAME_PATTERN.test(name)) return refuse(`A campaign's name is ${NAME_WORDS}.`, 400);
  if (isRigCheck(name))
    return refuse(
      "A name that starts with rig-check- is for rig checks. Choose another name.",
      400,
    );
  const kb = store.kb();
  if (known.has(name) || store.campaigns.versions(name).length || kb.reads(name).length)
    return refuse(`There is a campaign named ${name} already. Choose another name.`);
  const assigned = store.runRegistry.assigned(run);
  const row = assigned ? store.commands.row(assigned.command) : undefined;
  if (!assigned || !row) return refuse(`Control signed no assignment of ${run}.`, 404);
  const p = row.payload as Payload;
  const branches = runBranchesOf(store.reportedRigs.supervisor(assigned.rig), run);
  const commit = branches?.champions[String(champion)];
  if (!p.results || !branches)
    return refuse(
      `${run}'s work does not go to git, so its champions have no commits another rig can fetch. Start its campaign again with its work going to git, or take champion #${champion} as a patch.`,
      400,
    );
  if (!commit)
    return refuse(
      `Champion #${champion} of ${run} is not in git yet: its rig pushes each champion after its next export. Press Export on the rig's page, or wait for the hourly one.`,
      404,
    );
  const seed = p.seed;
  const project = (p.imports ?? []).find(
    (i) => i.kind === "repo_bundle" && i.repo === seed?.repo && i.commit === seed?.commit,
  );
  const kit = (p.imports ?? []).find((i) => i.kind === "kit_bundle");
  if (!seed || !project?.source?.git || !kit?.source)
    return refuse(`${run}'s assignment names no project and kit to start from.`, 400);
  const version = store.campaigns.nextVersion(name);
  const source = (req.contract ?? p.contract) as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") return refuse("The contract is not an object.", 400);
  const parsed = parseContract({ ...source, campaign: name, version });
  if (!parsed.ok)
    return refuse(
      `${req.contract ? "The changed contract" : `${run}'s contract`} is not valid: ${parsed.errors.join("; ")}`,
      400,
    );
  // The champion's commit is where the run's branches went: the project's repository, read with
  // its own access, or a results repository, read with the access that pushed there.
  const onProject = p.results.git === project.source.git;
  const fetchAccess = onProject ? project.source.access : p.results.access;
  const results: CampaignResults | undefined = p.results.access
    ? onProject
      ? { to: "project", access: p.results.access }
      : { to: "repository", git: p.results.git, access: p.results.access }
    : undefined;
  const sources: CampaignSources = {
    project: {
      url: p.results.git,
      ...(fetchAccess ? { access: fetchAccess } : {}),
      repo: seed.repo,
      commit,
    },
    kit: kit.source.control
      ? { control: kit.source.control }
      : {
          git: kit.source.git as string,
          ...(kit.source.access ? { access: kit.source.access } : {}),
        },
    ...(Array.isArray(p.mcp_servers) && p.mcp_servers.length ? { mcp_servers: p.mcp_servers } : {}),
    ...(results ? { results } : {}),
  };
  const from = assigned.campaign ?? run;
  store.campaigns.put({
    campaign: name,
    version,
    contract: parsed.contract,
    sha: parsed.sha,
    sources,
    copiedFrom: { campaign: from, rig: assigned.rig, run },
    by,
  });
  if (req.grant && from !== name) kb.grant(name, from, by);
  store.auditLog.add(by, "campaign_from_champion", {
    campaign: name,
    from: { campaign: from, run, champion, commit },
    sha: parsed.sha,
    changed_contract: req.contract !== undefined,
    ...(req.grant ? { grant: from } : {}),
  });
  return { ok: true, campaign: name, version, sha: parsed.sha, commit, from };
}

/** MCP's and REST's `start_campaign` body (goal 185). */
export const StartCampaignBody = z.strictObject({
  name: z.string().min(1).max(64),
  from: z.strictObject({ run: z.string().min(1).max(64), champion: z.number().int().min(1) }),
  /** A changed contract; none: the run's own. */
  contract: z.record(z.string(), z.unknown()).optional(),
  /** The rig its first run starts on; none: saved only. */
  rig: z.string().min(1).max(64).optional(),
  /** Its runs may read the source campaign's collection, read only. */
  grant: z.boolean().optional(),
});

/**
 * `start_campaign` (goal 185): the new campaign from a champion, then its first run on `rig`,
 * with Start a run's checks; with no rig, saved only. A run that cannot start leaves the campaign
 * saved, and says why.
 */
export async function startFromChampion(
  parts: ControlParts,
  body: z.infer<typeof StartCampaignBody>,
  by: string,
  owner: boolean,
): Promise<
  | {
      ok: true;
      campaign: string;
      version: number;
      contract_sha: string;
      commit: string;
      run?: string;
      command?: string;
      said?: string;
    }
  | { ok: false; status: 400 | 404 | 409; error: string }
> {
  const saved = campaignFromChampion(
    parts.store,
    {
      run: body.from.run,
      champion: body.from.champion,
      name: body.name,
      contract: body.contract,
      grant: body.grant,
    },
    by,
    campaignModes(parts.store, parts.views()),
  );
  if (!saved.ok) return saved;
  const out = {
    ok: true as const,
    campaign: saved.campaign,
    version: saved.version,
    contract_sha: saved.sha,
    commit: saved.commit,
  };
  if (!body.rig) return out;
  const started = await startARun(
    parts,
    { campaign: saved.campaign, rig: body.rig, agents: true },
    by,
    owner,
  );
  if (started.state === "started") return { ...out, run: started.run, command: started.command };
  return {
    ...out,
    said:
      started.state === "refused"
        ? `Saved, and no run started: ${started.error}`
        : `Saved, and no run started yet: ${started.said}`,
  };
}
