# Thermite v1 — Cleanroom Direction & Foundations (Goal 0)

**Status:** Goal 0 (preplanning, 2026-11-28). Cleanroom rewrite (`v1`, replacing the incremental `v0.3.0` path). Start small, lock technical foundations first, and grow strictly through plugins. `v0.2.x` stays untouched for existing runs while `v1` is built cleanly from scratch.

---

## 1. Core Philosophy

- **Slim, minimum LOC to outcome:** simplest plain TypeScript that solves the problem; small single-job files, few dependencies, no classes/wrappers/speculative layers, delete before adding.
- **Thin core, features in plugins (the `fxbot` model):** core holds *only* what every run needs, what plugins plug into, and what Thermite needs to run. Everything else is a plugin — when a plugin hits a gap, widen the plugin API with the smallest hook instead of moving the feature into core.
- **Agents propose; separate code judges:** measurement, verdicts, completion, and promotion stay outside what a run's own worker agents can write or load.
- **Full owner delegation by policy (no hardcoded owner-only walls):** the owner decides what an operator or delegated agent can do — including granting **full end-to-end delegation** to run campaigns, approve promotions, manage compute, and tune settings without hitting hardcoded human-only locks. (Distinct from a run's worker agents, which never judge their own work.)
- **No default research caps:** no hidden turn, submission, time, or spend limits unless configured (only safety circuit breakers that pause broken infrastructure or oscillating loops).
- **Start small and grow:** ship the smallest end-to-end working core first, then add capabilities outward as plugins.

---

## 2. Core Architecture: NATS + Sans-I/O Event System

- **NATS (JetStream) is the backbone:** every command, state transition, trial result, live stream, and runner heartbeat flows through NATS as durable events.
- **Sans-I/O everywhere:** core domain logic (run lifecycle, scheduler placement, judge verdicts, circuit breakers, approval state machine, advisor triggers) is pure deterministic TypeScript — `(state, event) => { nextState, effects }` — completely decoupled from network, database, process, and clock I/O.
  - Thin I/O adapters at the edges talk to NATS, PostgreSQL, HTTP/MCP, and OS processes.
  - Enables millisecond, deterministic tests of verdicts, state transitions, and failure recovery without slow container/DB test bloat.
- **Delete the `rig` concept completely:** a **run** owns its agents, models, and compute share; **machines & devices** (`machine › device`) are a shared pool allocated whole, in turns, or shared.
- **Control plane vs. thin machine runner:**
  - **Control plane** holds the Door (API/MCP/UI), Record (single writer to PostgreSQL + NATS event log), Agents (core loop, durable sessions, worker zones, sealed secrets/keys), and Scheduler (pool + judge decisions).
  - **Machine runner** is one minimal program connected only over NATS, executing only hardware-bound work (builds, measurements, device experiments) on bare metal, VM, or container — with no supervisor, no local ledger, and no model credentials.

---

## 3. Agent Loop & Plugin System

- **`libfx` (`fx.sh`) is the core agent loop:** single built-in runtime for runs (same foundation as `fxbot` — streaming, tools, steering, cancellation, durable sessions, provider catalog/sign-ins).
- **External coding agents are later plugins:** **Claude Code**, **Agy**, Codex, Pi, etc. ship as optional `harness-*` plugins rather than core dependencies on day one.
- **Plugin rules (matching `fxbot`):**
  - Core never imports or names a specific plugin; unused plugins cost zero processes, tables, timers, or UI code.
  - Core features run through the same hooks plugins use; plugins compose via `provide` / `need` and declare compatibility (`minThermite` + `plugin-breaks.json`), sharing `plugin.json` conventions with `fxbot`.
  - Plugin data lives in plugin-owned tables/files, never core migrations; removing a plugin leaves core intact.
  - Core plugin families: `harness-*` (agent loops/CLIs), `device-*` (hardware targets & runtimes: CPU, CUDA, Vulkan, Metal/MLX, ROCm), `compute-*` (machine sources: SSH, Kubernetes, cloud GPU), plus plugins for web pairing, live publishing, dataset distillation, advisors, campaign modes, walls, and judges.
- **Proof-based plugin trust:** only the owner installs plugins; every verdict records plugin + version; core verifies mechanism proofs (isolation self-test for walls, A/A calibration for judges) instead of hardcoding static bans.

---

## 4. One Surface Parity: API/MCP First + Shared UI Library

- **Zero API-only / UI-only / MCP-only splits:** every capability is defined once in a typed action registry (`core/api`) that automatically exposes identical REST routes, MCP tools, CLI commands, and generated docs — so any person or agent can complete any job from any single surface.
- **UI is a thin client on top:** standalone React 19 / Vite / Tailwind / Radix / Geist app (`packages/ui`) consuming only the typed client — zero UI-only backdoors or duplicated business logic.
- **Shared UI library with `fxbot`:** build on `packages/design-system` already started in this repo, update it against current `fxbot` UI improvements (`v0.12.0`+), and keep it cleanly packaged so `fxbot` adopts it directly later.
- **Clarity-first UX:** warm-grey + flame brand, system light/dark, `390px` mobile, one state sentence and one main action per screen, catalogue-driven provider setup (allowing custom/LAN HTTP local-LM endpoints out of the box), and clean navigation (**Home / Needs you, Compute, Knowledge, Campaigns, Setup**; **Thermy** as a later plugin).

---

## 5. Onboarding, Git Sync, Publishing & Data Flows (Fixing v0.2 Pains)

- **Effortless onboarding & campaign setup:**
  - **One-command install** (like `fxbot`'s `setup.sh`) brings up Control + NATS + Postgres + UI ready immediately, with an obvious first-run flow so new users immediately know what to do.
  - **Simple campaign creation:** guided defaults, templates, and minimal config — no multi-file boilerplate or prerequisite dance just to start a campaign.
  - **One-command machine join (`herdr` / `rex` style):** copy-paste one command on any machine to enroll its lightweight runner over NATS (supporting bare-metal, VM, or container execution cleanly, including macOS Metal/MLX).
- **First-class Git auto-sync on champions & fast Git-native delivery:**
  - Configurable per-campaign Git sync policy (auto-commit, auto-push to target branch, optional auto-PR/tag on each promoted champion) built in and reliable.
  - Replace slow giant export bundles and manual cross-repo `.patch` shuffling with fast incremental/streaming exports and direct Git-native champion branches/commits.
- **Built-in Live publishing (`thermite live` / Live plugin):**
  - Replace the brittle separate `live.usethermite.com` multi-agent/folder-sync deployment with a simple toggle per campaign/run fed directly by NATS events.
  - Anyone can serve or deploy their own live view (`live.usethermite.com` or self-hosted) straight from Thermite with zero external sync choreography.
- **Remote WebRTC pairing (`web.usethermite.com`, like `web.fxbot.sh`):**
  - Pair any browser/device directly to Control over encrypted WebRTC without needing Tailscale, VPNs, or port forwarding (aligned with `fxbot`'s `web-pairing` plugin architecture).
- **Fine-tuning dataset distillation & JSONL export:**
  - First-class distillation/export pipeline turning run traces, prompts, diffs, verdicts, tool calls, and learnings into clean, redacted fine-tuning JSONL datasets (e.g. SFT / preference pairs / trajectories, filterable by outcome, champion, and role).

---

## 6. Execution & Engineering Lessons Baked Into v1

- **Infra & build circuit breakers (in Sans-I/O core):** auto-pause lanes and advisors after consecutive infra crashes (`3`) or identical invalid build failures (`5`); first-class `rejudge` for recorded attempts; fail over on consecutive invalid planner epochs (no silent FIFO drift); detect `(decision, certainty)` oscillation in research mode.
- **Sane sandbox & resource defaults:** host-proportional memory/file limits (never hardcoded tiny caps on large machines); kill only timed-out child process groups (`-pgid`), never the worker session; pass prompts via stdin/file (no `argv` `E2BIG`); writable scratch `/tmp`, diff visibility, and diagnostic findings without forcing dummy diffs.
- **Unbiased judging & clean device sharing:** support interleaved A/B + B/A timing blocks, GPU-drain checks before timing, and dedicated lane-vs-judge device scheduling so judge load never starves worker builds.
- **Low-friction approvals & event-driven advisors:** narrow auditor `needs_owner` holds to concrete gaming/defects with an auditor timeout; never freeze all lanes while one attempt awaits review; trigger advisors on state changes (not blind hourly ticks) and actually inject concise active rules into lane prompts with scoped `AVOID` carve-outs.
- **Lean repo checks:** test Sans-I/O transitions, judge math, isolation self-tests, and API contracts; keep pre-commit checks fast (`< 2 min`); drop fail-on-shrink baseline ratchets (`--lower` traps), forced file-splitting churn, and brittle CSS-ban tests.

---

## 7. Dedicated Research & Exploration Tracks (Goal 0 — Not Decisions Yet)

- **Knowledge system research (required before building):** do *not* port `v0.2`'s slow, bulky SQLite/word-index KB. Research and benchmark an effective, efficient, scalable replacement (evaluating hybrid Postgres FTS + `pgvector`, hierarchical indexing, chunking, scoped retrieval, incremental ingestion, empty-scope short-circuits, and core-vs-plugin boundaries).
- **Control-plane lightweight isolation exploration (exploration only — NOT a directive):** investigate whether Control-plane agent zones (running `libfx`, virtual/scoped filesystems, and code-writing tools while offloading builds/benchmarks to machines via `run_experiment`) can run inside **V8 isolates / WASM sandboxes** instead of Docker/containers/VMs — allowing Control to run cleanly anywhere without a container engine. *Scope:* Control plane only; compute machines still execute on bare metal, VMs, or containers as their workloads require.

---

## 8. Goal 0 — Preplanning Deliverables Before Goal 1

- **Cleanroom home:** lock branch/directory/repo strategy for `v1`.
- **`libfx` gap check:** audit `libfx` (at `0.0.16` in `fxbot`) on Anthropic prompt caching + thinking, Responses API, turn/compaction controls, and shared agent-core packaging with `fxbot`.
- **`packages/design-system` sync audit:** diff against `fxbot` `0.12.0`+ UI components/tokens so both products share one clean library.
- **Knowledge research spike:** architecture + benchmark proposal for the new Knowledge system.
- **Control-plane WASM / V8 isolate exploration spike:** feasibility, filesystem/git/tool ergonomics, `libfx` compatibility, security boundary, and fallback options vs. containers/microsandbox.
- **Core contracts sketch:** NATS + Sans-I/O event taxonomy, `core/api` unified action & delegation policy model, one-command install + `herdr`/`rex`-style machine join flow, and `v1.0` MVP vs. plugin roadmap cut line.

---

## 9. Goal 0 Outputs and Navigation

- **[Visual Explainer Site](site/index.html)** & **[Feature Process Explainer](site/process.html)** — self-contained interactive architecture, Sans-I/O lifecycle + 7 reliability breakers, capabilities, Goals 1–14 roadmap, 16 locked decisions, and interactive 4-track / 6-gate Anti-Slop Firewall + IA plugin slot explorer (offline `file://` + HTTP, light/dark, `1440px`/`820px`/`390px`).
- **[Interactive UI/UX Mockups (7 Screens)](mockups/index.html)** & **[Design Plan](design-plan.md)** — postmortem of v0.3.0 UI, elevated `@iammrduncan/magnesium` direction, 5-area IA + 6 bounded plugin slots, clickable 7-screen prototype with live **Direction A (Split Workbench)** vs. **Direction B (Focused Stream)** toggle, and Screen 7 **Grafana/Datadog-style Observability Explorer** (facets, stacked histogram, Visual Filter ↔ SQL, `BesidePanel` inspector, Live Tail, JSONL export).
- **[Requirements & User Stories](requirements.md)** — living 46-REQ ledger (`REQ-001`–`REQ-046` + `DROP-01`–`DROP-10`) grounded in all 51 public GitHub issues, 67 public PRs, Goals 1–14, and field usage.
- **[Anti-Slop Development Process](process.md)** & **[Phase Template](phases/_template.md)** — 4 proportional change tracks, 6-gate intake/research/core-or-plugin/UX-mockup/owner-review firewall, and 12 hard red lines.
- **[Goal 0 Decisions (All 16 Locked)](decisions.md)** — settled direction, verified technical foundations across all 6 spikes, and all 16 owner decisions locked on 2026-11-28.
- **[Execution Roadmap (Goals 1–14)](roadmap.md)** — cleanroom `v1` branch cutover through `v1.0` MVP (~12.0k–16.2k LOC) and post-MVP plugin waves (`v1.1`–`v1.3`).
- **Verified Goal 0 Research & Design Spikes:**
  - [`goal-0/sansio-nats-contract.md`](goal-0/sansio-nats-contract.md) — NATS JetStream bus, pure Sans-I/O reducer, unified `core/api`, `PolicyGrant` delegation, and `fxbot`-aligned `PluginApi`.
  - [`goal-0/libfx-audit.md`](goal-0/libfx-audit.md) — `libfx@0.0.16` gap audit, Option C hybrid packaging, `createFxEngine` persistence, and `harness-*` plugin seam.
  - [`goal-0/design-system-sync.md`](goal-0/design-system-sync.md) — `packages/design-system` vs. `fxbot` `0.12.0` diff, brand-vs-semantic token split, subpath exports, and pre-screen sync checklist.
  - [`goal-0/knowledge-research.md`](goal-0/knowledge-research.md) — `v0.2` SQLite KB postmortem, two-layer PostgreSQL 18 + `pgvector` architecture, and 60-needle benchmark plan.
  - [`goal-0/wasm-isolation-spike.md`](goal-0/wasm-isolation-spike.md) — Control-plane WASM/V8 isolate exploration verdict (NO-GO for full zones; Conditional GO for zero-container Control via host `libfx` + `wall-tools`/`wall-os`).
  - [`goal-0/onboarding-and-mvp.md`](goal-0/onboarding-and-mvp.md) — `< 2 min` `setup.sh`, `herdr`/`rex`-style `thermite join`, 7–12 line `thermite.yaml`, `v1` branch cutover, lean checks, and `v1.0` MVP cut line.
