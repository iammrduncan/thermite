import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { redact } from "../../common/env.ts";
import { errorText, jsonBody } from "../../common/errors.ts";
import { COMMAND, ISSUE, RUN_HOURS, TEACHERS_ROUND } from "../../core/api/control/owner.ts";
import { addRunHours, issueWaking, startTeachersRound, WakeRefused } from "../issue/index.ts";
import { type ApiContext, clampLimit } from "./context.ts";

/**
 * Signed commands from the owner's token: one issued, a teachers' round asked for (goal 194),
 * and the newest listed.
 */
export function commandRoutes(app: Hono, api: ApiContext): void {
  const { store, privateKeyPem, parts, admin } = api;
  const { runpodRigs } = parts;

  app.post(ISSUE.path, admin, bodyLimit({ maxSize: ISSUE.maxBytes }), async (c) => {
    const body = ISSUE.body.parse(await jsonBody(c.req));
    // A wipe goes only through the full reset (export, verified push, the owner's confirmation).
    if (body.kind === "wipe_state")
      return c.json({ error: "wipe_state is issued only by a full reset" }, 400);
    let issued: { id: string; woke: string | null };
    try {
      // A run assigned or resumed on a stopped RunPod pod starts the pod first.
      issued = await issueWaking(store, privateKeyPem, runpodRigs, {
        rig: body.rig,
        kind: body.kind,
        payload: body.payload,
        ttlMinutes: body.ttl_minutes,
        // The admin token is the owner's; who issued a command is control's to say, not the client's.
        issuedBy: "owner:api",
        owner: true,
      });
    } catch (err) {
      // A refused command (a bad payload, a message nothing would read) is the client's to fix,
      // and in the audit log as the dashboard's and MCP's refusals are.
      const error = errorText(err);
      await store.auditLog.refusal("owner:api", "refused", {
        path: "/v1/commands",
        kind: body.kind,
        why: redact(error),
      });
      return c.json(
        { error },
        err instanceof WakeRefused ? 409 : error.startsWith("unknown rig") ? 404 : 400,
      );
    }
    // `woke` only when control started the rig's stopped pod first: other answers stay as they were.
    return c.json(
      { id: issued.id, status: "pending", ...(issued.woke ? { woke: issued.woke } : {}) },
      201,
    );
  });

  // More hours for a run (goal 198), the run named alone: control sends it to the run's rig.
  app.post(RUN_HOURS.path, admin, bodyLimit({ maxSize: RUN_HOURS.maxBytes }), async (c) => {
    const run = c.req.param("run");
    const body = RUN_HOURS.body.safeParse(await jsonBody(c.req));
    if (!body.success)
      return c.json({ error: "hours is the hours to add: more than 0, at most 8760" }, 400);
    try {
      const r = await addRunHours(store, privateKeyPem, {
        run,
        hours: body.data.hours,
        issuedBy: "owner:api",
      });
      return c.json(r, 201);
    } catch (err) {
      const error = errorText(err);
      await store.auditLog.refusal("owner:api", "refused", {
        path: RUN_HOURS.path,
        run,
        why: redact(error),
      });
      return c.json({ error }, /^(unknown rig|Control knows no run)/.test(error) ? 404 : 409);
    }
  });

  // A teachers' round now (goal 194), the run named alone: control sends it to the run's rig.
  app.post(TEACHERS_ROUND.path, admin, async (c) => {
    const run = c.req.param("run");
    try {
      return c.json(
        await startTeachersRound(store, privateKeyPem, { run, issuedBy: "owner:api" }),
        201,
      );
    } catch (err) {
      const error = errorText(err);
      await store.auditLog.refusal("owner:api", "refused", {
        path: TEACHERS_ROUND.path,
        run,
        why: redact(error),
      });
      return c.json({ error }, /^(unknown rig|Control knows no run)/.test(error) ? 404 : 409);
    }
  });

  app.get("/v1/commands", admin, async (c) =>
    c.json({ commands: await store.commands.list(clampLimit(c.req.query("limit"), 100)) }),
  );
}

/** One command, its delivery status and outcome, for the owner's token. */
export function commandStatusRoutes(app: Hono, api: ApiContext): void {
  const { store, admin } = api;

  app.get(COMMAND.path, admin, async (c) => {
    const cmd = await store.commands.get(c.req.param("id"));
    return cmd ? c.json(cmd) : c.json({ error: "not found" }, 404);
  });
}
