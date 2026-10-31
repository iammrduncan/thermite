import type { Hono } from "hono";
import { role, roles, runPrompt } from "../prompts.ts";
import { esc } from "../ui/components/index.ts";
import { agentsHref, promptPage, rolePage, rolesPage } from "../ui/prompts.ts";
import { campaignHref, RUN_ROUTES, runHref } from "../ui/urls.ts";
import type { Dashboard } from "./context.ts";

/**
 * The Agents page and each role's page, and one prompt a run's agent was sent (goal 166). A run's
 * list of prompts is its Prompts tab (campaigns/run/section.ts).
 */
export function agentRoutes(app: Hono, dash: Dashboard): void {
  const { page, runOf, store } = dash;
  app.get(agentsHref, (c) =>
    page(
      c,
      {
        title: "Agents",
        summary: "every agent role Thermite runs, and what each is told",
        active: "campaigns",
      },
      rolesPage(roles()),
    ),
  );
  app.get(`${agentsHref}/:role`, (c) => {
    const r = role(c.req.param("role"));
    const crumbs = [{ href: agentsHref, text: "Agents" }];
    if (!r) {
      c.status(404);
      return page(
        c,
        { title: "Not found", crumbs, active: "campaigns" },
        `<div class="card"><div class="empty">No such role.</div></div>`,
      );
    }
    return page(
      c,
      { title: r.name, crumbs, summary: esc(r.what), active: "campaigns" },
      rolePage(r),
    );
  });
  app.get(RUN_ROUTES.prompt, async (c) => {
    const campaign = c.req.param("campaign") ?? "";
    const x = await runOf(campaign, c.req.param("run") ?? "");
    const p = x ? await runPrompt(store, x, Number(c.req.param("id"))) : undefined;
    const crumbs = [
      { href: "/ui/campaigns", text: "Campaigns" },
      { href: campaignHref(campaign), text: campaign },
      ...(x ? [{ href: runHref(x.run, "prompts"), text: x.run.id }] : []),
    ];
    if (!x || !p) {
      c.status(404);
      return page(
        c,
        { title: "Not found", crumbs, active: "campaigns" },
        `<div class="card"><div class="empty">No such prompt in this run.</div></div>`,
      );
    }
    return page(c, { title: `Prompt ${p.id}`, crumbs, active: "campaigns" }, promptPage(x.run, p));
  });
}
