# Thermite v1 — `libfx` Audit, Packaging Tradeoffs & `harness-*` Plugin Seam

**Status:** Goal 0 preplanning audit (2026-11-28). Read-only inspection; zero production code changes.  
**Audited:** `libfx@0.0.16` (installed native N-API addon + `fx-core.wasm` + JS/TS declarations), `fxbot@0.12.0` (`packages/sdk/src/`), Thermite `src/agents/` & `src/harness/agents/`, [Goal 260](../../goals/260-fxbot-and-thermite.goal), [Goal 255](../../goals/255-one-way-to-run-a-program.goal), and [NATS + Sans-I/O Contract](sansio-nats-contract.md).

## TL;DR Recommendation

1. **Use `libfx` as Thermite v1's built-in default loop — via `createFxEngine({ persistence })`, NOT `createFxAgent({ durability: world(...) })`.** Direct `Persistence` (~120 LOC on Thermite's Postgres + NATS `LIVE` streaming) delivers full crash recovery, fencing, steering, cancellation, and checkpoints while avoiding `@workflow/world-postgres` (3 foreign schemas + `graphile_worker` polling queue + `vercel-labs/fx#1253`).
2. **Adopt Option C (Hybrid packaging): wrap `libfx` directly inside Thermite (`packages/harness-libfx`, ~750–900 LOC) for v1.0; do NOT block Goal 1 on carving `@fxbot/agent-core` out of `fxbot`.** `@fxbot/sdk` is 9,112 LOC (`8,396` across 30 `.ts` files + `716` across 5 `.json` files, excl. `migrations/`) of private, unbuilt, untested TS tightly bound to Postgres; only ~936 LOC (539 LOC JSON catalog + 126 LOC validator + 271 LOC OAuth helpers) are DB-free. Consume `fxbot`'s catalog schema now and optionally extract a tiny DB-free `@fxbot/providers` later once both repos stabilize.
3. **Close `libfx@0.0.16`'s five critical runtime gaps at the `options.fetch` + `hooks` edge (~500 LOC total) rather than waiting on upstream `0.0.x`:**
   - **LAN HTTP local-LM servers:** pass synthetic loopback `http://127.0.0.1/thermite-route/<id>` to `libfx` and rewrite to the configured `http://<host>:<port>/v1` URL in `options.fetch` (live-verified).
   - **Usage & TTFT telemetry:** wire `hooks.onEvent` (`model.start` / `model.output_start` / `model.end`) for TTFT & `call_ms`, paired with a ~60 LOC SSE usage scanner in `options.fetch` — because live probing proved `libfx@0.0.16` **drops** `cached_tokens`, `cache_write_tokens`, and `reasoning_tokens` on all custom providers.
   - **Anthropic direct-key prompt caching (+ optional thinking) & custom-provider `effort`:** add a ~250 LOC Chat-Completions-to-Messages translating `fetch` shim (and `reasoning_effort` body injection) so direct Anthropic API keys avoid the 5–8× uncached penalty without requiring Vercel AI Gateway BYOK.
   - **Turn/token/wall limits, stall guard & bounded retries:** gate the `(N+1)`th call synchronously in `options.fetch` + `AbortSignal`, wrap `fetch` with `stallGuard`, and cap host tool outputs at 60 KiB UTF-8 (live probing proved `libfx` hard-fails tool results > 64 KiB).
4. **Lock one `HarnessPlugin` / `HarnessSession` boundary (`registerHarness`)** so `libfx` is simply the default bundled plugin and `harness-claude`, `harness-agy`, `harness-codex`, and `harness-pi` plug into the exact same seam with zero core branches.

---

## 1. Delta Since Goal 260 (Nov 11) & Upstream `libfx` Status

