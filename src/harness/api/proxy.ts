import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { forwardToProvider } from "../../agents/model/index.ts";
import { throughProxy } from "../../core/agents.ts";
import type { ApiContext } from "./context.ts";

/** The model proxy, through which the agents' programs reach the rig's provider. */
export function proxyRoutes(app: Hono, { service, registry }: ApiContext): void {
  // The model proxy: OpenCode and the Codex CLI reach the rig's provider through here, so the
  // provider's key (or a ChatGPT sign-in's access token) never reaches the lane. It takes a
  // trial's token, a call's in its own terminal, or one the harness minted for a check or a plan
  // (as a bearer token, or as Anthropic's x-api-key), adds the real key and streams the answer. A minted token may name
  // its own route: the planner's, when control gave the planner a model of its own (goal 073).
  // The tokens a trial's answers report are kept with the trial: its run's budget counts them,
  // not what the trial's program says.
  const openTrial = (token: string) => {
    try {
      return registry.openTrial(token);
    } catch {
      return undefined;
    }
  };
  app.all("/v1/model-proxy/*", bodyLimit({ maxSize: 64 * 1024 * 1024 }), async (c) => {
    const bearer = c.req.header("authorization") ?? "";
    const given = bearer.startsWith("Bearer ")
      ? bearer.slice(7)
      : (c.req.header("x-api-key") ?? "");
    const trial = given.startsWith("trial.");
    const open = trial ? openTrial(given.slice("trial.".length)) : undefined;
    const trialId = open?.id;
    // A call in its own terminal (goal 169): its credential, for its own route.
    const call = given.startsWith("call.") ? service.callOf(given) : undefined;
    const ok = trial ? trialId !== undefined : call !== undefined || service.proxyTokenValid(given);
    if (!ok) return c.json({ error: "unauthorized" }, 401);
    const m =
      (trial ? undefined : (call?.model ?? service.proxyTokenModel(given))) ??
      service.models?.current();
    // OpenCode's own models need no proxy; a Claude subscription is used only by Claude Code.
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
      },
      { api: m.api, baseUrl: m.baseUrl, key: m.keyNow?.() ?? m.apiKey },
      // Each error answer, for the trial (or the check or plan) to tell its kind (goal 079).
      (a) => service.noteProviderAnswer(trialId ?? call?.id ?? "proxy", a),
      // A stream that goes silent is broken off, logged and said in the trial's Live (goal 079).
      { ms: service.modelStallMs, onStall: (ms) => service.noteModelStall(open, ms) },
      // The tokens each of a trial's answers reported: what its run's budget counts of it.
      trialId ? (t) => service.ledger.trials.proxySaw(trialId, t) : undefined,
    );
  });
}
