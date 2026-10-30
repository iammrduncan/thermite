import { Hono } from "hono";
import type { MountPages } from "../pages.ts";
import type { ControlStore } from "../store/index.ts";
import { actionRoutes } from "./actions.ts";
import { agentRoutes } from "./agents.ts";
import { newCampaignRoutes } from "./campaigns/new.ts";
import { campaignPageRoutes } from "./campaigns/page.ts";
import { attemptRoutes } from "./campaigns/run/attempt.ts";
import { runPageRoutes } from "./campaigns/run/page.ts";
import { shelfRoutes } from "./campaigns/shelf.ts";
import { commandRoutes } from "./commands.ts";
import { type DashboardOptions, dashboardContext } from "./context.ts";
import { knowledgeRoutes } from "./knowledge.ts";
import { liveRoutes } from "./live/index.ts";
import { overviewRoutes } from "./overview.ts";
import { recordRoutes } from "./records.ts";
import { addRigRoutes } from "./rigs/add.ts";
import { editRigRoutes } from "./rigs/edit.ts";
import { joinedRigRoutes } from "./rigs/joined.ts";
import { rigListRoutes } from "./rigs/list.ts";
import { rigPageRoutes } from "./rigs/page.ts";
import { runpodRigRoutes } from "./rigs/runpod.ts";
import { rigStateRoutes } from "./rigs/state.ts";
import { sessionRoutes } from "./session.ts";
import { cloudRoutes } from "./settings/clouds.ts";
import { clusterRoutes } from "./settings/clusters.ts";
import { machineRoutes } from "./settings/machines.ts";
import { settingsPageRoutes } from "./settings/page.ts";
import { providerRoutes } from "./settings/providers.ts";
import { reachRoutes } from "./settings/reach.ts";

export type { DashboardOptions };

/**
 * The control dashboard: server-rendered pages over control's store, with forms that issue signed
 * commands. Login takes the admin token once and keeps a random session in an HttpOnly,
 * SameSite=Strict cookie. Sessions are kept in control's store (hashed), so a restart does not sign
 * the owner out; each use renews one, and a new admin token ends them all. Every form carries a
 * token derived from the session and the admin token (CSRF). The only script is control's own
 * (/ui/assets/app.js): it streams the live view, and follows the owner's actions to their outcome
 * (goal 080: it draws the page's parts again when one comes). Pages never reload by themselves
 * otherwise: the status bar says when the page was made and has a refresh link. The look follows
 * Magnesium's design.
 *
 * Each section of the dashboard is a module in dashboard/ that adds its routes to the app, with
 * what it takes from the context (dashboard/context.ts). They are added in this order, which is
 * the order Hono matches them in: signing in comes first, since its session check guards the rest.
 */
export function createDashboard(store: ControlStore, opts: DashboardOptions): Hono {
  const app = new Hono();
  const dash = dashboardContext(store, opts);
  sessionRoutes(app, dash);
  overviewRoutes(app, dash);
  newCampaignRoutes(app, dash);
  campaignPageRoutes(app, dash);
  runPageRoutes(app, dash);
  shelfRoutes(app, dash);
  knowledgeRoutes(app, dash);
  rigListRoutes(app, dash);
  rigPageRoutes(app, dash);
  attemptRoutes(app, dash);
  agentRoutes(app, dash);
  liveRoutes(app, dash);
  recordRoutes(app, dash);
  actionRoutes(app, dash);
  settingsPageRoutes(app, dash);
  clusterRoutes(app, dash);
  reachRoutes(app, dash);
  cloudRoutes(app, dash);
  addRigRoutes(app, dash);
  joinedRigRoutes(app, dash);
  rigStateRoutes(app, dash);
  runpodRigRoutes(app, dash);
  machineRoutes(app, dash);
  providerRoutes(app, dash);
  editRigRoutes(app, dash);
  commandRoutes(app, dash);
  return app;
}

/** The dashboard as control's API mounts it (control/pages.ts): every page under "/". */
export const mountDashboard: MountPages = (app, store, o) => {
  app.route("/", createDashboard(store, o));
};
