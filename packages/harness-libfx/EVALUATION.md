# `libfx@0.0.18` Live Evaluation (`0.0.16` Baseline vs `0.0.18`)

**Date:** 2026-11-28  
**Environment:** Node.js `v22.23.4` (`linux-x64`), native N-API addon (`@libfx/libfx-linux-x64-gnu`), zero external network calls (in-process scripted `fetch` probes).  
**Decision:** **Pin exact `"libfx": "0.0.18"`** in `packages/harness-libfx/package.json`. Zero Node 22 / N-API regressions; two concrete improvements directly benefit Goal 4 (`reasoningEfforts` on custom providers and native OpenAI nested usage parsing).

---

## 1. Artifact Sizes & Package Surface Delta

| Artifact / Surface | `libfx@0.0.16` | `libfx@0.0.18` | Delta |
| --- | --- | --- | --- |
| `@libfx/libfx-linux-x64-gnu/libfx.node` | `9,077,152` B (`8.66 MiB`) | `8,781,544` B (`8.37 MiB`) | `-295,608` B (`-3.26%`) |
| `libfx/fx-core.wasm` | `2,260,477` B (`2.16 MiB`) | `2,491,311` B (`2.38 MiB`) | `+230,834` B (`+10.21%`) |
| `libfx/fx-term.wasm` | `3,554,437` B (`3.39 MiB`) | `4,292,229` B (`4.09 MiB`) | `+737,792` B (`+20.76%`) |
| `libfxApiVersion` / `fxSdkApiVersion` | `3` / `2` | `3` / `2` | Unchanged |
| `getBackendInfo({ surface: "agent" })` | `native` (`supportsJspi: false`) | `native` (`supportsJspi: false`) | Unchanged |
| `engine.js` | Identical | Identical | `0` diff lines |
| `node.js` + `fetch-cleanup.js` | `startCoreFetchResponse` | Adds `startCoreFetchResponseWithRetryAfter` (`Retry-After` integer seconds) | Additive |
| `custom-provider.js` + `types/libfx.d.cts` | `{ name, baseUrl, models }` with 4 model fields | Adds `modelDefaults`, `titleModel`, `visionModel`, and per-model `outputLimitField`, `request`, `reasoningEfforts` | Additive |
| `types/libfx.d.cts` (`FxStopReason`, `FxEngineEvent`, `FxHookEvent`) | No `"yielded"` in `FxStopReason`; `journal.append` lacked `barrier` | `FxStopReason` adds `"yielded"`; `journal.append` adds `barrier: boolean`; `delegation` removes `"yielded"` | Additive / minor narrowing on `FxTurnResult.stopReason` |

---

## 2. Eight-Dimension Live Probe Comparison

Every probe executed both `libfx@0.0.16` and `libfx@0.0.18` in-process against the same scripted SSE mock `fetch`.

