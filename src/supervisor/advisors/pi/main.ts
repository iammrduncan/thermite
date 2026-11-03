import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { z } from "zod";
import { mcpAgentTools } from "../../../agents/mcp/index.ts";
import { modelConfigFromEnv, UsageSender } from "../../../agents/model/index.ts";
import { startView } from "../../../agents/pi-view/index.ts";
import { promptRecord } from "../../../agents/prompt.ts";
import { callRoute } from "../../../common/api/call.ts";
import { errorText } from "../../../common/errors.ts";
import type { McpCallResult } from "../../../common/mcp-client.ts";
import type { BodyOf, Method, Route } from "../../../core/api/route.ts";
import {
  ADVISOR_CALL_ANSWER,
  ADVISOR_CALL_COMPACTED,
  ADVISOR_CALL_END,
  ADVISOR_CALL_KEEP,
  ADVISOR_CALL_KEPT_MAX,
  ADVISOR_CALL_LIVE,
  ADVISOR_CALL_MCP,
  ADVISOR_CALL_MCP_TOOLS,
  ADVISOR_CALL_MESSAGES,
  ADVISOR_CALL_READ,
  ADVISOR_CALL_TOOL,
  ADVISOR_CALL_TURN,
  ADVISOR_CALL_USAGE,
} from "../../../core/api/supervisor/advisor-call.ts";
import type { McpToolInfo } from "../../../core/mcp.ts";
import { piAdvisor, toolAnswer } from "./agent.ts";
import { PI_ADVISOR_SPEC_FILE, type PiAdvisorSpec } from "./spec.ts";

/**
 * An advisor in Pi in a process of its own, in its Pi view (goal 169; ../terminal/pi.ts starts
 * it): the terminal host runs it as an advisor user, on a terminal of its own, in its call's folder,
 * where it draws its view. It reaches the supervisor only over its call's routes on localhost, with
 * its call's credential, which stops working when the call ends (core/api/supervisor/
 * advisor-call.ts): each of its tools, which the supervisor runs as for a headless advisor; its
 * model through the call's proxy, which adds the key; its lines for Live, the owner's messages
 * (before its next model call), its usage, its compactions, its later turns, its view's console,
 * and its answer, which the supervisor checks as a headless advisor's. It reads nothing else of
 * the supervisor's.
 */

/** How long one call to the supervisor may take: a tool's (an MCP server's, a fetch) at most. */
const CALL_MS = 10 * 60_000;

/** Its call's routes, once its spec is read: a failed start says why over them. */
let ended: ((error: string) => Promise<unknown>) | undefined;

