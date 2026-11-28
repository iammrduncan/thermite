# Thermite v1 (Goal 0): Onboarding, Machine Join, Campaign DX, Cutover & MVP Cut Line

**Status:** Goal 0 preplanning deliverable (2026-11-28). Product & DX blueprint for the cleanroom `v1` rewrite, aligned with [NATS + Sans-I/O Core & Plugin Contract](./sansio-nats-contract.md), [Knowledge Architecture Research](./knowledge-research.md), and [Control-Plane Isolation Exploration](./wasm-isolation-spike.md).

## TL;DR Recommendations

1. **One-command install (`< 2 min`):** Adopt `fxbot`'s `setup.sh` + host CLI (`thermite`) pattern: single `curl | sudo bash` installs a 3-service Compose stack (`control`, `nats`, `db`) plus an auto-enrolled local host runner (`thermite-runner.service`), systemd boot + self-update watcher, and a 3-step first-run UI flow with a **pre-bundled 60-second sample (`matmul-cpu`)** — zero manual secret init, zero `-f` compose override chains, zero cloning the repo to try Thermite.
2. **One-command machine join (`herdr`/`rex` style):** Replace v0.2's SSH-sudo and fragile single-use `curl | sh` rig scripts with `thermite join <url> --token <token>`. It runs preflight *before* consuming the token, auto-detects hardware via `device-*` plugins, mints a local Ed25519 NATS NKey whose private seed never leaves the machine, receives least-privilege NATS credentials (`runner:<machineId>`), starts a lightweight runner (`systemd` / `launchd` / container), and appears immediately in **Compute**.
3. **Zero-boilerplate campaigns + Git auto-sync:** One 7–12 line `thermite.yaml` (or 1-screen UI/CLI/MCP wizard) with sane defaults (`editable_paths: ["**"]`, host-proportional limits, automatic A/A calibration) and `git.onChampion: push | tag | none` in `v1.0` (`pr` in Phase 1.1, Open Call #5) via the bundled default-on `git-sync` plugin + `live: true | false`. Control snapshots judge scripts/hidden cases outside worker workspaces so **agents still never see or edit the judge**.
4. **Cleanroom cutover:** Build on a dedicated **`v1` branch** in this repository (keeping `packages/design-system/`, `docs/plan/v1/`, and `scripts/checks/public.mjs`; leaving `main` untouched for `v0.2.x` fixes). Enforce a `< 2 min` pre-commit gate (`typecheck`, `lint`, `check:public`, fast Sans-I/O + PGlite tests) and drop all `--lower` baseline ratchets, line-count split traps, and CSS-ban tests.
5. **Ruthless `v1.0` MVP (~10–15k LOC vs v0.2's 220k LOC):** Ship end-to-end **hill-climb + goal + research** on `libfx` + NATS Sans-I/O + 1 enrolled runner (`device-cpu`, `device-cuda`) + unified API/MCP/CLI + core UI + lean PG 18 FTS Knowledge + `git-sync`. Move external harnesses (`harness-claude`, `harness-agy`), `web-pairing`, `live-publish` (`thermite live`), `distill-jsonl`, `knowledge-semantic` (`pgvector`) / extra `knowledge-*`, `thermy`, `sql-explorer`, and cloud/cluster compute into clean post-MVP plugins.

---

## Why v0.2 Onboarding & Setup Fail Today (Forensic Friction Audit)

| Surface | Observed v0.2 Friction (from current docs & `compose.yaml`) | v1 Target |
| --- | --- | --- |
| **Install** (`first-run.md`, `one-machine.md`, 547-line `compose.yaml`) | "~20 min": manually `mkdir`, `curl compose.yaml`, verify SHA-256, run `init` container (18 secret files in `.dev/secrets/`), `up -d` (4+ containers, 2.5+ GB), `cat .dev/secrets/control-admin-token` to sign in. GPUs/tokens/Claude/results require stacking up to **7 `-f compose.*.yaml` overrides** on every `up`. Running `thermite doctor` or `token new` requires `git clone` + `npm ci` + `npm run build`. No boot unit on Podman; no in-UI update. | One `curl \| sudo bash` (`< 2 min`), 3 core containers + host local runner (`thermite-runner.service`), single `/opt/thermite/.env`, host `thermite` CLI with systemd boot + atomic rollback updates. |
| **First run** (`agents-with-a-free-model.md`) | Empty dashboard (`0 runs`). Trying the sample requires adding a provider, editing the rig's model + harness, waiting for model check, `git clone` Thermite source, `tar -czf matmul-cpu-kit.tar.gz`, filling a 6-step form (including pasting 3 regexes under Advanced), and uploading the tarball. | 3-click first-run UI (account -> provider -> one-click bundled `matmul-cpu` run or your own repo). |
| **Add machine** (`second-machine.md`, `join-a-rig.md`) | Requires manual HTTPS reverse proxy (90 MB body, no buffering), `.env` edits (`THERMITE_CONTROL_PUBLIC_URL`, `THERMITE_NATS_PUBLISH=0.0.0.0:4222`), firewall port 4222, `NOPASSWD` sudo or manual `loginctl enable-linger` + CDI spec + GPU index entry. Join token is burned even if preflight fails. Mac Metal/MLX impossible in containers; Vulkan needs `krunkit` + custom `podman build`. | `thermite join <url> --token <tok>` (idempotent preflight, auto hardware probe, NKey scoped NATS auth, optional WSS tunnel, native `launchd` support for macOS). |
| **Campaign & result** (`your-own-project.md`, `write-a-contract.md`, `write-a-kit.md`, `take-the-result.md`) | Separate kit git repo pinned by 40-char SHA, 50-line `contract.json` + 65-line `kit.json` (with incompatible placeholder syntax vs UI form), mandatory `editable_paths` & unused `target.class`. Form resets blank on error. Taking a champion requires manual rig export -> `.patch` download -> `git apply`. | 7–12 line `thermite.yaml` or 1-page sticky wizard with dry-run button; automatic `git.onChampion` push/tag (`pr` in Phase 1.1) via Control's bundled `git-sync` plugin. |

---

## 1. One-Command Install (`setup.sh` + `thermite` CLI) & First-Run UX

Directly mirrors `fxbot`'s `setup.sh` and `deploy/fxbot` host command architecture, eliminating container-socket exposure while enabling one-click UI updates and rollbacks.

### Install Command & Step-by-Step Flow (`< 2 minutes`)

```sh
# Linux (Debian/Ubuntu/Fedora/RHEL/openSUSE/Arch with systemd; x86_64 or arm64)
curl -fsSL https://usethermite.com/setup.sh | sudo bash

# Options: pinned release, custom port, explicit engine
curl -fsSL https://usethermite.com/setup.sh | sudo THERMITE_PORT=8800 bash -s -- v1.0.0

# AI-agent setup prompt (replaces/aliases v0.2's docs/_site/public/llm-setup.txt, matching fxbot)
# "Set up Thermite on this computer for me: follow https://usethermite.com/agent-setup.txt"
```

1. **Non-destructive preflight (fails fast before writing anything):** checks OS/arch, `systemd` (with WSL2 hint), supported package manager (`apt`/`dnf`/`zypper`/`pacman`), port availability (`8800`, `4222`), free disk (`>= 3 GB` in `/var/lib`), RAM warning (`< 1 GB`), and rejects snap-Docker cleanly.
2. **Engine & Compose auto-setup:** reuses running Docker or Podman `>= 4`, otherwise installs distro Podman `>= 4.9` (or Docker CE with SHA-256 verified key) and Compose v2 (`>= 2.26`, SHA-256 verified fallback binary). Records every installed package in `/etc/thermite/packages` so `thermite uninstall` reports exact cleanup commands.
3. **Zero-ceremony layout & sealed secrets:**
   - System user `thermite`, `/etc/thermite/secret.key` (`0400`, seals provider keys, Git tokens, NATS CA seed), `/etc/thermite/thermite.env` (non-secret overrides).
   - `/opt/thermite/{compose.yaml, .env, thermite}` symlinked to `/usr/local/bin/thermite`.
   - `/var/lib/thermite/{data, backups, control/requests}` — zero `.dev/secrets/` dance, zero manual `-f` override files (`thermite` selects engine/GPU compose overlays automatically from `.env`).
4. **Minimal 3-service Compose stack (~55 lines vs v0.2's 547) + host local runner:**
   - `control`: Door (REST/MCP/UI on `127.0.0.1:8800`, plus `/nats` WebSocket proxy to internal NATS WS when remote WSS fallback is enabled), Record, Agents (`libfx`), Scheduler. Never mounts the host container socket.
   - `nats`: JetStream with auto-generated Control CA TLS (`127.0.0.1:4222` locally; publishes `0.0.0.0:4222` for direct remote runners and listens on an internal WS port behind `control`'s `:8800` proxy for single-port remote runners).
   - `db`: PostgreSQL 18 (`pgvector/pgvector:0.8.x-pg18-trixie`, internal network only, auto-generated password in `/opt/thermite/.env` — ready for both core FTS and the `knowledge-semantic` plugin with zero image swap later).
   - **Auto-enrolled local runner (host service, outside Compose):** `setup.sh` enrolls this machine via the exact same `thermite join` path as a host `systemd` service (`thermite-runner.service`), keeping Compose strictly 3 services and letting `wall-container` use the host engine cleanly without exposing any container socket inside Compose.
5. **Systemd lifecycle & safe UI updates (`fxbot` request-dir pattern):**
   - `thermite.service` runs `thermite up` / `thermite down` at boot.
   - `thermite-control.path` + `thermite-control.service` watch `/var/lib/thermite/control/requests/*.json` and invoke `thermite apply`, allowing **Setup › System › Update** to pull the new release, snapshot Postgres, start with health wait, and auto-rollback if health fails.
6. **Host CLI (`thermite`) + checkout workflow:**
   - Release install: `thermite up | down | status | logs [svc] | update [ver] | backup | restore | rotate-key | join | uninstall [--purge]`.
   - From source checkout: `npm install && npm run dev` starts Postgres + NATS (`deploy/compose.dev.yaml`) and runs `control`, `runner`, and Vite UI directly from TypeScript source (no `tsc` build step).
7. **Terminal finish output:** prints `http://127.0.0.1:8800` (with one-time setup link if first install), `ssh -N -L 8800:127.0.0.1:8800 <you>@<host>`, `sudo tailscale serve --bg 8800`, and notes remote access via the `web-pairing` plugin once released.

### Obvious First-Run UI Guidance ("What do I do next?")

Applies `fxbot`'s onboarding state rules (stable step ID persisted in Postgres so refresh/restart resumes cleanly, **Skip for now** on every step, never shown to existing installs), trimmed to **at most 3 steps** (matching the 3-step target cited in `fxbot`'s onboarding plan):

1. **Create owner account** *(first visit only)*: username + password -> sets long-lived session cookie (replaces `cat .dev/secrets/control-admin-token`).
2. **Connect a model provider**: embedded provider catalogue (OAuth sign-in, API key, or local LAN HTTP endpoint like Ollama/vLLM/llama.cpp). Live-tests one cheap call before saving; `Skip for now` stays available for judge-only runs.
3. **Run something real** *(ends inside the product, never on an empty screen)*:
   - **Primary card — Run the 60-second sample (`matmul-cpu`):** pre-bundled inside `control` (no clone, no tarball, no wizard). One click baselines + launches 1 `libfx` lane on the auto-enrolled local runner and opens the live Run screen.
   - **Secondary card — Point at your own repository:** opens the 1-screen campaign creator (Section 3).
- **Home readiness strip (if anything was skipped):** compact checklist showing only incomplete real capabilities ("Connect a provider", "Join a GPU machine" with copyable `thermite join`, "Connect Git for auto-push") — disappears automatically once satisfied.

---

## 2. One-Command Machine Join (`herdr` / `rex` Style)

Replaces v0.2's multi-step SSH/CDI/proxy/rig choreography with a single idempotent command that works identically on Linux bare metal, VMs, containers, and macOS Apple Silicon.

### User Flow (~30 seconds to Ready in Compute)

1. **Mint a join command** (same `core/api` action `machines.create_join_token` in UI **Compute › Add machine**, CLI `thermite machine token`, or MCP `machines_create_join_token`):
   ```sh
   # Machine with thermite CLI installed:
   thermite join https://control.example.com --token thm_join_8f3a...

   # Fresh machine (bootstraps thin runner + joins in one paste):
   curl -fsSL https://usethermite.com/join.sh | sh -s -- https://control.example.com --token thm_join_8f3a...
   ```
   Optional flags: `--name <label>`, `--wall container|host`, `--tags gpu,fast`, `--devices all|0,1`. Token TTL is 15 minutes, revocable, and **not consumed until cryptographic registration succeeds** (fixing v0.2's burned-token trap on preflight failures).
2. **Local preflight & hardware probe (zero server state mutated on failure):**
   - Installs/updates only the thin `thermite-runner` artifact (zero Postgres, zero UI, zero supervisor, zero model credentials).
   - Loads `device-*` plugins to probe hardware automatically:
     - `device-cpu`: logical cores, usable RAM, arch.
     - `device-cuda`: `nvidia-smi` GPUs, VRAM, driver, container toolkit/CDI readiness (prints exact one-line fix or auto-generates CDI spec when run as root).
     - `device-vulkan`: `/dev/dri` Vulkan devices.
     - `device-metal`: Apple Silicon GPU + unified memory + MLX availability (native macOS runner via `launchd`, solving v0.2's container-blocks-Metal gap).
   - Checks reachability to Control HTTPS and NATS transport: connects via direct NATS TLS (`:4222`) when reachable, or falls back cleanly to **NATS-over-WebSocket (`wss://<control>/nats`)** through Control's existing HTTPS port so Tailscale `serve --bg 8800` or any single-port reverse proxy works with zero extra firewall rules.
3. **Zero-YAML cryptographic enrollment:**
   - Runner generates a local **Ed25519 NATS NKey** (`runner.nk`, mode `0600`); private seed never leaves the machine.
   - Runner calls `POST /v1/machines/enroll` with `{ token, nkeyPublic, name, os, arch, wall, devices }`.
   - Control validates & consumes the token, assigns `machineId`, writes a **least-privilege NATS user** `runner:<machineId>` (matching `core/bus` in [sansio-nats-contract.md](./sansio-nats-contract.md)) scoped strictly to publishing `t.machine.<machineId>.{hb,job.result,job.*.live}`, `$JS.API.CONSUMER.{INFO,MSG.NEXT}.JOBS.runner-<machineId>`, and `$JS.ACK.JOBS.runner-<machineId>.>`, and subscribing `_INBOX.m.<machineId>.>` + `t.machine.<machineId>.cancel`, reloads NATS via `$SYS`, emits `machine.enrolled`, and returns `{ machineId, natsUrl, busCaPem, wsFallbackUrl }`.
   - Runner persists `runner.json` and `bus-ca.pem` (`0600`). No manual YAML, TLS cert copy, or `.env` editing.
4. **Service startup, wall proof & live appearance:**
   - Registers & starts OS service: `systemd` (`thermite-runner.service`, user or system) on Linux, `launchd` (`com.usethermite.runner.plist`) on macOS, or container mode if requested.
   - Runner connects over NATS TLS with its NKey, executes the **wall isolation self-test** (recording `machine.wall_checked`), and publishes `t.machine.<machineId>.hb` heartbeats with verified devices.
   - Machine appears immediately in **Compute** (`<machine> › <device>`, e.g., `gpu-box › RTX 4090 · 24 GB · Ready`). `thermite leave` (or **Remove** in Compute) stops the service and revokes its NKey immediately.

---

## 3. Zero-Boilerplate Campaign Setup & Git Auto-Sync Config

### Sane Defaults (Eliminating 80% of v0.2 Boilerplate)

| Field | v0.2 Requirement | v1 Default |
| --- | --- | --- |
| `editable_paths` | Mandatory every time | `["**"]` (whole repo, excluding `.git/**` and `.thermite/**`) |
| `limits` (RAM/disk/timeout) | Fixed non-host-proportional defaults (`src/core/kit.ts`: `1024 MiB` run / `4096 MiB` build; `src/core/contract.ts`: `2048 MiB` lane / `4096 MiB` dev run; sample `matmul-cpu` kit: `256 MiB` run / `1024 MiB` build) | Host-proportional (`75%` runner RAM, `5x` baseline run time); **zero default turn/trial/spend caps** (Sans-I/O circuit breakers only: `3` infra crashes / `5` identical build failures) |
| `target` / `device` | Mandatory `type` + dummy `class` string | Inferred from requested device capability (`cpu` default) |
| `acceptance` / repeats | Manual `equivalence_band`, `runs_per_cell`, `audit` | Automatic baseline A/A noise calibration + interleaved A/B + B/A blocks (`min_effect: 0.03`) |
| `kit` repository | Mandatory separate git repo + 40-char commit SHA | Optional! Inline commands/files in `thermite.yaml` OR external `kit:` repo/folder for private/large benchmarks. Control always snapshots judge commands & hidden files into an immutable judge record **outside** worker zones so agents never read or modify the judge. |
| `git.onChampion` | Manual `.patch` download or external results repo | `push` (to `thermite/<campaign>/<run>`) when repo write access exists, else `none` (`thermite pull <run>`) |
| `live` | Separate multi-agent sync deployment | `false` (`true` projects sanitized run streams onto `t.live.<run>.>` for the `live-publish` plugin) |

### Minimal Campaign Manifests (`thermite.yaml`, 7–12 Lines)

**Hill climb (12 lines):**
```yaml
name: matmul-speed
mode: hill_climb
repo: https://github.com/org/matmul.git    # ref defaults to repo default branch, pinned at start
build: cc -O2 -o bench bench.c src/kernel.c
run: ./bench --size {size} --out {out}/res.txt
check: ./check.sh {out}/res.txt            # exit 0 = valid; optional last-line JSON metrics
cases:
  small: { size: 128 }
  large: { size: 512 }
  held:  { size: 384, hidden: true }
score: { metric: time_s, direction: min }
git: { onChampion: push, branch: thermite/matmul-speed }   # push | tag | none in v1.0 (pr: Phase 1.1)
live: false
```

**Goal campaign (9 lines):**
```yaml
name: add-fp16
mode: goal
repo: https://github.com/org/engine.git
build: cmake --build build
goals:
  - { id: tests, run: ctest --output-on-failure }
  - { id: speed, run: ./bench --fp16, metric: tok_s, op: ">=", value: 120 }
git: { onChampion: push, branch: thermite/add-fp16 }       # or onChampion: pr in Phase 1.1
live: false
```

**Research campaign (7 lines):**
```yaml
name: allocator-tail-latency
mode: research
topic: How modern allocators keep p99 latency low under high thread contention
questions:
  - Which thread-local caching designs avoid lock contention?
  - What do published benchmarks show for jemalloc vs mimalloc vs snmalloc?
seeds: [https://example.com/allocators-overview]
live: true
```

### Git Auto-Sync Policy (Bundled `git-sync` Plugin on `PluginApi`)

Control owns a bare Git mirror per project and holds sealed Git credentials (runners never hold push credentials). On every `attempt.promoted` domain event (and reducer `sync_git` effect), the bundled default-on `git-sync` plugin runs the configured policy and emits `git.sync_finished`:

| `git.onChampion` | Availability | Control Action |
| --- | --- | --- |
| `push` | **`v1.0`** | Fast-forward pushes real commit `Champion #<n>: <summary> (<delta>)` to `git.branch` (default `thermite/<campaign>/<run>`). Never force-pushes. |
| `tag` | **`v1.0`** | Pushes commit + annotated tag `thermite/<campaign>/champ-<n>`. |
| `none` | **`v1.0`** | Keeps commit in Control's bare mirror; fetch anytime via `thermite pull <run>` (fast incremental `git bundle` / patch) — replaces v0.2's giant export tarballs. |
| `pr` | **Phase 1.1** *(Open Call #5)* | Pushes branch and creates/updates one PR against `git.base` with benchmark delta table & attempt summary (GitHub/GitLab/Gitea API). |

### One-Surface Wizard (UI / CLI / MCP)

One typed `core/api` action set (`campaigns.validate`, `campaigns.dry_run`, `campaigns.create`, `runs.start`) backs every surface:
- **UI:** 1-page progressive creator (**Aim & Repo/Topic**, **How to Judge**, **Git & Live**, collapsed **Advanced**). Preserves form state on error (fixing v0.2's blank-reset pain) and provides one-click **Dry-run check** (validates build + baseline on a runner before starting agents).
- **CLI:** `thermite init` (5-prompt interactive generator -> `thermite.yaml`), `thermite run thermite.yaml [--dry-run]`, `thermite pull <run>`.
- **MCP:** External coding agents create, dry-run, launch, steer, and pull champions with the exact same JSON schema.

---

## 4. Cleanroom Repo/Branch Cutover Plan & Lean Checks

### Git Cutover Comparison

| Strategy | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **A. Dedicated `v1` branch in this repo** (clean tree keeping `packages/design-system/`, `docs/plan/v1/`, `LICENSE`, `SECURITY.md`, `CREDITS.md`, `.gitleaks.toml`, `scripts/checks/public.mjs`) | Preserves repo URL, stars, Issues, PRs, GHCR image namespace, and `packages/design-system`. Zero v0.2 code/tests/ratchets polluting search, imports, or Dependabot. `main` stays 100% untouched for `v0.2.x` patch releases (`fix/* -> main`). | Working on a `v0.2.x` hotfix concurrently requires a `git worktree` (one command). | **Recommended** |
| **B. `v1/` subdirectory inside `main` / `v0.3.0`** | Single checkout sees v0.2 and v1 side-by-side. | 220k LOC + 161k test LOC remain in tree; root workspace/lockfile/Biome/TS collisions; ugly `v1/` prefix must be moved at launch; agents accidentally import v0.2 files. | Reject |
| **C. Separate sibling repository (`thermite-v1`)** | Complete physical separation. | Splits Issues, stars, releases, CI secrets, and GHCR images; duplicates `packages/design-system` and `docs/_site`; painful rename/archive at launch. | Reject |

### Exact Cutover Sequence (Zero History Rewrite on `main`)

1. **Start Goal 1:** `git checkout -b v1 main`; commit #1 removes v0.2's `src/`, `web/`, `tests/`, `kits/`, `containers/`, and v0.2 check baselines while keeping `packages/design-system/`, `docs/plan/v1/`, `LICENSE`, `SECURITY.md`, `CREDITS.md`, `.gitleaks.toml`, and `scripts/checks/public.mjs`, and scaffolds the minimal workspace root (`packages/{core,control,runner,cli,ui,design-system}`).
2. **Parallel `v0.2.x` maintenance:** Patch fixes branch from `main` (`fix/*`), tag `v0.2.5+`, and never merge into `v1`.
3. **`v1.0.0` promotion (without force-pushing `main`):**
   - Preserve v0.2 on a permanent branch `release/v0.2` from `main`.
   - Merge `main` into `v1` with `git merge -s ours main -m "Prepare v1.0.0 cleanroom cutover"` (records full lineage while keeping 100% of `v1`'s clean tree), then fast-forward `main` to `v1` and tag `v1.0.0`.
   - `v0.2` deployments remain unaffected until the operator installs `v1.0` cleanly.

### Lean Pre-Commit Checks (`< 2 min`, Zero Churn Traps)

| Check | Status in `v1` | Target Time | Rationale |
| --- | --- | --- | --- |
| `npm run typecheck` (`tsc --noEmit` across workspaces) | **Keep** | `~8s` | Catches contract/API/Sans-I/O type breaks immediately. |
| `npm run lint` (Biome + `noFloatingPromises`) | **Keep** | `~3s` | Fast formatting + real async bug prevention. |
| `npm run check:public` (`scripts/checks/public.mjs`) | **Keep** | `< 2s` | Mandatory public-repository & secret hygiene gate. |
| `npm test` (Sans-I/O unit + judge math + API/PGlite) | **Keep** | `~20–40s` | Deterministic, millisecond domain & verdict proof without container bloat. |
| `npm run build:ui` (only when `ui` / `design-system` touched) | **Keep** | `~8s` | Confirms browser bundle compiles cleanly. |
| Real Postgres + NATS + browser + compose smoke | **CI / release only** | CI | Keeps local inner loop under 1 minute; CI validates real services. |
| `check:sizes` (`size-baseline.json`, `--lower`, `--due`, 700/800-line forced splits) | **Drop** | — | Created mechanical splitting churn and `--lower` commit failures. Enforce clean single-job files in review. |
| `check:loose-ends` (25 KB `loose-ends.json`, `--lower` ratchet) | **Drop** | — | Biome/TS catch real unused locals; exception ratchets waste agent turns. |
| `check:imports` (`import-exceptions.json`, folder-order matrices) | **Drop** | — | npm workspace `package.json` `exports` enforce package boundaries natively. |
| `tests/web/design-system.test.ts` regex `className=` ban | **Drop** | — | Brittle regex friction on layout utilities; enforce design-system usage via shared components & stories. |

---

## 5. Exact `v1.0` MVP vs. Post-MVP Plugin Cut Line

Target `v1.0` MVP footprint: **~10,000–15,000 LOC** total (over 15x smaller than v0.2's 220k LOC), proving every core invariant end-to-end before growing strictly through plugins.

| Area | `v1.0` Core MVP (Ship First) | Post-MVP Plugin / Phase | Cut Rationale |
| --- | --- | --- | --- |
| **Core & Bus** | `packages/core`: Sans-I/O reducers (run, judge, scheduler, circuit breakers, delegation policy), NATS JetStream subjects, `core/api` typed registry, `core/plugin` loader + hooks (`provide`/`need`, `onEvent`, `register*`). | Additional hook widenings only when a second real plugin needs them. | Non-negotiable cleanroom spine. |
| **Agent Loop** | Built-in `libfx` loop behind `harness-*` seam (durable Postgres sessions, streaming, steering, cancel, provider catalogue incl. local LAN HTTP servers). | **Phase 1.1:** `harness-claude` (Claude Code), `harness-agy`, `harness-codex`, `harness-pi`. | Proves `libfx` + `harness-*` seam with zero CLI-PTY bloat in v1.0. |
| **Campaign Modes** | **Hill climb** (interleaved A/B+B/A + A/A calibration + held-out), **Goal** (code verifiers + metric threshold + review panel), **Research** (seed fetch/archive + verified quotes + oscillation breaker + report). | Custom campaign modes, custom judges, and event-driven advisor packs (`advisors-*`) via `registerJudge`/`onEvent`. | All 3 core product modes work on day 1 with pure Sans-I/O logic. |
| **Runners, Devices & Walls** | Thin `packages/runner` over NATS (`thermite join`, NKey scoped auth, `wall-container` + isolation self-test) + `device-cpu` & `device-cuda`; Control-plane `wall-tools` / `wall-os` (per [wasm-isolation-spike.md](./wasm-isolation-spike.md)). | **Phase 1.1:** `device-metal` (native macOS MLX), `device-vulkan`, `device-rocm`; `compute-ssh`, `compute-k8s`, `compute-runpod`; `wall-microsandbox` (`libkrun` microVMs). | One runner + CPU/CUDA proves local + GPU runs; cloud/cluster drivers and microVMs don't block MVP. |
| **Surfaces & UI** | Unified `core/api` -> REST + MCP + `packages/cli` (`up`, `join`, `init`, `run`, `status`, `pull`) + slim `packages/ui` on synced `packages/design-system`: **Onboarding, Home/Needs you, Compute, Knowledge, Campaigns + Run (Summary/Live/Attempts/Results), Setup (Providers/Git/Policy/Plugins)**. | **Phase 1.2–1.3:** `web-pairing` (`web.usethermite.com` WebRTC P2P), `live-publish` (`thermite live` / `live.usethermite.com` on `t.live.<run>.>`), `thermy` copilot, `sql-explorer` (read-only views + saved queries), `⌘K` global search. | Daily research loop + full delegation parity + `README.md` core nav first; secondary surfaces plug into UI slots & NATS. |
| **Git, Knowledge & Data Flows** | Bundled default-on `git-sync` plugin (`push \| tag \| none`) + `thermite pull <run>` from Control's bare mirror + bundled `matmul-cpu` sample + lean core PG 18 FTS/`pg_trgm` Knowledge (~950 LOC per [knowledge-research.md](./knowledge-research.md)). | **Phase 1.1:** `git-sync` `pr` adapter *(Open Call #5)*. **Phase 1.2:** `distill-jsonl` (redacted SFT / preference-pair / trajectory JSONL exporter), `knowledge-semantic` (`pgvector` HNSW + optional local/remote embedder). **Phase 1.3:** `knowledge-bm25`, `knowledge-ingest-pdf`, `knowledge-graph`. | Dogfoods `PluginApi` on day 1, replaces v0.2's 11.6k-LOC SQLite KB with ~950 LOC PG FTS, and keeps embeddings/distillation strictly pluggable. |
| **Delegation & Auth** | Configurable `PolicyGrant` profiles (`viewer`, `operator`, `autonomous_delegate`, `owner`) — full autonomous end-to-end delegation when owner opts in; internal `run_worker`/`run_advisor` stay walled from door & judge. | Enterprise SSO / multi-tenant RBAC plugins if ever needed. | Fixes v0.2's hardcoded `OWNER_ONLY_KINDS` walls from commit #1. |

---

## Open Owner Calls (Decide Before Goal 1)

| # | Decision | Recommendation | Impact |
| --- | --- | --- | --- |
| **1** | **Cleanroom git home** (`v1` branch vs `v1/` dir vs sibling repo) | **`v1` branch in this repo**, preserving `packages/design-system/`, `docs/plan/v1/`, and `scripts/checks/public.mjs`; `main` untouched for `v0.2.x` fixes until `v1.0.0` cutover. | Locks Goal 1 repo scaffold & CI workflow immediately. |
| **2** | **NATS-over-WebSocket (`wss://<control>/nats`) fallback in `v1.0`** | **Include in `v1.0`** alongside direct TLS `:4222`. NATS 2.15 supports WebSockets natively behind `control`'s `:8800` proxy, so `thermite join` works through Tailscale `serve --bg 8800` or any single HTTPS proxy with zero extra port forwarding. | Removes the #1 networking blocker for remote machines. |
| **3** | **Native macOS runner (`launchd` + `device-metal`) timing** | **Phase 1.1** right after `v1.0` vertical slice (keep `v1.0` focused on Linux `wall-container` + `device-cpu`/`device-cuda`), *unless* Apple Silicon MLX campaigns are required on `v1.0` day 1. | Keeps `v1.0` wall-proof & test matrix minimal (~1 week saved). |
| **4** | **Loopback authentication on single-user installs** | **Create owner username + password in Step 1 of first-run UI** (long-lived cookie; zero token copy-paste), with optional `THERMITE_NO_AUTH_LOOPBACK=1` for local dev. | Cleanly supports delegation policies & remote exposure without v0.2's `.dev/secrets` token dance. |
| **5** | **`git.onChampion: pr` in `v1.0` vs Phase 1.1** | Keep **`push`, `tag`, and `none`** in the `v1.0` `git-sync` plugin (pure `git`, zero host-specific API code) and add **`pr`** (GitHub/GitLab/Gitea API adapter) in Phase 1.1 — or pull into `v1.0` if PR automation is required on day 1. | Saves forge-specific OAuth/API edge cases during initial vertical slice. |
