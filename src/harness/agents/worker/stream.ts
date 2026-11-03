import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { buildModel, PiMeter } from "../../../agents/model/index.ts";
import type { ProviderWatch } from "../provider-errors.ts";

/** What a Pi agent sends its provider, and how each call is watched (worker and research trials). */

/**
 * Pi's stream function for an agent: each call to the provider through `watch` (its error answers'
 * status and headers) and, when the trial measures its usage, through the meter (goal 075).
 */
export function watchedStream(
  models: ReturnType<typeof buildModel>["models"],
  watch: ProviderWatch,
  meter?: PiMeter | undefined,
): NonNullable<ConstructorParameters<typeof Agent>[0]>["streamFn"] {
  const fetch = watch.wrap(meter ? meter.fetch : globalThis.fetch);
  return (model, context, options) => models.streamSimple(model, context, { ...options, fetch });
}

/**
 * What is sent to the model: the conversation with every earlier reply's thinking left out (the
 * replies' text, tool calls and their results stay). Qwen-family chat templates keep earlier
 * reasoning only until the next user turn, so sending it both grows each prompt by all the
 * thinking so far and, whenever a nudge or warning is appended, changes the prompt's prefix, which
 * forces a shared model server to read the whole conversation again.
 */
export function withoutPastThinking(messages: AgentMessage[]): Message[] {
  return messages
    .filter(
      (m) =>
        m.role === "system" ||
        m.role === "user" ||
        m.role === "assistant" ||
        m.role === "toolResult",
    )
    .map((m) =>
      m.role === "assistant" && Array.isArray(m.content)
        ? { ...m, content: m.content.filter((b) => (b as { type?: string }).type !== "thinking") }
        : m,
    ) as Message[];
}
