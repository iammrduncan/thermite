import { z } from "zod";
import { mapInTurn } from "../../common/in-turn.ts";
import type { ControlStore } from "../store/index.ts";
import { campaignKnown, campaignViews, type RigView } from "../views/index.ts";

/**
 * Archive a campaign, and folders for campaigns in the dashboard's left navigation (goal 077).
 *
 * - **Archive.** An archived campaign leaves the left navigation, Needs you and the Overview's
 *   lists; the Campaigns page lists it under Archived. Its runs, results, kits and folder in the
 *   knowledge base stay. Control refuses to archive a campaign while a run of it is at work or
 *   waits to start, and refuses to start or resume a run of an archived one (issue.ts). An
 *   archived campaign keeps its folder (the owner, 2026-10-21): the navigation leaves it out of
 *   the folder and its count while it is archived, and unarchiving brings it back into the folder.
 * - **Folders.** A folder groups campaigns in the navigation, and nothing else: it is not a
 *   campaign's collection in the knowledge base. A campaign is in one folder or in none, archived or
 *   not. A folder with campaigns in it, archived ones too, is not deleted.
 *
 * The dashboard, REST (`/v1/campaigns/<campaign>/archive`, `/unarchive` and `/folder`,
 * `/v1/campaign-folders`) and MCP (`archive_campaign`, `unarchive_campaign`, `campaign_folders`,
 * `create_campaign_folder`, `rename_campaign_folder`, `delete_campaign_folder`, `move_campaign`)
 * all call these functions, so they check, refuse and audit alike.
 */

/** A folder's name: at most this many characters. */
export const FOLDER_NAME_MAX = 40;

export type ShelfOutcome<T> =
  | { ok: true; answer: T }
  | { ok: false; error: string; status: 400 | 404 | 409 };

const refused = (error: string, status: 400 | 404 | 409) => ({ ok: false, error, status }) as const;

/** Why a folder's name can't be used, in words, or "". `self`: the folder being renamed. */
export async function folderNameRefusal(
  store: ControlStore,
  name: string,
  self?: number,
): Promise<string> {
  const n = name.trim();
  if (!n) return "Give the folder a name.";
  if (n.length > FOLDER_NAME_MAX)
    return `A folder's name is at most ${FOLDER_NAME_MAX} characters.`;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  if (/[\u0000-\u001f\u007f]/.test(n)) return "A folder's name is one line of text.";
  const taken = await store.folders.get(n);
  if (taken && taken.id !== self) return `There is a folder named ${taken.name} already.`;
  return "";
}

/**
 * Why a campaign can't be archived now, in words, or "": a run of it at work, or one control sent a
 * rig to start or resume that the rig has not taken yet.
 */
export async function archiveRefusal(
  store: ControlStore,
  vs: RigView[],
  campaign: string,
): Promise<string> {
  const k = campaignViews(vs).find((x) => x.name === campaign);
  const lines = (k?.runs ?? [])
    .filter((x) => x.run.status === "running")
    .map((x) => ({
      rig: x.rig.id,
      run: x.run.id,
      words: `${x.run.id} is at work on ${x.rig.id}.`,
    }));
  for (const p of await store.commands.pendingStarts(campaign))
    if (!lines.some((l) => l.rig === p.rig && l.run === p.run))
      lines.push({ ...p, words: `${p.run} waits to start on ${p.rig}.` });
  if (!lines.length) return "";
  const shown = lines.slice(0, 3).map((l) => l.words);
  if (lines.length > 3) shown.push(`And ${lines.length - 3} more.`);
  return `Pause or close its runs first. ${shown.join(" ")}`;
}

/** Whether control knows a campaign by this name: from a rig's report, a saved version, an assignment or the knowledge base. */
const knows = async (store: ControlStore, campaign: string) =>
  (await campaignKnown(store, campaign)) || (await store.archive.get(campaign)) !== undefined;

export interface ArchiveAnswer {
  campaign: string;
  archived: boolean;
  /** When and by whom, while it is archived. */
  at: string | null;
  by: string | null;
  /** The folder it is in: kept while it is archived, and where it comes back. Null: none. */
  folder: string | null;
  /** False when it was so already. */
  changed: boolean;
}

/** Archives a campaign, or says in words why not. */
export async function archiveCampaign(
  store: ControlStore,
  vs: RigView[],
  campaign: string,
  by: string,
): Promise<ShelfOutcome<ArchiveAnswer>> {
  if (!(await knows(store, campaign)))
    return refused(`Control has no campaign named ${campaign}.`, 404);
  const folder = (await store.folders.of(campaign))?.name ?? null;
  const was = await store.archive.get(campaign);
  if (was)
    return { ok: true, answer: { campaign, archived: true, ...was, folder, changed: false } };
  const why = await archiveRefusal(store, vs, campaign);
  if (why) return refused(why, 409);
  const now = await store.archive.add(campaign, by);
  await store.auditLog.add(by, "campaign_archived", { campaign, folder });
  return { ok: true, answer: { campaign, archived: true, ...now, folder, changed: true } };
}

/** Unarchives a campaign: it comes back to the navigation, in the folder it kept. */
export async function unarchiveCampaign(
  store: ControlStore,
  campaign: string,
  by: string,
): Promise<ShelfOutcome<ArchiveAnswer>> {
  if (!(await knows(store, campaign)))
    return refused(`Control has no campaign named ${campaign}.`, 404);
  const folder = (await store.folders.of(campaign))?.name ?? null;
  const changed = await store.archive.remove(campaign);
  if (changed) await store.auditLog.add(by, "campaign_unarchived", { campaign, folder });
  return { ok: true, answer: { campaign, archived: false, at: null, by: null, folder, changed } };
}

