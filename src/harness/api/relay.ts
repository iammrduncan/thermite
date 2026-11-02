import type { Context, Hono } from "hono";
import { errorText } from "../../common/errors.ts";
import {
  COMMAND_CHECK,
  COMMAND_UNSTAGED,
  COMMANDS,
  EXPORTS_DONE,
  LIVE_MESSAGES,
  LIVE_PAGE_DEFAULT,
  RETENTION_REMOVED,
  SCREENS,
  SNAPSHOT,
  SNAPSHOT_PAGE_DEFAULT,
  SNAPSHOT_PAGE_MAX,
  SPACE,
  TERMINAL_KEYS,
} from "../../core/api/harness/supervisor.ts";
import { LIVE_BATCH_MAX } from "../../core/live.ts";
import { recordRemoved, spaceOf } from "../retention.ts";
import { type ApiContext, limitOf } from "./context.ts";

/**
 * What the supervisor relays between the harness and control: the harness's signed report and
 * control's signed commands, the live log, and the exports. The three groups of routes are added
 * at their places in the API's order (api.ts).
 */

/** The report (a page of events with the summary) and control's commands. */
export function reportRoutes(app: Hono, { service, supervisor }: ApiContext): void {
  app.get(SNAPSHOT.path, supervisor, (c) => {
    const cursor = Number(c.req.query("cursor") ?? "0");
    const limit = Math.min(
      Number(c.req.query("limit") ?? SNAPSHOT_PAGE_DEFAULT),
      SNAPSHOT_PAGE_MAX,
    );
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1) {
      return c.json({ error: "bad cursor or limit" }, 400);
    }
    return c.json(service.snapshot(cursor, limit) as object);
  });

  app.post(COMMANDS.path, supervisor, limitOf(COMMANDS), async (c) => {
    const outcome = await service.applyCommand(await c.req.json());
    if (outcome.status === "rejected") return c.json(outcome, 403);
    return c.json(outcome);
  });
  // Checked, not applied: what the supervisor asks before it fetches a command's sources.
  app.post(COMMAND_CHECK.path, supervisor, limitOf(COMMAND_CHECK), async (c) =>
    c.json(service.checkCommand(await c.req.json())),
  );
  // A command whose content the supervisor could not stage: recorded as not applied, with why.
  app.post(COMMAND_UNSTAGED.path, supervisor, limitOf(COMMAND_UNSTAGED), async (c) => {
    const { command, reason } = COMMAND_UNSTAGED.body.parse(await c.req.json());
    const outcome = service.recordUnstaged(command, reason);
    if (outcome.status === "rejected") return c.json(outcome, 403);
    return c.json(outcome);
  });
}

/** The live log, and the screens of the trials someone watches. */
export function liveRoutes(app: Hono, { service, supervisor }: ApiContext): void {
  /** The page a request asks for; undefined unless `after` is a whole number from 0, `limit` from 1. */
  const pageOf = (c: Context) => {
    const after = Number(c.req.query("after") ?? "0");
    const limit = Math.min(Number(c.req.query("limit") ?? LIVE_PAGE_DEFAULT), LIVE_BATCH_MAX);
    const good = Number.isInteger(after) && after >= 0 && Number.isInteger(limit) && limit >= 1;
    return good ? { after, limit } : undefined;
  };
  // The live log, signed, as the message bus's messages, for the supervisor to publish.
  app.get(LIVE_MESSAGES.path, supervisor, (c) => {
    const p = pageOf(c);
    if (!p) return c.json({ error: "bad after or limit" }, 400);
    return c.json(service.liveMessages(p.after, p.limit) as object);
  });
  // The screens of the trials control's viewers watch (goal 169), for the supervisor to send on.
  app.post(SCREENS.path, supervisor, limitOf(SCREENS), async (c) => {
    const { trials } = SCREENS.body.parse(await c.req.json());
    return c.json({ screens: await service.consoles.screens(trials) });
  });
  // The keys the owner pressed on Live (goal 187), each to its trial's terminal, in order.
  app.post(TERMINAL_KEYS.path, supervisor, limitOf(TERMINAL_KEYS), async (c) => {
    const { keys } = TERMINAL_KEYS.body.parse(await c.req.json());
    const refused: { trial: string; why: string }[] = [];
    for (const k of keys)
      await service.consoles
        .keystrokes(k.trial, k.data, "owner:live")
        .catch((err) => refused.push({ trial: k.trial, why: errorText(err) }));
    return c.json({ refused });
  });
}

/**
 * The exports: those the supervisor pushed leave the outbox. And the retention policies' part of
 * the rig (retention.ts): what it keeps of the builds, for control, and what the supervisor
 * removed of the advisors' records.
 */
export function exportRoutes(app: Hono, { service, supervisor }: ApiContext): void {
  app.post(EXPORTS_DONE.path, supervisor, limitOf(EXPORTS_DONE), async (c) => {
    const body = EXPORTS_DONE.body.parse(await c.req.json());
    return c.json({ removed: service.removeExports(body.names) });
  });
  app.get(SPACE.path, supervisor, (c) => c.json(spaceOf(service.ledger, service.paths.stateDir)));
  app.post(RETENTION_REMOVED.path, supervisor, limitOf(RETENTION_REMOVED), async (c) => {
    recordRemoved(service.ledger, RETENTION_REMOVED.body.parse(await c.req.json()));
    return c.json({ ok: true });
  });
}
