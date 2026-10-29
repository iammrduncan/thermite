import type { McpUse } from "../../../core/mcp.ts";
import {
  campaignContract,
  contractContext,
  copiedFromWords,
  copiedMcpWords,
  ownModels,
  rigContext,
} from "../../campaigns/index.ts";
import { campaignMcpServers } from "../../mcp-servers/index.ts";
import { startLine, startNote } from "../../ui/campaigns/context/index.ts";
import { copyDrawer, suggestCopyName } from "../../ui/campaigns/copy/index.ts";
import { isRigCheck, lastActivity, type StartRig, startDrawer } from "../../ui/campaigns/list.ts";
import { infoLabel } from "../../ui/campaigns/new/index.ts";
import { ago, esc, hardwareLine, icon } from "../../ui/components/index.ts";
import { pastSection } from "../../ui/knowledge.ts";
import { campaignHref } from "../../ui/urls.ts";
import { earlierWords } from "../../ui/words/index.ts";
import {
  campaignModes,
  campaignViews,
  podStopped,
  type RigView,
  type RunOnRig,
} from "../../views/index.ts";
import type { Ctx, Dashboard } from "../context.ts";
import { modelPrefix } from "../settings/shared.ts";
import { campaignHelpers, copiedBy } from "./shared.ts";

/** A try of the Copy panel that control refused (goal 069): what it sent, and why not. */
export interface CopyTry {
  name: string;
  picked?: McpUse[] | undefined;
  error: string;
  /** The copy's Agents' context as typed (goal 070). */
  context?: { cw: string; ca: string } | undefined;
}

/**
 * The Start a run and Copy panels of a campaign's page (another run of a campaign), with the
 * lines and actions beside them.
 */
