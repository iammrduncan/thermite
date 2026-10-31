import type { Hono } from "hono";
import {
  archiveCampaign,
  createFolder,
  deleteFolder,
  moveCampaign,
  renameFolder,
  type ShelfOutcome,
  unarchiveCampaign,
} from "../../campaigns/index.ts";
import { campaignHref } from "../../ui/urls.ts";
import { backTo, type Ctx, type Dashboard } from "../context.ts";

/**
 * Archive and the navigation's folders (goal 077). A campaign's grants are given and ended on its
 * collection in the Knowledge page (dashboard/knowledge.ts).
 */
export function shelfRoutes(app: Hono, dash: Dashboard): void {
  const { store, views } = dash;

  // ---------------------------------------- Archive, and the navigation's folders (goal 077)
  /**
   * Where Archive or a folder's form returns: its page, with what control did (sent) or what it
   * refused (error, on=shelf), in words. The navigation's script asks for JSON instead.
   */
  const shelfAnswer = <T>(
    c: Ctx,
    f: Record<string, unknown>,
    out: ShelfOutcome<T>,
    done: (a: T) => string,
    not: string,
    fallback: string,
  ) => {
    if (c.req.header("accept")?.includes("application/json")) {
      if (out.ok) return c.json({ ...out.answer, said: done(out.answer) });
      // A redirect's refusal is audited from its address; this answer says it itself.
      store.auditLog.refusal("owner:ui", "refused", {
        path: new URL(c.req.url).pathname,
        why: out.error,
      });
      return c.json({ error: `${not} ${out.error}` });
    }
    const to = backTo(f, fallback);
    const [path = fallback, hash] = to.split("#");
    const q = out.ok
      ? `sent=${encodeURIComponent(done(out.answer))}`
      : `error=${encodeURIComponent(`${not} ${out.error}`)}&on=shelf`;
    return c.redirect(`${path}${path.includes("?") ? "&" : "?"}${q}${hash ? `#${hash}` : ""}`, 303);
  };
  /** A folder of the navigation by the id its forms carry. */
  const folderById = (id: string) => store.folders.list().find((x) => String(x.id) === id);
  const goneFolder = {
    ok: false,
    error: "That folder is not there any more.",
    status: 404,
  } as const;
  app.post("/ui/campaigns/:campaign/archive", async (c) => {
    const name = c.req.param("campaign");
    return shelfAnswer(
      c,
      await c.req.parseBody(),
      archiveCampaign(store, views(), name, "owner:ui"),
      (a) =>
        a.changed
          ? `Archived ${name}. It left the navigation, Needs you and the Overview.`
          : `${name} is archived already.`,
      "Not archived.",
      campaignHref(name),
    );
  });
  app.post("/ui/campaigns/:campaign/unarchive", async (c) => {
    const name = c.req.param("campaign");
    return shelfAnswer(
      c,
      await c.req.parseBody(),
      unarchiveCampaign(store, views(), name, "owner:ui"),
      (a) =>
        a.changed
          ? `Unarchived ${name}. It is back in the navigation, ${a.folder ? `in ${a.folder}` : "in no folder"}.`
          : `${name} is not archived.`,
      "Not unarchived.",
      campaignHref(name),
    );
  });
  app.post("/ui/campaigns/:campaign/folder", async (c) => {
    const name = c.req.param("campaign");
    const f = await c.req.parseBody();
    const id = String(f.folder ?? "");
    const to = id ? folderById(id) : undefined;
    return shelfAnswer(
      c,
      f,
      id && !to ? goneFolder : moveCampaign(store, views(), name, to?.name ?? null, "owner:ui"),
      (a) =>
        !a.changed
          ? a.folder
            ? `${name} is in ${a.folder} already.`
            : `${name} is in no folder already.`
          : a.folder
            ? `Moved ${name} to ${a.folder}.`
            : `Moved ${name} out of its folder.`,
      "Not moved.",
      campaignHref(name),
    );
  });
  app.post("/ui/campaign-folders", async (c) => {
    const f = await c.req.parseBody();
    return shelfAnswer(
      c,
      f,
      createFolder(store, String(f.name ?? ""), "owner:ui"),
      (a) =>
        `Made the folder ${a.folder.name}. Drag a campaign onto it, or use Move to folder on a campaign's page.`,
      "No folder made.",
      "/ui/campaigns",
    );
  });
  app.post("/ui/campaign-folders/:id/rename", async (c) => {
    const f = await c.req.parseBody();
    const folder = folderById(c.req.param("id"));
    return shelfAnswer(
      c,
      f,
      folder ? renameFolder(store, folder.name, String(f.name ?? ""), "owner:ui") : goneFolder,
      (a) => (a.changed ? `Renamed ${a.was} to ${a.folder.name}.` : "Nothing to rename."),
      "Not renamed.",
      "/ui/campaigns",
    );
  });
  app.post("/ui/campaign-folders/:id/delete", async (c) => {
    const f = await c.req.parseBody();
    const folder = folderById(c.req.param("id"));
    return shelfAnswer(
      c,
      f,
      folder ? deleteFolder(store, folder.name, "owner:ui") : goneFolder,
      (a) => `Deleted the folder ${a.deleted}.`,
      "Not deleted.",
      "/ui/campaigns",
    );
  });
}
