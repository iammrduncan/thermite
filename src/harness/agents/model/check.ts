import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { buildModel, type ModelConfig } from "../../../agents/model/index.ts";
import { messageText, systemText } from "../../../agents/prompt.ts";
import { renderModelCheck } from "../../../agents/roles/index.ts";
import { errorText } from "../../../common/errors.ts";

/** What a rig check found: whether it passed, in a sentence, and the details behind it. */
export interface RigCheckReport {
  ok: boolean;
  summary: string;
  /** A note on a check that passed with a caveat (the smoke check on a machine with noisy timing). */
  note?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

type Reply = {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: { input?: number; output?: number };
  content?: { type: string; text?: string }[];
};

/**
 * The model route as the workers and the planner use it, through the same client: one short
 * request that must come back as a tool call carrying the word it was given. It reports the
 * time, the reply's stop reason and token use, and whether the reply carried thinking: what a
 * new or changed model server most often gets wrong (no tool calls, a cut-off reply, a refusal).
 */
// One short tool call: a route that has not answered in two minutes is not working.
export async function checkModel(cfg: ModelConfig, timeoutMs = 120_000): Promise<RigCheckReport> {
  const { models, model, thinkingLevel } = buildModel(cfg);
  const word = `thermite-${Math.random().toString(36).slice(2, 8)}`;
  const sent = renderModelCheck({ program: "pi", word });
  let echoed: string | undefined;
  const agent = new Agent({
    initialState: {
      systemPrompt: systemText(sent),
      model,
      thinkingLevel,
      tools: [
        {
          name: "echo",
          label: "echo",
          description: "Echo a word back.",
          parameters: Type.Object({ word: Type.String() }),
          execute: async (_id, params) => {
            echoed = String((params as { word?: unknown }).word);
            return { content: [{ type: "text", text: "ok" }], details: {}, terminate: true };
          },
        },
      ],
    },
    streamFn: models.streamSimple.bind(models),
  });
  const started = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, timeoutMs);
  let thrown: string | undefined;
  try {
    await agent.prompt(messageText(sent));
  } catch (err) {
    thrown = errorText(err);
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - started;
  const reply = (agent.state.messages as Reply[]).find((m) => m.role === "assistant");
  const text = (reply?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .slice(0, 300);
  const detail = {
    model: cfg.model,
    base_url: cfg.baseUrl,
    seconds: Math.round(ms / 100) / 10,
    stop: reply?.stopReason ?? null,
    error: reply?.errorMessage ?? thrown ?? null,
    tokens_in: reply?.usage?.input ?? null,
    tokens_out: reply?.usage?.output ?? null,
    thinking: (reply?.content ?? []).some((c) => c.type === "thinking"),
    tool_called: echoed !== undefined,
    text: text || null,
    context_window: cfg.contextWindow || null,
    max_tokens: cfg.maxTokens,
  };
  if (echoed === word) {
    return {
      ok: true,
      summary: `${cfg.model} answered with a correct tool call in ${detail.seconds} s`,
      detail,
    };
  }
  const why = timedOut
    ? `no answer in ${Math.round(timeoutMs / 1000)} s (is the model up?)`
    : echoed !== undefined
      ? `it called the tool with "${echoed.slice(0, 80)}", not "${word}"`
      : detail.error
        ? `no tool call: ${String(detail.error).slice(0, 300)}`
        : `no tool call (stop: ${detail.stop ?? "none"})${text ? `; it wrote: ${text.slice(0, 200)}` : ""}`;
  return { ok: false, summary: `${cfg.model} failed the tool-call check: ${why}`, detail };
}