| Dimension | Goal 260 (2026-11-11, `fxbot@0.9.0`) | Installed Today (`fxbot@0.12.0`, `libfx@0.0.16`) | Upstream `libfx` (`0.0.17`–`0.0.18`, Nov 2026) |
| --- | --- | --- | --- |
| **Pinned `libfx` version** | `0.0.16` | Still `0.0.16` (`fxbot: packages/sdk/package.json:16`) | `0.0.18` on npm (rapid weekly `0.0.x` breaking changes continue) |
| **Custom provider protocol** | `openai-chat-completions` only | Unchanged (`libfx: custom-provider.js:95`) | Still `openai-chat-completions` only for custom providers; Gateway prompt caching improved in `0.0.17` |
| **Effort on custom providers** | Assumed `model: { id, effort }` works | **Fails hard** on all custom providers (`fxbot: types.ts:244-246`, `fx #1803`; live-verified `LIBFX_MODEL_UNSUPPORTED_EFFORT`) | No custom-provider effort catalog support yet |
| **Compaction control** | Noted absent in `libfx` | Still absent; `fxbot@0.10–0.12` built `/compact`, `/fresh` & idle compaction **outside** `libfx` via `checkpoint()` → throwaway engine → new `sessionId` (`fxbot: index.ts:758-899`) | Internal compactor retries hardened (`src/core/compactor/`); still no host threshold/summarizer API |
| **Infinite retry / stuck turns** | Not flagged in Goal 260 | `fxbot` added 30s sweep canceling refusing turns after 5 min (`fxbot: index.ts:510-522`) | Engine still auto-retries indefinitely unless cancelled |
| **SDK tests & packaging** | Private TS source, no tests/CI | Unchanged (`fxbot: package.json:1-31` has `typecheck`, zero test scripts) | `libfx` itself ships node/wasm tests; `fxbot` still has none |

---

## 2. Gap-by-Gap Code Audit (Hard Evidence + Live Probe Verification)

Every claim below was verified against installed `libfx@0.0.16` JS/TS sources, `fx-core.wasm` binary strings, `fxbot@0.12.0` SDK sources, Thermite `src/agents/`, and live `node` probes executing the installed `@libfx/libfx-linux-x64-gnu` native addon against an in-process mock `fetch`.

