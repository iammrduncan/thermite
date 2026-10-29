import type { Hono } from "hono";
import { redact } from "../../common/env.ts";
import { errorText, jsonBody } from "../../common/errors.ts";
import { COMMAND, ISSUE } from "../../core/api/control/owner.ts";
import { issueWaking, WakeRefused } from "../issue/index.ts";
import { type ApiContext, clampLimit } from "./context.ts";

/** Signed commands from the owner's token: one issued, and the newest listed. */
export function commandRoutes(app: Hono, api: ApiContext): void {
  const { store, privateKeyPem, parts, admin } = api;
  const { runpodRigs } = parts;

  app.post(ISSUE.path, admin, async (c) => {
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
      store.auditLog.add("owner:api", "refused", {
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

  app.get("/v1/commands", admin, (c) =>
    c.json({ commands: store.commands.list(clampLimit(c.req.query("limit"), 100)) }),
  );
}

/** One command, its delivery status and outcome, for the owner's token. */
export function commandStatusRoutes(app: Hono, api: ApiContext): void {
  const { store, admin } = api;

  app.get(COMMAND.path, admin, (c) => {
    const cmd = store.commands.get(c.req.param("id"));
    return cmd ? c.json(cmd) : c.json({ error: "not found" }, 404);
  });
}
