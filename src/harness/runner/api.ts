import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { Commit, MirrorName, RUN, RUN_GIT, RunAsk } from "../../core/api/harness/runs.ts";
import { HEALTH } from "../../core/api/harness/supervisor.ts";
import { type ApiTokens, allows } from "../api/index.ts";
import { type RunHost, RunRefusal } from "./host.ts";

/**
 * A runner process's API (goal 206): its health, and its runs for the core
 * (core/api/harness/runs.ts). Only its own supervisor reaches it, with the supervisor's token, and
 * passes on the core's asks.
 */
export function runnerApi(host: RunHost, tokens: ApiTokens, rig: string): Hono {
  const app = new Hono();

  // A refused ask says why: a runner the process lacks, a folder it did not name, a field the
  // schema refused. A failure is logged and answered with its words, which the core's judge
  // records as an infrastructure failure.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof z.ZodError)
      return c.json({ error: `invalid request: ${err.issues[0]?.message ?? "bad body"}` }, 400);
    if (err instanceof RunRefusal) return c.json({ error: err.message }, 409);
    const error = errorText(err);
    log("harness", "a run failed", { path: c.req.path, error }, "error");
    return c.json({ error: error.slice(0, 2000) }, 500);
  });

  app.get(HEALTH.path, (c) =>
    c.json(
      allows(tokens, ["supervisor"], c.req.header("authorization"))
        ? { ok: true, rig, runner: true }
        : { ok: true },
    ),
  );

  const supervisorOnly: MiddlewareHandler = async (c, next) => {
    if (!allows(tokens, ["supervisor"], c.req.header("authorization")))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  };
  app.use(RUN.path, supervisorOnly);
  app.use(`${RUN.path}/*`, supervisorOnly);

  app.post(RUN.path, bodyLimit({ maxSize: RUN.maxBytes }), async (c) =>
    c.json(await host.ask(RunAsk.parse(await c.req.json()))),
  );

  app.post(RUN_GIT.path, bodyLimit({ maxSize: RUN_GIT.maxBytes }), async (c) => {
    const repo = MirrorName.parse(c.req.param("repo"));
    const commit = Commit.parse(c.req.param("commit"));
    await host.takeGit(repo, commit, Buffer.from(await c.req.arrayBuffer()));
    return c.json({ ok: true });
  });

  return app;
}
