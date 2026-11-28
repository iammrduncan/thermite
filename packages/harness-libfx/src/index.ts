import {
  FxFencedError,
  type FxFetch,
  type JournalRecord,
  type Persistence,
  type PersistenceLoadResult,
} from "libfx";

export const LIBFX_PIN = "0.0.18" as const;

export interface LibfxGapProfile {
  readonly pin: typeof LIBFX_PIN;
  /** Custom providers in libfx still hardcode `openai-chat-completions` and reject `protocol`. */
  readonly requiresAnthropicMessagesShim: boolean;
  /** Retired in 0.0.18: `provider.models[id].reasoningEfforts` natively sends custom effort fields. */
  readonly requiresCustomEffortFetchShim: boolean;
  /** Note: model ID must exist as a key in `provider.models` (even `{}`) to inherit `modelDefaults.reasoningEfforts`. */
  readonly customEffortRequiresListedModel: boolean;
  /** New in 0.0.18: `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` parse natively. */
  readonly nativeOpenAiNestedUsage: boolean;
  /** Still needed in 0.0.18: `cacheWriteTokens` is always null, and flat/DeepSeek/OpenRouter usage fields stay null. */
  readonly requiresSseUsageScanner: boolean;
  /** `provider.baseUrl` rejects non-loopback `http://` URLs with `TypeError`. */
  readonly requiresLoopbackLanRewrite: boolean;
  /** Host tool outputs > 65,536 bytes hard-fail with `isError: true`; cap at 60 KiB UTF-8. */
  readonly requiresHostToolCap: boolean;
  readonly hostToolHardLimitBytes: number;
  readonly recommendedHostToolCapBytes: number;
  /** No native turn/token/wall options; 429/500 retry indefinitely unless aborted. */
  readonly requiresFetchBudgetAndStallGuards: boolean;
  /** New in 0.0.18: stringified JSON tool arguments are coerced to schema-typed values. */
  readonly coercesTypedToolArgs: boolean;
}

export const LIBFX_GAP_PROFILE: LibfxGapProfile = {
  pin: LIBFX_PIN,
  requiresAnthropicMessagesShim: true,
  requiresCustomEffortFetchShim: false,
  customEffortRequiresListedModel: true,
  nativeOpenAiNestedUsage: true,
  requiresSseUsageScanner: true,
  requiresLoopbackLanRewrite: true,
  requiresHostToolCap: true,
  hostToolHardLimitBytes: 64 * 1024,
  recommendedHostToolCapBytes: 60 * 1024,
  requiresFetchBudgetAndStallGuards: true,
  coercesTypedToolArgs: true,
};

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Rewrites libfx's synthetic loopback `routePrefix` (e.g. `http://127.0.0.1/thermite-route/<id>`)
 * to a configured non-loopback HTTP/HTTPS `targetBaseUrl` at the `options.fetch` edge, preserving
 * libfx's bearer-header injection and secret redaction while allowing LAN local-LM servers.
 */
export function createLoopbackRouteFetch(
  targetBaseUrl: string,
  routePrefix: string,
  baseFetch?: FxFetch,
): FxFetch {
  const target = stripTrailingSlash(new URL(targetBaseUrl).toString());
  const prefix = stripTrailingSlash(new URL(routePrefix).toString());
  const transport: FxFetch = baseFetch ?? ((input, init) => globalThis.fetch(input, init));

  return (input, init) => {
    const matches =
      input === prefix || input.startsWith(`${prefix}/`) || input.startsWith(`${prefix}?`);
    const rewritten = matches ? `${target}${input.slice(prefix.length)}` : input;
    return transport(rewritten, init);
  };
}

export interface StoredJournalEntry extends JournalRecord {
  readonly idempotencyKey: string;
  readonly barrier: boolean;
}

export interface InMemoryPersistence extends Persistence {
  readonly records: readonly StoredJournalEntry[];
  readonly checkpoint: { readonly through: string; readonly data: Uint8Array } | null;
  readonly head: string | null;
  saveCheckpoint(input: { through: string; data: Uint8Array }): Promise<void>;
}

/**
 * Minimal in-memory `Persistence` matching libfx's opaque-bytes journal/checkpoint contract
 * with idempotent appends and optimistic cursor fencing (`FxFencedError`).
 */
export function createInMemoryPersistence(): InMemoryPersistence {
  const records: StoredJournalEntry[] = [];
  let checkpoint: { readonly through: string; readonly data: Uint8Array } | null = null;
  let head: string | null = null;

  return {
    get records() {
      return records;
    },
    get checkpoint() {
      return checkpoint;
    },
    get head() {
      return head;
    },
    async load(): Promise<PersistenceLoadResult> {
      const afterIndex = checkpoint
        ? records.findIndex((r) => r.cursor === checkpoint?.through) + 1
        : 0;
      const journal = records
        .slice(afterIndex)
        .map(({ cursor, data }) => ({ cursor, data: data.slice() }));
      return {
        ...(checkpoint
          ? { checkpoint: { through: checkpoint.through, data: checkpoint.data.slice() } }
          : {}),
        journal,
        head,
      };
    },
    async append({ expected, idempotencyKey, data, barrier }): Promise<{ cursor: string }> {
      const existing = records.find((r) => r.idempotencyKey === idempotencyKey);
      if (existing) return { cursor: existing.cursor };
      if (expected !== head) {
        throw new FxFencedError(
          `fenced journal append: expected cursor ${String(expected)}, actual head ${String(head)}`,
        );
      }
      const cursor = String(records.length + 1);
      records.push({ cursor, idempotencyKey, data: data.slice(), barrier });
      head = cursor;
      return { cursor };
    },
    async saveCheckpoint({ through, data }): Promise<void> {
      checkpoint = { through, data: data.slice() };
    },
  };
}
