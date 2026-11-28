# Thermite v1 — NATS + Sans-I/O Core, Unified API, Delegation Policy & Plugin Contract

**Status:** Goal 0 architectural contract (preplanning, 2026-11-28). Zero production code changes.  
**Inputs:** [v1 Direction & Foundations](../README.md), [v0.3.0 Decisions](../../v030/decisions.md), [Option 4](../../v030/options/option-4-programs-one-core-and-plugins.md), and `fxbot` plugin conventions.

## TL;DR Architecture

Thermite v1 replaces v0.2's rig-centric SQLite relays, 141-event ledger sprawl, and duplicated REST/MCP/CLI/HTML handlers with **four small contracts** in `packages/core`:

```text
  UI / CLI / MCP / Scripts / Delegated Agents
                     │  (1) core/api: single typed action registry + policy gate
                     ▼
          ┌─────────────────────┐      (4) core/plugin: fxbot-style hooks
          │   packages/control  │◄───► harness-* · compute-* · wall-* · judge-*
          │  ┌───────────────┐  │      git-sync · distill-jsonl · live · web-pairing
          │  │ Pure Sans-I/O │  │
          │  │ reduce(s,e,t) │  │  (2) ZERO I/O imports; millisecond deterministic tests
          │  └───────┬───────┘  │
          │  Thin I/O Adapters  │────► PostgreSQL (record + plugin_<name> schemas)
          └──────────┬──────────┘
                     │  (3) core/bus: NATS JetStream (3 streams, zero `rig` subjects)
                     ▼
          ┌─────────────────────┐
          │   packages/runner   │◄───► device-* (CPU / CUDA / Vulkan / Metal / ROCm)
          │  (hardware-only;    │      wall-* (container / bare-metal / future isolate)
          │   no model keys)    │
          └─────────────────────┘
```

- **Zero `rig` anywhere:** every subject, table, and state key is addressed by `run`, `machine`, `job`, `attempt`, or `need`.
- **Sans-I/O core (`packages/core/src/machine/`):** all run lifecycles, circuit breakers, planner failover, oscillation detection, narrowed approvals, and advisor triggers run in a pure reducer `(state, event, now) => { state, effects }`.
- **One action table (`packages/core/src/api/`):** generates REST, MCP, typed `fetch` client, CLI, and docs with zero drift.
- **Policy-driven delegation:** replaces v0.2's hardcoded `OWNER_ONLY_KINDS` (28 kinds) and scattered `issuedBy !== "owner:operator"` checks with composable token capabilities — enabling full end-to-end agent delegation when the owner opts in, while preserving the hard invariant that a run's own worker/advisor agents never judge or self-approve.
- **Thin core, `fxbot`-aligned plugins:** shared `plugin.json` manifest + `provide`/`need` + `plugin-breaks.json` compatibility checks cleanly host Git auto-sync, JSONL distillation export, `thermite live`, and WebRTC pairing outside core.

---

## 1. NATS (JetStream) Bus Contract (`core/bus`)

### 1.1 Minimal Streams & Subject Hierarchy

v0.2 ran 6 JetStream streams (`COMMANDS`, `CONFIG`, `EVENTS`, `LIVE`, `REPORTS`, `KB_FILES`) because rigs held local ledgers and needed sealed model/MCP config pushed over NATS. In v1, the control plane owns agents, keys, and the record; runners execute hardware-bound jobs only. That collapses the bus to **3 JetStream streams + 2 Core NATS subjects**:

