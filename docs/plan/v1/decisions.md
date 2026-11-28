# Thermite v1 — Goal 0 Decisions & Open Owner Calls

**Status:** Goal 0 locked (2026-11-28) — all 16 owner calls settled via `/grill-me`; ready to start Goal 1.  
**Inputs:** [Direction & Foundations](README.md) and 6 independently verified Goal 0 spikes under [`goal-0/`](README.md#9-goal-0-outputs-and-navigation).

---

## 1. Settled Direction (Owner-Locked)

- **Slim, minimum LOC to outcome:** simplest plain TypeScript that solves the problem; small single-job files, few dependencies, no classes/wrappers/speculative layers, delete before adding.
- **Thin core, features in plugins (`fxbot` model):** core holds *only* what every run needs and what plugins plug into; core never imports or names optional plugins; unused plugins cost zero processes, tables, timers, or UI bytes.
- **Shared plugin discipline & proof-based trust:** `fxbot`-aligned `plugin.json` (`"com.usethermite"`), `provide`/`need`, `plugin-breaks.json`, plugin-owned `plugin_<name>` Postgres schemas, owner-only install, wall isolation `selfTest()`, judge A/A calibration, and `{ judgePlugin, judgeVersion }` attribution on every verdict.
- **Agents propose; separate code judges:** measurement, verdicts, completion, and promotion stay structurally outside what a run's own worker/advisor agents can write, read, or load.
- **No default research caps:** no hidden turn, submission, time, or spend limits unless explicitly configured — only safety circuit breakers that pause broken infrastructure or oscillating loops.
- **NATS JetStream + Sans-I/O everywhere:** pure deterministic TypeScript core (`(state, event, now) => { state, effects }`) decoupled from network, database, process, and clock I/O; thin edge adapters handle NATS, PostgreSQL 18, HTTP/MCP, and OS processes.
- **Delete `rig` completely:** a **run** owns its agents, models, and compute share; **machines & devices** (`machine › device`) are a shared pool allocated whole, in turns, or shared. Control owns Door, Record, Agents, and Scheduler; machine runners are thin hardware-only NATS workers with no supervisor, no local ledger, and no model credentials.
- **`libfx` (`fx.sh`) core agent loop:** single built-in runtime behind one `harness-*` seam; external coding CLIs (**Claude Code**, **Agy**, Codex, Pi) ship as optional post-MVP `harness-*` plugins.
- **One surface parity (API/MCP-first) + shared UI library:** one typed `core/api` action registry auto-generates REST, MCP, typed client, CLI, and reference docs — zero API-only / UI-only / MCP-only splits. Thin React 19 / Vite / Tailwind 4 / Radix / Geist app (`packages/ui`) consumes only the typed client and shares `packages/design-system` with `fxbot` (`0.12.0`+).
- **Clarity-first UX:** warm-grey + flame brand, system light/dark, `390px` mobile, catalogue-driven provider setup (allowing LAN HTTP local-LM servers out of the box), and clean core nav (**Home / Needs you, Compute, Knowledge, Campaigns, Setup**; **Thermy** later as a plugin).
- **Configurable full owner delegation (no hardcoded owner-only walls):** `PolicyGrant` lets the owner delegate **100% end-to-end campaign operations** (including promotions, compute, settings, and closures) to an operator or external orchestrator agent, while internal run workers/advisors remain structurally walled from the Door and Judge.
- **Effortless onboarding & machine join:** `< 2 min` one-command install (`setup.sh` + host `thermite` CLI), 3-step first-run UI with bundled `matmul-cpu` sample, minimal 7–12 line `thermite.yaml`, and one-command `herdr`/`rex`-style `thermite join` over NATS.
- **Git auto-sync, built-in Live, WebRTC pairing & JSONL distillation:**
  - Configurable per-campaign Git auto-sync on champions + fast incremental `thermite pull <run>` (replacing giant export tarballs and manual `.patch` shuffling).
  - Built-in per-run `live` toggle projecting sanitized events onto NATS for `live-publish` / `thermite live` (replacing multi-agent folder-sync deployments).
  - Remote encrypted WebRTC pairing (`web-pairing` / `web.usethermite.com`) with zero VPN or port forwarding; first-class fine-tuning JSONL distillation (`distill-jsonl`) for redacted SFT, preference-pair, and trajectory exports.
- **v0.2 reliability lessons & lean repo checks:** Sans-I/O circuit breakers (`3` infra crashes, `5` identical invalid builds, first-class `rejudge`, `2` invalid planner epochs failover, `3`-round research `(decision, certainty)` oscillation freeze), host-proportional limits, `-pgid` timeout kills, interleaved A/B + B/A + GPU-drain checks, narrowed non-blocking approvals + auditor timeout, event-driven advisors injecting scoped `AVOID` directives, and `< 2 min` pre-commit checks (dropping `--lower` baseline ratchets, forced file-split traps, and CSS-ban tests).

---

## 2. Goal 0 Recommended Technical Foundations

### 2.1 NATS JetStream + Sans-I/O Core, Unified API, Policy & Plugins ([`goal-0/sansio-nats-contract.md`](goal-0/sansio-nats-contract.md))
- **3 JetStream streams + 2 ephemeral Core NATS subjects:**
  - `EVENTS` (`t.run.<run>.ev.<kind>`, `t.run.<run>.attempt.<stage>`, `t.run.<run>.need.<state>`, `t.machine.<machine>.ev.<kind>` — `O(runs)` subject cardinality, `s2`, `discard: new`, `max_age: 0`).
  - `JOBS` (`t.machine.<machine>.job.{dispatch,result}` — `workqueue`, `< 1 MiB` payloads, Control authenticated Git-HTTP commit fetch, `7d` dedup).
  - `LIVE` (`t.run.<run>.live.<source>`, `t.machine.<machine>.job.<job>.live`, `t.need.<need>.live`, `t.live.<run>.<channel>` — 1 h / 256 MiB rolling; `t.live.<run>.>` populated only when `run.live === true`).
  - Core NATS: `t.machine.<machine>.hb` (5 s heartbeats) and `t.machine.<machine>.cancel` (`-pgid` kill). Ed25519 NKey principals across two NATS accounts enforce strict isolation (`THERMITE`: `control`, `runner:<m>`, `live-reader`, `backup`; `SYS`: `system`).
- **Four minimal contracts in `packages/core`:** pure `reduce(state, event, now)` (`21` core `DomainEvent`s, `8` `Effect`s, zero I/O imports); `core/api` `ActionDef` registry generating REST, policy-filtered MCP, typed `fetch` client, CLI, and docs; `PolicyGrant` profiles (`viewer`, `operator`, `autonomous_delegate`, `owner`); and `fxbot`-aligned `PluginApi` (`provide`/`need`, `onEvent`, `registerActions`, `route`, `socket`, `callAction`, `register{Harness,Device,Compute,Wall,Judge}`, `postgres.js` `PluginSql`).

### 2.2 `libfx` Agent Loop, Packaging & `harness-*` Seam ([`goal-0/libfx-audit.md`](goal-0/libfx-audit.md))
- **Runtime & Option C (Hybrid) packaging:** drive `libfx` via **`createFxEngine({ persistence })`** (~120 LOC Postgres journal/checkpoint adapter + NATS `LIVE` stream), avoiding `createFxAgent` / `@workflow/world-postgres`. Wrap `libfx` inside Thermite (`packages/harness-libfx`, ~750–900 LOC) + port ~271 LOC pure OAuth helpers + consume `fxbot`'s `providers-registry.json` schema; do **not** block Goal 1 on extracting `@fxbot/agent-core` from `fxbot`'s 9,112-LOC DB-coupled SDK.
- **Close 5 verified `libfx@0.0.16` edge gaps (~500 LOC in `options.fetch` + `hooks`):** synthetic-loopback LAN HTTP rewrite (~15 LOC); `hooks.onEvent` TTFT/call-ms + ~60 LOC SSE usage scanner (fixes dropped `cached_tokens`/`cache_write_tokens`/`reasoning_tokens` on custom providers); ~250 LOC Anthropic Chat-Completions-to-Messages caching translator + `reasoning_effort` injection; synchronous turn/token/wall limits + `stallGuard`; and 60 KiB UTF-8 host tool truncation (avoids `libfx`'s 64 KiB hard fail).
- **One `HarnessPlugin` / `HarnessSession` contract (`packages/core/src/plugin/harness.ts`):** gated by one ~150 LOC scripted HTTP/SSE conformance suite shared by `harness-libfx` and later `harness-claude`/`agy`/`codex`/`pi`.

### 2.3 Shared Design System Sync ([`goal-0/design-system-sync.md`](goal-0/design-system-sync.md))
- **One workspace package (`packages/design-system/`), source-exported `.ts`/`.tsx`:** move to root npm workspaces (deleting `web/package-lock.json` and `scripts/design-system/link.mjs`) with clean subpath exports (`./primitives`, `./parts`, `./chat`, `./providers`, `./provider-logos`, `./editor`, `./theme/*`) and optional peer deps (`9` `prosemirror-*`, `streamdown`, `@shadcn/react`, `qrcode-generator`) so unused modules cost `0 KB`.
- **Brand-vs-semantic split & `fxbot` `0.12.0` sync:** split `theme.css` into `theme/base.css` (20 semantic status tokens + `.gutter`/`[data-beside]`/`.plugin-icon`) + thin presets (`src/theme/presets/thermite.css` ~70 LOC, `src/theme/presets/fxbot.css` ~45 LOC); de-brand 8 Thermite part files (`brand`/`art` props); sync 17 stock `radix-nova` primitives (12 core + 5 chat/trace; 26 total), `ResizeGutter`/`BesidePanel`/`SettingsShell`/`ResponsiveDialog`/`ModelCombobox`/`TraceSteps`, and Vite `lucideIcons()`.
- **Replace CSS-ban bureaucracy:** delete `tests/web/design-system.test.ts`, `tests/web/brand.test.ts`, and `design-door`/`design-own` import rules; keep workspace `tsc --noEmit` + one ~25-LOC boundary/token-parity check.

### 2.4 Knowledge Architecture ([`goal-0/knowledge-research.md`](goal-0/knowledge-research.md))
- **Two-layer PostgreSQL 18 stack (do NOT port `v0.2`'s 11,580-LOC / 67-file synchronous SQLite KB):**
  - **Core (~900–1,100 LOC, zero extra services):** normalized `kb_collections`/`kb_items`/`kb_versions`/`kb_chunks`/`kb_blobs`/`kb_links`/`kb_grants`/`kb_run_scopes`; content-addressed blobs (zero text duplication); async NATS-driven heading-aware parent-child chunker; dual `tsvector` (`english` + `simple`) + `pg_trgm`; O(1) empty-scope `< 1 ms` short-circuit; pooled async PG (`max >= 8`); pure Sans-I/O query parser + RRF (`packages/core/src/plugin/kb.ts`).
  - **Default semantic plugin `knowledge-semantic` (~450–650 LOC):** `pgvector` 0.8+ partial `halfvec` HNSW per `(model, dims)` + `hnsw.iterative_scan = 'relaxed_order'`, async batch embedder (`off | remote | local` `llama.cpp` `EmbeddingGemma 2`/`Qwen3-Embedding`), running on one PG image (`pgvector/pgvector:0.8.x-pg18-trixie`, PG-licensed; never AGPLv3 `pg_search`). Validate via a 1-day 60-needle / 30k & 150k-chunk benchmark before coding; defer `knowledge-bm25` (`pg_textsearch`), `knowledge-ingest-pdf`, `knowledge-contextual`, and `knowledge-graph` to optional plugins.

### 2.5 Control-Plane Isolation *(Exploration Verdict — NOT an Imposed Directive)* ([`goal-0/wasm-isolation-spike.md`](goal-0/wasm-isolation-spike.md))
- **NO-GO for full agent zones inside V8 isolates or WASM:** `libfx`'s native N-API addon cannot load in isolates/WASM; `fx-core.wasm` requires WebAssembly JSPI (`LIBFX_JSPI_UNAVAILABLE` on Node 22 LTS / V8 12.4); `isomorphic-git` + `memfs` stalls/OOMs on large C++/Zig/Rust repos; external CLIs (`claude`, `agy`) cannot run in isolates/WASM.
- **Conditional GO for zero-container Control:** keep `libfx` (native N-API, built-in shell/FS off) + sealed secrets on host Node and isolate untrusted tools/CLIs behind **`WallPlugin`** (`registerWall` + active `selfTest()`): **Tier 1 `wall-tools`** (path-jailed `git worktree` + structured file tools, zero OS shell), **Tier 2 `wall-os`** (Linux `bwrap`+Landlock+seccomp / macOS `Seatbelt` + host egress proxy), and optional **Tier 3 plugins** (`wall-container` rootless Podman/Docker; post-MVP `wall-microsandbox` on `libkrun`). Compute runners stay bare metal / VM / container (`wall-container` default in `v1.0`).

### 2.6 Onboarding, Machine Join, Campaign DX & `v1.0` Cut Line ([`goal-0/onboarding-and-mvp.md`](goal-0/onboarding-and-mvp.md))
- **Install & join:** `curl -fsSL https://usethermite.com/setup.sh | sudo bash` (`< 2 min`) deploys a 3-service Compose stack (`control`, `nats`, `db`, ~55 lines vs. v0.2's 547) + host `thermite-runner.service`, systemd boot + `thermite-control.path` atomic rollback updates, and a 3-step first-run UI with bundled 60 s `matmul-cpu`. `thermite join <url> --token <tok>` enrolls any remote machine in `~30 s` (non-destructive preflight before token burn, `device-*` probe, Ed25519 NKey, TLS `:4222` + `wss://<control>/nats`).
- **Cleanroom `v1.0` cut (~10–15k LOC vs. v0.2's ~220k LOC):** dedicated `v1` branch (`main` stays `v0.2.x`); ships hill-climb + goal + research on `libfx` + NATS Sans-I/O + `device-cpu`/`device-cuda` + unified API/MCP/CLI + core UI + core PG 18 FTS Knowledge + bundled `git-sync` (`push | tag | none`). External harnesses, macOS Metal/Vulkan/ROCm, cloud/cluster compute, `web-pairing`, `live-publish`, `distill-jsonl`, `knowledge-semantic`, `thermy`, and `sql-explorer` ship as post-MVP plugins.

---

## 3. Owner Calls — All 16 Locked (2026-11-28)

All 27 open questions across the 6 spikes were deduplicated into **16 decisions** and locked by the owner on `2026-11-28`.

### Core, Repo & Data Stack

1. **`[Decided]` Cleanroom git home** ([`onboarding-and-mvp.md`](goal-0/onboarding-and-mvp.md#open-owner-calls-decide-before-goal-1))
   - *Decision:* **Dedicated `v1` branch in this repo** — preserves `packages/design-system/`, `docs/plan/v1/`, `LICENSE`, `SECURITY.md`, `CREDITS.md`, `.gitleaks.toml`, and `scripts/checks/public.mjs`; `main` stays `v0.2.x` until `v1.0.0` `-s ours` cutover.

2. **`[Decided]` PostgreSQL driver & default PG 18 image** ([`sansio-nats-contract.md`](goal-0/sansio-nats-contract.md#6-open-owner-calls-goal-0-decisions), [`knowledge-research.md`](goal-0/knowledge-research.md#7-open-owner-calls-4-crisp-decisions))
   - *Decision:* **`postgres.js` + `pgvector/pgvector:0.8.x-pg18-trixie`** — verbatim `fxbot` plugin-API parity, zero overhead when `vector` is off, and zero DB image swap when enabling `knowledge-semantic`.

3. **`[Decided]` `libfx` pin version & Option C hybrid packaging** ([`libfx-audit.md`](goal-0/libfx-audit.md#5-open-owner-calls-goal-0-decisions))
   - *Decision:* **Option C Hybrid + evaluate/pin `libfx@0.0.18` in Goal 1** — wrap `libfx` directly in `packages/harness-libfx`, sync `fxbot`'s `providers-registry.json` + ~271 LOC pure OAuth helpers, and do not block Goal 1 on extracting `@fxbot/agent-core`.

4. **`[Decided]` Direct Anthropic caching shim & compaction scope in `v1.0`** ([`libfx-audit.md`](goal-0/libfx-audit.md#5-open-owner-calls-goal-0-decisions))
   - *Decision:* **Ship the ~250 LOC Anthropic Messages caching/thinking translator in `v1.0`** (85%+ token savings on API keys) + `libfx` auto-compaction (metered via `hooks`) & 60 KiB tool cap; **defer custom `compactAt` rollover** until needed.

### Control-Plane Isolation & Runners

5. **`[Decided]` Control-plane default wall & virtual bash** ([`wasm-isolation-spike.md`](goal-0/wasm-isolation-spike.md#open-owner-calls))
   - *Decision:* **Ship `wall-tools` (zero-dep shell-free default) WITH virtual bash (`bashkit-wasm`/`just-bash`) + `wall-os` (opt-in OS sandbox for local shell / external CLI harnesses) in `v1.0`**, so shell-free workers still get piped `grep`/`awk`/`sed` locally.

6. **`[Decided]` `wall-os` OS coverage & `wall-microsandbox` timing** ([`wasm-isolation-spike.md`](goal-0/wasm-isolation-spike.md#open-owner-calls))
   - *Decision:* **Include `wall-microsandbox` (`libkrun` microVM) in `v1.0` day one** alongside `wall-os` (Linux `bwrap`+Landlock+seccomp / macOS `Seatbelt` + `wall-container` fallback when `/dev/kvm` is absent) for hardware-virtualized isolation from launch.

7. **`[Decided]` Runner networking & Git artifact delivery** ([`onboarding-and-mvp.md`](goal-0/onboarding-and-mvp.md#open-owner-calls-decide-before-goal-1), [`sansio-nats-contract.md`](goal-0/sansio-nats-contract.md#6-open-owner-calls-goal-0-decisions))
   - *Decision:* **Ship `wss://<control>/nats` (proxied on `:8800`) alongside direct TLS `:4222` + authenticated Git-HTTP commit fetch in `v1.0`**; keep NATS leaf/Object-Store blobs optional inside `compute-*` plugins.

8. **`[Decided]` Native macOS runner (`launchd` + `device-metal`) timing** ([`onboarding-and-mvp.md`](goal-0/onboarding-and-mvp.md#open-owner-calls-decide-before-goal-1))
   - *Decision:* **Pull `launchd` + `device-metal` (Apple Silicon / MLX) into `v1.0` day one** so Apple Silicon MLX campaigns run natively from launch without waiting for `v1.1`.

### Policy, Plugins & Git Sync

9. **`[Decided]` `git-sync` placement & `git.onChampion: pr` timing** ([`sansio-nats-contract.md`](goal-0/sansio-nats-contract.md#6-open-owner-calls-goal-0-decisions), [`onboarding-and-mvp.md`](goal-0/onboarding-and-mvp.md#open-owner-calls-decide-before-goal-1))
   - *Decision:* **Bundled default-on `git-sync` plugin on `PluginApi` supporting all four modes (`push | pr | tag | none`, GitHub PRs first) in `v1.0` day one** (dogfoods `PluginApi` and delivers PR sync at launch).

10. **`[Decided]` First-run loopback auth & `autonomous_delegate` ceiling** ([`onboarding-and-mvp.md`](goal-0/onboarding-and-mvp.md#open-owner-calls-decide-before-goal-1), [`sansio-nats-contract.md`](goal-0/sansio-nats-contract.md#6-open-owner-calls-goal-0-decisions))
    - *Decision:* **Step 1 owner account (username + password cookie, plus optional `THERMITE_NO_AUTH_LOOPBACK=1` for dev)**, with `autonomous_delegate` granting 100% campaign/promotion/compute/settings/`terminal:input` + installed campaign plugin actions and excluding only `plugins:manage` & `tokens:manage` by default (still grantable via custom `PolicyGrant`).

11. **`[Decided]` Third-party `registerJudge` execution model** ([`sansio-nats-contract.md`](goal-0/sansio-nats-contract.md#6-open-owner-calls-goal-0-decisions))
    - *Decision:* **In-process for `v1.0`** (gated by owner-only `plugins:manage` + A/A calibration proof + `{ judgePlugin, judgeVersion }` verdict attribution); add optional subprocess isolation later if needed.

### Knowledge & Shared UI Library

12. **`[Decided]` Knowledge default embedder profile** ([`knowledge-research.md`](goal-0/knowledge-research.md#7-open-owner-calls-4-crisp-decisions))
    - *Decision:* **Core PG 18 FTS + `pg_trgm` default (`embedder: off` on minimal install)** with a 1-click UI toggle / `--with-semantic` flag to enable `knowledge-semantic` (`local` ~450 MB or `remote`).

13. **`[Decided]` Knowledge scope: compaction transcripts & shared collections** ([`knowledge-research.md`](goal-0/knowledge-research.md#7-open-owner-calls-4-crisp-decisions))
    - *Decision:* **Exclude compaction transcripts from default `kb_search`** (browsable by kind / `include_transcripts: true`) and **support `kind: 'campaign' | 'shared'` collections in Core schema from day one (~15 LOC)**.

14. **`[Decided]` Shared UI package name & per-preset typography/control scale** ([`design-system-sync.md`](goal-0/design-system-sync.md#5-open-owner-calls))
    - *Decision:* **Workspace package name `@iammrduncan/magnesium`** (design system name: **Magnesium**, inside `packages/design-system/`, to be adopted later by `fxbot` in place of its own) + **per-preset CSS variables** (`thermite.css` keeps `--font-weight-medium: 600` & `36px`/`h-9`; `fxbot.css` keeps `500` & `32px`/`h-8`).

15. **`[Decided]` Provider logos bundle (`./provider-logos`, 183 SVGs / 274 KB)** ([`design-system-sync.md`](goal-0/design-system-sync.md#5-open-owner-calls))
    - *Decision:* **Include lazy-loaded `./provider-logos` chunk in `@iammrduncan/magnesium`** with full `CREDITS.md` + `licenses-styles.md` attribution.

16. **`[Decided]` PWA (`VitePWA`) timing & gallery deployment** ([`design-system-sync.md`](goal-0/design-system-sync.md#5-open-owner-calls))
    - *Decision:* **Inline splash + safe-area insets + `interactive-widget=resizes-content` in `v1.0`**, **`VitePWA` with `web-pairing` (`v1.2`)**, and **dev-only Magnesium gallery (`npm run design:dev`, not served by production Control)**.