export interface FolderView {
  name: string;
  campaigns: string[];
  created_at: string;
  created_by: string;
}

const folderView = (
  f: Awaited<ReturnType<ControlStore["folders"]["list"]>>[number],
): FolderView => ({
  name: f.name,
  campaigns: f.campaigns,
  created_at: f.created_at,
  created_by: f.created_by,
});

/**
 * The navigation's folders, each with its campaigns (archived ones too: they keep their folder),
 * and the archived campaigns, each with the folder it keeps.
 */
export async function campaignFoldersAnswer(store: ControlStore): Promise<{
  folders: FolderView[];
  archived: { campaign: string; at: string; by: string; folder: string | null }[];
}> {
  const folders = await store.folders.list();
  const of = (c: string) => folders.find((f) => f.campaigns.includes(c))?.name ?? null;
  return {
    folders: folders.map(folderView),
    archived: (await store.archive.list()).map((a) => ({ ...a, folder: of(a.campaign) })),
  };
}

/** Makes a folder in the navigation. */
export async function createFolder(
  store: ControlStore,
  name: string,
  by: string,
): Promise<ShelfOutcome<{ folder: FolderView }>> {
  const n = name.trim();
  const why = await folderNameRefusal(store, n);
  if (why) return refused(why, why.startsWith("There is") ? 409 : 400);
  await store.folders.add(n, by);
  await store.auditLog.add(by, "campaign_folder_created", { folder: n });
  const f = (await store.folders.list()).find((x) => x.name === n);
  return {
    ok: true,
    answer: {
      folder: f ? folderView(f) : { name: n, campaigns: [], created_at: "", created_by: by },
    },
  };
}

/** Renames a folder of the navigation. */
export async function renameFolder(
  store: ControlStore,
  folder: string,
  name: string,
  by: string,
): Promise<ShelfOutcome<{ folder: FolderView; was: string; changed: boolean }>> {
  const f = await store.folders.get(folder);
  if (!f) return refused(`There is no folder named ${folder}.`, 404);
  const n = name.trim();
  const why = await folderNameRefusal(store, n, f.id);
  if (why) return refused(why, why.startsWith("There is") ? 409 : 400);
  const changed = n !== f.name;
  if (changed) {
    await store.folders.rename(f.id, n);
    await store.auditLog.add(by, "campaign_folder_renamed", { folder: f.name, name: n });
  }
  const now = (await store.folders.list()).find((x) => x.id === f.id);
  return {
    ok: true,
    answer: {
      folder: now ? folderView(now) : { name: n, campaigns: [], created_at: "", created_by: "" },
      was: f.name,
      changed,
    },
  };
}

/**
 * Deletes an empty folder of the navigation; one with campaigns in it is refused in words, and an
 * archived one, which the navigation leaves out, is named as archived.
 */
export async function deleteFolder(
  store: ControlStore,
  folder: string,
  by: string,
): Promise<ShelfOutcome<{ deleted: string }>> {
  const f = (await store.folders.list()).find((x) => x.name.toLowerCase() === folder.toLowerCase());
  if (!f) return refused(`There is no folder named ${folder}.`, 404);
  const n = f.campaigns.length;
  if (n) {
    const named = await mapInTurn(f.campaigns, async (c) =>
      (await store.archive.get(c)) ? `${c} (archived)` : c,
    );
    const list = named.slice(0, 5).join(", ") + (n > 5 ? ` and ${n - 5} more` : "");
    return refused(
      `${f.name} is not empty. Move its ${n === 1 ? "campaign" : `${n} campaigns`} out first: ${list}.`,
      409,
    );
  }
  await store.folders.delete(f.id);
  await store.auditLog.add(by, "campaign_folder_deleted", { folder: f.name });
  return { ok: true, answer: { deleted: f.name } };
}

/**
 * Puts a campaign in a folder of the navigation, or (null or "") in none. An archived campaign
 * may move too: it keeps the new folder, and comes back into it when it is unarchived.
 */
export async function moveCampaign(
  store: ControlStore,
  campaign: string,
  folder: string | null,
  by: string,
): Promise<ShelfOutcome<{ campaign: string; folder: string | null; changed: boolean }>> {
  if (!(await knows(store, campaign)))
    return refused(`Control has no campaign named ${campaign}.`, 404);
  const want = folder?.trim() ? await store.folders.get(folder.trim()) : null;
  if (want === undefined) return refused(`There is no folder named ${folder}.`, 404);
  const was = (await store.folders.of(campaign)) ?? null;
  if ((was?.id ?? null) === (want?.id ?? null))
    return { ok: true, answer: { campaign, folder: want?.name ?? null, changed: false } };
  await store.folders.place(campaign, want?.id ?? null);
  await store.auditLog.add(by, "campaign_moved", {
    campaign,
    folder: want?.name ?? null,
    from: was?.name ?? null,
  });
  return { ok: true, answer: { campaign, folder: want?.name ?? null, changed: true } };
}

/** The bodies REST takes (MCP's inputs are the same fields). */
export const FolderNameBody = z.object({ name: z.string().max(200) }).strict();
export const MoveBody = z.object({ folder: z.string().max(200).nullable() }).strict();
