import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { redact } from "../../common/env.ts";
import {
  CAMPAIGN_ADDITIONS,
  CAMPAIGN_CONTEXT,
  CAMPAIGN_COPY,
  CAMPAIGN_KB_WRITES,
  START_RUN,
} from "../../core/api/control/owner.ts";
import {
  archiveCampaign,
  bodyRefusal,
  CampaignAdditionsBody,
  CampaignContextBody,
  CampaignKbWritesBody,
  CopyCampaignBody,
  campaignAdditionsAnswer,
  campaignContextAnswer,
  campaignFoldersAnswer,
  campaignKbWritesAnswer,
  copyACampaign,
  copyCampaignAnswer,
  createFolder,
  deleteFolder,
  FolderNameBody,
  MoveBody,
  moveCampaign,
  renameFolder,
  type ShelfOutcome,
  StartRunBody,
  setCampaignAdditions,
  setCampaignContext,
  setCampaignKbWrites,
  startARun,
  startRunAnswer,
  startRunRequest,
  unarchiveCampaign,
} from "../campaigns/index.ts";
import { rigView } from "../views/index.ts";
import type { ApiContext } from "./context.ts";

/**
 * The campaigns control keeps, from the owner's token: a run started, a campaign copied, its own
 * context settings, and the shelf (a campaign archived, and the left navigation's folders). Each
 * is the twin of the dashboard's and MCP's, with the same refusals in words, in the audit log.
 */
