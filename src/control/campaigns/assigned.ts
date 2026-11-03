import type { SignedCommand } from "../../core/commands.ts";
import { type Contract, parseContract } from "../../core/contract.ts";
import { isRigCheck } from "../../core/ids.ts";
import type { ControlStore } from "../store/index.ts";
import { RUN_FIELDS } from "./copy.ts";

/**
 * A campaign an assignment names, saved on control (goal 182): an `assign_campaign` issued any way
 * (MCP's `issue_command`, `POST /v1/commands`, `thermite assign`) keeps its contract as a version
 * of its campaign, with the assignment's starting point, imports and MCP servers as its sources,
 * as a copy of a campaign known only by an assignment keeps them. The campaign is then on control
 * before its first run starts and after its runs end: its page, Start a run, a copy and a grant of
 * a collection all find it. A version control has (from New campaign, Start a run, a copy or an
 * earlier assignment) is not saved again, and a rig check's campaign never is.
 */

/** The assignment's contract, parsed, when it names a campaign control may keep. */
function assignedContract(payload: unknown): { contract: Contract; sha: string } | undefined {
  const parsed = parseContract((payload as { contract?: unknown } | null)?.contract);
  if (!parsed.ok || isRigCheck(parsed.contract.campaign)) return undefined;
  return { contract: parsed.contract, sha: parsed.sha };
}

/**
 * Saves an issued assignment's contract as its campaign's version, unless control has that version:
 * then control keeps its own, as the owner may assign a contract changed under the same version.
 */
export function keepAssignedCampaign(store: ControlStore, signed: SignedCommand): void {
  const e = signed.envelope;
  if (e.kind !== "assign_campaign") return;
  const a = assignedContract(e.payload);
  if (!a) return;
  const { campaign, version } = a.contract;
  if (store.campaigns.versions(campaign).some((v) => v.version === version)) return;
  store.campaigns.put({
    campaign,
    version,
    contract: a.contract,
    sha: a.sha,
    sources: {
      assignment: Object.fromEntries(
        Object.entries(e.payload as Record<string, unknown>).filter(([k]) => !RUN_FIELDS.has(k)),
      ),
    },
    by: e.issued_by,
  });
}