export function campaignPanels(dash: Dashboard) {
  const { csrf, mcpServers, opts, store } = dash;
  const { pastResults } = campaignHelpers(dash);

  /** Rigs for the Start a run panel: hardware, whether the campaign's kit fits, busy, the model. */
  const startRigs = (campaign: string, vs: RigView[]): StartRig[] => {
    const want =
      (
        store.campaigns.versions(campaign)[0]?.contract as
          | { target?: { type?: string } }
          | undefined
      )?.target?.type ??
      (
        store.commands.latestAssignments().get(campaign)?.payload.contract as
          | { target?: { type?: string } }
          | undefined
      )?.target?.type;
    const given = store.agentModels.byRig();
    return vs.map((u) => {
      const t = u.hardware?.target?.type;
      const busy = u.runs.find((r) => r.status === "running");
      return {
        id: u.id,
        hardware: u.hardware ? hardwareLine(u.hardware) : t ? t : "",
        off:
          want && t && t !== want
            ? `Other hardware: this campaign is measured on ${want}, this rig on ${t}.`
            : undefined,
        busy: busy ? busy.id : undefined,
        stale: u.stale,
        stopped: podStopped(u),
        model:
          given[u.id]?.model ??
          (u.model?.source !== "none" ? (u.model?.model ?? undefined) : undefined),
      };
    });
  };
  /** Whether control can start a run of a campaign: a saved version, or an earlier assignment. */
  const startFrom = (campaign: string): string | undefined => {
    const v = store.campaigns.versions(campaign)[0];
    // A copy of a campaign known only by an assignment takes that assignment's imports: no kit here.
    if (v && (opts.kits || v.sources.assignment))
      return `Control signs an assignment of version ${v.version} (saved ${esc(ago(v.created_at, Date.now()))} ago) to the rig; the rig fetches the project and the kit, checks both, and starts the run.`;
    const past = store.commands.latestAssignments().get(campaign);
    if (past)
      return `Control assigns the campaign again as it assigned ${esc(past.run)} on ${esc(past.rig)}: the same contract, starting point and imports, as a new run.`;
    return undefined;
  };
  /**
   * Start a run's rigs with what the campaign's Agents' context gives their workers (goal 070):
   * each one's note, its line when chosen, and whether control refuses the run there.
   */
  const startContext = (campaign: string, rigs: StartRig[]): StartRig[] => {
    if (isRigCheck(campaign)) return rigs;
    const contract = campaignContract(store, campaign) as { mode?: unknown } | undefined;
    const ctx = contractContext(contract);
    return rigs.map((r) => {
      if (r.off) return r;
      const now = rigContext(ownModels(store, r.id, contract?.mode), ctx);
      const note = startNote(now);
      return {
        ...r,
        context: {
          note: note.text,
          refused: note.bad,
          line: startLine(campaign, r.id, now, Boolean(ctx)),
        },
      };
    });
  };
  /** The Start a run panel; `runs`, every run of the campaign, earlier ones too (goal 170). */
  const startPanel = (
    c: Ctx,
    campaign: string,
    vs: RigView[],
    open: boolean,
    runs: readonly RunOnRig[],
  ) => {
    const from = startFrom(campaign);
    // An archived campaign starts no run (goal 077): its page offers Unarchive instead.
    if (!from || store.archive.get(campaign)) return "";
    const kb = store.kb();
    const pastQ = (c.req.query("past") ?? "").slice(0, 300);
    return startDrawer({
      past: pastSection({
        campaign,
        readable: kb.readable(campaign),
        q: pastQ,
        results: pastResults(campaign, pastQ),
        result: (x) => kb.resultOf(x),
      }),
      campaign,
      // The collections it may also search, read only (goal 175): those granted now.
      granted: kb.reads(campaign),
      csrf: csrf(c),
      open,
      rigs: startContext(campaign, startRigs(campaign, vs)),
      models: store.modelProviders
        .list()
        .filter((p) => p.models.length)
        .map((p) => ({
          group: p.name,
          options: p.models.map((m) => ({
            value: `${encodeURIComponent(p.name)}|${encodeURIComponent(m.id)}`,
            label: `${modelPrefix(p.type)}${m.id}`,
          })),
        })),
      from,
      // Every run of the campaign, earlier ones too (goal 170): their queues are in control's records.
      copyFrom: runs
        .map((x) => {
          const up = x.run.queue.filter((q) => q.state === "queued").length;
          const ideas = x.run.queue.filter((q) => q.state === "proposed").length;
          return { x, up, ideas };
        })
        .filter((y) => y.up + y.ideas > 0)
        .sort((a, b) => lastActivity(b.x.run).localeCompare(lastActivity(a.x.run)))
        .map(({ x, up, ideas }) => ({
          key: x.run.id,
          label: `${x.run.id} (${x.earlier ? `${earlierWords(x.rig.id, x.earlier)}, ` : ""}${up} up next${ideas ? `, ${ideas} lane idea${ideas === 1 ? "" : "s"}` : ""})`,
        })),
      // A judge-only run's queue links here with itself chosen (goal 099).
      copyPick: c.req.query("copy"),
    });
  };
  /** A copy's line on its page: where it came from, who copied it and when. */
  const copiedLine = (name: string): string => {
    const first = store.campaigns.versions(name).at(-1);
    const f = first?.copied_from;
    if (!first || !f) return "";
    const now = Date.now();
    const when =
      now - Date.parse(first.created_at) < 60_000
        ? "just now"
        : `${ago(first.created_at, now)} ago`;
    return `<div class="card" style="margin-bottom:16px"><span class="muted">Copied from</span> <a href="${campaignHref(f.campaign)}">${esc(copiedFromWords(f))}</a> <span class="muted">by ${esc(copiedBy(first.created_by))}, ${esc(when)}. Its collection in the knowledge base started empty.${f.other_mcp_servers ? ` ${esc(copiedMcpWords(first.contract))}` : ""}</span></div>`;
  };
  /**
   * What a copy of a campaign takes, as copyCampaign takes it: whether it is research, what it
   * copies in words, and the servers its agents use. Undefined: control can't copy it.
   */
  const copySource = (name: string) => {
    if (isRigCheck(name)) return undefined;
    const saved = store.campaigns.versions(name)[0];
    const assigned = saved ? undefined : store.commands.latestAssignments().get(name);
    if (!saved && !assigned) return undefined;
    const contract = (saved?.contract ?? assigned?.payload.contract) as
      | { mode?: unknown }
      | undefined;
    return {
      research: contract?.mode === "research",
      what: saved
        ? `version ${saved.version} of ${name}`
        : copiedFromWords({ campaign: name, rig: assigned?.rig, run: assigned?.run }),
      servers: campaignMcpServers(store, name) ?? [],
    };
  };
  /**
   * The names a copy may not take (every campaign control knows, and each a grant names), and
   * of those, the ones only the knowledge base knows, which the panel names as such.
   */
  const copyNames = (vs: RigView[]) => {
    const taken = [
      ...new Set([...campaignModes(store, vs).keys(), ...store.kb().grantNames()]),
    ].sort();
    const ran = new Set([
      ...campaignViews(vs).map((k) => k.name),
      ...store.campaigns.versions().map((v) => v.campaign),
      ...store.commands.latestAssignments().keys(),
    ]);
    return { taken, folderOnly: taken.filter((n) => !ran.has(n)) };
  };
  /** The Copy panel of a campaign's page, or "" for a campaign control can't copy. */
  const copyPanel = (c: Ctx, name: string, vs: RigView[], tried?: CopyTry) => {
    const src = copySource(name);
    if (!src) return "";
    const names = copyNames(vs);
    return copyDrawer({
      campaign: name,
      research: src.research,
      what: src.what,
      csrf: csrf(c),
      open: tried !== undefined || c.req.query("copy") === "1",
      name: tried?.name ?? suggestCopyName(name, new Set(names.taken)),
      taken: names.taken,
      folderOnly: names.folderOnly,
      servers: mcpServers.list(),
      source: src.servers,
      picked: tried?.picked,
      error: tried?.error,
      context: contractContext(campaignContract(store, name)),
      typed: tried?.context,
    });
  };
  /**
   * A campaign's buttons at the top of its page: Copy, then Start a run, as control can, then ⋯
   * with Move to folder and Archive (goal 077). An archived campaign starts no run: its ⋯ has
   * Unarchive.
   */
  const campaignActions = (c: Ctx, name: string) => {
    const archived = store.archive.get(name);
    const hidden = `<input type="hidden" name="csrf" value="${esc(csrf(c))}">`;
    const folders = store.folders.list();
    const here = store.folders.of(name);
    const move = folders.length
      ? `<form class="sfd" method="post" action="${campaignHref(name)}/folder">${hidden}${infoLabel("Move to folder", archived ? "The folder this campaign keeps while it is archived, and comes back into when you unarchive it. Its runs, results and collection in the knowledge base do not change." : "Where this campaign shows in the left navigation. You can also drag it there. Its runs, results and collection in the knowledge base do not change.")}<span class="kmove"><select name="folder" aria-label="Folder"><option value=""${here ? "" : " selected"}>No folder</option>${folders.map((f) => `<option value="${f.id}"${f.id === here?.id ? " selected" : ""}>${esc(f.name)}</option>`).join("")}</select><button class="sm">Move</button></span></form>`
      : `<div class="sfd">${infoLabel("Move to folder", "Where this campaign shows in the left navigation. Make a folder with the folder button beside Campaigns there.")}<span class="muted small">No folder yet: make one with the folder button beside Campaigns in the navigation.</span></div>`;
    const more = `<details class="menu" data-campaign-more><summary class="btn" title="More" aria-label="More">${icon.dots}</summary><div class="menu-pop kmore-pop">${
      archived
        ? `${move}<div class="fsep"></div><form method="post" action="${campaignHref(name)}/unarchive">${hidden}<button class="sm">Unarchive</button></form><span class="muted small">It comes back to the navigation, ${here ? `in ${esc(here.name)}` : "in no folder"}.</span>`
        : `${move}<div class="fsep"></div><form method="post" action="${campaignHref(name)}/archive">${hidden}<button class="sm">${icon.archive}Archive</button></form><span class="muted small">Out of the navigation, Needs you and the Overview. Its runs, results and kits stay.</span>`
    }</div></details>`;
    return `${copySource(name) ? `<a class="btn" href="${campaignHref(name)}?copy=1" data-open="#copy">${icon.copy}Copy</a>` : ""}${!archived && startFrom(name) ? `<a class="btn primary" href="${campaignHref(name)}?start=1" data-open="#start">${icon.play}Start a run</a>` : ""}${more}`;
  };
  /** An archived campaign's line at the top of its page, with Unarchive. */
  const archivedLine = (c: Ctx, name: string) => {
    const a = store.archive.get(name);
    if (!a) return "";
    const folder = store.folders.of(name);
    return `<div class="card" style="margin-bottom:16px"><b>${icon.archive} Archived</b> ${esc(ago(a.at, Date.now()))} ago by ${esc(copiedBy(a.by))}. <span class="muted">It is out of the navigation, Needs you and the Overview. Its runs, results and kits stay${folder ? `, and it keeps its folder, ${esc(folder.name)}` : ""}. Control starts no run of it until you unarchive it.</span> <form class="inline" method="post" action="${campaignHref(name)}/unarchive"><input type="hidden" name="csrf" value="${esc(csrf(c))}"><button class="sm">Unarchive</button></form></div>`;
  };
  return {
    archivedLine,
    campaignActions,
    copiedLine,
    copyPanel,
    copySource,
    startFrom,
    startPanel,
    startRigs,
  };
}
