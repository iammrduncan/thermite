# Thermite v1 — Execution Roadmap (Goals 1–14)

**Status:** Goal 0 locked (2026-11-28) — all 16 owner decisions applied from [`decisions.md`](decisions.md); ready to execute Goal 1.  
**Discipline:** Thin core + `fxbot`-style plugins, pure Sans-I/O core reducers, unified `core/api` surface parity, and `< 2 min` pre-commit checks. `v1.0` MVP targets **~12–16.5k LOC** total (~14x smaller than `v0.2`'s ~220k LOC, including day-one `wall-microsandbox`, `device-metal`/MLX, virtual bash in `wall-tools`, and `git-sync` PRs); every later capability lands strictly as an optional plugin with zero core bloat.

---

## Release Map at a Glance

| Wave | Goals | Theme | Est. New LOC |
| --- | --- | --- | --- |
| **`v1.0` MVP** | Goals 1–8 | Cleanroom `v1` workspace + `@iammrduncan/magnesium`, NATS + Sans-I/O core, Control + thin runner (`device-cpu`/`cuda`/`metal` + `launchd`), `harness-libfx` + `wall-tools` (w/ virtual bash) / `wall-os` / `wall-microsandbox`, hill-climb/goal/research + `git-sync` (`push`/`pr`/`tag`/`none`), PG 18 FTS Knowledge, CLI + UI, `setup.sh` + `v1.0.0` cutover | **~12.0k–16.2k** |
| **`v1.1` Plugins** | Goals 9–10 | `harness-claude`, `harness-agy`, `harness-codex`/`pi`, `device-vulkan`/`rocm`, `compute-ssh`/`k8s`/`runpod`, `git-sync` GitLab/Gitea PRs | ~2.0k–3.1k *(plugins)* |
| **`v1.2` Plugins** | Goals 11–13 | `web-pairing` (`web.usethermite.com`) + PWA, `live-publish` (`thermite live`), `distill-jsonl`, `knowledge-semantic` (`pgvector`) + optional `knowledge-bm25`/`ingest-pdf` | ~2.6k–3.9k *(plugins)* |
| **`v1.3` Plugins** | Goal 14 | `thermy` operator copilot, read-only `sql-explorer`, `⌘K` search & custom advisor/judge packs | ~1.2k–1.8k *(plugins)* |

---

## Wave 1: `v1.0` Cleanroom MVP (~12.0k–16.2k LOC)

### Goal 1 — Cleanroom `v1` Workspace, Lean Checks & `@iammrduncan/magnesium` Sync
- **Depends on:** Goal 0 locked decisions ([`decisions.md`](decisions.md))
- **Est. LOC / Size:** ~600–900 LOC new scaffold/sync *(preserves `packages/design-system/`, `docs/plan/v1/`, `scripts/checks/public.mjs`)*
- **Scope:**
  - Branch `v1` from `main`; remove `v0.2` `src/`, `web/`, `tests/`, `kits/`, `containers/`, and ratchet baselines (`size-baseline.json`, `import-exceptions.json`, `loose-ends.json`); scaffold root npm workspaces `packages/{core,control,runner,cli,ui,design-system}` (`@iammrduncan/magnesium`) plus `packages/harness-libfx` (Option C, evaluating/pinning `libfx@0.0.18`) + `deploy/compose.dev.yaml` (NATS + `pgvector/pgvector:0.8.x-pg18-trixie`).
  - Wire `< 2 min` pre-commit checks (`typecheck`, Biome `lint` + `noFloatingPromises`, `check:public`, fast Node tests, conditional `build:ui`); delete `link.mjs`, `web/package-lock.json`, and CSS-ban tests.
  - Complete the `@iammrduncan/magnesium` pre-screen sync ([`goal-0/design-system-sync.md`](goal-0/design-system-sync.md)): split `theme/base.css` + `src/theme/presets/{thermite,fxbot}.css` (per-preset weight/height scales), de-brand 8 part files (`brand`/`art` props), sync 17 `fxbot` `radix-nova` primitives + `ResizeGutter`/`BesidePanel`/`SettingsShell`/`ResponsiveDialog`/`ModelCombobox`/`TraceSteps` + lazy `./provider-logos` (183 MIT SVGs), keep gallery dev-only (`npm run design:dev`), add `lucideIcons()` Vite plugin and ~25-LOC boundary/token-parity check.
- **Done when:** `npm run check` passes in `< 60s` on `v1`; `packages/design-system/site/` (`npm run design:dev`) renders both `thermite.css` and `fxbot.css` presets in light/dark at `1440px` and `390px`; `public.mjs` reports 0 hits.

### Goal 2 — Sans-I/O Core, NATS Bus Contract, Unified `core/api` & Policy
- **Depends on:** Goal 1
- **Est. LOC / Size:** ~2,000–2,600 LOC (`packages/core`)
- **Scope:**
  - Pure Sans-I/O reducer (`packages/core/src/machine/`, zero `node:*`/DB/NATS/clock imports): 21 core `DomainEvent`s, 8 `Effect`s, run/scheduler/judge/research lifecycles, and all reliability breakers (`3` infra crashes, `5` identical invalid builds, first-class `rejudge`, `2` invalid planner epochs failover, `3`-round research `(decision, certainty)` oscillation freeze, narrowed non-blocking approvals + auditor timeout, event-driven advisors + `ScopedDirective` / `AVOID` carve-outs).
  - NATS JetStream subject/NKey contract (`packages/core/src/bus/`): `EVENTS`, `JOBS`, `LIVE`, ephemeral `t.machine.<m>.{hb,cancel}`, and least-privilege NKey principal templates across two NATS accounts (`THERMITE`: `control`, `runner:<m>`, `live-reader`, `backup`; `SYS`: `system`).
  - Single typed `core/api` `ActionDef` registry + browser-safe `core/client.ts` + `PolicyGrant` evaluator (`viewer`, `operator`, `autonomous_delegate`, `owner` — zero hardcoded `OWNER_ONLY_KINDS`).
  - `fxbot`-aligned plugin contract (`packages/core/src/plugin/`: `plugin.json` `"com.usethermite"`, `provide`/`need`, `plugin-breaks.json` `unfit()`, `PluginApi`, `HarnessPlugin`, `WallPlugin`, `KbPluginHooks`).
- **Done when:** Pure reducer tests prove all 7 reliability breakers, deterministic replay, and delegation boundaries (including worker/advisor Door isolation) in `< 1s`; every `ActionDef` compiles to JSON Schema and round-trips through the shared door executor.

### Goal 3 — Control Plane Backbone (PG 18 Record, Door) & Thin Runner (`thermite join`)
- **Depends on:** Goal 2
- **Est. LOC / Size:** ~2,500–3,200 LOC (`packages/control`, `packages/runner`)
- **Scope:**
  - Control Record & NATS adapters: single-writer `EVENTS` → PostgreSQL 18 (`postgres.js` + `plugin_<name>` schemas), JetStream stream/NKey provisioning + `$SYS` reload, authenticated Git-HTTP mirror endpoint, and `wss://<control>/nats` proxy on `:8800`.
  - Control Door: REST + policy-filtered MCP (`tools/list` scoped to `PolicyGrant`), owner account session auth + `PolicyGrant` token CRUD, sealed secrets (`secret.key`).
  - Hardware-only `packages/runner` + `thermite join <url> --token <tok>` (Linux `systemd` + native macOS `launchd`): non-destructive preflight before token burn, Ed25519 NKey enrollment (`POST /v1/machines/enroll`), TLS `:4222` + WSS fallback, `device-cpu`, `device-cuda`, and **`device-metal` (Apple Silicon / MLX)** plugins, `wall-container` + active `selfTest()`, `-pgid` timeout kills, and 5s heartbeats (`t.machine.<m>.hb`).
- **Done when:** One `thermite join` enrolls a Linux or macOS runner (`device-cpu`/`cuda`/`metal`), passes `wall.selfTest()`, runs a `JOBS` build/measure job via Git-HTTP fetch, streams `LIVE` output, cleanly kills timed-out process groups (`-pgid`), and survives NATS/runner restarts without duplicate execution.

### Goal 4 — `harness-libfx` Loop, Provider Catalog & Control-Plane Walls (`wall-tools`, `wall-os`, `wall-microsandbox`)
- **Depends on:** Goal 2, Goal 3
- **Est. LOC / Size:** ~2,100–2,800 LOC (`packages/harness-libfx`, `packages/control` walls/providers)
- **Scope:**
  - `packages/harness-libfx` (~750–900 LOC per [`goal-0/libfx-audit.md`](goal-0/libfx-audit.md), pinned to `libfx@0.0.18` if conformance passes): `createFxEngine({ persistence })` on Postgres journal/checkpoint tables (`FxFencedError` fencing) + NATS `LIVE` stream; `options.fetch` + `hooks` middleware (synthetic-loopback LAN HTTP rewrite, `hooks.onEvent` TTFT/call-ms + ~60 LOC SSE usage scanner, ~250 LOC Anthropic caching translator + `reasoning_effort` injection, synchronous turn/token/wall limits + `stallGuard`, 60 KiB UTF-8 tool cap).
  - Provider catalog & sign-ins: `providers-registry.json` schema + ~271 LOC pure RFC-8628/PKCE OAuth helpers + API key & keyless LAN HTTP local-LM support.
  - Control-plane `WallPlugin` stack over bare-Git mirror + per-trial `git worktree` (Decision #5 & #6): **Tier 1 `wall-tools`** (path-jailed file tools + virtual bash `bashkit-wasm`/`just-bash` + SSRF-filtered `fetch`, zero OS shell), **Tier 2 `wall-os`** (Linux `bwrap`+Landlock+seccomp / macOS `Seatbelt` + host egress proxy, with `wall-container` fallback), and **Tier 3 `wall-microsandbox`** (`libkrun` microVMs on KVM Linux / Apple Silicon HVF), all gated by `wall.selfTest()`.
- **Done when:** `harness-libfx` passes the ~150 LOC scripted HTTP/SSE conformance suite (tool calls, live `steer()`, `cancel()`, cache/reasoning/TTFT telemetry, LAN HTTP, 429/401/stall, crash-resume), and `wall-tools`, `wall-os`, and `wall-microsandbox` pass all secret/FS/network/orphan-kill `selfTest()` probes.

### Goal 5 — End-to-End Campaign Modes (Hill Climb, Goal, Research) & Bundled `git-sync`
- **Depends on:** Goal 3, Goal 4
- **Est. LOC / Size:** ~1,600–2,200 LOC (`packages/control`, bundled `git-sync` plugin)
- **Scope:**
  - Minimal 7–12 line `thermite.yaml` parser & one-surface actions (`campaigns.validate`, `campaigns.dry_run`, `campaigns.create`, `runs.start`) with sane defaults (`editable_paths: ["**"]`, host-proportional limits: 75% runner RAM / 5x baseline time, immutable judge snapshot outside worker zones).
  - All 3 campaign modes on the Sans-I/O scheduler + default statistical `registerJudge`: **Hill climb** (auto A/A calibration, interleaved A/B + B/A blocks, GPU-drain checks, held-out cases), **Goal** (code verifiers, metric thresholds, review panel), and **Research** (SSRF-safe seed fetch/archive, verified quotes, oscillation breaker, report synthesis), plus event-driven advisors & non-blocking `needs`.
  - Bundled default-on `git-sync` plugin on `PluginApi` (`onEvent("attempt.promoted")` -> `git.onChampion: push | pr | tag | none` with GitHub PR support on day one, emitting `git.sync_finished`), fast incremental `thermite pull <run>`, and pre-bundled 60-second `matmul-cpu` sample.
- **Done when:** Scripted-model end-to-end tests execute hill-climb (`matmul-cpu`), goal, and research runs in `< 30s`, verifying A/A calibration, judge isolation, champion promotion + `git-sync` push/PR, `rejudge`, and circuit-breaker pauses.

### Goal 6 — Lean Core Knowledge Engine (PG 18 FTS + `pg_trgm`)
- **Depends on:** Goal 3 *(run 1-day benchmark before implementation)*
- **Est. LOC / Size:** ~900–1,100 LOC (`packages/core/src/kb`, `packages/control/src/kb`)
- **Scope:**
  - Execute the 1-day 60-needle / 30k & 150k-chunk benchmark script ([`goal-0/knowledge-research.md`](goal-0/knowledge-research.md#6-reproducible-pre-build-benchmark-plan)) against PG 18 FTS + `pg_trgm`, `pgvector` HNSW, and `pg_textsearch` before writing production KB code.
  - Implement normalized core tables (`kb_collections` with `kind: 'campaign' | 'shared'`, `kb_items`, `kb_versions`, `kb_chunks`, `kb_blobs`, `kb_links`, `kb_grants`, `kb_run_scopes`), content-addressed blobs, async NATS-driven heading-aware parent-child chunker, dual `tsvector` (`english` + `simple`) + `pg_trgm`, O(1) empty-scope `< 1 ms` short-circuit, compaction transcripts excluded from default search, pooled async PG (`max >= 8`), pure Sans-I/O query parser + RRF, policy-governed grants, `core/api` KB actions, and `KbPluginHooks`.
- **Done when:** Benchmark gates pass (B1 Recall@5 `>= 95%`, B2 Recall@10 `>= 85%`, scoped p95 `< 20 ms`, empty-scope `< 1 ms`, `0 ms` event-loop stall under 16 concurrent readers + 100 writes/s); core KB stays `<= 1,100 LOC`.

### Goal 7 — Unified CLI (`packages/cli`) & Core Web UI (`packages/ui`)
- **Depends on:** Goal 1, Goal 5, Goal 6
- **Est. LOC / Size:** ~1,700–2,300 LOC (`packages/cli`, `packages/ui`)
- **Scope:**
  - `packages/cli` auto-generated from `core/api` (`init`, `run [--dry-run]`, `status`, `pull`, `machine token`, `join`, `leave`, `up/down/logs/update/backup/restore`) with `--json` output.
  - Thin `packages/ui` app on `@iammrduncan/magnesium` (consuming only `core/client.ts` + SSE/WS `LIVE`, with inline splash + safe-area insets + `interactive-widget=resizes-content`): 3-step resumable **Onboarding** (account → provider catalogue w/ live test → 1-click `matmul-cpu` or own repo), **Home / Needs you** (with auto-clearing readiness strip), **Compute** (`machine › device` + copyable `thermite join`), **Knowledge**, **Campaigns + Run** (1-page sticky creator + dry-run; Summary / Live trace / Attempts / Results), and **Setup** (Providers, Git, Policy tokens, Plugins, System Update), plus plugin UI runtime bridge exposing host React + `@iammrduncan/magnesium`.
- **Done when:** Browser checks verify light/dark + `390px` mobile across all screens, 3-click onboarding to a running `matmul-cpu` run, 100% job completion from CLI/MCP alone (zero UI-only backdoors), and `build:ui` passes cleanly.

### Goal 8 — One-Command Install (`setup.sh`), Docs & `v1.0.0` Cutover
- **Depends on:** Goal 7
- **Est. LOC / Size:** ~500–700 LOC (`setup.sh`, `join.sh`, `deploy/compose.yaml`, doc generator)
- **Scope:**
  - Ship `setup.sh`, `join.sh`, `agent-setup.txt`, ~55-line 3-service `deploy/compose.yaml` (`control`, `nats`, `db` on `pgvector/pgvector:0.8.x-pg18-trixie`), host `thermite-runner.service`, `thermite.service`, and `thermite-control.path` atomic backup/update/rollback flow.
  - Auto-generate REST/MCP/CLI docs from `core/api`; update public guides and `CREDITS.md` (`libfx`, `fxbot`, `pgvector`, `bubblewrap`, `@anthropic-ai/sandbox-runtime`, provider logos).
  - Execute cleanroom cutover: preserve `release/v0.2` from `main`, merge `main` into `v1` with `-s ours`, fast-forward `main`, and tag `v1.0.0`.
- **Done when:** Clean Linux VM runs `curl | sudo bash` → 3-step UI → first `matmul-cpu` champion push in `< 3 min`; second machine joins via `thermite join` in `< 30s`; full CI (real PG 18 + NATS + compose smoke + browser + `gitleaks` + `public.mjs`) is green; total `v1.0` footprint lands inside **~12–16.5k LOC**.

---

## Wave 2: `v1.1` Plugins — External Harnesses, Remaining Devices & Cloud Compute

### Goal 9 — External CLI Harnesses (`harness-claude`, `harness-agy`, optional `harness-codex`/`harness-pi`)
- **Depends on:** Goal 4 (`HarnessPlugin` seam + `wall-os` / `wall-microsandbox`)
- **Est. LOC / Size:** ~900–1,400 LOC *(independent plugins; `0` core LOC)*
- **Scope:**
  - `harness-claude` (Claude Code CLI via loopback `toolBridge` MCP/CLI + PTY `attachTerminal()` + isolated `claude_subscription` auth) and `harness-agy` (Agy CLI via `toolBridge` + normalized `HarnessEvent` stream), running inside Control's `wall-os` / `wall-microsandbox` / `wall-container`.
  - Optional `harness-codex` and `harness-pi` plugins on the identical `registerHarness` seam.
- **Done when:** Each plugin passes the shared `HarnessPlugin` conformance suite, completes a real hill-climb trial with zero `packages/core` edits, and keeps subscription credentials strictly isolated per harness.

### Goal 10 — Additional Hardware Devices, Cloud/Cluster Compute & Multi-Forge PRs
- **Depends on:** Goal 3, Goal 5
- **Est. LOC / Size:** ~1,100–1,700 LOC *(independent plugins; `0` core LOC)*
- **Scope:**
  - Device plugins (`registerDevice`): `device-vulkan` (`/dev/dri`) and `device-rocm`.
  - Compute plugins (`registerCompute`): `compute-ssh`, `compute-k8s`, and `compute-runpod` (with optional NATS leaf/blob transport for firewalled cloud pods).
  - Additional `git-sync` PR forge adapters (GitLab, Gitea) alongside `v1.0`'s GitHub PR support.
- **Done when:** Each `device-*` and `compute-*` plugin enrolls via NKey, passes `wall.selfTest()`, runs a benchmark, and tears down cleanly; GitLab/Gitea PR creation passes integration tests.

---

## Wave 3: `v1.2` Plugins — Remote Pairing, Live Publishing, Distillation & Semantic Knowledge

### Goal 11 — Remote WebRTC Pairing (`web-pairing` / `web.usethermite.com`) & PWA
- **Depends on:** Goal 7 (`PluginApi.route`/`socket`/`localUrl` + `@iammrduncan/magnesium` plugin bridge)
- **Est. LOC / Size:** ~800–1,200 LOC *(plugin; ported from `fxbot/plugins/web-pairing`)*
- **Scope:**
  - `web-pairing` plugin owning `plugin_web_pairing` (`devices`, `passkeys`), Noise + Ed25519 keys, QR + 6-digit SAS pairing tab, on-demand signaling relay WebSocket, and encrypted WebRTC data-channel HTTP/SSE/WS bridge to `t.localUrl` (`x-thermite-web-pairing` block on pairing admin routes).
  - Enable `VitePWA` (`registerType: "prompt"`) in `packages/ui` for installable mobile access via `web.usethermite.com` with zero VPN or port forwarding.
- **Done when:** A mobile browser pairs via QR + SAS over `web.usethermite.com`, monitors a live run, and resolves a `need`; pairing admin routes reject proxied requests; uninstalling the plugin leaves zero core tables or routes.

### Goal 12 — Built-in Live Publishing (`live-publish` / `thermite live`) & JSONL Distillation (`distill-jsonl`)
- **Depends on:** Goal 5, Goal 7
- **Est. LOC / Size:** ~900–1,300 LOC *(two independent plugins; `0` core LOC)*
- **Scope:**
  - `live-publish` (`thermite live`): consumes sanitized `t.live.<run>.>` projections (emitted only when `run.live === true`), registers `live.toggle` / `live.status`, and serves public SSE/JSON via `route()` or forwards to `live.usethermite.com` using the least-privilege `live-reader` NKey principal in the `THERMITE` account.
  - `distill-jsonl`: registers `distill.export` / `distill.preview` + streaming download `route()`, distilling run traces, prompts, diffs, verdicts, tool calls, and learnings into redacted SFT, preference-pair, and trajectory JSONL datasets filterable by outcome, champion, and role.
- **Done when:** Toggling `run.live` serves a live public view while private runs remain physically unreadable to `live-reader`; `distill.export` streams validated, secret-redacted JSONL over a multi-attempt run with zero core schema changes.

### Goal 13 — Semantic & Extended Knowledge Plugins (`knowledge-semantic`, optional `knowledge-bm25`/`ingest-pdf`)
- **Depends on:** Goal 6 (`KbPluginHooks` + `pgvector/pgvector:0.8.x-pg18-trixie`)
- **Est. LOC / Size:** ~450–650 LOC (`knowledge-semantic`) + ~400–700 LOC optional plugins
- **Scope:**
  - `knowledge-semantic`: plugin-owned `plugin_knowledge_semantic.chunk_embeddings`, lazy partial `halfvec` HNSW per `(model, dims)` with `hnsw.iterative_scan = 'relaxed_order'`, async batch embedder (`off | local` `llama.cpp` `EmbeddingGemma 2`/`Qwen3-Embedding` `| remote`), and cosine-gated RRF (`k = 60`) lane.
  - Optional plugins gated by benchmark proof: `knowledge-bm25` (PG-licensed `pg_textsearch` only if `>= +8 pp` on B2/B4), `knowledge-ingest-pdf` (isolated child-process PDF/HTML/DOCX extractor), plus later `knowledge-contextual` & `knowledge-graph`.
- **Done when:** `knowledge-semantic` clears the Goal 0 benchmark gate (`>= +25 pp` Recall@10 on B3 conceptual queries, zero regression on B1/B4, scoped p95 `< 50 ms`, seamless fallback to Core FTS when embedder is off/down).

---

## Wave 4: `v1.3` Plugins — Operator Copilot & SQL Explorer

### Goal 14 — Operator Copilot (`thermy`), Read-Only `sql-explorer` & Power Navigation
- **Depends on:** Goal 4, Goal 7 *(optional Goal 13)*
- **Est. LOC / Size:** ~1,200–1,800 LOC *(independent plugins; `0` core LOC)*
- **Scope:**
  - `thermy`: conversational operator copilot plugin using `harness-libfx` (or any installed harness) + `@iammrduncan/magnesium/chat` (`TraceSteps`, `Markdown`, optional `./editor`) invoking `core/api` actions strictly under the user's `PolicyGrant`.
  - `sql-explorer`: read-only PostgreSQL explorer & saved-queries plugin (using `Explorer` / `DataGrid` from `@iammrduncan/magnesium/parts`) over `EVENTS`, attempts, telemetry, and Knowledge tables with statement timeouts.
  - Optional `⌘K` global search command palette and custom advisor/judge packs (`advisors-*`, `registerJudge`).
- **Done when:** `thermy` diagnoses run state and runs permitted `core/api` actions respecting `PolicyGrant` caps; `sql-explorer` executes bounded read-only queries and blocks writes; uninstalling either leaves core UI intact.
