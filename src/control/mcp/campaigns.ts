import { z } from "zod";
import {
  COMPACT_AT_MAX,
  COMPACT_AT_MIN,
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
} from "../../core/compaction.ts";
import { ROLE_ADDITION_MAX_CHARS } from "../../core/role-additions.ts";
import {
  archiveCampaign,
  type CopyCampaignRequest,
  campaignAdditionsAnswer,
  campaignAdditionsFields,
  campaignContextAnswer,
  campaignContextFields,
  campaignFoldersAnswer,
  copyACampaign,
  copyCampaignAnswer,
  copyCampaignFields,
  createFolder,
  deleteFolder,
  FOLDER_NAME_MAX,
  moveCampaign,
  renameFolder,
  type ShelfOutcome,
  type StartRunBody,
  setCampaignAdditions,
  setCampaignContext,
  startARun,
  startRunAnswer,
  startRunFields,
  startRunRequest,
  unarchiveCampaign,
} from "../campaigns/index.ts";
import { rigView } from "../views/index.ts";
import type { ToolContext } from "./context.ts";

/** A run of a campaign started, and a campaign copied: the owner's token and an operator's. */
export function registerRunStarts(tools: ToolContext): void {
  const { server, opts, actor, role, canCommand, audited } = tools;

  // Start a run, as a campaign page's Start a run does (campaigns/start-run.ts): the owner's token and an
  // operator's, which may assign runs with issue_command too.
  if (canCommand) {
    server.registerTool(
      "start_run",
      {
        title: "Start a run of a campaign",
        description: `As a campaign page's Start a run does, with the same checks and refusals in words: a new run of a campaign control keeps (saved on the New campaign page, or assigned before; control then assigns it again with the same contract, starting point and imports) on a rig whose hardware the campaign's kit measures on. On a busy rig the run at work pauses, as a rig runs one run at a time. Returns the new run and its command id (follow it with command_status), with notes in words. When the campaign sets its own context settings (set_campaign_context), agents_context says what each agent works with: its model, its window (the lower of the campaign's and its own model's) and its compaction point; a campaign window above what a provider lists for one of the rig's agents' models is refused. A rig with no model for its agents is refused: give agents_model (control gives the rig that model first and answers started: false; start the run again once the rig has it), or use set_rig_model. On a rig launched on RunPod whose pod is stopped, control starts the pod first (the owner's token only; another token is refused), and woke says so.${role === "owner" ? "" : " judge_gpus is the owner's alone."}`,
        inputSchema: {
          campaign: z.string().min(1).describe("The campaign, as on its page"),
          ...startRunFields,
        },
      },
      audited("start_run", async (a: StartRunBody & { campaign: string }) => {
        const { campaign, ...body } = a;
        // A new GPU split restarts the rig's harness: Edit rig's, which is the owner's.
        if (role !== "owner" && body.judge_gpus !== undefined)
          throw new Error(
            "Only the owner's token changes a rig's GPU split: leave out judge_gpus.",
          );
        const out = await startARun(
          opts.parts,
          startRunRequest(campaign, body),
          actor,
          role === "owner",
        );
        if (out.state === "refused") throw new Error(out.error);
        return startRunAnswer(out);
      }),
    );
  }
  // Copy a campaign (goal 069): the owner's token and an operator's, as for start_run.
  if (canCommand) {
    server.registerTool(
      "copy_campaign",
      {
        title: "Copy a campaign",
        description:
          "A new campaign with another name, from a campaign control keeps: the same contract and kit as its newest saved version (or, for a campaign only assigned before, as that assignment), with the new name in the contract, so its contract hash is its own. The copy has its own empty folder in Thermite's knowledge base; it reads no other folder, and no folder is granted to it. It has no runs: start one with start_run. Use it to compare two models on the same campaign, each from zero: two runs of one campaign share its collection in the knowledge base, so each starts with what the other recorded. A research campaign's copy may name other MCP servers for its agents (mcp_servers), with the New campaign page's checks; a hill-climb or goal campaign's servers are in its kit, which a copy does not change. A copy may set its own context settings for its runs' agents (agents_context, as set_campaign_context takes them), in place of the source's. The copy keeps the source's brief (its additional information, starting links, ideas to try and hypotheses); notes, links, ideas and hypotheses each replace the source's part. Returns {campaign, version, contract_sha, from}, and agents_context when the copy has any. Refused in words: a name that is taken or not valid, a campaign with no saved version and no assignment, a rig check's campaign, mcp_servers for a campaign with a kit, a server Settings lacks, a tool its server does not list, the planner (a research run has none), a context window or compaction point out of range, ideas for a research campaign.",
        inputSchema: {
          from: z.string().min(1).describe("The campaign to copy, as on its page"),
          ...copyCampaignFields,
        },
      },
      audited("copy_campaign", (a: CopyCampaignRequest) => {
        const out = copyACampaign(
          opts.parts,
          {
            from: a.from,
            name: a.name,
            ...(a.mcp_servers !== undefined ? { mcp_servers: a.mcp_servers } : {}),
            ...(a.agents_context !== undefined ? { agents_context: a.agents_context } : {}),
            // The copy's own brief (goal 078), each part in place of the source's.
            ...(a.notes !== undefined ? { notes: a.notes } : {}),
            ...(a.links !== undefined ? { links: a.links } : {}),
            ...(a.ideas !== undefined ? { ideas: a.ideas } : {}),
            ...(a.hypotheses !== undefined ? { hypotheses: a.hypotheses } : {}),
          },
          actor,
        );
        if (out.state === "refused") throw new Error(out.error);
        return copyCampaignAnswer(out);
      }),
    );
  }
}