| Thermite v1 Need | Status in `libfx@0.0.16` | Code / Binary / Live-Probe Evidence | Concrete Fix in Thermite v1 |
| --- | --- | --- | --- |
| **1. Anthropic Messages API (caching & thinking)** | **Gap** for direct API key; **Works** via AI Gateway | `custom-provider.js:95` hardcodes `protocol: "openai-chat-completions"`; `fx-core.wasm` lacks `anthropic-messages` & `v1/messages` (contains `"providerOptions":{"anthropic":{"cacheControl":{"type":"ephemeral"}}}` only for Gateway). `fxbot: providers-registry.json:72` warns: *"no prompt caching, and returns no thinking"*. | Support AI Gateway BYOK natively **plus** a ~250 LOC `options.fetch` translator (`/chat/completions` ↔ Anthropic `/v1/messages`) adding `cache_control: { type: "ephemeral" }` breakpoints and mapping `thinking` deltas to `delta.reasoning_content` (live probe proved `libfx` emits `reasoning_delta` from `delta.reasoning_content`!). *Caveat:* multi-turn interleaved thinking requires an in-memory `thinking.signature` side-table (degrades to text-only on resume) until upstream adds native Messages support. |
| **2. OpenAI Responses API (key providers)** | **Gap** for API keys; **Works** for ChatGPT/Grok plans | `fx-core.wasm` hardcodes `/responses` only for `https://chatgpt.com/backend-api/codex/responses` (`chatgpt.js:11`) and `https://cli-chat-proxy.grok.com/v1/responses` (`grok.js:10`). Custom OpenAI keys hit `/chat/completions`. | Use native `provider: "codex"` / `"grok"` for plans and `/chat/completions` for OpenAI keys in v1.0; add optional ~200 LOC `options.fetch` Responses translator only if a Responses-only API-key model is needed. |
| **3. Reasoning `effort` on key/local providers** | **Gap** (undiscovered in Goal 260) | Live probe: `model: { id, effort: "high" }` on custom provider throws `LIBFX_MODEL_UNSUPPORTED_EFFORT`. `fxbot: types.ts:244-246` restricts effort to `["gateway","vercel","chatgpt","grok"]` (`fx #1803`). | Inject `reasoning_effort` into the Chat Completions JSON body inside Thermite's `options.fetch` when configured for a custom/local model (and strip it if `"off"` / unset). |
| **4. Turn, token & wall-time limits + stall/retry guards** | **Gap** (no API options; retries forever) | `libfx.d.cts:699-755` & `node.js:358-369` have no `maxTurns`, `maxTokens`, or hard `maxDurationMs`; `engine.js:170` rejects `env`; live probe confirmed `process.env.FX_MAX_AGENT_STEPS=2` is **ignored** (ran 5 calls). `fxbot: index.ts:510-518` notes `libfx` retries refusing providers forever. | v1 has **no default research caps**; when user budgets are set, enforce turn/token limits synchronously inside `options.fetch` + `AbortController` (live probe verified zero wasted `(N+1)`th call) and wall time via `AbortSignal.timeout`. Wrap `options.fetch` with Thermite's `stallGuard` (`src/agents/model/stall.ts`) + bounded retry / instant fail on 401/402/403. |
| **5. Compaction control & hard payload limits** | **Gap** (internal-only) + **64 KiB traps** | `fx-core.wasm` contains `fx-compactor-v1` & `FX_AUTO_COMPACT_PERCENT`, but `libfx` exposes zero threshold/prompt/disable API — only passive `hooks` `purpose: "compaction"` (`libfx.d.cts:398`). `fxbot` bypassed it externally (`index.ts:758-899`). Hard limits: `instructions` ≤ 64 KiB (`engine.js:17,1080`), steer ≤ 64 KiB (`engine.js:55`), checkpoint/journal ≤ 4 MiB / 1,024 turns (`engine.js:47-49,290`), and **live probe proved tool returns > 64 KiB fail with `isError: true` ("Host tool result exceeded the configured limit")**. | Let `libfx` auto-compact as a last-resort safety net (logged + metered via `hooks`), and support host-triggered rollover (`checkpoint()` → archive transcript → throwaway `summarize()` → fresh session) when campaign `compactAt` or owner `/compact` triggers. Enforce a strict 60 KiB UTF-8 cap + scratch-file overflow pointer in Thermite's host tool wrapper, and keep instructions < 60 KiB. |
| **6. Streaming & durable session resume** | **Strong fit** via `createFxEngine({ persistence })` | `libfx.d.cts:481-515,596-624` exposes a 3-method opaque-bytes `Persistence` (`load`, `append` with `FxFencedError`, `saveCheckpoint`), `resume({ onAmbiguous })`, `steer()`, `withdraw()`, `cancel({ reason: "handoff" })`, and `yieldAt`. By contrast, `createFxAgent` + `@workflow/world-postgres` (`fxbot: sessions.ts:18-69`) drags in 3 foreign PG schemas (`workflow`, `workflow_drizzle`, `graphile_worker`), an external `bin/setup.js` child process, and `vercel-labs/fx#1253` + stream `ConflictingIdentity` races (`fxbot: index.ts:705-706`). | Use **`createFxEngine({ persistence })`** on a ~120 LOC Postgres adapter (`harness_journal` + `harness_checkpoints` with optimistic cursor fencing) and stream turn events onto Thermite's NATS `LIVE` subject. Control's scheduler owns leases & dispatch; zero Workflow World dependency. |
| **7. Usage & TTFT telemetry** | **Partial — critical bug on custom providers** | `hooks.onEvent` (`libfx.d.cts:394-410`) fires `model.start`, `model.admitted`, `model.output_start`, `model.end` with epoch-ms timestamps (live probe verified exact `TTFT = output_start.ts - start.ts` and `call_ms = end.ts - start.ts`). **However, live probing across 3 JSON shapes (`prompt_tokens_details.cached_tokens`, flat `cache_read_tokens`/`cache_write_tokens`/`reasoning_tokens`, Anthropic compat) proved `libfx@0.0.16` ALWAYS emits `null` for `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens` on custom providers** (`fx-core.wasm` lacks `prompt_tokens_details` and `completion_tokens_details` entirely). | Combine `hooks.onEvent` (call boundaries, `purpose`, TTFT, `call_ms`, `finishReason`, `toolCalls`) with a ~60 LOC SSE usage scanner in `options.fetch` (porting `src/agents/model/meter.ts` & `tokens.ts`) to extract exact `cached_in`, `cache_write_in`, `reasoning`, preserving `null` ("not reported") vs `0` (`src/core/usage.ts:9`). |
| **8. LAN HTTP local-LM servers** | **Blocked by default**; **15-LOC fix verified** | `libfx: custom-provider.js:12,37-38` and `fxbot: providers.ts:24,29-39` allow only `https:` or `http:` on `localhost`/`127.0.0.1`/`[::1]` (live probe threw `TypeError` for non-loopback HTTP). Yet `node.js:460` & `engine.js:1458-1495` route 100% of HTTP traffic through `options.fetch` after JS-side bearer injection. | Pass synthetic `baseUrl: "http://127.0.0.1/thermite-route/<providerId>"` to `createFxEngine()` and rewrite that prefix to the configured `http://<lan-host>:<port>/v1` target in `options.fetch` (live-verified: auth header injection & secret masking stay intact; omit `credentials` for keyless local servers). |

