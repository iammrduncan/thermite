import type { z } from "zod";
import { Refusal } from "../../common/errors.ts";
import type { CommandPayloads } from "../../core/commands.ts";
import { type Kit, KitSchema, kitProblems } from "../../core/kit.ts";
import { sameUses, usesWords } from "../../core/mcp.ts";
import { hasCommit, isAncestor, showFile } from "../git.ts";
import type { Ledger } from "../ledger/index.ts";
import { runImport } from "./assignment.ts";
import type { HarnessService } from "./index.ts";

/**
 * A running run moved onto a later commit of its kit by the owner (goal 233): the newest
 * `kit_set` event names the commit the judge measures with from its next job, over the
 * contract's. The contract and its hash stay as they were.
 */

/** The kit commit the owner moved a run onto; none: the contract's. */
export function ownersKit(ledger: Ledger, run: string): string | undefined {
  return ledger.events.newest("kit_set", { subject: run })?.body.commit;
}

async function kitAt(mirror: string, repo: string, commit: string): Promise<Kit> {
  try {
    return KitSchema.parse(JSON.parse(await showFile(mirror, commit, "kit.json")));
  } catch (err) {
    throw new Refusal(
      `kit ${repo} at ${commit} has no valid kit.json: ${err instanceof Error ? err.message.slice(0, 500) : String(err)}`,
    );
  }
}

/**
 * The `kit_commit` command: the kit's bundle imported, the commit checked to come after the one
 * the run measures with, its kit.json to fit the contract as at an assignment, and its MCP servers
 * to be the run's; then a `kit_set` event, or with `preview` what it would do.
 */
export async function moveRunKit(
  svc: HarnessService,
  p: z.infer<(typeof CommandPayloads)["kit_commit"]>,
  by: string,
): Promise<Record<string, unknown>> {
  const contract = svc.contractFor(p.run);
  const ref = contract.mode !== "research" ? contract.project.kit : undefined;
  if (!ref) throw new Refusal(`${p.run} has no kit: there is nothing to move`);
  const [spec] = p.imports;
  if (!spec || spec.repo !== ref.repo)
    throw new Refusal(
      `${p.run} measures with kit ${ref.repo}, not ${spec?.repo}: a run moves only onto a later commit of its own kit`,
    );
  const from = ownersKit(svc.ledger, p.run) ?? ref.commit;
  if (spec.commit === from) throw new Refusal(`${p.run} measures with kit commit ${from} already`);
  const mirror = svc.mirrorFor(`kit-${ref.repo}`);
  if (!(await hasCommit(mirror, spec.commit))) await runImport(svc, spec, ref.repo, by);
  if (!(await isAncestor(mirror, from, spec.commit)))
    throw new Refusal(
      `kit commit ${spec.commit} does not come after ${from}, the one ${p.run} measures with: a run moves only onto a later commit of its kit`,
    );
  const kit = await kitAt(mirror, ref.repo, spec.commit);
  const problems = kitProblems(contract, kit, svc.targetType);
  if (problems.length)
    throw new Refusal(
      `the kit at ${spec.commit} does not fit the contract: ${problems.join("; ")}`,
    );
  const was = await kitAt(mirror, ref.repo, from);
  if (!sameUses(kit.mcp_servers ?? [], was.mcp_servers ?? []))
    throw new Refusal(
      `the kit at ${spec.commit} names the MCP servers ${usesWords(kit.mcp_servers ?? [])}, and the run's ${usesWords(was.mcp_servers ?? [])}: a run's servers are its assignment's`,
    );
  if (p.preview)
    return {
      run: p.run,
      preview: true,
      commit: spec.commit,
      from,
      words: `The run's judge would measure with kit ${ref.repo} at ${spec.commit.slice(0, 12)} (now ${from.slice(0, 12)}), from its next job; a job under way keeps the kit it started with. Nothing changed.`,
    };
  svc.ledger.appendEvent(by, "kit_set", p.run, {
    repo: ref.repo,
    commit: spec.commit,
    from,
    reason: p.reason,
  });
  return { run: p.run, commit: spec.commit, from };
}
