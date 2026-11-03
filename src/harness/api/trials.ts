import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { PI_VIEW_DONE, PI_VIEW_END, PI_VIEW_NEXT } from "../../core/api/harness/console.ts";
import { PLANNER_ANSWER } from "../../core/api/harness/planner.ts";
import {
  CALL_PROMPT_ROLES,
  KEEP_TRIAL_PROMPT,
  TRIAL_PROMPT_ROLES,
} from "../../core/api/harness/prompts.ts";
import { TURN_OFFER, TURN_TAKEN } from "../../core/api/harness/turn.ts";
import { compactionOf, KEPT_MAX } from "../compactions.ts";
import { LedgerError } from "../ledger/index.ts";
import { type ApiContext, limitOf, Unauthorized } from "./context.ts";

/**
 * A running trial's own routes, each bound to the trial by its token: its session's lines for the
 * live log, the owner's messages waiting for it and its receipt for them (a Pi worker's, or its
 * program's hook or plugin's inside the agent's turn), its ideas and field notes, the compactions
 * of its conversation, the later turns its worker sent in it, and a worker in Pi's own side of its
 * Pi view's console. A planner in Pi in its own process (goal 169) reaches the same routes for its
 * session (its lines, the owner's messages, its compactions, its later turns, its Pi view), bound
 * to its call by the call's credential, and gives its answer at its own.
 */