async function main(): Promise<void> {
  const spec = JSON.parse(readFileSync(PI_ADVISOR_SPEC_FILE, "utf8")) as PiAdvisorSpec;
  const target = {
    whose: "the supervisor's",
    url: spec.url,
    token: spec.auth,
    timeoutMs: CALL_MS,
  };
  /** One of its call's routes, by its contract. */
  const call = <R extends Route>(route: R, body?: BodyOf<R>) =>
    callRoute(target, route, body !== undefined ? { body } : {});
  let tokens = { in: 0, out: 0 };
  ended = (error) =>
    call(ADVISOR_CALL_END, { tokens_in: tokens.in, tokens_out: tokens.out, error });
  const cfg = modelConfigFromEnv();
  if (!cfg) throw new Error("no model route for the advisor: its call's proxy was not given");
  const view = startView({
    heading: spec.heading,
    // The view's console, over the Pi view's routes on the call's server.
    call: (method: string, path: string, body?: unknown) =>
      callRoute(
        target,
        { method: method as Method, path, answer: z.unknown() },
        body !== undefined ? { body: body as never } : {},
      ),
    servers: spec.mcp?.servers ?? [],
    relist: async (fresh) => mcpOf(await call(ADVISOR_CALL_MCP_TOOLS, { fresh })),
  });
  // Its MCP tools, each called by the supervisor, which holds the servers' sign-in.
  const mcpOf = (listed: {
    tools: McpToolInfo[];
    unavailable?: { server: string; why: string }[] | undefined;
  }) => ({
    tools: listed.tools,
    unavailable: listed.unavailable,
    call: async (server: string, tool: string, args: Record<string, unknown>) =>
      (await call(ADVISOR_CALL_MCP, { server, tool, arguments: args })) as McpCallResult,
  });
  // Its own tools, as the headless advisor has them, each run by the supervisor.
  const own: AgentTool[] = spec.tools.map(
    (t) =>
      ({
        name: t.name,
        label: t.label,
        description: t.description,
        parameters: t.parameters as TSchema,
        execute: async (_id: string, params: unknown) =>
          toolAnswer(
            (await call(ADVISOR_CALL_TOOL, { tool: t.name, args: (params ?? {}) as never })).text,
          ),
      }) as AgentTool,
  );
  const usage = new UsageSender((calls) => call(ADVISOR_CALL_USAGE, { calls }));
  const end = await piAdvisor({
    name: spec.name,
    cfg,
    sent: spec.sent,
    tools: (mcp) => [...own.slice(0, spec.mcpAt), ...mcp, ...own.slice(spec.mcpAt)],
    mcp: spec.mcp?.tools.length
      ? { listed: mcpOf(spec.mcp), tools: (m) => mcpAgentTools(m.tools, m.call) }
      : undefined,
    answerSchema: spec.answerSchema as TSchema,
    check: async (answer) => {
      const r = await call(ADVISOR_CALL_ANSWER, { answer });
      return r.ok
        ? { ok: true, output: answer }
        : { ok: false, problems: String(r.problems), words: String(r.words) };
    },
    maxTurns: spec.maxTurns,
    timeoutS: spec.timeoutS,
    keep: async (n, markdown) =>
      (
        await call(ADVISOR_CALL_KEEP, {
          number: n,
          markdown: markdown.slice(0, ADVISOR_CALL_KEPT_MAX),
        })
      ).kept,
    compacted: (c) => {
      void call(ADVISOR_CALL_COMPACTED, {
        number: c.number,
        tokens_before: c.tokens_before,
        tokens_after: c.tokens_after,
        how: c.how === "trimmed" ? "trimmed" : "summary",
        kept: c.kept,
        ...(c.error ? { error: c.error.slice(0, 4000) } : {}),
      }).catch(() => undefined);
    },
    // Each later turn, kept by the supervisor with the round's prompts (goal 166). Best effort:
    // the record is provenance, never a gate.
    later: (p) => {
      const { role, turn, sections } = promptRecord(p, {});
      void call(ADVISOR_CALL_TURN, {
        role: role as never,
        program: "pi",
        turn,
        sections,
      }).catch(() => undefined);
    },
    usage: usage.add,
    view: view.inputs,
    // A usage limit is waited out (the owner's decision of 2026-10-27): drawn, and said in Live.
    waitOut: (w) => {
      view.waiting(w);
      void call(ADVISOR_CALL_LIVE, {
        entries: [
          {
            kind: "status",
            text: `waits for its provider's usage limit to reset, until ${w.until}: ${w.words.slice(0, 600)}`,
          },
        ],
      }).catch(() => undefined);
    },
    // Its lines for Live, and the owner's messages for its role, each read once its agent has it.
    link: {
      live: (entries) => call(ADVISOR_CALL_LIVE, { entries: entries as never }),
      messages: async () => (await call(ADVISOR_CALL_MESSAGES)).messages,
      read: (ids) => call(ADVISOR_CALL_READ, { ids }),
    },
  });
  tokens = { in: end.tokensIn, out: end.tokensOut };
  await usage.finish();
  await call(ADVISOR_CALL_END, {
    tokens_in: end.tokensIn,
    tokens_out: end.tokensOut,
    ...(end.answered ? {} : { error: (end.error ?? "no answer").slice(0, 200_000) }),
  }).catch(() => undefined);
  await view.finish(end.answered ? "the answer went to the supervisor" : `no answer: ${end.error}`);
  process.exit(0);
}

main().catch(async (err) => {
  // It could not start its call: the supervisor hears why, once its route is known.
  await ended?.(`the advisor's process failed: ${errorText(err)}`.slice(0, 200_000)).catch(
    () => undefined,
  );
  process.exit(0);
});
