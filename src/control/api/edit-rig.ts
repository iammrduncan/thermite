import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { redact } from "../../common/env.ts";
import { bodyRefusal } from "../campaigns/index.ts";
import {
  ClusterResourcesBody,
  clusterResourcesRequest,
  setClusterRigResources,
} from "../clusters/index.ts";
import {
  RigModelBody,
  RigSettingsBody,
  rigModelAnswer,
  rigModelRequest,
  rigModels,
  rigModelsAnswer,
  rigSettingsAnswer,
  rigSettingsRead,
  setRigModel,
  setRigSettings,
} from "../rigs/index.ts";
import type { ApiContext } from "./context.ts";

/**
 * A rig as Edit rig changes it, from the owner's token: each agent's model, the rig's own
 * settings, and a cluster rig's size. Each is the twin of Edit rig's and MCP's, with the same
 * refusals in words.
 */
export function editRigRoutes(app: Hono, api: ApiContext): void {
  const { store, privateKeyPem, parts, admin } = api;

  // Give one of a rig's agents a model, or clear it (goals 029 and 070): the twin of MCP's
  // set_rig_model, through Edit rig's own code (rigs/agent-models.ts), with its refusals in words.
  // Each call sets the agent's context window cap and compaction point anew: none given, none kept.
  app.post("/v1/rigs/:rig/model", admin, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const rig = c.req.param("rig");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const refuse = (error: string) => {
      store.auditLog.refusal("owner:api", "refused", {
        path: `/v1/rigs/${rig}/model`,
        why: redact(error),
      });
      return c.json({ error }, error === `no rig ${rig}` ? 404 : 400);
    };
    const body = RigModelBody.safeParse(raw);
    if (!body.success) return refuse(bodyRefusal(body.error));
    const req = rigModelRequest(body.data);
    const out = await setRigModel(store, rig, req, "owner:api");
    if ("error" in out) return refuse(out.error);
    return c.json(rigModelAnswer(rig, req, out));
  });

  // Each of a rig's agents' models on control: the twin of MCP's rig_models.
  app.get("/v1/rigs/:rig/model", admin, (c) => {
    const rig = c.req.param("rig");
    const agents = rigModels(store, rig);
    if ("error" in agents) return c.json({ error: agents.error }, 404);
    return c.json(rigModelsAnswer(store, rig, agents));
  });

  // A rig's own settings (goal 029): the twin of Save changes on Edit rig and of MCP's
  // set_rig_settings. Only what differs from what the rig reports is sent, as one signed
  // rig_settings command; nothing differing sends nothing. Refused in Edit rig's words.
  app.post("/v1/rigs/:rig/settings", admin, bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const rig = c.req.param("rig");
    const raw: unknown = await c.req.json().catch(() => undefined);
    const body = RigSettingsBody.safeParse(raw);
    const out = body.success
      ? setRigSettings(store, privateKeyPem, rig, body.data, "owner:api", true)
      : ({ state: "refused", error: bodyRefusal(body.error), status: 400 } as const);
    if (out.state === "refused") {
      store.auditLog.refusal("owner:api", "refused", {
        path: `/v1/rigs/${rig}/settings`,
        why: redact(out.error),
      });
      return c.json({ error: out.error }, out.status);
    }
    return c.json(rigSettingsAnswer(rig, out));
  });

  // A cluster rig's GPUs, CPUs and memory (goal 118): the twin of Edit rig's fields for a rig
  // control set up on a cluster and of MCP's set_cluster_rig_resources, with their refusals in
  // words. Its pods restart with the new size, draining first while it works.
  app.post(
    "/v1/rigs/:rig/cluster/resources",
    admin,
    bodyLimit({ maxSize: 16 * 1024 }),
    async (c) => {
      const rig = c.req.param("rig");
      const raw: unknown = await c.req.json().catch(() => undefined);
      const body = ClusterResourcesBody.safeParse(raw);
      const out = body.success
        ? await setClusterRigResources(
            parts,
            rig,
            clusterResourcesRequest(body.data),
            "owner:api",
            { wait: body.data.wait, owner: true, drainMinutes: body.data.drain_minutes },
          )
        : ({ error: bodyRefusal(body.error), status: 400 } as const);
      if ("error" in out) {
        store.auditLog.refusal("owner:api", "refused", {
          path: `/v1/rigs/${rig}/cluster/resources`,
          why: redact(out.error),
        });
        return c.json({ error: out.error }, out.status);
      }
      return c.json({ rig, said: out.ok });
    },
  );

  // The settings a rig reports, and its GPU split: the twin of MCP's rig_settings.
  app.get("/v1/rigs/:rig/settings", admin, (c) => {
    const rig = c.req.param("rig");
    const read = rigSettingsRead(store, rig);
    return read ? c.json(read) : c.json({ error: `no rig ${rig}` }, 404);
  });
}