export function trialRoutes(app: Hono, { service, trialOf, agentOf, agentId }: ApiContext): void {
  // A Pi view (goal 169): the owner's next input, one call in its trial's or call's loop; what
  // became of it; and the end, when the harness keeps the view's last screen. The trial's token,
  // or the call's credential, decides whose, so a process reaches only its own console.
  const piView = (header: string | undefined) => {
    const view = service.consoles.piView(agentId(header));
    if (!view) throw new LedgerError("conflict", "this trial or call has no Pi view");
    return view;
  };
  app.post(PI_VIEW_NEXT.path, limitOf(PI_VIEW_NEXT), async (c) => {
    const view = piView(c.req.header("authorization"));
    const { wait_ms } = PI_VIEW_NEXT.body.parse(await c.req.json());
    return c.json({ input: await view.next(wait_ms) });
  });
  app.post(PI_VIEW_DONE.path, limitOf(PI_VIEW_DONE), async (c) => {
    const view = piView(c.req.header("authorization"));
    const b = PI_VIEW_DONE.body.parse(await c.req.json());
    view.done(b.id, b.outcome, b.why);
    return c.json({ ok: true });
  });
  app.post(PI_VIEW_END.path, limitOf(PI_VIEW_END), async (c) => {
    const view = piView(c.req.header("authorization"));
    PI_VIEW_END.body.parse(await c.req.json());
    await view.end();
    return c.json({ ok: true });
  });

  // A worker's own lines for the live log: its trial decides the source, lane and run. A planner's
  // own process gives only its session's lines, for its call's source.
  app.post("/v1/trial/live", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    const who = agentOf(c.req.header("authorization"));
    const body = z
      .object({
        entries: z
          // What an agent's session produces; the owner's messages and their receipts are the
          // harness's own lines, never a worker's.
          .array(
            z.object({
              kind: z.enum(["text", "thinking", "tool", "result"]),
              text: z.string().max(8000),
            }),
          )
          .max(200),
        /** The session's counters so far (turns, tool calls, tokens). */
        progress: z
          .object({
            turns: z.number().int().min(0),
            tool_calls: z.number().int().min(0),
            tokens_in: z.number().int().min(0),
            tokens_out: z.number().int().min(0),
          })
          .optional(),
        /**
         * Its open model call, as a Pi worker reports it every 30 seconds: since when, and the
         * characters of text, thinking and tool-call arguments so far; null: it ended (goal 143).
         */
        reply: z
          .object({
            since: z.iso.datetime(),
            text: z.number().int().min(0),
            thinking: z.number().int().min(0),
            tool_args: z.number().int().min(0),
          })
          .nullable()
          .optional(),
        /** The trial waits for its provider, then goes on in the same conversation (goal 079). */
        wait: z
          .object({
            until: z.iso.datetime(),
            kind: z.enum(["rate_limit", "server", "model", "context", "credits", "auth", "route"]),
            words: z.string().max(2000),
          })
          .optional(),
      })
      .parse(await c.req.json());
    if (who.call) {
      if (body.progress || body.wait || body.reply !== undefined)
        throw new LedgerError("conflict", "a planner's process gives only its session's lines");
      who.call.own.live(body.entries);
      return c.json({ ok: true });
    }
    const trial = who.trial;
    // Counters and waits come only from a worker that reports its own session (Pi's): for a
    // command-line program, the harness reads them from the program's output itself.
    if ((body.progress || body.wait) && !service.ownSession(trial.id))
      throw new LedgerError(
        "conflict",
        "this trial's counters and waits come from the harness, which reads its program's output",
      );
    service.trialReport(trial, body);
    if (body.wait) service.trialWait(trial, body.wait);
    return c.json({ ok: true });
  });

  // The owner's messages waiting for this trial (to it, its lane or everyone working), or for a
  // planner's own process. Fetching them gives nothing to the agent: the process confirms each one
  // once its agent has it.
  const inboxOf = (header: string | undefined) => {
    const who = agentOf(header);
    if (who.call) return who.call.own.messages;
    const t = who.trial;
    return service.trialInbox({ id: t.id, run: t.run, lane: t.lane });
  };
  app.get("/v1/trial/messages", (c) =>
    c.json({ messages: inboxOf(c.req.header("authorization")).waiting() }),
  );

  // The receipt: these messages reached its agent (only messages waiting for it count). Only a
  // process in Pi sends one: it steers each message in before its agent's next model call.
  app.post("/v1/trial/messages/read", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const inbox = inboxOf(c.req.header("authorization"));
    const body = z
      .object({ ids: z.array(z.number().int().positive()).min(1).max(100) })
      .parse(await c.req.json());
    inbox.given(body.ids, "next-call");
    return c.json({ ok: true });
  });

  // A program's hook or plugin asks for the owner's next message inside the agent's turn (goal
  // 169): the trial's token decides the trial, and a call's credential the call (a planner's in
  // its own terminal), so it gets only what that agent may have. The offer reads nothing; its
  // receipt, once the program has the text, reads the message.
  app.post(TURN_OFFER.path, limitOf(TURN_OFFER), async (c) => {
    const id = agentId(c.req.header("authorization"));
    const { at } = TURN_OFFER.body.parse(await c.req.json());
    return c.json(service.turnOffer(id, at) ?? { offer: null, text: "" });
  });
  app.post(TURN_TAKEN.path, limitOf(TURN_TAKEN), async (c) => {
    const id = agentId(c.req.header("authorization"));
    const { offer } = TURN_TAKEN.body.parse(await c.req.json());
    return c.json({ messages: service.turnTaken(id, offer) });
  });

  // A worker's idea for its run's queue: proposed by its lane (its trial decides run and lane).
  app.post("/v1/trial/idea", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { token } = trialOf(c.req.header("authorization"));
    return c.json(service.proposeIdea(token, await c.req.json()), 201);
  });

  // A worker's field note: its trial decides the run, the lane and who wrote it.
  app.post("/v1/trial/note", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const { token } = trialOf(c.req.header("authorization"));
    return c.json(service.writeTrialNote(token, await c.req.json()), 201);
  });

  // A later turn a Pi worker sent inside its trial (goal 166), from its role's definition: kept as
  // the trial's first prompt is, its trial deciding the run, the lane and the trial; a planner's
  // process's, as its call's.
  app.post(KEEP_TRIAL_PROMPT.path, limitOf(KEEP_TRIAL_PROMPT), async (c) => {
    const who = agentOf(c.req.header("authorization"));
    const body = KEEP_TRIAL_PROMPT.body.parse(await c.req.json());
    const roles: readonly string[] = who.call ? CALL_PROMPT_ROLES : TRIAL_PROMPT_ROLES;
    if (!roles.includes(body.role))
      throw new LedgerError(
        "invalid",
        `a ${who.call ? "call" : "trial"} keeps no ${body.role}'s turns`,
      );
    const id = who.call
      ? service.ledger.prompts.record("harness", who.call.own.run, {
          ...body,
          lane: null,
          trial: null,
          call: who.call.own.call,
        })
      : service.ledger.prompts.record("harness", who.trial.run, {
          ...body,
          lane: who.trial.lane,
          trial: who.trial.id,
          call: null,
        });
    return c.json({ id }, 201);
  });

  // Where a process's compactions go: its trial's place, or its call's.
  const compactionsOf = (header: string | undefined) => {
    const who = agentOf(header);
    return who.call ? who.call.own.compaction : compactionOf(who.trial);
  };

  // A process in Pi compacts its conversation (goal 070): first the whole conversation, kept in
  // the run's research folder (the trial or call decides the run, the lane and the file's name),
  // then the record of the compaction. Both come from its own code, never from its agent.
  app.post("/v1/trial/snapshot", bodyLimit({ maxSize: 2 * KEPT_MAX + 64 * 1024 }), async (c) => {
    const of = compactionsOf(c.req.header("authorization"));
    if (!service.compactions || !of)
      return c.json({ error: "this harness keeps no compactions" }, 404);
    const body = z
      .strictObject({
        number: z.number().int().min(1).max(10_000),
        markdown: z.string().min(1).max(KEPT_MAX),
      })
      .parse(await c.req.json());
    return c.json(service.compactions.keep(of, body.number, body.markdown), 201);
  });
  app.post("/v1/trial/compacted", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const of = compactionsOf(c.req.header("authorization"));
    if (!service.compactions || !of)
      return c.json({ error: "this harness keeps no compactions" }, 404);
    const b = z
      .strictObject({
        number: z.number().int().min(1).max(10_000),
        tokens_before: z.number().int().min(0),
        tokens_after: z.number().int().min(0),
        how: z.enum(["summary", "trimmed"]),
        kept: z.boolean(),
        summary: z.string().max(32_000).optional(),
        error: z.string().max(2000).optional(),
      })
      .parse(await c.req.json());
    service.compactions.record(of, {
      number: b.number,
      tokensBefore: b.tokens_before,
      tokensAfter: b.tokens_after,
      how: b.how,
      harness: "pi",
      summary: b.summary,
      error: b.error,
      kept: b.kept,
    });
    return c.json({ ok: true }, 201);
  });

  // A planner's own process gives its answer (goal 169): submit_plan's arguments, which the
  // harness checks as data, or why it gave none. Only a call's credential answers here.
  app.post(PLANNER_ANSWER.path, limitOf(PLANNER_ANSWER), async (c) => {
    const who = agentOf(c.req.header("authorization"));
    if (!who.call) throw new Unauthorized("unauthorized");
    who.call.own.answer(PLANNER_ANSWER.body.parse(await c.req.json()));
    return c.json({ ok: true });
  });
}
