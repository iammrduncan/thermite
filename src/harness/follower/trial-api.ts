import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { forwardToProvider, modelStallMs } from "../../agents/model/index.ts";
import { throughProxy } from "../../core/agents.ts";
import { LANE_CALL_MAX_BYTES } from "../../core/api/harness/lanes.ts";
import { TURN_OFFER, TURN_TAKEN } from "../../core/api/harness/turn.ts";
import { laneLimits } from "../../core/contract.ts";
import { type DevRuns, type LaneRunner, laneRun } from "../agents/index.ts";
import type { Hosted, LaneHost } from "./lanes.ts";

/**
 * A follower's routes for the trials of the lanes it holds (goal 205, step 2), which their
 * processes reach on loopback with the trial's token: those that need the workspace's machine
 * (the lane's commands, dev runs, the model proxy with the trial's route, the owner's messages
 * inside a turn) are served here; every other call of the trial goes to the leader (lanes.ts), and
 * its answer comes back as the leader's API gave it.
 */

/** Limits for a trial whose spec carried none: the contract's defaults. */
const DEFAULT_LIMITS = laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });

export function laneRoutes(
  app: Hono,
  host: LaneHost,
  o: { lanes: LaneRunner; devRuns?: DevRuns | undefined },
): void {
  const refuse = (why: string) =>
    new HTTPException(401, { res: Response.json({ error: why }, { status: 401 }) });
  // The trial a call is for, by its token: as a bearer token, or as Anthropic's x-api-key.
  const holderOf = (c: Context): Hosted => {
    const auth = c.req.header("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : (c.req.header("x-api-key") ?? "");
    const h = given.startsWith("trial.") ? host.byToken(given.slice(6)) : undefined;
    if (!h) throw refuse("unauthorized");
    return h;
  };

  app.post("/v1/lane/run", bodyLimit({ maxSize: 9 * 1024 * 1024 }), async (c) => {
    const h = holderOf(c);
    if (!h.root) return c.json({ error: "no workspace for this trial" }, 404);
    const r = await laneRun(
      o.lanes,
      { lane: h.spec.lane, root: h.root, limits: h.spec.limits ?? DEFAULT_LIMITS },
      await c.req.json(),
      refuse,
    );
    return c.json(r as object);
  });

  app.post("/v1/dev-runs", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const h = holderOf(c);
    if (!o.devRuns) return c.json({ error: "dev runs are not available" }, 404);
    const body = (await c.req.json()) as { command?: unknown; timeout_s?: unknown; cwd?: unknown };
    const limits = h.spec.limits ?? DEFAULT_LIMITS;
    return c.json(
      (await o.devRuns.run(
        {
          command: body.command,
          cwd: body.cwd,
          ...(typeof body.timeout_s === "number"
            ? { timeout_s: Math.max(1, Math.trunc(body.timeout_s)) }
            : {}),
          lane: h.spec.lane,
        },
        h.spec.trialId,
        {
          rssMib: limits.devRunRssMib,
          diskMib: limits.workspaceMib,
          processes: limits.processes,
          ...(limits.devRunTimeoutS !== undefined ? { timeoutS: limits.devRunTimeoutS } : {}),
        },
      )) as object,
    );
  });

  // The model proxy, with the trial's route and its key here: the key never reaches the lane.
  const stallMs = modelStallMs();
  app.all("/v1/model-proxy/*", bodyLimit({ maxSize: 64 * 1024 * 1024 }), async (c) => {
    const h = holderOf(c);
    const m = h.route;
    if (!m || !throughProxy(m.api)) return c.json({ error: "no provider to reach" }, 404);
    return forwardToProvider(
      {
        method: c.req.method,
        rest: c.req.path.slice("/v1/model-proxy/".length),
        search: new URL(c.req.url).search,
        header: (k) => c.req.header(k),
        body:
          c.req.method === "GET" || c.req.method === "HEAD"
            ? undefined
            : Buffer.from(await c.req.arrayBuffer()),
        program: m.harness,
      },
      { api: m.api, baseUrl: m.baseUrl, key: m.apiKey },
      (a) => host.noteProviderAnswer(h, a),
      { ms: stallMs, onStall: (ms) => host.noteStall(h, ms) },
      (t) => host.proxySaw(h, t),
    );
  });

  // The owner's messages inside the agent's turn, from the trial's inbox here (goal 169).
  app.post(TURN_OFFER.path, bodyLimit({ maxSize: TURN_OFFER.maxBytes }), async (c) => {
    const h = holderOf(c);
    const { at } = TURN_OFFER.body.parse(await c.req.json());
    return c.json(host.turnOffer(h, at) ?? { offer: null, text: "" });
  });
  app.post(TURN_TAKEN.path, bodyLimit({ maxSize: TURN_TAKEN.maxBytes }), async (c) => {
    const h = holderOf(c);
    const { offer } = TURN_TAKEN.body.parse(await c.req.json());
    return c.json({ messages: host.turnTaken(h, offer) });
  });

  // A Pi view's console: a trial on a follower runs headless (goal 205, step 2e).
  app.all("/v1/trial/console/*", (c) => {
    holderOf(c);
    return c.json({ error: "a trial on a follower runs headless" }, 404);
  });

  // Every other call of the trial: the leader's API answers it.
  app.all("/v1/*", bodyLimit({ maxSize: LANE_CALL_MAX_BYTES }), async (c) => {
    const h = holderOf(c);
    const body =
      c.req.method === "GET" || c.req.method === "HEAD"
        ? Buffer.alloc(0)
        : Buffer.from(await c.req.arrayBuffer());
    const a = await host.forward(h, {
      method: c.req.method,
      path: c.req.path,
      search: new URL(c.req.url).search,
      type: c.req.header("content-type") ?? "",
      auth: c.req.header("authorization") ?? "",
      body,
    });
    // A submission the leader took: the trial's program reads it, as the leader's ledger says.
    if (c.req.method === "POST" && c.req.path === "/v1/attempts" && a.status < 300)
      try {
        host.submittedNow(h, JSON.parse(a.body.toString("utf8")));
      } catch {
        // Not JSON: no submission here.
      }
    return new Response(new Uint8Array(a.body), {
      status: a.status,
      headers: a.type ? { "content-type": a.type } : {},
    });
  });
}
