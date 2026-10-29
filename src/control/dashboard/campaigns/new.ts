import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import { FolderSchema } from "../../../core/contract.ts";
import { McpUses } from "../../../core/mcp.ts";
import { askOwnerFrom, ownModels, startCampaign } from "../../campaigns/index.ts";
import { kitSummary, unpackKit } from "../../kits/index.ts";
import { sameModel } from "../../providers/index.ts";
import { probeRepository, readKitManifest } from "../../repo-probe.ts";
import {
  agentsModelMissing,
  giveRigModel,
  harnessKept,
  opencodeOnlyModel,
  researchNeedsOpencode,
  sendSplit,
  splitFor,
} from "../../rigs/index.ts";
import { COPY_JS } from "../../ui/campaigns/copy/index.ts";
import { NEW_CAMPAIGN_JS, newCampaignBody } from "../../ui/campaigns/new/index.ts";
import { PLANNER_JS } from "../../ui/campaigns/queue/index.ts";
import { PROVIDERS_JS } from "../../ui/providers/client.ts";
import { campaignHref, runHref } from "../../ui/urls.ts";
import type { Ctx, Dashboard } from "../context.ts";
import { modelPrefix, settingsHelpers } from "../settings/shared.ts";

/**
 * A new campaign: its page and form, the lookups the page's script makes (a project's head and
 * paths, a kit's manifest, an uploaded kit), and the page scripts it and other pages load.
 */
