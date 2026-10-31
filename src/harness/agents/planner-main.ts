import { readFileSync } from "node:fs";
import type { McpForAgent } from "../../agents/mcp/index.ts";
import { mcpAgentTools } from "../../agents/mcp/index.ts";
import { modelConfigFromEnv, UsageSender } from "../../agents/model/index.ts";
import { startView } from "../../agents/pi-view/index.ts";
import { type Prompt, promptRecord } from "../../agents/prompt.ts";
import { KB_SERVER, type KbCall, kbAgentTools } from "../../agents/tools/index.ts";
import { errorText } from "../../common/errors.ts";
import { type McpCallResult, resultText } from "../../common/mcp-client.ts";
import {
  PLANNER_ANSWER,
  PLANNER_ANSWER_MAX,
  type PlannerAnswer,
} from "../../core/api/harness/planner.ts";
import { KEEP_TRIAL_PROMPT } from "../../core/api/harness/prompts.ts";
import type { McpToolInfo } from "../../core/mcp.ts";
import { KEPT_MAX } from "../compactions.ts";
import { apiCall } from "./api-call.ts";
import {
  callPlanner,
  PLAN_SPEC,
  PlannerCallError,
  type PlannerCallSpec,
  type PlannerCompaction,
  type PlannerMcp,
  type PlannerViewSpec,
} from "./planner/index.ts";
import { RESEARCH_PLAN_SPEC } from "./research/index.ts";

/**
 * A planner in Pi in its own process, in its Pi view (goal 169; planner/view.ts starts it): the
 * terminal host runs it as the planner's user, on a terminal of its own, where it draws its view.
 * It reaches the harness only through the local API with its call's credential, which binds every
 * call to the planner's run and round and stops working when the call ends: its knowledge base and
 * MCP tools through the gateway, its compactions, its model usage, its later turns, its lines for
 * Live, the owner's messages (before its next model call) and the owner's console. Its answer,
 * submit_plan's arguments or why it gave none, goes to the harness's planner route, which reads it
 * as data.
 */

/** Each call's spec, as the harness names it. */
const SPECS: Record<PlannerCallSpec["id"], PlannerCallSpec> = {
  plan: PLAN_SPEC,
  research: RESEARCH_PLAN_SPEC,
};

/** Its credential, once its spec is read: the last answer of a failed start uses it. */
let answerWith: ((a: PlannerAnswer) => Promise<unknown>) | undefined;