| # | Evaluation Dimension | `libfx@0.0.16` (Baseline) | `libfx@0.0.18` (Live Probe) | Impact on Goal 4 (`harness-libfx`) |
| --- | --- | --- | --- | --- |
| **1** | **`createFxEngine({ persistence })` API surface** (`load`, `append`, `FxFencedError`, `saveCheckpoint`, `resume`, `steer`, `cancel`) | Passes cleanly; live `steer()` injects `user_message` into next model call; `cancel()` ends `"cancelled"`. | Identical runtime contract; zero breaking changes (`engine.js` unchanged). `journal.append` diagnostic adds `barrier: boolean`. | **Keep** `createFxEngine({ persistence })` design verbatim. |
| **2** | **Custom provider protocol** | `custom-provider.js` hardcodes `protocol: "openai-chat-completions"`; rejects `protocol` field with `TypeError`. | **Unchanged in public JS/TS API:** `custom-provider.js:124` still hardcodes `"openai-chat-completions"` and throws `TypeError: a custom provider has unknown field protocol`. *(Core binary added internal CLI validation text naming `anthropic-messages`, but `v1/messages` and `cache_control` are absent and unexposed.)* | **Keep** ~250 LOC Anthropic Chat-Completions-to-Messages translator (Decision #4). |
| **3** | **Custom provider `effort`** | `model: { id, effort: "high" }` always throws `LIBFX_MODEL_UNSUPPORTED_EFFORT`; `reasoningEfforts` rejected with `TypeError`. | **Fixed natively when model is listed:** `provider.models[id].reasoningEfforts` validates `model: { id, effort: "high" }` and emits `reasoning_effort: "high"` (plus `request` and `outputLimitField: "max_completion_tokens"`). **Gotcha:** `modelDefaults.reasoningEfforts` only takes effect if `id` is present in `provider.models` (even as `{}`); unlisted models still throw `LIBFX_MODEL_UNSUPPORTED_EFFORT`. | **Retire** OpenAI-compat `reasoning_effort` body-injection fetch shim; populate `provider.models[id].reasoningEfforts` instead. |
| **4** | **`hooks.onEvent` TTFT / `call_ms` & custom-provider usage** | TTFT (`model.output_start - model.start`) and `call_ms` (`model.end - model.start`) accurate. **All** 5 usage shapes emitted `null` for `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens`. | TTFT (`41 ms` for `40 ms` delay) and `call_ms` (`71 ms` for `40+30 ms`) accurate; `delta.reasoning_content` → `reasoning_delta`. **Partial fix:** OpenAI nested `prompt_tokens_details.cached_tokens` (`700`) and `completion_tokens_details.reasoning_tokens` (`80`) now parse natively! **Still `null`:** `cacheWriteTokens` across **all** shapes, plus flat/DeepSeek/OpenRouter/Anthropic-compat fields (`cache_read_tokens`, `cached_tokens`, `prompt_cache_hit_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, flat `reasoning_tokens`, `input_tokens_details`, `output_tokens_details`). | **Keep** ~60 LOC SSE usage scanner in `options.fetch` to recover `cacheWriteTokens` and non-OpenAI-nested provider shapes. |
| **5** | **Synthetic loopback LAN HTTP rewrite** | Non-loopback `http://192.0.2.10:8080/v1` throws `TypeError`; `http://127.0.0.1/thermite-route/<id>` rewritten in `options.fetch` works for authed and keyless servers. | **Identical & verified clean:** `TypeError` on direct non-loopback HTTP; synthetic loopback rewrite preserves `Authorization: Bearer …` when `credentials` is set and omits `authorization` when keyless. | **Shipped** in Goal 1 (`createLoopbackRouteFetch` in `src/index.ts`). |
| **6** | **Host tool execution** (>64 KiB cap, serialization, arg coercion) | `61,440` B & `65,536` B succeed; `65,537` B & `71,680` B fail (`isError: true`, `"Host tool result exceeded the configured limit"`). `{ writes: true, idempotent: false }` serializes (`maxActive: 1`); `{ writes: false, idempotent: true }` runs in parallel (`maxActive: 2`). Stringified `"1"` stayed `string`. | Exact same `65,536` B hard limit (`65,537` B fails with identical error) and exact same serialization/parallelism semantics. **Bonus:** JSON-text arguments (e.g. `"1"` for `type: "integer"`) are now coerced to typed values (`number`). | **Keep** 60 KiB (`61,440` B) UTF-8 host tool cap + overflow file pointer in Goal 4. |
| **7** | **Turn/token/wall gating & HTTP status handling** | Synchronous turn limit in `options.fetch` + `AbortController` stops with 0 wasted extra calls (`stopReason: "cancelled"`). | Verified all three: turn limit (`maxCalls=2` → `2` calls), token limit (`maxTokens=500` → `1` call), wall limit (`AbortSignal.timeout(40)` → `41 ms`). HTTP `401`/`402`/`403` stop immediately after `1` call with `stopReason: "refused"`; HTTP `429` (now honoring integer `Retry-After`) and `500` retry until aborted. | **Keep** `options.fetch` budget gates, `stallGuard`, and bounded 429/500 retry guard in Goal 4. |
| **8** | **Crash-resume persistence & `FxFencedError` fencing** | `load`/`append`/`saveCheckpoint` + `cancel({ reason: "handoff" })` + `resume()` completes with 0 duplicate tool runs; stale `FxFencedError` stops turn with `FX_JOURNAL_APPEND_FAILED` (`cause: FxFencedError`, `cause.code: "FX_FENCED"`) and hook `journal.error { fenced: true }`. | **Identical & verified clean:** `checkpointAfterBytes: 1` triggers `saveCheckpoint`, fresh engine resumes open turn from persisted tool result without re-running the tool, and stale writers fail cleanly with `cause instanceof FxFencedError` + `journal.error { fenced: true }`. | **Shipped** in-memory contract (`createInMemoryPersistence`) for Goal 4 tests; PG adapter follows same contract. |

---

## 3. Goal 4 Shim Scorecard (`libfx@0.0.18`)

- **Retired by `0.0.18`:**
  - OpenAI-compatible `reasoning_effort` body injection in `options.fetch` (replaced by `provider.models[modelId].reasoningEfforts`, always listing `modelId` in `provider.models`).
- **Still required in Goal 4:**
  1. **Anthropic Messages translator (~250 LOC)** — direct API-key prompt caching (`cache_control: { type: "ephemeral" }`) and `thinking` blocks.
  2. **SSE usage scanner (~60 LOC)** — fills `cacheWriteTokens` (still `null`) and non-OpenAI-nested `cache_read` / `reasoning` fields.
  3. **60 KiB UTF-8 host tool cap + overflow pointer** — prevents `libfx`'s `65,537`-byte hard error.
  4. **Synchronous turn/token/wall gates + `stallGuard` + bounded 429/500 retry** — guards indefinite upstream retries and enforces configured run budgets with zero wasted calls.
  5. **Synthetic-loopback LAN HTTP rewriter** — already implemented and tested in `packages/harness-libfx/src/index.ts` (`createLoopbackRouteFetch`).