/**
 * A campaign's own context settings, and the shelf: archived campaigns and the dashboard
 * navigation's folders. Every token but the agent's reads; the owner and an operator change them.
 */
export function registerCampaignSettings(tools: ToolContext): void {
  const { server, store, opts, actor, canCommand, audited } = tools;

  // A campaign's own context settings for all its runs' agents (goal 070): the tokens that may
  // copy a campaign may set them. A new version of its contract.
  if (canCommand) {
    server.registerTool(
      "set_campaign_context",
      {
        title: "Set a campaign's context window and compaction point",
        description: `Sets the context window and the compaction point that every agent of a campaign's runs works with: the workers, the planner and the advisors. The rig sets the defaults (each agent's model, its cap and its point: set_rig_model); a campaign may set its own. context_window (tokens, ${CONTEXT_WINDOW_MIN} to ${CONTEXT_WINDOW_MAX}): each agent's window is the lower of it and its own model's, never above the rig's or the provider's. compact_at (percent, ${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}): replaces the rig's point. Each call sets them anew: a call without them removes them. Control saves a new version of the campaign's contract (its agents_context), as the New campaign page saves one; runs started from then take it, and a run keeps the settings it started with. Start a run says what applies to each agent, and refuses a window above what a provider lists for one of the rig's agents' models. A rig's harness older than this change refuses a contract with agents_context. Returns {campaign, version, contract_sha, agents_context, said}. Refused in words: a campaign with no saved version and no assignment, a rig check's campaign, a value out of range.`,
        inputSchema: {
          campaign: z.string().min(1).describe("The campaign, as on its page"),
          ...campaignContextFields,
        },
      },
      audited(
        "set_campaign_context",
        (a: { campaign: string; context_window?: number; compact_at?: number }) => {
          const out = setCampaignContext(
            store,
            {
              campaign: a.campaign,
              contextWindow: a.context_window,
              compactAt: a.compact_at,
            },
            actor,
          );
          if (out.state === "refused") throw new Error(out.error);
          return campaignContextAnswer(out);
        },
      ),
    );
    // The owner's additions to a campaign's roles (goal 166): a new version of its contract.
    server.registerTool(
      "set_campaign_additions",
      {
        title: "Add the owner's text to a campaign's roles",
        description: `Sets the owner's additions to a campaign's agent roles: text added to a role's own instructions for this campaign's runs, without a change to Thermite's code. additions: each role's text, by the role's id (agent_roles lists the roles): worker, planner, teacher, merged-by, auditor or reviewer for a hill-climb or goal campaign; research-worker, research-planner, research-teacher, research-merged-by, research-reviewer, synthesizer or final-writer for a research campaign; each at most ${ROLE_ADDITION_MAX_CHARS} characters. Each prompt of the role carries its addition as a section of its own after the role's text, labelled as the owner's, with the contract's version; it adds to the role's text and replaces none of it, and the role's text comes first where the two differ. An addition never decides a measurement, a verdict or a promotion: code does. Each call sets them anew: a role left out, or an empty text, has none. Control saves a new version of the campaign's contract (its role_additions), signed into each assignment; runs started from then take it, and a run keeps what it started with. A rig's harness older than this change refuses a contract with role_additions. Returns {campaign, version, contract_sha, role_additions, said}. Refused in words: a role the campaign's mode never runs, an unknown role, a text too long, a campaign with no saved version and no assignment, a rig check's campaign.`,
        inputSchema: {
          campaign: z.string().min(1).describe("The campaign, as on its page"),
          ...campaignAdditionsFields,
        },
      },
      audited(
        "set_campaign_additions",
        (a: { campaign: string; additions?: Record<string, string> }) => {
          const out = setCampaignAdditions(
            store,
            { campaign: a.campaign, additions: a.additions },
            actor,
          );
          if (out.state === "refused") throw new Error(out.error);
          return campaignAdditionsAnswer(out);
        },
      ),
    );
  }
  // Archive a campaign, and the dashboard navigation's folders (goal 077): the same functions as
  // the dashboard and REST. The reader may read them; the owner and an operator change them.
  const allViews = () =>
    store.reportedRigs
      .list()
      .map((u) =>
        rigView(store, u.id, {
          staleAfterMs: opts.staleAfterMs,
          offlineAfterMs: opts.offlineAfterMs,
          control: opts.control,
        }),
      )
      .filter((v): v is NonNullable<typeof v> => v !== undefined);
  const shelved = <T>(out: ShelfOutcome<T>): T => {
    if (!out.ok) throw new Error(out.error);
    return out.answer;
  };
  server.registerTool(
    "campaign_folders",
    {
      title: "Campaign folders and archived campaigns",
      description:
        "How the owner arranged the campaigns in the dashboard's left navigation: each folder, by name, with the campaigns in it ({name, campaigns, created_at, created_by}), archived ones too, and the archived campaigns ({campaign, at, by, folder}), which are out of the navigation, Needs you and the Overview. An archived campaign keeps its folder (folder: its name, or null), but the navigation neither shows nor counts it there until it is unarchived. A campaign in no folder and not archived shows on its own in the navigation. These folders only group campaigns there: they are not the campaigns' collections in the knowledge base (kb_collections).",
      inputSchema: {},
    },
    audited("campaign_folders", () => campaignFoldersAnswer(store)),
  );
  if (canCommand) {
    const campaignInput = {
      campaign: z.string().min(1).describe("The campaign, as on its page"),
    };
    server.registerTool(
      "archive_campaign",
      {
        title: "Archive a campaign",
        description:
          "As Archive on a campaign's page: the campaign leaves the dashboard's left navigation, Needs you and the Overview's lists, and the Campaigns page lists it under Archived. Its runs, results, kits and collection in the knowledge base stay, and it keeps its folder in the navigation, where it comes back when unarchived. Control starts and resumes no run of an archived campaign until unarchive_campaign. Returns {campaign, archived: true, at, by, folder, changed} (changed: false when it was archived already). Refused in words while a run of it is at work or waits to start (a start or resume control sent that the rig has not taken yet): \"Pause or close its runs first.\", with each such run; and for a campaign control does not know.",
        inputSchema: campaignInput,
      },
      audited("archive_campaign", (a: { campaign: string }) =>
        shelved(archiveCampaign(store, allViews(), a.campaign, actor)),
      ),
    );
    server.registerTool(
      "unarchive_campaign",
      {
        title: "Unarchive a campaign",
        description:
          "As Unarchive on the Campaigns page's Archived list: the campaign comes back to the dashboard's left navigation, in the folder it kept, and its runs may start again. Returns {campaign, archived: false, at: null, by: null, folder, changed} (changed: false when it was not archived). Refused in words for a campaign control does not know.",
        inputSchema: campaignInput,
      },
      audited("unarchive_campaign", (a: { campaign: string }) =>
        shelved(unarchiveCampaign(store, allViews(), a.campaign, actor)),
      ),
    );
    const folderName = z.string().max(200).describe(`At most ${FOLDER_NAME_MAX} characters`);
    server.registerTool(
      "create_campaign_folder",
      {
        title: "Make a folder for campaigns",
        description: `A folder in the dashboard's left navigation, to group campaigns there (move_campaign puts one in it). Not a folder of the knowledge base. A name is one line of at most ${FOLDER_NAME_MAX} characters, and two folders can't have the same one, whatever its case. Returns {folder: {name, campaigns, created_at, created_by}}. Refused in words: an empty name, a name too long, a taken one.`,
        inputSchema: { name: folderName },
      },
      audited("create_campaign_folder", (a: { name: string }) =>
        shelved(createFolder(store, a.name, actor)),
      ),
    );
    server.registerTool(
      "rename_campaign_folder",
      {
        title: "Rename a folder for campaigns",
        description:
          "Renames a folder of the dashboard's left navigation; its campaigns stay in it. Returns {folder, was, changed}. Refused in words: no such folder, an empty name, a name too long, a taken one.",
        inputSchema: {
          folder: z.string().min(1).max(200).describe("The folder's name now"),
          name: folderName.describe("Its new name"),
        },
      },
      audited("rename_campaign_folder", (a: { folder: string; name: string }) =>
        shelved(renameFolder(store, a.folder, a.name, actor)),
      ),
    );
    server.registerTool(
      "delete_campaign_folder",
      {
        title: "Delete an empty folder for campaigns",
        description:
          "Deletes a folder of the dashboard's left navigation that has no campaign in it, archived ones included. Returns {deleted}. Refused in words: no such folder, or one with campaigns in it, each archived one marked (archived) (move them out first with move_campaign, folder: null).",
        inputSchema: { folder: z.string().min(1).max(200).describe("The folder's name") },
      },
      audited("delete_campaign_folder", (a: { folder: string }) =>
        shelved(deleteFolder(store, a.folder, actor)),
      ),
    );
    server.registerTool(
      "move_campaign",
      {
        title: "Move a campaign to a folder",
        description:
          "Puts a campaign in a folder of the dashboard's left navigation (folder: its name), or in none (folder: null). Only the navigation changes: not its runs, results or collection in the knowledge base. An archived campaign may move too: it comes back into its new folder when it is unarchived. Returns {campaign, folder, changed}. Refused in words: no such campaign or folder.",
        inputSchema: {
          ...campaignInput,
          folder: z.string().max(200).nullable().describe("The folder's name, or null for none"),
        },
      },
      audited("move_campaign", (a: { campaign: string; folder: string | null }) =>
        shelved(moveCampaign(store, allViews(), a.campaign, a.folder, actor)),
      ),
    );
  }
}