**Additional operational notes verified in code:**
- **Tool concurrency:** On native N-API, `libfx` runs `idempotent: true, writes: false` tools up to 16 in parallel and serializes `writes: true` or `idempotent: false` (`README.md:273`). For code workers sharing one workspace/lane user, mark mutating/shell/submit tools `idempotent: false, writes: true` (matching `src/harness/agents/worker/index.ts:150-152` sequential execution invariant).
- **WASM / V8 isolate compatibility:** `libfx` ships `fx-core.wasm` + `libfx/wasm`, **requiring JSPI** (`node.js:315-325` prompts for `--experimental-wasm-jspi`, which Node 22.x / V8 12.4 lacks and returns `LIBFX_JSPI_UNAVAILABLE` — so `libfx/wasm` requires Node 24+ / Deno / `workerd` / browser; see [`wasm-isolation-spike.md`](wasm-isolation-spike.md)); native Linux addon needs glibc ≥ 2.34 (`README.md:516`).

---

## 3. Packaging Tradeoffs: Direct Wrap vs. `@fxbot/agent-core` vs. Hybrid

### Measured `fxbot` SDK Footprint (`packages/sdk/src/` = 9,112 LOC: 30 `.ts` = 8,396 + 5 `.json` = 716, excl. `migrations/`)

| Module Group in `fxbot` | Files & Measured LOC | DB / `fxbot` Coupling |
| --- | --- | --- |
| **Pure catalog & OAuth sign-ins** | `providers-registry.json` (539), `catalog.ts` (126), `device.ts` (54), `vercel.ts` (96), `vertex.ts` (50), `huggingface.ts` (27), `openrouter.ts` (28), `orcarouter.ts` (16) = **936 LOC** | **Nearly zero** (`vercel.ts` imports 8-LOC `withoutSecrets`; `catalog.ts:13` hardcodes loopback-only HTTP). |
| **Provider runtime & model cache** | `providers.ts` (649), `models.ts` (354), `secrets.ts` (89), `sessions.ts` (69) = **1,161 LOC** | **Tightly coupled** to `fxbot`'s Postgres tables (`providers`, `secrets`, `models_dev`, `model_lists`, `profiles`), `createFxAgent` per provider, and `@workflow/world-postgres`. |
| **Bot system (out of scope for runs)** | `index.ts` (1,413), `plugins.ts` (1,094), `mcp.ts` (713), `types.ts` (466), `registry.ts` (432), `skills.ts` (400), `client.ts` (367), `library.ts` (303), `history.ts` (292), `memories.ts` (273), `embeddings.ts` (232), + 8 smaller `.ts` files (853) + 4 bot-registry `.json` files (177) = **7,015 LOC** | Entirely `fxbot`-specific chatbot domain. |

### Option Comparison

