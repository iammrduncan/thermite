import { type RunView, runCampaign } from "../views/index.ts";

/**
 * The dashboard's addresses (goal 170): every link to a campaign, a run and what a run owns, and
 * to a rig, is made here, and the dashboard's routes for a run take their paths from RUN_ROUTES.
 * A thing is addressed through what owns it: a run under its campaign, an attempt under its run,
 * wherever the run ran. The rig a run ran on is a fact about it, not part of its address. A run's
 * name is unique on control, so the campaign and the run name it.
 */

const enc = encodeURIComponent;

/** A run as its addresses name it: its id, and its campaign (a run without one is its own). */
export type RunRef = Pick<RunView, "id" | "campaign">;

/**
 * A run page's tabs. Stats: its model use in detail (goal 075), for a run with agents or spend.
 * Reviews and Hypotheses: a research run's (goals 116 and 117). Prompts: what its agents were
 * sent (goal 166).
 */
export const RUN_TABS = [
  "overview",
  "experiments",
  "journal",
  "reviews",
  "hypotheses",
  "attempts",
  "history",
  "planner",
  "prompts",
  "stats",
] as const;
export type RunTab = (typeof RUN_TABS)[number];

/** The tab a path's last part names, or undefined for none of them (the overview has no part). */
export const runTab = (part: string): Exclude<RunTab, "overview"> | undefined =>
  RUN_TABS.find((t): t is Exclude<RunTab, "overview"> => t !== "overview" && t === part);

/** The dashboard's routes for a run and what it owns, as the router takes them. */
export const RUN_ROUTES = {
  run: "/ui/campaigns/:campaign/runs/:run",
  /** One of RUN_TABS but the overview; registered after the routes below, which it would match. */
  tab: "/ui/campaigns/:campaign/runs/:run/:tab",
  attempt: "/ui/campaigns/:campaign/runs/:run/attempts/:attempt",
  /** One prompt a run's agent was sent (goal 166). */
  prompt: "/ui/campaigns/:campaign/runs/:run/prompts/:id",
  live: "/ui/campaigns/:campaign/runs/:run/live",
  liveStream: "/ui/campaigns/:campaign/runs/:run/live/stream",
  message: "/ui/campaigns/:campaign/runs/:run/message",
  paper: "/ui/campaigns/:campaign/runs/:run/paper.md",
  champion: "/ui/campaigns/:campaign/runs/:run/champions/:file",
  /** The owner leaves a stuck trial running (goal 143): its card stays away until it is stuck again. */
  leaveTrial: "/ui/campaigns/:campaign/runs/:run/trials/:trial/leave",
} as const;

/** A campaign's page. */
export const campaignHref = (name: string) => `/ui/campaigns/${enc(name)}`;

/** A run's page, under its campaign, and one of its tabs. */
export const runHref = (r: RunRef, tab: RunTab = "overview") =>
  `${campaignHref(runCampaign(r))}/runs/${enc(r.id)}${tab === "overview" ? "" : `/${tab}`}`;

/** One attempt's page, under its run. */
export const attemptHref = (r: RunRef, attempt: string) => `${runHref(r)}/attempts/${enc(attempt)}`;

/**
 * Live for one run: its lanes, judge, planner and advisors, and the message box. `w` shows one of
 * them (a lane, planner, judge, advisors or you); `compose` puts the cursor in the message box.
 */
export const runLiveHref = (r: RunRef, o: { w?: string; compose?: boolean } = {}) => {
  const q = new URLSearchParams();
  if (o.w && o.w !== "all") q.set("w", o.w);
  if (o.compose) q.set("compose", "1");
  const query = q.toString();
  return `${runHref(r)}/live${query ? `?${query}` : ""}`;
};

/** A run's new Live lines, pushed to its page as they come (server-sent events). */
export const runLiveStreamHref = (r: RunRef) => `${runHref(r)}/live/stream`;

/** Where the owner's message to a run's agents is sent, from Live and the Planner tab. */
export const runMessageHref = (r: RunRef) => `${runHref(r)}/message`;

/** A research run's paper as a Markdown file (goal 112), from its rig's report. */
export const paperHref = (r: RunRef) => `${runHref(r)}/paper.md`;

/** One of a run's champions as a patch file, once its rig has published it. */
export const championPatchHref = (r: RunRef, seq: number) => `${runHref(r)}/champions/${seq}.patch`;

/** Where the owner leaves one of a run's stuck trials running. */
export const leaveTrialHref = (r: RunRef, trial: string) =>
  `${runHref(r)}/trials/${enc(trial)}/leave`;

/** A rig's page. */
export const rigHref = (rig: string) => `/ui/rigs/${enc(rig)}`;

/** A rig's Live: its sessions over every run, or one source's. */
export const liveHref = (rig: string, source?: string) =>
  `${rigHref(rig)}/live${source ? `?source=${enc(source)}` : ""}`;

/** A rig's new Live lines, pushed to its page as they come (server-sent events). */
export const rigLiveStreamHref = (rig: string) => `${rigHref(rig)}/live/stream`;

/** The knowledge explorer's root (goal 176). */
export const KNOWLEDGE_ROOT = "/ui/knowledge";

/**
 * The knowledge explorer at a place (`<campaign>`, `<campaign>/<run>`, `<campaign>/<run>/<slot>`)
 * or an item's own page, by its address (`<campaign>/<run>/<slot>/<kind>:<id>`). Each part is one
 * segment of the path: an item's id may hold `/`, which its segment keeps encoded; its `:` stays.
 */
export function knowledgeHref(at = ""): string {
  if (!at) return KNOWLEDGE_ROOT;
  const parts = at.split("/");
  const segments = parts.length > 4 ? [...parts.slice(0, 3), parts.slice(3).join("/")] : parts;
  return `${KNOWLEDGE_ROOT}/${segments.map((s) => enc(s).replace(/%3A/g, ":")).join("/")}`;
}

/** The parts of an explorer's path, each decoded: a place's, or an item's (its fourth). */
export function knowledgeParts(path: string): string[] | undefined {
  if (path !== KNOWLEDGE_ROOT && !path.startsWith(`${KNOWLEDGE_ROOT}/`)) return undefined;
  const raw = path.slice(KNOWLEDGE_ROOT.length).split("/").filter(Boolean);
  try {
    const parts = raw.map((s) => decodeURIComponent(s));
    return parts.length > 4 ? [...parts.slice(0, 3), parts.slice(3).join("/")] : parts;
  } catch {
    // A broken escape, such as %zz, names no place.
    return undefined;
  }
}
