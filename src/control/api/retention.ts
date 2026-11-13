import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BadInput, jsonBody } from "../../common/errors.ts";
import {
  RETENTION_CREATE,
  RETENTION_DELETE,
  RETENTION_LIST,
  RETENTION_ON,
  RETENTION_POLICY,
  RETENTION_PREVIEW,
  RETENTION_REMOVALS,
  RETENTION_REMOVALS_MAX,
  RETENTION_RUN,
  RETENTION_UPDATE,
} from "../../core/api/control/retention.ts";
import {
  createPolicy,
  deletePolicy,
  policyView,
  policyViews,
  previewOf,
  retentionKinds,
  runPolicy,
  setPolicyOn,
  specOf,
  updatePolicy,
} from "../retention/index.ts";
import { type ApiContext, clampLimit } from "./context.ts";

/**
 * The owner's retention policies over REST (core/api/control/retention.ts), with the owner's
 * token alone: the same operations as Settings › Retention policies and MCP, refused in the same
 * words. A policy control does not have answers 404.
 */

/** The policy a route names; undefined when control has none (a 404). */
async function named(api: ApiContext, c: Context): Promise<number | undefined> {
  const id = Number(c.req.param("id"));
  return Number.isSafeInteger(id) && id > 0 && (await api.store.retention.get(id)) ? id : undefined;
}

/** A body's `on`, and the rest as the policy's design. */
async function bodyOf(c: Context): Promise<{ on: boolean | undefined; spec: unknown }> {
  const body = await jsonBody(c.req);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadInput("the body is a retention policy's design, as JSON");
  const { on, ...spec } = body as Record<string, unknown>;
  if (on !== undefined && typeof on !== "boolean") throw new BadInput("on is true or false");
  return { on, spec };
}

export function retentionRoutes(app: Hono, api: ApiContext): void {
  const { store, admin, parts } = api;
  const deps = { store, privateKeyPem: parts.privateKeyPem };
  const by = "owner:api";
  const none = (c: Context) => c.json({ error: "no such retention policy" }, 404);

  app.get(RETENTION_LIST.path, admin, async (c) =>
    c.json({ kinds: retentionKinds(), policies: await policyViews(store) }),
  );
  app.get(RETENTION_REMOVALS.path, admin, async (c) => {
    const policy = c.req.query("policy");
    const limit = Math.min(clampLimit(c.req.query("limit"), 100), RETENTION_REMOVALS_MAX);
    const id = policy === undefined ? undefined : Number(policy);
    if (id !== undefined && !Number.isSafeInteger(id))
      throw new BadInput("policy is a policy's id");
    return c.json({ removals: await store.retention.removals(limit, id) });
  });
  app.post(
    RETENTION_PREVIEW.path,
    admin,
    bodyLimit({ maxSize: RETENTION_PREVIEW.maxBytes }),
    async (c) => c.json(await previewOf(store, await specOf(store, await jsonBody(c.req)))),
  );
  app.get(RETENTION_POLICY.path, admin, async (c) => {
    const p = await store.retention.get((await named(api, c)) ?? 0);
    return p ? c.json(await policyView(store, p)) : none(c);
  });
  app.post(
    RETENTION_CREATE.path,
    admin,
    bodyLimit({ maxSize: RETENTION_CREATE.maxBytes }),
    async (c) => {
      const { on, spec } = await bodyOf(c);
      const p = await createPolicy(store, spec, on === true, by);
      const said = `Saved “${p.name}”${p.on ? " and turned it on" : ", off"}.`;
      return c.json({ policy: await policyView(store, p), said });
    },
  );
  app.put(
    RETENTION_UPDATE.path,
    admin,
    bodyLimit({ maxSize: RETENTION_UPDATE.maxBytes }),
    async (c) => {
      const id = await named(api, c);
      if (id === undefined) return none(c);
      const { on, spec } = await bodyOf(c);
      const p = await updatePolicy(store, id, spec, on, by);
      return c.json({
        policy: await policyView(store, p),
        said: `Saved “${p.name}”${p.on ? ", on" : ", off"}.`,
      });
    },
  );
  app.post(RETENTION_ON.path, admin, bodyLimit({ maxSize: RETENTION_ON.maxBytes }), async (c) => {
    const id = await named(api, c);
    if (id === undefined) return none(c);
    const { on } = RETENTION_ON.body.parse(await jsonBody(c.req));
    const p = await setPolicyOn(store, id, on, by);
    return c.json({
      policy: await policyView(store, p),
      said: `“${p.name}” is ${p.on ? `on: it runs ${(await policyView(store, p)).when_words}` : "off: it removes nothing"}.`,
    });
  });
  app.delete(RETENTION_DELETE.path, admin, async (c) => {
    const id = await named(api, c);
    if (id === undefined) return none(c);
    const p = await deletePolicy(store, id, by);
    return c.json({
      deleted: p.id,
      said: `Deleted “${p.name}”. What it removed stays in the history.`,
    });
  });
  app.post(RETENTION_RUN.path, admin, async (c) => {
    const id = await named(api, c);
    if (id === undefined) return none(c);
    return c.json(await runPolicy(deps, id, "hand", by));
  });
}
