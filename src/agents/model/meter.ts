import type { Agent, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, createModels } from "@earendil-works/pi-ai";
import { type CallUsage, callUsage } from "../../core/usage.ts";

/**
 * Model usage in Pi (goal 075): one record for each reply of an agent, from pi-ai's usage on the
 * reply (input, output, cache read and written, reasoning) and its times (the request's start, its
 * first token, its last). pi-ai gives 0 for a cache or reasoning figure the provider leaves out,
 * so the meter reads the provider's answer as it passes: a figure its usage does not name is
 * recorded as not reported, never 0.
 */

/** A usage key with a number: the provider's answer names cached input tokens. */
const CACHED = /"(?:cached_tokens|cache_read_input_tokens|prompt_cache_hit_tokens)"\s*:\s*\d/;
/** The provider's answer names reasoning tokens. */
const REASONING = /"(?:reasoning_tokens|thinking_tokens)"\s*:\s*\d/;

type Models = ReturnType<typeof createModels>;

/** What one answer's usage named, as far as the meter has read it. */
interface Seen {
  cached: boolean;
  reasoning: boolean;
}

export class PiMeter {
  private readonly sink: (u: CallUsage) => void;
  /** The newest request's answer: an agent's calls, and a summary's, come one at a time. */
  private current: Seen | undefined;

  constructor(sink: (u: CallUsage) => void) {
    this.sink = sink;
  }

  /**
   * The fetch pi-ai calls the provider with: the answer passes through unchanged, and the meter
   * notes whether its usage names cached and reasoning tokens. Keys inside a JSON string (a
   * model's own text) are escaped there, so they never match.
   */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const seen: Seen = { cached: false, reasoning: false };
    this.current = seen;
    const res = await globalThis.fetch(input, init);
    if (!res.body) return res;
    const decoder = new TextDecoder();
    let tail = "";
    const scan = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        const text = tail + decoder.decode(chunk, { stream: true });
        if (!seen.cached && CACHED.test(text)) seen.cached = true;
        if (!seen.reasoning && REASONING.test(text)) seen.reasoning = true;
        // A key split between two chunks is found with the next one.
        tail = text.slice(-64);
        ctrl.enqueue(chunk);
      },
    });
    return new Response(res.body.pipeThrough(scan), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  /** pi-ai's stream function for an agent, calling the provider through this meter. */
  streamFn(models: Models): StreamFn {
    return (model, context, options) =>
      models.streamSimple(model, context, { ...options, fetch: this.fetch });
  }

  /** Records each of the agent's replies, with its first token's time; returns the unsubscribe. */
  watch(agent: Agent): () => void {
    let first: number | undefined;
    return agent.subscribe((e) => {
      if (e.type === "message_start" && e.message.role === "assistant") first = undefined;
      else if (e.type === "message_update" && e.assistantMessageEvent.type !== "start")
        first ??= Date.now();
      else if (e.type === "message_end" && e.message.role === "assistant") {
        this.reply(e.message as AssistantMessage, first);
        first = undefined;
      }
    });
  }

  /** Records one reply: an agent's, or a call made without one (a compaction's summary). */
  reply(m: AssistantMessage, firstAt?: number | undefined): void {
    const seen = this.current;
    this.current = undefined;
    const u = m.usage;
    const start = m.timestamp;
    this.sink(
      callUsage({
        at: start,
        calls: 1,
        tokensIn: u.input + u.cacheRead + u.cacheWrite,
        cachedIn: seen?.cached ? u.cacheRead : null,
        tokensOut: u.output,
        reasoning: seen?.reasoning ? (u.reasoning ?? null) : null,
        firstTokenMs: firstAt !== undefined ? firstAt - start : null,
        callMs: m.durationMs ?? Date.now() - start,
      }),
    );
  }
}

/** The most records one hand-over carries (the harness's route takes this many). */
export const USAGE_BATCH = 100;

/**
 * A worker's model usage on its way to the harness (goal 075): each record is sent as it is made,
 * in order. A hand-over the harness did not take is tried again with the next one, and once more
 * when the trial ends; `finish` says how many records could not be handed over.
 */
export class UsageSender {
  private readonly post: (calls: CallUsage[]) => Promise<unknown>;
  private readonly waiting: CallUsage[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(post: (calls: CallUsage[]) => Promise<unknown>) {
    this.post = post;
  }

  readonly add = (u: CallUsage): void => {
    this.waiting.push(u);
    void this.send();
  };

  private send(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const batch = this.waiting.splice(0, USAGE_BATCH);
      if (!batch.length) return;
      try {
        await this.post(batch);
      } catch {
        // Kept, in order, for the next hand-over; finish counts what is never taken.
        this.waiting.unshift(...batch);
      }
    });
    return this.chain;
  }

  /** Sends what waits, while the harness takes it; returns how many records it did not take. */
  async finish(): Promise<number> {
    for (;;) {
      const before = this.waiting.length;
      await this.send();
      if (!this.waiting.length || this.waiting.length >= before) return this.waiting.length;
    }
  }
}