export function campaignRoutes(app: Hono, api: ApiContext): void {
  const { store, viewOpts, parts, admin } = api;

  // Start a run of a campaign control keeps (goal 029): the twin of a campaign page's Start a
  // run (campaigns/start-run.ts), with its refusals in words. The owner's token, as on the dashboard; MCP's
  // start_run takes an operator's too.
  app.post(START_RUN.path, admin, bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const campaign = c.req.param("campaign");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const body = StartRunBody.safeParse(raw);
    const out = body.success
      ? await startARun(parts, startRunRequest(campaign, body.data), "owner:api", true)
      : ({ state: "refused", error: bodyRefusal(body.error), status: 400 } as const);
    if (out.state === "refused") {
      // In the audit log, as the dashboard's and MCP's refusals are.
      store.auditLog.add("owner:api", "refused", {
        path: `/v1/campaigns/${campaign}/runs`,
        why: redact(out.error),
      });
      return c.json({ error: out.error }, out.status);
    }
    return c.json(startRunAnswer(out), out.state === "started" ? 201 : 202);
  });

  // Copy a campaign control keeps (goal 069): a new campaign with the same contract and kit
  // under another name, with its own empty collection in the knowledge base and no runs. Its own
  // brief may come with it (goal 078): room for as much as one command carries to a rig.
  app.post(CAMPAIGN_COPY.path, admin, bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    const from = c.req.param("campaign");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const body = CopyCampaignBody.safeParse(raw);
    const out = body.success
      ? copyACampaign(parts, { from, ...body.data }, "owner:api")
      : ({ state: "refused", error: bodyRefusal(body.error), status: 400 } as const);
    if (out.state === "refused") {
      store.auditLog.add("owner:api", "refused", {
        path: `/v1/campaigns/${from}/copy`,
        why: redact(out.error),
      });
      return c.json({ error: out.error }, out.status);
    }
    return c.json(copyCampaignAnswer(out), 201);
  });

  // A campaign's own context window and compaction point for all its runs' agents (goal 070):
  // the twin of MCP's set_campaign_context. A new version of its contract; an empty body removes
  // them. 201 with a new version, 200 when the newest version has them already.
  app.post(CAMPAIGN_CONTEXT.path, admin, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const campaign = c.req.param("campaign");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const body = CampaignContextBody.safeParse(raw);
    const out = body.success
      ? setCampaignContext(
          store,
          {
            campaign,
            contextWindow: body.data.context_window,
            compactAt: body.data.compact_at,
          },
          "owner:api",
        )
      : ({ state: "refused", error: bodyRefusal(body.error), status: 400 } as const);
    if (out.state === "refused") {
      store.auditLog.add("owner:api", "refused", {
        path: `/v1/campaigns/${campaign}/context`,
        why: redact(out.error),
      });
      return c.json({ error: out.error }, out.status);
    }
    return c.json(campaignContextAnswer(out), out.state === "saved" ? 201 : 200);
  });

  // The owner's additions to a campaign's roles (goal 166): the twin of MCP's
  // set_campaign_additions. A new version of its contract; an empty body removes them. 201 with a
  // new version, 200 when the newest version has them already.
  app.post(CAMPAIGN_ADDITIONS.path, admin, bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    const campaign = c.req.param("campaign");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const body = CampaignAdditionsBody.safeParse(raw);
    const out = body.success
      ? setCampaignAdditions(store, { campaign, additions: body.data.additions }, "owner:api")
      : ({ state: "refused", error: bodyRefusal(body.error), status: 400 } as const);
    if (out.state === "refused") {
      store.auditLog.add("owner:api", "refused", {
        path: `/v1/campaigns/${campaign}/additions`,
        why: redact(out.error),
      });
      return c.json({ error: out.error }, out.status);
    }
    return c.json(campaignAdditionsAnswer(out), out.state === "saved" ? 201 : 200);
  });

  // Which kinds each role may write in the campaign's collection of the knowledge base (goal 175):
  // the twin of MCP's set_campaign_kb_writes. A new version of its contract; an empty body puts
  // back the default. 201 with a new version, 200 when the newest version says it already.
  app.post(CAMPAIGN_KB_WRITES.path, admin, bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const campaign = c.req.param("campaign");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const body = CampaignKbWritesBody.safeParse(raw);
    const out = body.success
      ? setCampaignKbWrites(store, { campaign, kb_writes: body.data.kb_writes }, "owner:api")
      : ({ state: "refused", error: bodyRefusal(body.error), status: 400 } as const);
    if (out.state === "refused") {
      store.auditLog.add("owner:api", "refused", {
        path: `/v1/campaigns/${campaign}/kb-writes`,
        why: redact(out.error),
      });
      return c.json({ error: out.error }, out.status);
    }
    return c.json(campaignKbWritesAnswer(out), out.state === "saved" ? 201 : 200);
  });

  // Archive a campaign, and the left navigation's folders (goal 077): the same functions as the
  // dashboard and MCP, with their refusals in words. The owner's token.
  const allViews = () =>
    store.reportedRigs
      .list()
      .map((u) => rigView(store, u.id, viewOpts))
      .filter((v): v is NonNullable<typeof v> => v !== undefined);
  /** A shelf outcome as the answer, a refusal in the audit log as the other routes' are. */
  const shelf = <T>(c: Context, path: string, out: ShelfOutcome<T>, created = false) => {
    if (out.ok) return c.json(out.answer, created ? 201 : 200);
    store.auditLog.add("owner:api", "refused", { path, why: redact(out.error) });
    return c.json({ error: out.error }, out.status);
  };
  const refusedBody = (e: z.ZodError) =>
    ({ ok: false, error: bodyRefusal(e), status: 400 }) as const;
  const bodyOf = async <T>(c: Context, schema: z.ZodType<T>) => {
    const raw: unknown = await c.req.json().catch(() => undefined);
    return schema.safeParse(raw);
  };
  app.post("/v1/campaigns/:campaign/archive", admin, (c) => {
    const campaign = c.req.param("campaign");
    return shelf(
      c,
      `/v1/campaigns/${campaign}/archive`,
      archiveCampaign(store, allViews(), campaign, "owner:api"),
    );
  });
  app.post("/v1/campaigns/:campaign/unarchive", admin, (c) => {
    const campaign = c.req.param("campaign");
    return shelf(
      c,
      `/v1/campaigns/${campaign}/unarchive`,
      unarchiveCampaign(store, allViews(), campaign, "owner:api"),
    );
  });
  app.post("/v1/campaigns/:campaign/folder", admin, bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    const campaign = c.req.param("campaign");
    const path = `/v1/campaigns/${campaign}/folder`;
    const body = await bodyOf(c, MoveBody);
    if (!body.success) return shelf(c, path, refusedBody(body.error));
    return shelf(c, path, moveCampaign(store, allViews(), campaign, body.data.folder, "owner:api"));
  });
  app.get("/v1/campaign-folders", admin, (c) => c.json(campaignFoldersAnswer(store)));
  app.post("/v1/campaign-folders", admin, bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    const body = await bodyOf(c, FolderNameBody);
    if (!body.success) return shelf(c, "/v1/campaign-folders", refusedBody(body.error));
    return shelf(c, "/v1/campaign-folders", createFolder(store, body.data.name, "owner:api"), true);
  });
  app.post(
    "/v1/campaign-folders/:folder/rename",
    admin,
    bodyLimit({ maxSize: 4 * 1024 }),
    async (c) => {
      const folder = c.req.param("folder");
      const path = `/v1/campaign-folders/${folder}/rename`;
      const body = await bodyOf(c, FolderNameBody);
      if (!body.success) return shelf(c, path, refusedBody(body.error));
      return shelf(c, path, renameFolder(store, folder, body.data.name, "owner:api"));
    },
  );
  app.post("/v1/campaign-folders/:folder/delete", admin, (c) => {
    const folder = c.req.param("folder");
    return shelf(
      c,
      `/v1/campaign-folders/${folder}/delete`,
      deleteFolder(store, folder, "owner:api"),
    );
  });
}