| Stream / Layer | Retention & Limits | Subject Pattern | Publisher → Consumer | Purpose & Cardinality Guard |
| --- | --- | --- | --- | --- |
| **`EVENTS`** (JetStream) | `limits`, file, `s2`, `discard: new`, `max_age: 0` (retention purge only), `allow_direct`, `allow_atomic` | `t.run.<run>.ev.<kind>`<br>`t.run.<run>.attempt.<stage>`<br>`t.run.<run>.need.<state>`<br>`t.machine.<machine>.ev.<kind>` | `control` → `record`, plugins, backup | Immutable domain record. Dotted `DomainEvent.type` maps `.` → `_` for single-token `<kind>` (or routes `attempt.<stage>` / `need.<state>`). `attemptId`, `jobId`, `needId` ride in payload + headers (`Thermite-Attempt`, `Thermite-Job`, `Thermite-Need`), keeping retained subject count `O(runs)`. |
| **`JOBS`** (JetStream) | `workqueue`, file, `max_age: 7d`, `max_msgs_per_subject: 256`, `discard: new`, `discard_new_per_subject: true`, `duplicate_window: 7d` | `t.machine.<machine>.job.dispatch`<br>`t.machine.<machine>.job.result` | `control` → `runner:<m>`<br>`runner:<m>` → `control` | Durable job handoff & terminal outcomes (`build`, `measure`, `experiment`, `self_test`). Because JetStream dedup is stream-wide, `Nats-Msg-Id` namespaces phase: `<m>:<jobId>:dispatch` vs `<m>:<jobId>:result`. Workqueue deletes acked msgs. |
| **`LIVE`** (JetStream) | `limits`, file, `max_age: 1h`, `max_bytes: 256MiB`, `max_msgs_per_subject: 1000`, `discard: old` | `t.run.<run>.live.<source>`<br>`t.machine.<machine>.job.<job>.live`<br>`t.need.<need>.live`<br>`t.live.<run>.<channel>` | `control` / `runner:<m>` → UI door, `live-publish` | Rolling terminal/log/metric lines. `t.live.<run>.>` receives sanitized projections **only** when `run.live === true` (private runs never appear there). |
| **Core NATS** (ephemeral) | Zero disk, fire-and-forget | `t.machine.<machine>.hb`<br>`t.machine.<machine>.cancel` | `runner:<m>` → `control`<br>`control` → `runner:<m>` | 5s runner heartbeats (devices, GPU-drain status, active `jobIds`) and immediate `-pgid` kill signals for timed-out/aborted jobs. |

**Payload, prefix & Git transfer rules:** All subjects use the short `t.` prefix (constructed only via `core/bus/subjects.ts`) to keep JetStream subject-tree RAM minimal. `JOBS` messages stay `< 1 MiB` (metadata + commit SHA + kit ref); runners fetch commits over Control's authenticated Git-HTTP endpoint using a short-lived job token, deleting v0.2's manual base64 chunking state machine (`core/link/runners.ts`).

### 1.2 Account & NKey Permission Separation

Every participant generates its own Ed25519 NKey locally; only the public key is enrolled in Control and written to the NATS users config (reloaded via `$SYS`).

| NATS Account | Principal | Publish Allow / Deny | Subscribe Allow | Security Boundary |
| --- | --- | --- | --- | --- |
| `THERMITE` (JS on) | `control` | Allow `>` **except** deny `$JS.API.STREAM.DELETE.EVENTS` | `>` | Single writer to `EVENTS`; cannot destroy the record stream. |
| `THERMITE` | `runner:<m>` | `t.machine.<m>.hb`, `t.machine.<m>.job.result`, `t.machine.<m>.job.*.live`, `$JS.API.CONSUMER.{INFO,MSG.NEXT}.JOBS.runner-<m>`, `$JS.ACK.JOBS.runner-<m>.>` | `_INBOX.m.<m>.>`, `t.machine.<m>.cancel` | Cryptographically bound to `<m>`. Cannot create consumers, read `EVENTS`, read/spoof other machines or runs, or see model credentials. Reducer additionally checks `job.machineId === msg.machine`. |
| `THERMITE` | `live-reader` (optional) | **Live-only:** None.<br>**JS replay:** `$JS.API.CONSUMER.{INFO,MSG.NEXT}.LIVE.<c>`, `$JS.ACK.LIVE.<c>.>` (never `t.live.>`) | **Live-only:** `t.live.>`<br>**JS replay:** `_INBOX.live.<c>.>` | Used by `thermite live` external edge relays; physically unable to read private runs or forge messages into `LIVE`. |
| `THERMITE` | `backup` | `$JS.API.STREAM.{INFO,MSG.GET,SNAPSHOT,RESTORE}.EVENTS`, `$JS.SNAPSHOT.{ACK,RESTORE}.EVENTS.>` | `_INBOX.backup.>` | Snapshot/restore of `EVENTS` only; cannot publish or purge. |
| `SYS` | `system` | `$SYS.REQ.SERVER.*.{RELOAD,VARZ,CONNZ,JSZ}` | `_INBOX.>` | Server config reload and metrics only; zero access to `THERMITE`. |

