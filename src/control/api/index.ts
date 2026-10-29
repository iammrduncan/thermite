import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { log, redact } from "../../common/env.ts";
import { answerOf } from "../../common/errors.ts";
import { busHealth } from "../bus/index.ts";
import { watchDrains } from "../clusters/index.ts";
import { controlDiskOf } from "../disk.ts";
import { ExportFiles } from "../exports.ts";
import { mountMcp } from "../mcp/index.ts";
import { mountMcpServerRoutes } from "../mcp-servers/index.ts";
import type { ControlStore } from "../store/index.ts";
import { busRoutes } from "./bus.ts";
import { campaignRoutes } from "./campaigns.ts";
import { commandRoutes, commandStatusRoutes } from "./commands.ts";
import { apiContext, type ControlOptions, type ControlTokens } from "./context.ts";
import { editRigRoutes } from "./edit-rig.ts";
import { gpuCloudRoutes } from "./gpu-clouds.ts";
import { kitRoutes } from "./kits.ts";
import { lifecycleRoutes } from "./lifecycle.ts";
import { modelRoutes } from "./model-routes.ts";
import { recordRoutes, rigRecordRoutes } from "./records.ts";
import { relayRoutes } from "./relay.ts";
import { resultRoutes } from "./results.ts";
import { rigRoutes } from "./rigs.ts";
import { usageRoutes } from "./usage.ts";

export type { ControlOptions, ControlTokens } from "./context.ts";

/**
 * Control HTTP API (v1 core). Admin tokens issue commands and read everything; each rig's token
 * may only report for its own rig, fetch its own pending commands and acknowledge them.
 *
 * Each section of the API is a module in api/ that adds its routes to the app, with what it takes
 * from the context built once here (api/context.ts: control's build and parts, and the guards of
 * the owner's, the rigs' and the reader's routes). They are added in this order, the order Hono
 * matches them in; then the dashboard's pages and MCP.
 */
export function createControlApi(
  store: ControlStore,
  tokens: ControlTokens,
  privateKeyPem: string,
  opts: ControlOptions = { staleAfterMs: 180_000 },
): Hono {
  const app = new Hono();
  const api = apiContext(app, store, tokens, privateKeyPem, opts);
  const { control, creds, parts, admin, rigAuth } = api;
  const owner = creds.owner;
  const { secrets, chatgpt, runpodTests, mcpServers, runpodRigs, runpodDriver } = parts;

  // Every refusal and bad input is answered in its own words and status, the same as MCP's. A
  // body past its route's limit keeps its own answer, 413: the rig's supervisor halves its page.
  app.onError((err, c) =>
    err instanceof HTTPException
      ? err.getResponse()
      : c.json({ error: answerOf(err).error }, answerOf(err).status),
  );

  // What fails goes to control's output and its audit log: the dashboard says why only once, in
  // the page it sends back, and whoever debugs control reads it again over MCP (control_log).
  app.use("*", async (c, next) => {
    await next();
    const path = new URL(c.req.url).pathname;
    const status = c.res.status;
    if (c.error || status >= 500) {
      const error = redact(c.error?.message ?? `status ${status}`);
      log("control", "request failed", { method: c.req.method, path, status, error }, "error");
      store.auditLog.add("control", "failed", { method: c.req.method, path, status, error });
      return;
    }
    if (!path.startsWith("/ui/") || c.req.method !== "POST") return;
    const to = c.res.headers.get("location");
    // Pages send a refusal back as error, or as msgerror for a message to agents.
    const back = to ? new URL(to, "http://control").searchParams : undefined;
    const why = back?.get("error") ?? back?.get("msgerror") ?? null;
    if (why || status >= 400) {
      const reason = redact(why ?? `status ${status}`);
      log("control", "refused", { path, why: reason }, "warn");
      store.auditLog.add("owner:ui", "refused", { path, why: reason });
    }
  });

  // Control is up; the message bus as control holds it: off, connected or away; each of
  // control's loops with its age, 503 when one is late (goal 173); and its disk against its floor,
  // `degraded` while it holds new runs for it. The bus away and a full disk are no reason for 503:
  // control waits for the one, holds new runs for the other, and says so here.
  app.get("/v1/health", (c) => {
    const h = parts.loops.health();
    const disk = controlDiskOf(store)?.state();
    const more = disk ? { disk, degraded: disk.low } : {};
    return c.json({ ...h, bus: busHealth(parts.bus), ...more }, h.ok ? 200 : 503);
  });

  relayRoutes(app, api);
  modelRoutes(app, api);

  // MCP servers (goal 068): the owner's routes, the OAuth callback, and what a rig gets.
  mountMcpServerRoutes(app, {
    store,
    servers: mcpServers,
    admin,
    rigAuth,
    publicUrl: parts.publicUrl,
  });

  // Where control keeps the exports rigs without a results repository send it (api/results.ts
  // takes them; the dashboard's Exports page reads them).
  const exportFiles = opts.exportsDir ? new ExportFiles(opts.exportsDir) : undefined;
  resultRoutes(app, api, exportFiles);
  lifecycleRoutes(app, api);
  rigRoutes(app, api);
  usageRoutes(app, api);
  busRoutes(app, api);
  kitRoutes(app, api);
  rigRecordRoutes(app, api);
  commandRoutes(app, api);
  campaignRoutes(app, api);
  editRigRoutes(app, api);
  recordRoutes(app, api);
  gpuCloudRoutes(app, api);
  commandStatusRoutes(app, api);

  // A draining cluster rig's pods restart once nothing runs on it, and any rig's drain past its
  // deadline is noted (clusters/drain.ts).
  watchDrains(parts, opts.drainWatchMs);
  opts.pages?.(app, store, {
    admin: owner,
    privateKeyPem,
    staleAfterMs: opts.staleAfterMs,
    driver: opts.driver,
    sessionDays: opts.sessionDays,
    secrets,
    chatgpt,
    providerFetch: opts.providerFetch,
    kits: parts.kits,
    probeRepo: opts.probeRepo,
    readKit: opts.readKit,
    cloudFetch: opts.cloudFetch,
    runpodTests,
    parts,
    mcpServers,
    runpodRigs,
    runpodDriver,
    control,
    offlineAfterMs: opts.offlineAfterMs,
    rigUpdates: opts.rigUpdates,
    exportFiles,
  });
  app.get("/", (c) => c.redirect("/ui", 302));
  mountMcp(app, store, {
    admin: owner,
    operator: creds.operator,
    agent: creds.agent,
    read: creds.read,
    privateKeyPem,
    staleAfterMs: opts.staleAfterMs,
    offlineAfterMs: opts.offlineAfterMs,
    control,
    runpodTests,
    runpodRigs,
    runpodDriver,
    driver: opts.driver,
    parts,
    mcpServers,
    publicUrl: parts.publicUrl,
    kits: parts.kits,
  });

  return app;
}