| Criterion | Option A: Wrap `libfx` Directly in Thermite v1 | Option B: Carve Out & Publish `@fxbot/agent-core` First (Goal 260) | Option C (Recommended): Hybrid — Direct `packages/harness-libfx` Now, Shared Catalog Schema, Optional `@fxbot/providers` Later |
| --- | --- | --- | --- |
| **New / refactored LOC before Goal 1 ships** | ~750–900 LOC in Thermite (`harness-libfx` + provider/sign-in glue); **0 LOC in `fxbot`** | **~1,500–2,200 LOC** churn in `fxbot` (decouple Postgres, add build + npm publish + CI + tests + relax URL checks + add hooks/limits/Anthropic shim) + ~350 LOC in Thermite | **~750–900 LOC** in Thermite (`packages/harness-libfx` + thin provider store consuming `providers-registry.json` schema + ported 271 LOC OAuth helpers); **0 LOC blocking in `fxbot`** |
| **Blocks v1 cleanroom kickoff?** | No | **Yes** — Goal 1 stalls behind cross-repo refactor & CI buildout in `fxbot` | **No** — Goal 1 starts immediately |
| **Runtime fit** | Exact fit (`createFxEngine` + PG `Persistence`, hooks metering, LAN HTTP, Anthropic shim, limits) | Compromised — forces one loop wrapper to serve opposite lifecycles (lasting chatbot on Workflow World vs. stateless judged worker on NATS/Sans-I/O) | Exact fit in Thermite; `fxbot` stays unburdened by trial limits/metering |
| **`libfx` `0.0.x` upgrade risk** | Contained to one ~850 LOC package tested against scripted stand-ins in Thermite CI | **Double-blast radius** — every weekly `libfx` break requires release dance across `fxbot` → npm → Thermite, with no CI in `fxbot` today | Contained to `packages/harness-libfx` (exact pin + scripted stand-in suite); zero `libfx` types leak into `packages/core` |
| **Maintenance / duplication** | Re-implements ~270 LOC OAuth + ~150 LOC model-lister + catalog sync | Single copy of providers/sign-ins, but dual maintenance of core wrapper for two divergent products | Shares `providers-registry.json` format (can read `fxbot.sh/providers-registry.json` + local overrides); duplicates only ~270 LOC stable RFC-8628/PKCE OAuth code until an optional ~450 LOC zero-DB `@fxbot/providers` package makes sense |

**Verdict:** Choose **Option C (Hybrid)**. `libfx` itself is already the shared agent engine; wrapping `createFxEngine` directly inside Thermite's `packages/harness-libfx` costs ~850 LOC total, gives Thermite 100% control over metering, limits, LAN HTTP, Anthropic caching, and CI stand-in tests, and keeps Goal 1 unblocked. If/when `fxbot` adds CI and adopts `packages/design-system`, extract only the pure, zero-DB provider catalog + OAuth sign-in module (~450 LOC) — **never** couple the two products' agent-loop runtimes.

---

## 4. Exact `harness-*` Plugin Boundary (Zero Core Hacks)