---

## 2. Pure Sans-I/O State Machine (`core/machine`)

### 2.1 Reducer Contract

Core domain logic imports **only** TypeScript types and pure utilities (`packages/core/src/machine/` has zero imports of `node:*`, `pg`, `@nats-io/*`, `fetch`, `Date.now`, or `Math.random`).

```ts
export type ReduceResult = {
  readonly state: ControlState;
  readonly effects: readonly Effect[];
};

/** Pure deterministic transition. Replayable from EVENTS + snapshots in milliseconds. */
export function reduce(state: ControlState, event: DomainEvent, now: number): ReduceResult;
```

### 2.2 Core Domain Events & Effects (Slim Union)

Instead of 141 ad-hoc event kinds, v1 models **21 orthogonal core domain events** (`machine.heartbeat` and `clock.tick` are ephemeral reducer inputs not persisted to `EVENTS`) and **8 edge effects** (`sync_git` / `git.sync_finished` model core Git-native champion delivery, fulfilled by core's minimal git adapter or the default `git-sync` plugin without naming optional plugins in core):

```ts
export type DomainEvent =
  // Run lifecycle & policy
  | { type: "run.created"; runId: string; campaignId: string; mode: "hill_climb" | "goal" | "research"; config: RunConfig }
  | { type: "run.status_changed"; runId: string; status: "running" | "paused" | "completed" | "closed"; reason: string; actor: ActorRef }
  | { type: "run.config_updated"; runId: string; patch: Partial<RunConfig>; actor: ActorRef }
  // Machine pool & wall proof
  | { type: "machine.enrolled"; machineId: string; devices: DeviceInfo[]; wallPlugin: string; wallVersion: string }
  | { type: "machine.heartbeat"; machineId: string; devices: DeviceTelemetry[]; activeJobs: string[] }
  | { type: "machine.wall_checked"; machineId: string; passed: boolean; proofDigest: string; detail?: string }
  | { type: "machine.status_changed"; machineId: string; status: "online" | "draining" | "offline" | "retired" }
  // Jobs (scheduler <-> runner)
  | { type: "job.dispatched"; jobId: string; runId: string; attemptId?: string; machineId: string; deviceIds: string[]; kind: JobKind; deadlineAt: number }
  | { type: "job.finished"; jobId: string; machineId: string; outcome: "ok" | "invalid" | "crash_infra" | "timeout" | "cancelled"; errorHash?: string; metrics?: MetricSamples; artifactsDigest?: string }
  // Attempts, judging, rejudge & promotion
  | { type: "attempt.submitted"; runId: string; laneId: string; attemptId: string; parentId?: string; commitRef: string; summary: string }
  | { type: "attempt.judged"; runId: string; attemptId: string; verdict: Verdict; judgePlugin: string; judgeVersion: string; rejudgeOf?: string }
  | { type: "attempt.rejudge_requested"; runId: string; attemptId: string; reason: string; actor: ActorRef }
  | { type: "attempt.promoted"; runId: string; attemptId: string; commitRef: string; metricDelta: number; actor: ActorRef }
  | { type: "attempt.invalidated"; runId: string; attemptId: string; reason: string; actor: ActorRef }
  // Agents, planner & research
  | { type: "planner.epoch_completed"; runId: string; epoch: number; valid: boolean; assignments?: LaneTask[]; error?: string }
  | { type: "research.round_recorded"; runId: string; hypothesisId: string; decision: ResearchDecision; certainty: Certainty; summary: string }
  // Advisors & non-blocking approvals (needs)
  | { type: "advisor.completed"; runId: string; role: AdvisorRole; targetId?: string; finding?: AuditFinding; directives?: ScopedDirective[] }
  | { type: "need.opened"; needId: string; runId: string; kind: NeedKind; scope: { attemptId?: string; laneId?: string; hypothesisId?: string }; summary: string; deadlineAt?: number }
  | { type: "need.resolved"; needId: string; resolution: "approve" | "decline" | "override" | "resume" | "dismiss"; note?: string; actor: ActorRef }
  // Git sync & clock
  | { type: "git.sync_finished"; runId: string; attemptId: string; ok: boolean; ref?: string; prUrl?: string; error?: string }
  | { type: "clock.tick"; now: number };

export type Effect =
  | { kind: "persist_pg"; events: readonly StoredEvent[]; projections: readonly ProjectionOp[] }
  | { kind: "publish_nats"; subject: string; payload: unknown; msgId?: string; headers?: Record<string, string> }
  | { kind: "dispatch_job"; machineId: string; job: JobSpec }
  | { kind: "cancel_job"; machineId: string; jobId: string; reason: string }
  | { kind: "invoke_harness_turn"; runId: string; laneId: string; harness: string; promptCtx: TurnContext; directives: readonly ScopedDirective[] }
  | { kind: "trigger_advisor"; runId: string; role: AdvisorRole; targetId?: string; reason: string; deadlineAt: number }
  | { kind: "notify_live"; runId?: string; scope: string; delta: unknown; publishPublic: boolean }
  | { kind: "sync_git"; runId: string; attemptId: string; commitRef: string; policy: GitChampionPolicy };
```

### 2.3 Reliability Breakers Baked Into `reduce()`

Every v0.2 execution lesson lives directly in deterministic reducer guards — testable in `< 1 ms` with synthetic event arrays:

| Failure Mode | Reducer State Tracked | Trigger Condition | Deterministic Action (Effects Emitted) |
| --- | --- | --- | --- |
| **Infra crash loop** | `run.infraCrashStreak`, `machine.infraCrashStreak` | `3` consecutive `crash_infra` (configurable) | Pause affected lane/run & pause advisors; mark machine degraded if host-specific; emit `need.opened("infra_paused")`. Resets to `0` on any non-infra finish. |
| **Identical build failure loop** | `lane.lastInvalidHash`, `lane.identicalInvalidStreak` | `5` consecutive `invalid` with identical normalized `errorHash` | Pause **only that lane**; emit `need.opened("build_loop", { laneId })` + optional `trigger_advisor("teacher")`. |
| **First-class `rejudge`** | `attempt.rejudges[]`, immutable `commitRef` | `attempt.rejudge_requested` on any recorded attempt | Enqueue fresh `measure` job with `rejudgeOf: attemptId`; keeps old trial data in history, supersedes active verdict on completion. |
| **Planner invalid-epoch drift** | `run.planner.invalidEpochStreak` | `2` consecutive `planner.epoch_completed` with `valid: false` | Switch to `run.config.plannerFallbackModel` if set; else pause planning & emit `need.opened("planner_failed")`. **Never** silently falls back to blind FIFO. |
| **Research oscillation** | `hypothesis.history: Array<[decision, certainty]>` | Cycle/flip-flop across `3` consecutive rounds without certainty gain | Freeze **only that hypothesis** (`status: "stalled"`); emit `need.opened("research_oscillation", { hypothesisId })` with cycle trace. |
| **Narrowed non-blocking approvals + auditor timeout** | `attempt.pendingNeedId`, `audit.deadlineAt` | Auditor returns `finding.kind` ∈ `{"defect", "gaming"}` **or** `clock.tick` passes `deadlineAt` | Hold **only** that attempt's promotion — all other lanes keep running. On auditor timeout, apply `onAuditTimeout` (`"proceed"` or `"need_owner"`), never wedging lanes. |
| **Event-driven advisors + active rules** | `run.advisorLastAt[role]`, `run.activeDirectives[]` | Transition on `attempt.promoted`, regression, breaker trip, or round end (cooldown-gated) | Emit `trigger_advisor`; returned `ScopedDirective[]` (including scoped `AVOID` carve-outs with path/condition) are attached to every subsequent `invoke_harness_turn`. |

---

## 3. Unified `core/api` Action Registry (Zero Surface Drift)

Every Thermite capability — core or plugin — is declared **once** as an `ActionDef` tuple in `packages/core/src/api/`. There is no separate REST router table, MCP tool list, CLI flag parser, or handwritten client DTO.

```ts
export type ActionDef<TName extends string, TIn extends z.ZodType, TOut extends z.ZodType> = {
  readonly name: TName;                          // e.g. "attempts.rejudge", "needs.resolve"
  readonly summary: string;                      // one-line description for MCP, CLI --help, docs
  readonly capability: Capability;               // policy scope checked at the door before handler runs
  readonly idempotent?: boolean;                 // safe to retry on network drop
  readonly http: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string }; // e.g. POST /v1/runs/:runId/attempts/:attemptId/rejudge
  readonly mcp?: { tool?: string; readOnly?: boolean; destructive?: boolean };  // default tool = name.replaceAll(".", "_")
  readonly cli?: { path?: string; alias?: string };                             // default = "thermite " + name.replaceAll(".", " ")
  readonly input: TIn;
  readonly output: TOut;
};
```

How the five surfaces derive from `ACTIONS` with zero manual sync:
1. **REST (`control/door/rest.ts`):** binds `http.method` + `http.path`, parses path/query/body against `input` once at the edge, runs the policy check for `capability`, calls the domain handler (which dispatches into `reduce()` or queries `control/record`), maps typed `ThermiteError` codes to HTTP status.
2. **MCP (`control/door/mcp.ts`):** lists **only** actions permitted by the caller's token capabilities (`tools/list` dynamically reflects policy — no hardcoded `MCP_OPERATOR_KINDS` vs `MCP_OWNER_KINDS`), converting `input` via `z.toJSONSchema()`.
3. **Typed client (`core/client.ts`):** browser-safe `fetch`-only client (`client.call("attempts.rejudge", input)`), with exact `InputOf<K>` / `OutputOf<K>` inferred from `typeof ACTIONS`. Used by both `packages/ui` and `packages/cli`.
4. **CLI (`packages/cli`):** walks `ACTIONS` to auto-generate subcommands, flags from `input.shape`, `--json` output, and `--help`.
5. **Reference docs & contract test:** one generator writes REST/MCP/CLI reference tables; one test asserts every action has a handler, valid JSON Schema, and capability, and tests core actions once through the shared door executor.

---

## 4. Configurable Owner-Delegation Policy Model

v0.2 hardcoded 28 `OWNER_ONLY_KINDS` (`src/core/commands.ts`) plus scattered `issuedBy !== "owner:operator"` checks (`src/core/invalidation.ts`, `src/core/terminal-input.ts`), blocking owners from delegating full campaign operations to an external orchestrator agent.

v1 splits authorization into **two orthogonal layers**:

1. **Door Policy (configurable per token/principal by the owner):** every door token carries a `PolicyGrant` specifying exact capabilities, optional campaign/run scoping, and expiry.
2. **Run-Agent Isolation Boundary (structural, non-configurable invariant):** a run's own worker and advisor agents **never** receive a door token and cannot reach the door, judge code, wall code, or promotion actions.

```ts
export type CoreCapability =
  | "runs:read" | "runs:write" | "runs:close"
  | "attempts:rejudge" | "attempts:invalidate"
  | "promotions:approve" | "needs:resolve"
  | "compute:read" | "compute:manage"
  | "settings:read" | "settings:write"
  | "terminal:input" | "plugins:manage" | "tokens:manage" | "*";

/** Core capabilities plus plugin-registered namespaced capabilities (`<plugin>:<verb>`, e.g. `live:manage`, `distill:export`). */
export type Capability = CoreCapability | `${string}:${string}`;

export type PolicyGrant = {
  readonly id: string;
  readonly label: string;
  readonly principalKind: "owner_session" | "delegated_agent" | "operator_token" | "ci_token";
  readonly capabilities: readonly Capability[];
  readonly scope?: { readonly campaignIds?: readonly string[]; readonly runIds?: readonly string[] };
  readonly grantedBy: string;          // owner principal id
  readonly expiresAt?: string;
};
```

### Built-in Profiles (Sugar Over `Capability[]`)

Core never hardcodes optional plugin names: plugins declare namespaced capabilities (`<plugin>:<verb>`) when registering actions, and profiles can include explicit plugin grants or `plugin:*` opt-ins.

| Profile | Default Capabilities | Intended Caller | Can Run End-to-End Campaign? |
| --- | --- | --- | --- |
| `viewer` | `runs:read`, `compute:read`, `settings:read` | Dashboards, observers, CI monitors | Read-only |
| `operator` | `viewer` + `runs:write`, `attempts:rejudge`, `compute:manage` (+ optional `<plugin>:<verb>` grants) | Day-to-day automation without promotion sign-off | Starts/steers/rejudges; escalates promotions |
| `autonomous_delegate` | **All campaign & ops capabilities** (`runs:*`, `attempts:*`, `promotions:approve`, `needs:resolve`, `compute:*`, `settings:*`, `terminal:input`, plus installed campaign plugin actions) | External orchestrator agent granted full autonomy by the owner | **Yes — 100% end-to-end**, incl. approving promotions, closing runs, invalidating evidence, tuning limits |
| `owner` | `["*"]` (adds `plugins:manage`, `tokens:manage`) | Owner browser session / admin CLI | Full control incl. installing plugins & minting/revoking tokens |
| *(Internal — no door token)* `run_worker` / `run_advisor` | **None on door.** Scoped harness toolset only (`submit_change`, `run_experiment`, `write_note`) | Worker & advisor loops inside a run | **Never** writes/loads judge code, installs plugins, or approves/invalidates its own work |

Every door action writes `{ principalId, principalKind, grantId, capability }` into `EVENTS`, and revoking a `PolicyGrant` takes effect immediately on the next request.

---

## 5. Plugin API & Hook Points (`core/plugin`, `fxbot` Style)

### 5.1 Manifest & Lifecycle (Aligned With `fxbot`)

Thermite adopts `fxbot`'s exact `plugin.json` convention — allowing a single plugin package to target both `fxbot` (`"sh.fxbot"`) and Thermite (`"com.usethermite"`):

```json
{
  "name": "web-pairing",
  "version": "0.1.0",
  "description": "Pair browsers to Thermite over encrypted WebRTC at web.usethermite.com.",
  "license": "Apache-2.0",
  "extensions": {
    "com.usethermite": {
      "minThermite": "1.0.0",
      "control": "./thermite/control.ts",
      "runner": "./thermite/runner.ts",
      "page": "./thermite/page.js",
      "css": "./thermite/page.css",
      "migrations": "./thermite/migrations",
      "settings": [{ "name": "relay", "description": "Signaling relay URL", "default": "wss://web.usethermite.com/signal" }],
      "needs": {}
    }
  }
}
```

- **Compatibility:** evaluated purely via `unfit(manifest, code, version, breaks)` against `packages/core/src/plugin/plugin-breaks.json` (same 40-line model as `fxbot`'s `plugin-fit.ts` and `plugin-breaks.json`).
- **Isolation:** each plugin owns its Postgres schema (`plugin_<name>`), sealed `secrets`, `log`, and `AbortSignal` (`signal`). Unused plugins cost zero tables, routes, processes, or UI bundle bytes.
- **Proof-based trust:** only principals with `plugins:manage` install plugins. `registerWall` must pass core's isolation self-test before scheduling jobs; `registerJudge` must pass core's A/A calibration before verdicts count, and every `attempt.judged` event records `{ judgePlugin, judgeVersion }`.

### 5.2 Minimal `PluginApi` Interface

```ts
export type PluginSetup = (t: PluginApi) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;

export type PluginApi = {
  readonly name: string;
  readonly settings: Readonly<Record<string, string>>;
  readonly sql: PluginSql;                                // schema plugin_<name> (postgres.js `Sql` for fxbot parity, or thin tagged-template over `pg`)
  readonly secrets: { get(k: string): Promise<string | null>; set(k: string, v: string | null): Promise<void> };
  readonly localUrl: string;                              // loopback URL of Control's door (for bridges like web-pairing)
  readonly signal: AbortSignal;                           // aborts on plugin unload
  log(...parts: unknown[]): void;

  // Composition (identical to fxbot)
  provide(api: Record<string, unknown>): void;
  need<T = Record<string, unknown>>(pluginName: string): T | null;
  dependents(): readonly { name: string; version: string; needs: Record<string, unknown>; api: Record<string, unknown> | null }[];

  // Reactive events & unified door extension
  onEvent<K extends DomainEvent["type"] | "*">(
    filter: K,
    handler: (ev: K extends "*" ? DomainEvent : Extract<DomainEvent, { type: K }>) => void | Promise<void>,
  ): void;
  registerActions(actions: readonly PluginActionBinding[]): void;        // auto-exposed as REST, MCP, CLI, client (namespaced capabilities)
  route(method: string, path: string, handler: PluginRoute): void;       // raw HTTP & SSE streams under /v1/plugins/<name>/*
  socket(path: string, handler: PluginSocketHandler): void;              // raw WebSockets under /v1/plugins/<name>/* (matches fxbot's PluginSocket)
  callAction<K extends CoreActionName>(name: K, input: InputOf<K>, callerGrant?: PolicyGrant): Promise<OutputOf<K>>; // forwards verified callerGrant or host-issued plugin grant (never self-minted)

  // Domain extension registries (core uses the exact same interfaces for built-ins)
  registerHarness(harness: HarnessPlugin): void;          // control: startTurn, steer, cancel, usage (default: libfx)
  registerDevice(device: DevicePlugin): void;             // runner: probe, allocate, checkDrained, measure
  registerCompute(compute: ComputePlugin): void;          // control: discover, provision, enroll, terminate
  registerWall(wall: WallPlugin): void;                   // runner/control: prepare, exec, selfTest (proof-gated)
  registerJudge(judge: JudgePlugin): void;                // control: evaluate, calibrateAA (proof-gated)
};
```

### 5.3 Plugin Hook Map — How Key Features Stay Out of Core

| Feature / Plugin | Runtime | Hooks Used | Data & Secrets | How It Works Without Core Bloat |
| --- | --- | --- | --- | --- |
| **Git Auto-Sync on Champions** (`git-sync`, bundled default) | Control | `onEvent("attempt.promoted")`, `registerActions` (`git.sync_now`) | Reads campaign `git.onChampion` (`push \| pr \| tag \| none`) + sealed git credentials | Reacts to `attempt.promoted` (or `sync_git` effect), pushes champion branch/tag or opens PR via host/token API, posts `git.sync_finished` event. Zero git hosting SDKs in core. |
| **JSONL Fine-Tuning Distillation** (`distill-jsonl`) | Control | `registerActions` (`distill.export`, `distill.preview`), `onEvent("run.status_changed")`, `route` (streaming download) | Read-only SQL views over events, turns, diffs, verdicts; optional `plugin_distill_jsonl` presets | Streams redacted SFT / preference-pair / trajectory JSONL filterable by outcome, champion, and role. Zero extra core tables or export bundles. |
| **`thermite live` Publishing** (`live-publish`) | Control | `registerActions` (`live.toggle`, `live.status`), `onEvent("*")`, `route` (public SSE/JSON), `socket` (optional WS), NATS `t.live.<run>.>` | `plugin_live_publish` public slug/token config | When `run.live === true`, reducer emits `notify_live(..., publishPublic: true)` onto `t.live.<run>.>`. Plugin serves public SSE/JSON via `route()` directly or forwards to `live.usethermite.com` — replacing v0.2's multi-agent folder sync completely. |
| **WebRTC Pairing** (`web-pairing` for `web.usethermite.com`) | Control | `sql`, `secrets`, `route`, `localUrl`, `signal` + `page`/`css` tab (exact `fxbot/plugins/web-pairing` pattern) | `plugin_web_pairing` (`devices`, `passkeys`), sealed Noise + Ed25519 keys + ICE/TURN config | Holds relay WebSocket only when paired devices, passkeys, or open tickets exist; bridges verified WebRTC data-channel HTTP/SSE and WebSocket requests to `t.localUrl` with `x-thermite-web-pairing` header (refused by pairing admin routes). |
| **Harnesses, Devices, Compute, Walls, Judges** | Control / Runner | `registerHarness`, `registerDevice`, `registerCompute`, `registerWall`, `registerJudge` | Plugin-owned schemas/settings; device plugins carry their own runner image file | Core ships `libfx` harness + `device-cpu` + `wall-container` + default statistical judge through these exact hooks; `harness-claude`, `harness-agy`, `device-cuda/vulkan/metal`, `compute-ssh/k8s/runpod` add zero core branches. |

---

## 6. Open Owner Calls (Goal 0 Decisions)

1. **Git artifact delivery to runners (HTTP vs. NATS Object Store):** Default to Control's authenticated Git-HTTP endpoint (keeps `JOBS` messages tiny and avoids bus storage pressure), or add an optional `BLOBS` NATS Object Store for firewalled leaf-node runners that can only speak NATS? *Recommendation: Git-HTTP default; optional NATS leaf/blob transport inside `compute-*` plugins only if a cloud runner needs bus-only transfer.*
2. **`autonomous_delegate` ceiling:** Should the built-in `autonomous_delegate` profile include 100% of campaign/promotion/compute/settings capabilities while leaving `plugins:manage` and `tokens:manage` owner-only unless explicitly added to a custom `PolicyGrant`? *Recommendation: Yes — gives full end-to-end campaign autonomy out of the box without silently letting a delegated token install arbitrary host code or mint eternal tokens.*
3. **Process isolation for third-party `registerJudge` plugins:** Load owner-installed judge plugins in-process (matching `fxbot`, gated by owner install + A/A proof + verdict attribution) or isolate them in a separate worker subprocess? *Recommendation: In-process for v1.0 (matches `fxbot`, minimal LOC); add optional subprocess isolation only if untrusted community judges emerge.*
4. **PostgreSQL driver for `PluginApi.sql` (`postgres.js` vs. `pg`):** `fxbot` plugins expect `postgres` (`postgres.js` tagged-template `Sql`), whereas Thermite v0.2 uses `pg` (`Pool`, v0.3.0 Decision 14). Adopt `postgres.js` in cleanroom v1 so plugins like `web-pairing` port verbatim, or keep `pg` behind a minimal `PluginSql` tagged-template wrapper? *Recommendation: Adopt `postgres.js` in cleanroom v1 (single driver, zero adapter shim, direct `fxbot` plugin compatibility).*
5. **Placement of `git-sync` (bundled default plugin vs. core adapter):** Both consume `attempt.promoted` / `sync_git`. *Recommendation: Ship `git-sync` as a bundled default-on plugin using `PluginApi` so it dogfoods the plugin contract on day one while giving zero-config Git auto-sync.*