export function newCampaignRoutes(app: Hono, dash: Dashboard): void {
  const { csrf, mcpServers, opts, page, store, views } = dash;
  const { accessFor } = settingsHelpers(dash);

  // ---------------------------------------------------------------- a new campaign
  app.get("/ui/assets/new-campaign.js", (c) =>
    c.body(NEW_CAMPAIGN_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  app.get("/ui/assets/providers.js", (c) =>
    c.body(PROVIDERS_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  // The Planner tab's script: the `:` picker of the run's directions in Tell the planner.
  app.get("/ui/assets/planner.js", (c) =>
    c.body(PLANNER_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  // The Copy panel's script, on a campaign's page (goal 069).
  app.get("/ui/assets/copy.js", (c) =>
    c.body(COPY_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  const newCampaignPage = (
    c: Ctx,
    extra: { draft?: Record<string, unknown>; errors?: string[] } = {},
  ) =>
    page(
      c,
      {
        title: "New campaign",
        active: "campaigns",
        crumbs: [{ href: "/ui/campaigns", text: "Campaigns" }],
      },
      newCampaignBody({
        csrf: csrf(c),
        rigs: views(),
        access: store.gitAccess.list(),
        // The MCP servers in Settings, for the kit's MCP servers block (goal 068).
        mcp: mcpServers.list(),
        models: store.modelProviders
          .list()
          .filter((p) => p.models.length)
          .map((p) => ({
            group: p.name,
            options: p.models.map((m) => ({
              value: `${encodeURIComponent(p.name)}|${encodeURIComponent(m.id)}`,
              label: `${modelPrefix(p.type)}${m.id}`,
              window: m.context_window ?? 0,
            })),
          })),
        // The Agents' context checks a window against each rig's agents' models (goal 070).
        agentModels: Object.fromEntries(views().map((u) => [u.id, ownModels(store, u.id)])),
        ...extra,
      }),
    );
  app.get("/ui/campaigns/new", (c) =>
    opts.kits ? newCampaignPage(c) : c.text("This control keeps no kits.", 404),
  );
  // The project's head at a ref and its paths (not its contents), for the page's suggestions:
  // a project in a folder of its repository gets that folder's paths. A POST with the form's
  // token, as it may unseal a Git access.
  app.post("/ui/campaigns/new/probe", async (c) => {
    const f = await c.req.parseBody();
    const one = (k: string) => (typeof f[k] === "string" ? String(f[k]) : "");
    const url = one("url");
    const ref = one("ref") || "HEAD";
    const folder = one("folder") || undefined;
    if (folder && !FolderSchema.safeParse(folder).success)
      return c.json(
        {
          error:
            "The folder is a path in the repository, such as examples/matmul-cpu/project: no / at either end, and no part that starts with a dot.",
        },
        400,
      );
    try {
      return c.json(
        await (opts.probeRepo ?? probeRepository)(
          url,
          ref,
          accessFor(one("access") || undefined, url),
          folder,
        ),
      );
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
  });
  // A kit uploaded on the page: unpacked and checked now, its archive kept beside the kit
  // repositories (never served to rigs: only <name>.git is) until a campaign uses it.
  const uploadsDir = () => join(opts.kits?.dir ?? "", "uploads");
  app.post("/ui/campaigns/new/kit", async (c) => {
    const f = await c.req.parseBody();
    const file = f.archive;
    if (!opts.kits) return c.json({ error: "This control keeps no kits." }, 404);
    if (!(file instanceof File)) return c.json({ error: "Choose a kit archive." }, 400);
    try {
      const archive = Buffer.from(await file.arrayBuffer());
      const k = await unpackKit(file.name, archive);
      mkdirSync(uploadsDir(), { recursive: true });
      writeFileSync(join(uploadsDir(), k.id), archive);
      writeFileSync(join(uploadsDir(), `${k.id}.name`), file.name);
      return c.json({ id: k.id, ...kitSummary(k.kit) });
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
  });
  /** An uploaded kit, unpacked again from its kept archive. */
  const uploaded = async (id: string) => {
    if (!/^[0-9a-f]{64}$/.test(id)) return undefined;
    const p = join(uploadsDir(), id);
    if (!existsSync(p)) return undefined;
    return unpackKit(readFileSync(`${p}.name`, "utf8"), readFileSync(p));
  };
  // A kit in a repository: the MCP servers its kit.json names at that commit (goal 068), for
  // the page to show beside Settings' servers. Control reads kit.json alone. A POST with the
  // form's token, as it may unseal a Git access.
  app.post("/ui/campaigns/new/kit-repo", async (c) => {
    const f = await c.req.parseBody();
    const one = (k: string) => (typeof f[k] === "string" ? String(f[k]) : "");
    try {
      const manifest = (await (opts.readKit ?? readKitManifest)(
        one("url"),
        one("commit"),
        accessFor(one("access") || undefined, one("url")),
      )) as { name?: unknown; mcp_servers?: unknown };
      const uses = McpUses.safeParse(manifest?.mcp_servers ?? []);
      if (!uses.success)
        return c.json(
          { error: `kit.json's mcp_servers: ${uses.error.issues[0]?.message ?? "not valid"}` },
          400,
        );
      return c.json({
        name: typeof manifest.name === "string" ? manifest.name : null,
        mcp_servers: uses.data,
      });
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
  });
  // What a page sent back with mistakes shows again about the kit it had uploaded.
  app.get("/ui/campaigns/new/kit/:id", async (c) => {
    const k = await uploaded(c.req.param("id")).catch(() => undefined);
    if (!k) return c.json({ error: "The uploaded kit is gone: upload it again." }, 404);
    return c.json({ id: k.id, ...kitSummary(k.kit) });
  });
  app.post("/ui/campaigns/new", async (c) => {
    const f = await c.req.parseBody();
    if (!opts.kits) return c.text("This control keeps no kits.", 404);
    let draft: Record<string, unknown>;
    try {
      draft = JSON.parse(String(f.draft ?? "")) as Record<string, unknown>;
    } catch {
      return newCampaignPage(c, { errors: ["The page sent no answers: is its script blocked?"] });
    }
    const vs = views();
    const rig = vs.find((u) => u.id === String(f.rig ?? ""));
    if (!rig) return newCampaignPage(c, { draft, errors: ["Choose a rig for the first run."] });
    const target = rig.hardware?.target;
    if (!target)
      return newCampaignPage(c, {
        draft,
        errors: [`${rig.id} has not reported its hardware yet, so its target is unknown.`],
      });
    // The project pinned to a commit: control looks the ref up when the page did not.
    const project = draft.project as
      | { url?: string; ref?: string; commit?: string; folder?: unknown }
      | undefined;
    if (project?.url && !project.commit) {
      // A folder that is not a valid path is refused below, with the builder's own words.
      const folder = FolderSchema.safeParse(project.folder);
      try {
        project.commit = (
          await (opts.probeRepo ?? probeRepository)(
            project.url,
            project.ref || "HEAD",
            accessFor((project as { access?: string }).access, project.url),
            folder.success ? folder.data : undefined,
          )
        ).commit;
      } catch (err) {
        return newCampaignPage(c, {
          draft,
          errors: [`The project: ${errorText(err)}`],
        });
      }
    }
    const promotion = String(f.promotion ?? "");
    const askOwner = askOwnerFrom(f);
    if (typeof askOwner === "string") return newCampaignPage(c, { draft, errors: [askOwner] });
    const split = splitFor(rig, String(f.judge_gpus ?? ""));
    if (typeof split === "string") return newCampaignPage(c, { draft, errors: [split] });
    // The agents' model: given here, or the rig's; agents never start on a rig with none.
    let startValue = String(f.start_value ?? "start");
    const chosen = String(f.agents_model ?? "").trim();
    let modelNote = "";
    // Checked before the rig is given anything: OpenCode's free models work only in OpenCode.
    const researchModel =
      draft.mode === "research" && startValue === "start"
        ? opencodeOnlyModel(store, rig, chosen || undefined, String(f.agents_harness ?? ""))
        : undefined;
    if (researchModel)
      return newCampaignPage(c, { draft, errors: [researchNeedsOpencode(rig.id, researchModel)] });
    if (chosen) {
      const given = giveRigModel(
        store,
        rig.id,
        chosen,
        harnessKept(store, rig.id, chosen, String(f.agents_harness ?? "")),
      );
      if ("error" in given) return newCampaignPage(c, { draft, errors: [given.error] });
      const [, mRaw] = chosen.split("|");
      const model = decodeURIComponent(mRaw ?? "");
      // Not on the rig yet: it arrives within a minute. Starting now would fail the first trials.
      if (startValue === "start" && !sameModel(rig.model?.model, model)) {
        startValue = "save";
        modelNote = `${rig.id} takes ${model} within a minute. Settings › Providers shows the rig taking it until then; then start the run here.`;
      }
    }
    // Control gave the rig a model it has not taken yet: saved now, started once it has.
    const pending = store.agentModels.byRig()[rig.id];
    if (
      !chosen &&
      startValue === "start" &&
      pending &&
      !sameModel(rig.model?.model, pending.model)
    ) {
      startValue = "save";
      modelNote = `${rig.id} has not taken ${pending.model} yet (it does within a minute of being given it; Settings › Providers shows it taking the model until then). Then start the run here.`;
    }
    if (!chosen && startValue === "start" && agentsModelMissing(store, rig))
      return newCampaignPage(c, {
        draft,
        errors: [
          `${rig.id} has no model for its agents, so they could not work: choose one under "The agents' model".`,
        ],
      });
    const uploadId = (draft.kit as { source?: string; upload?: string } | undefined)?.upload;
    const upload = uploadId ? await uploaded(uploadId).catch(() => undefined) : undefined;
    let r: Awaited<ReturnType<typeof startCampaign>>;
    try {
      r = await startCampaign(
        {
          store,
          kits: opts.kits,
          privateKeyPem: opts.privateKeyPem,
          uploads: (id) => (id === uploadId ? upload?.files : undefined),
          runpodRigs: opts.runpodRigs,
        },
        {
          draft,
          rig: rig.id,
          target: { type: target.type, class: target.class },
          start: startValue === "save" ? false : startValue === "try" ? "try" : true,
          promotion: promotion === "auto" || promotion === "owner_approval" ? promotion : undefined,
          askOwner,
          by: "owner:ui",
        },
      );
    } catch (err) {
      r = { ok: false, errors: [errorText(err)] };
    }
    if (!r.ok) return newCampaignPage(c, { draft, errors: r.errors });
    if (r.run && split !== undefined) sendSplit(store, opts.privateKeyPem, rig.id, split);
    return c.redirect(
      r.run
        ? `${runHref({ id: r.run, campaign: r.campaign })}${r.woke ? `?ok=${encodeURIComponent(r.woke)}` : ""}`
        : modelNote
          ? `${campaignHref(r.campaign)}?ok=${encodeURIComponent(`Saved. ${modelNote}`)}`
          : campaignHref(r.campaign),
      303,
    );
  });
}