v0.2 duplicated session setup across 5 call sites and two incompatible abstractions (in-process Pi vs. subprocess `CliProgram`), causing ~35 files to change per new harness ([Goal 255](../../goals/255-one-way-to-run-a-program.goal)). In v1, **every** role (worker, research worker, planner, advisor, model-check, future Thermy) invokes one `HarnessPlugin` contract registered via `PluginApi.registerHarness()` ([`sansio-nats-contract.md`](sansio-nats-contract.md#L282)).

### Minimal TypeScript Interface (`packages/core/src/plugin/harness.ts`)

```ts
export type AuthKind =
  | "api_key" | "gateway" | "chatgpt_plan" | "grok_plan"
  | "claude_subscription" | "local_http" | "service_account";

export type HarnessCapabilities = {
  readonly tools: "host_fn" | "mcp_or_cli";         // libfx/pi take TS fns; CLI harnesses use scoped loopback MCP/CLI
  readonly steering: "live" | "next_turn" | "none";
  readonly durableResume: boolean;                  // true for libfx (PG persistence), false/session-id for CLIs
  readonly interactiveTerminal: boolean;            // true only for PTY CLI harnesses (Claude Code, Agy, Codex)
  readonly compactionControl: "host" | "rollover" | "native_only";
  readonly supportsResearch: boolean;
};

export type HarnessTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly idempotent: boolean;
  readonly writes?: boolean;
  execute(input: unknown, ctx: { signal: AbortSignal; callId: string }): Promise<unknown>;
};

export type HarnessSessionSpec = {
  readonly sessionId: string;                       // stable across crash/resume
  readonly role: "worker" | "research" | "planner" | "advisor" | "check";
  readonly model: { id: string; effort?: string; contextWindow?: number; maxOutputTokens?: number };
  readonly provider: { id: string; authKind: AuthKind; baseUrl?: string; headers?: Record<string, string>;
                       apiShape: "openai_chat" | "openai_responses" | "anthropic_messages" | "gateway" | "plan" };
  readonly credentials: () => Promise<{ apiKey?: string; accessToken?: string; refreshToken?: string; accountId?: string; expiresAt?: number }>;
  readonly onCredentials?: (next: Record<string, unknown>) => Promise<void>;
  readonly instructions: string;
  readonly workspaceDir?: string;                   // control-plane worker zone path (for code roles)
  readonly tools: readonly HarnessTool[];           // used by tools:"host_fn" harnesses
  readonly toolBridge?: { mcpUrl: string; cliEnv: Record<string, string> }; // exact same handlers over loopback for CLIs
  readonly persistence?: {                          // opaque journal/checkpoint store (Postgres-backed by Control)
    load(): Promise<{ checkpoint?: { through: string; data: Uint8Array }; journal?: { cursor: string; data: Uint8Array }[] }>;
    append(rec: { expected: string | null; idempotencyKey: string; data: Uint8Array; barrier: boolean }): Promise<{ cursor: string }>;
    saveCheckpoint(cp: { through: string; data: Uint8Array }): Promise<void>;
  };
};

export type TurnLimits = { maxTurns?: number; maxTokens?: number; wallMs?: number; stallMs?: number };

export type ModelCallTelemetry = {
  readonly at: string; readonly calls: number | null;
  readonly tokensIn: number; readonly cachedIn: number | null; readonly cacheWriteIn: number | null;
  readonly tokensOut: number; readonly reasoning: number | null;
  readonly firstTokenMs: number | null; readonly callMs: number | null;
  readonly purpose: "agent" | "compaction" | "auxiliary";
};

export type HarnessEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start"; callId: string; name: string; inputPreview?: string }
  | { type: "tool_end"; callId: string; name: string; isError: boolean; outputPreview?: string }
  | { type: "model_usage"; usage: ModelCallTelemetry }
  | { type: "compacted"; summary?: string; tokensBefore?: number; tokensAfter?: number }
  | { type: "provider_wait"; untilIso: string; reason: string }
  | { type: "turn_end"; stopReason: "end_turn" | "cancelled" | "turns_limit" | "wall_limit" | "token_limit" | "context_full" | "error"; error?: string };

export interface HarnessSession {
  readonly sessionId: string;
  runTurn(input: string, opts?: { turnId?: string; resume?: boolean; limits?: TurnLimits; signal?: AbortSignal }): AsyncIterable<HarnessEvent>;
  steer(text: string, id?: string): Promise<{ id: string; mode: "live" | "queued" }>;
  cancel(reason?: "abort" | "handoff"): Promise<void>;
  compact?(opts?: { instructions?: string }): Promise<{ newSessionId?: string; summary: string }>;
  attachTerminal?(): { write(data: string | Uint8Array): void; resize(cols: number, rows: number): void; onData(cb: (d: Uint8Array) => void): () => void };
  close(): Promise<void>;
}

export interface HarnessPlugin {
  readonly id: string;                              // e.g. "libfx", "claude-code", "agy", "codex", "pi"
  readonly name: string;
  readonly version: string;
  readonly capabilities: HarnessCapabilities;
  supportsAuth(authKind: AuthKind): boolean;        // core routes provider -> eligible harnesses with zero hardcoded names
  openSession(spec: HarnessSessionSpec): Promise<HarnessSession>;
}
```

### How Built-in `libfx` and Future Plugins Fit One Seam (Zero Core Branches)

| Plugin (`harness-*`) | `tools` Mode | Auth Kinds Accepted | Steering | Resume | Terminal | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| **`harness-libfx`** *(bundled default)* | `host_fn` | `api_key`, `gateway`, `chatgpt_plan`, `grok_plan`, `local_http`, `service_account` | `live` (`turn.steer`) | PG `persistence` (`resume()`) | Watch stream only | Wraps `createFxEngine` + fetch middleware (LAN rewrite, Anthropic cache shim, SSE usage scanner, `stallGuard`, limits). |
| **`harness-claude`** *(plugin)* | `mcp_or_cli` | `claude_subscription` (+ optional `api_key`) | `live` (hook/PTY) | CLI `--resume` | PTY (`attachTerminal`) | Never shares subscription tokens with core/other harnesses; emits `model_usage` from transcript/result. |
| **`harness-agy`** *(plugin)* | `mcp_or_cli` | Agy account / configured providers | `live` / `next_turn` | Plugin session ID | Optional PTY | Plugs straight into `toolBridge` (loopback MCP/CLI) & emits normalized `HarnessEvent` stream. |
| **`harness-codex`** *(plugin)* | `mcp_or_cli` | `chatgpt_plan`, `api_key` (Responses) | `next_turn` / PTY | Thread ID | PTY | Optional for users preferring native Codex CLI over `libfx`'s built-in `provider: "codex"`. |
| **`harness-pi`** *(optional fallback plugin)* | `host_fn` | `api_key`, `chatgpt_plan`, `local_http` | `live` (`agent.steer`) | In-memory / checkpoint | Watch stream | Drop-in escape hatch if `libfx` hits a blocking upstream regression; zero core changes. |

**Mandatory conformance gate (from Goal 255):** Core ships one ~150 LOC contract test suite (against a local scripted HTTP/SSE stand-in) that every `HarnessPlugin` must pass: tool execution, streaming deltas, `steer()`, `cancel()`, `model_usage` (with cache/reasoning/TTFT), 429/401/stall handling, configured turn/wall limits, and crash-resume (when `durableResume: true`).

---

## 5. Open Owner Calls (Goal 0 Decisions)

1. **Direct Anthropic API key strategy for v1.0:** Ship the ~250 LOC `options.fetch` Chat-Completions-to-Messages caching translator inside `packages/harness-libfx` on day one (recovering ~85%+ prompt cache savings without requiring Vercel AI Gateway), or defer direct-key caching and tell Anthropic-key users to route via AI Gateway BYOK / `harness-claude` until upstream `libfx` adds native Messages API?  
   *Recommendation:* **Ship the ~250 LOC caching translator in v1.0** (caching is an order-of-magnitude cost driver on long hill-climb trials); keep thinking-signature preservation best-effort until upstream native support lands.
2. **Pin `libfx@0.0.16` (matching `fxbot@0.12.0`) vs. bump to `0.0.18` at Goal 1 start?** `0.0.17–0.0.18` cut native binary sizes by ~31–36%, improved Gateway prompt caching, and sped up session resumes, but introduced breaking CLI/config changes.  
   *Recommendation:* **Evaluate & pin `0.0.18` (latest) in Goal 1** against Thermite's scripted conformance suite before writing production code, since Thermite v1 starts clean with no legacy journals to migrate.
3. **Host-controlled compaction in v1.0 (`compactAt` rollover vs. `libfx`-only auto-compaction):** Build `fxbot`'s checkpoint-rollover compactor (~120 LOC) in v1.0 so campaigns can set custom `compactAt` thresholds and archive full transcripts, or rely solely on `libfx`'s built-in auto-compactor for v1.0 MVP and add rollover in v1.1?  
   *Recommendation:* **Start v1.0 MVP with `libfx` auto-compaction (metered via `hooks`) + 60 KiB tool truncation**, and add checkpoint-rollover only if real v1 campaigns hit context-quality regressions.
4. **Shared `@fxbot/providers` extraction timing:** Confirm **Option C (Hybrid)** — port the ~270 LOC pure OAuth helpers + sync `providers-registry.json` schema in Thermite v1 now so Goal 1 is zero-blocked, and revisit extracting a tiny zero-DB `@fxbot/providers` package only after `fxbot` adds CI and adopts `packages/design-system`.
