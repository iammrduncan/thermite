import { parseContract } from "../../core/contract.ts";
import { isRigCheck } from "../../core/ids.ts";
import type { CampaignSources, ControlStore } from "../store/index.ts";
import { RUN_FIELDS } from "./copy.ts";

/**
 * A new version of a campaign's contract with some of its own settings changed, saved as the New
 * campaign page saves one, with the same sources: its context settings (context.ts) or the owner's
 * additions to its roles (additions.ts). A campaign control knows only by an assignment gets its
 * first saved version, from that assignment. Refused in words.
 */

export type SavedVersion =
  | {
      /**
       * saved: a new version; unchanged: the newest version has these settings already; valid:
       * checked only (`check`), it would be saved as this version.
       */
      state: "saved" | "unchanged" | "valid";
      campaign: string;
      version: number;
      sha: string;
    }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/**
 * Saves a new version of `campaign` whose `field` is `value` (undefined: the field is left out),
 * unless its newest saved version has it already (`same`). `what`: the settings in words, for a
 * rig check's refusal. The audit log records `action` with the version and `audit`. With `check`,
 * nothing is saved: the answer says whether it would be.
 */
export function saveWithField(
  store: ControlStore,
  o: {
    campaign: string;
    field: string;
    value: unknown;
    same: (saved: unknown) => boolean;
    what: string;
    by: string;
    action: string;
    audit: Record<string, unknown>;
    check?: boolean | undefined;
  },
): SavedVersion {
  const refuse = (error: string, status: 400 | 404 | 409 = 409): SavedVersion => ({
    state: "refused",
    error,
    status,
  });
  const { campaign } = o;
  if (isRigCheck(campaign))
    return refuse(`${campaign} is a rig check's campaign. Its agents keep ${o.what}.`, 400);
  const saved = store.campaigns.versions(campaign)[0];
  const assigned = store.commands.latestAssignments().get(campaign);
  const source = (saved?.contract ?? assigned?.payload.contract) as
    | Record<string, unknown>
    | undefined;
  if (!source)
    return refuse(
      `Control has no saved version or earlier assignment of ${campaign}. Save it on the New campaign page first.`,
      404,
    );
  if (saved && o.same(saved.contract))
    return { state: "unchanged", campaign, version: saved.version, sha: saved.sha };
  // Newer than every version a rig may hold: the harness refuses a version that is not newer.
  const assignedVersion = Number((assigned?.payload.contract as { version?: unknown })?.version);
  const version = Math.max(
    store.campaigns.nextVersion(campaign),
    Number.isInteger(assignedVersion) ? assignedVersion + 1 : 1,
  );
  const { [o.field]: _old, ...rest } = source;
  const parsed = parseContract({
    ...rest,
    version,
    ...(o.value !== undefined ? { [o.field]: o.value } : {}),
  });
  if (!parsed.ok)
    return refuse(
      `The contract of ${campaign} is not valid, so control cannot save a new version: ${parsed.errors.join("; ")}`,
    );
  if (o.check) return { state: "valid", campaign, version, sha: parsed.sha };
  const sources: CampaignSources = saved
    ? saved.sources
    : {
        assignment: Object.fromEntries(
          Object.entries((assigned as NonNullable<typeof assigned>).payload).filter(
            ([k]) => !RUN_FIELDS.has(k),
          ),
        ),
      };
  store.campaigns.put({
    campaign,
    version,
    contract: parsed.contract,
    sha: parsed.sha,
    sources,
    // A copy's later versions still say where it came from.
    copiedFrom: saved?.copied_from ?? undefined,
    by: o.by,
  });
  store.auditLog.add(o.by, o.action, { campaign, version, sha: parsed.sha, ...o.audit });
  return { state: "saved", campaign, version, sha: parsed.sha };
}
