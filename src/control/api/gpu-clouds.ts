import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { errorText, jsonBody } from "../../common/errors.ts";
import {
  CLOUD_LAUNCH,
  CLOUD_RIGS,
  RUNPOD_LIMITS,
  RUNPOD_RIG,
  RUNPOD_START,
  RUNPOD_STOP,
  RUNPOD_TERMINATE,
} from "../../core/api/control/owner.ts";
import {
  type LaunchRequest,
  type LimitsChange,
  podLogQuery,
  type TestRequest,
} from "../runpod/index.ts";
import type { ApiContext } from "./context.ts";

/**
 * GPU clouds, from the owner's token: test pods, and rigs launched on RunPod with their pod log,
 * their stop, start and terminate, and their limits.
 */
export function gpuCloudRoutes(app: Hono, api: ApiContext): void {
  const { parts, admin } = api;
  const { runpodTests, runpodRigs, runpodDriver } = parts;

  // Test pods on a GPU cloud (the owner's token; MCP gives operators the same).
  const TestBody = z.strictObject({
    gpu: z.string().min(1).optional(),
    cloud_type: z.enum(["SECURE", "COMMUNITY"]).optional(),
    image: z.string().min(1).optional(),
    disk_gb: z.number().int().optional(),
    restart: z.boolean().optional(),
    stop_after_minutes: z.number().positive().optional(),
  });
  app.get("/v1/gpu-clouds/:name/tests", admin, (c) =>
    c.json(runpodTests.list(c.req.param("name"))),
  );
  app.post("/v1/gpu-clouds/:name/tests", admin, bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    const body: TestRequest = TestBody.parse(await jsonBody(c.req));
    try {
      return c.json(await runpodTests.start(c.req.param("name"), body, "owner:api"), 201);
    } catch (err) {
      return c.json({ error: errorText(err) }, 409);
    }
  });
  // Rigs on a GPU cloud: launched by the owner alone (this token; MCP's owner tools; never an
  // operator's or an agent's), billed by the hour. Limits apply only when the owner sets them.
  app.get(CLOUD_RIGS.path, admin, (c) => c.json(runpodRigs.list(c.req.param("name"))));
  app.post(CLOUD_LAUNCH.path, admin, bodyLimit({ maxSize: CLOUD_LAUNCH.maxBytes }), async (c) => {
    const body: LaunchRequest = CLOUD_LAUNCH.body.parse(await jsonBody(c.req));
    try {
      return c.json(await runpodRigs.launch(c.req.param("name"), body, "owner:api"), 201);
    } catch (err) {
      return c.json({ error: errorText(err) }, 409);
    }
  });
  app.get(RUNPOD_RIG.path, admin, (c) => {
    const rig = c.req.param("rig");
    const v = runpodRigs.view(rig);
    return v
      ? c.json({ ...v, history: runpodRigs.history(rig) })
      : c.json({ error: "not found" }, 404);
  });
  // A rig's pod log, read from RunPod with the cloud's key: the owner's, as the rig's other reads
  // here. It spends nothing; each line is redacted before it leaves control.
  app.get("/v1/rigs/:rig/runpod/logs", admin, async (c) => {
    const rig = c.req.param("rig");
    if (!runpodRigs.view(rig)) return c.json({ error: "not found" }, 404);
    const q = podLogQuery(c.req.query("tail"), c.req.query("source"));
    if ("error" in q) return c.json({ error: q.error }, 400);
    try {
      return c.json(await runpodRigs.logs(rig, q));
    } catch (err) {
      return c.json({ error: errorText(err) }, 502);
    }
  });
  // Stop, start and terminate a rig's pod (the owner's alone, as the launch). Restart and the full
  // reset are the routes every rig has: /v1/rigs/<rig>/restart and /v1/rigs/<rig>/reset.
  const lifecycleRefused = (err: unknown) => {
    const error = errorText(err);
    return { error, status: /^no rig /.test(error) ? (404 as const) : (409 as const) };
  };
  app.post(RUNPOD_STOP.path, admin, async (c) => {
    try {
      return c.json(await runpodDriver.stop(c.req.param("rig"), "owner:api"));
    } catch (err) {
      const r = lifecycleRefused(err);
      return c.json({ error: r.error }, r.status);
    }
  });
  app.post(RUNPOD_START.path, admin, async (c) => {
    try {
      return c.json(await runpodDriver.start(c.req.param("rig"), "owner:api"));
    } catch (err) {
      const r = lifecycleRefused(err);
      return c.json({ error: r.error }, r.status);
    }
  });
  app.post(
    RUNPOD_TERMINATE.path,
    admin,
    bodyLimit({ maxSize: RUNPOD_TERMINATE.maxBytes }),
    async (c) => {
      const body = RUNPOD_TERMINATE.body.parse(await jsonBody(c.req));
      const rig = c.req.param("rig");
      if (body.confirm !== `terminate ${rig}`)
        return c.json({ error: `confirm with "terminate ${rig}"` }, 400);
      try {
        return c.json(await runpodDriver.terminate(rig, "owner:api", body.confirm));
      } catch (err) {
        const r = lifecycleRefused(err);
        return c.json({ error: r.error }, r.status);
      }
    },
  );
  app.post(RUNPOD_LIMITS.path, admin, bodyLimit({ maxSize: RUNPOD_LIMITS.maxBytes }), async (c) => {
    const body: LimitsChange = RUNPOD_LIMITS.body.parse(await jsonBody(c.req));
    try {
      return c.json(runpodRigs.limits(c.req.param("rig"), body, "owner:api"));
    } catch (err) {
      const error = errorText(err);
      return c.json({ error }, /^no rig /.test(error) ? 404 : 400);
    }
  });

  app.get("/v1/gpu-cloud-tests/:id", admin, (c) => {
    const t = runpodTests.view(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  });
  app.post("/v1/gpu-cloud-tests/:id/end", admin, async (c) => {
    try {
      return c.json(await runpodTests.end(c.req.param("id"), "owner:api"));
    } catch (err) {
      return c.json({ error: errorText(err) }, 404);
    }
  });
}