async function main(): Promise<void> {
  const file = JSON.parse(readFileSync(String(process.argv[2]), "utf8")) as PlannerViewSpec;
  const api = process.env.THERMITE_HARNESS_URL ?? "http://127.0.0.1:8700";
  const call = async (method: string, path: string, body?: unknown) => {
    const { status, text } = await apiCall(
      `${api}${path}`,
      method,
      { authorization: `Bearer ${file.auth}`, "content-type": "application/json" },
      body !== undefined ? JSON.stringify(body) : undefined,
    );
    if (status < 200 || status >= 300)
      throw new Error(`${method} ${path} -> ${status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  };
  const answer = (a: PlannerAnswer) => call(PLANNER_ANSWER.method, PLANNER_ANSWER.path, a);
  answerWith = answer;
  const model = modelConfigFromEnv();
  if (!model)
    throw new Error(
      "no model route configured (THERMITE_MODEL_BASE_URL, THERMITE_MODEL, THERMITE_MODEL_API_KEY)",
    );
  // The MCP tools the run's kit gives the planner (goal 068), as the gateway lists them for this
  // call; `fresh`: asked of the servers now (the Pi view's /mcp reconnect).
  const listMcp = async (fresh?: true | string): Promise<McpForAgent> => {
    const query =
      fresh === undefined ? "" : `?fresh=${encodeURIComponent(fresh === true ? "all" : fresh)}`;
    const listed = (await call("GET", `/v1/mcp-tools${query}`)) as {
      tools: McpToolInfo[];
      unavailable?: { server: string; why: string }[];
    };
    return {
      tools: listed.tools,
      unavailable: listed.unavailable,
      call: async (server, tool, args) =>
        (await call("POST", "/v1/mcp-call", { server, tool, arguments: args })) as McpCallResult,
    };
  };
  const view = startView({
    heading: file.heading,
    call,
    servers: file.mcpServers,
    relist: listMcp,
  });
  // A list that can't be read gives none: the planner goes on with its other tools.
  let listed: McpForAgent | undefined;
  if (file.mcpServers.length) {
    try {
      listed = await listMcp();
    } catch {
      listed = undefined;
    }
  }
  // Thermite's knowledge base (goal 175): its tools through the gateway's own server, which runs
  // them for the planner's slot.
  const kb: KbCall = async (tool, args) => {
    const r = (await call("POST", "/v1/mcp-call", {
      server: KB_SERVER,
      tool,
      arguments: args,
    })) as McpCallResult;
    return { text: resultText(r), isError: r.isError === true };
  };
  const mcp: PlannerMcp = {
    servers: file.mcpServers,
    tools: listed ? mcpAgentTools(listed.tools, listed.call) : [],
    listed,
    ...(file.kbWrites
      ? { kb: { writes: file.kbWrites, tools: kbAgentTools(kb, file.kbWrites) } }
      : {}),
  };
  // Compactions (goal 070): the harness keeps the conversation in the run's research folder and
  // records each compaction; the call's credential decides the run and the file's name.
  const compaction: PlannerCompaction = {
    keep: async (n, markdown) =>
      (await call("POST", "/v1/trial/snapshot", {
        number: n,
        markdown: markdown.slice(0, KEPT_MAX),
      })) as { path: string; rel: string },
    done: (r) =>
      call("POST", "/v1/trial/compacted", {
        number: r.number,
        tokens_before: r.tokensBefore,
        tokens_after: r.tokensAfter,
        how: r.how,
        kept: r.path !== undefined,
        ...(r.summary ? { summary: r.summary.slice(0, 32_000) } : {}),
        ...(r.error ? { error: r.error.slice(0, 2000) } : {}),
      }),
  };
  // Each later turn, kept by the harness as the call's first prompt is (goal 166). Best effort:
  // the record is provenance, never a gate.
  const kept = (p: Prompt) => {
    const { role, program, turn, sections } = promptRecord(p, {});
    void call(KEEP_TRIAL_PROMPT.method, KEEP_TRIAL_PROMPT.path, {
      role,
      program,
      turn,
      sections,
    }).catch(() => undefined);
  };
  // Each model call's usage, handed to the harness as it is made (goal 075).
  const usage = new UsageSender((calls) => call("POST", "/v1/trial/usage", { calls }));
  let a: PlannerAnswer;
  try {
    const plan = await callPlanner(model, file.sent, {
      mcp,
      compaction,
      usage: usage.add,
      spec: SPECS[file.spec],
      kept,
      view: view.inputs,
      // Its lines for Live, and the owner's messages, each read once its agent has it.
      link: {
        live: (entries) => call("POST", "/v1/trial/live", { entries }),
        messages: async () =>
          (
            (await call("GET", "/v1/trial/messages")) as {
              messages: { id: number; text: string }[];
            }
          ).messages,
        read: (ids) => call("POST", "/v1/trial/messages/read", { ids }),
      },
    });
    a = planAnswer(plan);
  } catch (err) {
    const e =
      err instanceof PlannerCallError
        ? err
        : new PlannerCallError("provider_error", errorText(err));
    a = { cause: e.planCause, detail: e.message.slice(0, 2000) };
  }
  await usage.finish();
  await answer(a).catch(() => undefined);
  await view.finish("plan" in a ? "the plan went to the harness" : `no plan: ${a.detail}`);
  process.exit(0);
}

/** submit_plan's arguments as the planner route takes them: an object, at most its size. */
function planAnswer(plan: unknown): PlannerAnswer {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan))
    return { cause: "invalid", detail: "submit_plan's arguments were not an object" };
  if (Buffer.byteLength(JSON.stringify(plan)) > PLANNER_ANSWER_MAX)
    return { cause: "invalid", detail: `its plan was over ${PLANNER_ANSWER_MAX} bytes` };
  return { plan: plan as Record<string, unknown> };
}

main().catch(async (err) => {
  // It could not start its call: the harness hears why, once its credential is known.
  await answerWith?.({ cause: "provider_error", detail: errorText(err).slice(0, 2000) }).catch(
    () => undefined,
  );
  process.exit(0);
});
