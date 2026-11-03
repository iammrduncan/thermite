import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { errorText } from "../../common/errors.ts";
import {
  RUN,
  RUN_ATTEMPT,
  RUN_CHAMPION_PATCH,
  RUN_DIRECTIONS,
  UNTRIED,
} from "../../core/api/control/owner.ts";
import { attemptRead, RUN_DETAIL_INPUT, runDetail } from "../run-lists.ts";
import type { ControlStore } from "../store/index.ts";
import type { RunOnRig, RunView } from "../views/index.ts";

/** What the routes need from control: a run wherever it ran, and a past run's untried experiments. */
export interface RunRoutesDeps {
  store: ControlStore;
  /** The run's view and the rig it ran on, or undefined for a run no rig created. */
  find(run: string): Promise<RunOnRig | undefined>;
  /** A past run's untried experiments as a new run's first queue, for `campaign` (goal 067). */
  untried(run: RunView, campaign: string): Promise<unknown[]>;
}

/** A number from the query, or undefined so that the argument's default applies. */
const num = (v: unknown) => (v === undefined || v === "" ? undefined : Number(v));

/** The query's arguments, read as MCP's get_run reads its own (goal 128). */
const DetailQuery = z.object({
  attempts: z.preprocess(num, RUN_DETAIL_INPUT.attempts),
  limit: z.preprocess(num, RUN_DETAIL_INPUT.limit),
  list: RUN_DETAIL_INPUT.list,
  offset: z.preprocess(num, RUN_DETAIL_INPUT.offset),
  full_report: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

/**
 * Control's REST routes for one run, the owner's and an operator's (admin), by the run's name
 * alone (goal 170), wherever it ran: the run itself, of a size an agent can read (goal 128, as
 * MCP's get_run gives it); one of its attempts (as MCP's get_attempt); a past run's untried
 * experiments as a new run's first queue (goal 067); its directions (goal 066); and its
 * champions' patches.
 */
export function runRoutes(app: Hono, admin: MiddlewareHandler, deps: RunRoutesDeps): void {
  const noRun = (run: string) => ({ error: `no run ${run}` });

  app.get(RUN.path, admin, async (c) => {
    const run = c.req.param("run");
    const found = await deps.find(run);
    if (!found) return c.json(noRun(run), 404);
    const q = DetailQuery.safeParse({
      attempts: c.req.query("attempts"),
      limit: c.req.query("limit"),
      list: c.req.query("list") || undefined,
      offset: c.req.query("offset"),
      full_report: c.req.query("full_report") || undefined,
    });
    if (!q.success) return c.json({ error: q.error.issues.map((i) => i.message).join("; ") }, 400);
    try {
      return c.json(runDetail(found.run, q.data));
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
  });

  app.get(RUN_ATTEMPT.path, admin, async (c) => {
    const run = c.req.param("run");
    const found = await deps.find(run);
    if (!found) return c.json(noRun(run), 404);
    const read = attemptRead(found, c.req.param("attempt"));
    return "error" in read ? c.json(read, 404) : c.json(read);
  });

  // A past run's untried experiments as a new run's first queue (goal 067): what Start a run
  // copies, at most 500, with the words and authors control's records hold, as MCP takes them
  // for the new run's campaign (`campaign`; the past run's own when not given).
  app.get(UNTRIED.path, admin, async (c) => {
    const run = c.req.param("run");
    const found = await deps.find(run);
    if (!found) return c.json(noRun(run), 404);
    const r = found.run;
    const campaign = c.req.query("campaign") || r.campaign || "";
    return c.json({
      run,
      rig: found.rig.id,
      campaign: r.campaign,
      queue: await deps.untried(r, campaign),
    });
  });

  // A run's directions (goal 066), each with its counts and the rules naming it, and the rules in
  // force: what a rule may name, and what a picker of directions lists.
  app.get(RUN_DIRECTIONS.path, admin, async (c) => {
    const run = c.req.param("run");
    const found = await deps.find(run);
    if (!found) return c.json(noRun(run), 404);
    const r = found.run;
    return c.json({ run, mode: r.mode, directions: r.directions, rules: r.rules });
  });

  // One of the run's champions as a patch file, once its rig has published it: the result the
  // owner takes away, which applies to the base commit the header names.
  app.get(RUN_CHAMPION_PATCH.path, admin, async (c) => {
    const run = c.req.param("run");
    const found = await deps.find(run);
    const p = found
      ? deps.store.championPatches.get(
          found.rig.id,
          found.rig.ledger_id,
          run,
          Number(c.req.param("seq")),
        )
      : undefined;
    if (!p) return c.json({ error: "no patch for that champion" }, 404);
    return c.body(new Uint8Array(p.patch), 200, {
      "content-type": "text/x-diff",
      "x-thermite-base-commit": p.base_commit,
      "x-thermite-sha256": p.sha256,
    });
  });
}
