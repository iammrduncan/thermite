# Control-Plane Isolation Exploration: V8 Isolates, WASM Sandboxes & Alternatives

> **Status: Goal 0 Technical Exploration (2026-11-28) — NOT a decision or directive.**
> Scope: **Control-plane agent zones only** (running `libfx`, workspace reading/editing/git, and later external CLI harnesses while offloading builds, tests, and benchmarks to compute machines over NATS via `run_experiment`). Compute machine runners remain bare metal, VM, or container per workload.

---

## TL;DR Verdict

| Question | Verdict | Why (verified) |
| --- | --- | --- |
| Run full Control-plane agent zones (`libfx` + git + shell) inside V8 isolates / WASM? | **NO-GO** as universal wall | `libfx`'s fast native N-API addon cannot load in isolates/WASM; its WASM build requires JSPI (missing in Node 22 LTS); `isomorphic-git` + `memfs` fails on large C++/Zig/Rust repos; external CLIs (`claude`, `agy`) cannot run in isolates/WASM. |
| Eliminate Docker/Podman as a hard dependency for Control? | **GO (Conditional)** | Do **not** sandbox `libfx` itself — `libfx` already disables built-in shell/FS tools and runs only host-injected `fetch` + `tools`. Keep `libfx` + sealed secrets on host Node and put **only untrusted tool/CLI execution** behind a swappable `Wall` plugin interface. |
| Recommended Control-plane `Wall` stack | **Two-tier zero-container default + pluggable hardened walls** | **Tier 1 (`wall-tools`):** capability-jailed host `git worktree` + structured file tools (plus optional WASM virtual bash) for pure `libfx` & research runs. **Tier 2 (`wall-os`):** Linux `bubblewrap` + Landlock + seccomp / macOS `Seatbelt` + host egress proxy for local shell & external CLI harnesses. **Tier 3 (optional plugins):** `wall-container` (rootless Podman/Docker) & `wall-microsandbox` (`libkrun` microVMs). |

---

## 1. Verified `libfx` & Runtime Findings

Direct inspection of `libfx@0.0.16` (Vercel Labs, Apache-2.0) and local execution on Node.js `v22.23.4` (V8 `12.4`):

1. **Same Zig engine ships in two forms (`package.json`):**
   - **Native N-API addon (`@libfx/libfx-linux-x64-gnu/libfx.node`, 9.08 MB; also `linux-arm64-gnu`, `darwin-x64`, `darwin-arm64`):** ELF symbol inspection confirms `GLIBC_2.34` (plus `2.2`–`2.28`), verifying Goal 260's Linux glibc 2.34+ requirement. **Cannot load inside `isolated-vm`, `workerd`, Deno isolates, or Wasmtime** (none expose Node N-API).
   - **WebAssembly module (`fx-core.wasm`, 2.26 MB, via `libfx/wasm` and `libfx/browser`; `fx-term.wasm` is 3.55 MB):** Requires **WebAssembly JSPI** (`typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function"`, `engine.js:651`).
2. **Verified Node 22 LTS blocker for `fx-core.wasm`:**
   - Running `libfx`'s `getBackendInfo({ nativeAddon: false })` on Node.js `v22.23.4` returns `backend: "unavailable"` (`LIBFX_JSPI_UNAVAILABLE`).
   - Node 22's V8 12.4 does **not** expose `WebAssembly.Suspending` or `WebAssembly.promising` (even with `--experimental-wasm-stack-switching`; `--experimental-wasm-jspi` is not a recognized flag on Node 22.23.4). `fx-core.wasm` in Node requires **Node 24+** (or Deno 2.x / `workerd` / browsers).
3. **Architectural inversion — `libfx` is trusted orchestration, not untrusted code:**
   - Per `libfx` README ("Security"): *"libfx orders [tool] calls but grants nothing itself, and the native backend doesn't turn on fx's built-in shell or file tools."*
   - Putting `libfx` inside a V8 isolate or WASM sandbox solves the wrong problem: it forfeits native N-API speed on Node 22, complicates durable Postgres session writers and SSE/NATS streaming, and still forces model credentials (or a proxy boundary) outside the isolate.
   - The real Control-plane threat boundary sits **between Control host (`libfx` + secrets + Postgres + NATS + Judge decisions) and worker tool execution / external CLI processes**.

---

## 2. 2026 Runtime Candidates — Comparison Matrix

| Candidate | Mechanism (2026) | Zero Container? | Runs `libfx`? | Native `git` / `rg` / `python3`? | Runs External CLIs (`claude`, `agy`)? | OS Support | Security Boundary & Key Caveats | Control-Plane Fit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **`isolated-vm`** | Embedded V8 isolates via C++ addon | Yes | No (no N-API; JSPI fragile) | No | No | Linux, macOS, Win | **Maintenance mode**; V8 C++ churn breaks every Node LTS (`5.x` N22, `6.x` N24, `7.x` N26); `node-gyp` build pain; `--no-node-snapshot`. | **No-Go** |
| **Cloudflare `workerd` / Miniflare** | V8 isolates + Dynamic Worker Loader (`globalOutbound: null`, `nodejs_compat` default since `2026-08-04`, native JSPI) | Yes | WASM only (`fx-core.wasm`) | No | No | Linux, macOS | Cloudflare explicitly warns **Miniflare is not a hardened local security boundary**; embedding raw `workerd` adds a C++ daemon for JS/WASM-only tools. | **No-Go** for general zones; niche for untrusted JS plugins |
| **Deno isolates / `deno_core`** | V8 + deny-by-default permissions (`--allow-read`/`--allow-net`); JSPI via V8 | Yes | WASM only | No (unless `--allow-run`, which breaks isolate boundary) | No | Linux, macOS, Win | Embedding `deno_core` requires Rust host; subprocess `deno` is weaker than OS sandbox once `--allow-run` is needed. Notably, Deno itself built **Deno Sandbox on microVMs** for AI agents. | **No-Go** |
| **Node `--permission`** | Process-level JS API allowlists (stable since Node 22.13 / 23.5) | Yes | Yes (native) | Only with `--allow-child-process` (no child confinement!) | No confinement | All | Node Security Policy explicitly states it is a **"seat belt," NOT a sandbox** against untrusted code (e.g., prefix-matching bugs such as CVE-2026-58043, RCE bypasses). | **Defense-in-depth only**, never sole wall |
| **WASM / WASI P2 (`wasmtime`, `jco`, `wasmer`, `extism`, `QuickJS-in-WASM`)** | Capability-based WASI 0.2/0.3 components, linear memory isolation, fuel/epoch CPU limits | Yes | `fx-core.wasm` is JSPI/browser-targeted, not WASI P2 | No native POSIX binaries (`rg`, `python3`, C `git`) | No | Linux, macOS, Win | Strong memory/capability sandbox; `jco` runs in-process on Node (inherits host process fault domain unless paired with `wasmtime`). Great for **untrusted tool plugins** or virtual bash. | **Conditional Go** for tool-level sandboxing / virtual bash only |
| **Virtual Bash (`bashkit-wasm` / `just-bash`)** | In-process POSIX-subset interpreter (Rust/WASM or TS AST) over scoped VFS/mounts | Yes | N/A (tool runtime) | Partial: 70–230 builtins (`grep`, `sed`, `awk`, `jq`, pipes), **no** native `python3`/compilers/C `git` | No | All | Zero process spawn; default-deny network; fast Unix pipelines for `libfx` workers; cannot replace real OS shell for arbitrary binaries or external CLIs. | **Optional Tier-1 accelerator** for `libfx` lanes |
| **OS-native sandbox (`wall-os`: `bubblewrap` + Landlock + seccomp / macOS `Seatbelt`, `@anthropic-ai/sandbox-runtime` pattern)** | Kernel FS/mount/netns isolation + host HTTP/SOCKS5 allowlist proxy (Apache-2.0) | **Yes** | Host runs `libfx`; wall wraps tools & CLIs | **Yes** (native `git`, `rg`, `python3`, linters) | **Yes** (`claude`, `agy`, `codex`) | Linux, macOS (Win alpha) | Sub-10ms startup; shares host kernel (not kernel-exploit proof); Linux `bwrap` needs unprivileged userns (sometimes restricted in locked-down K8s/Ubuntu AppArmor — detect at `selfTest` and fall back to Landlock or container). | **GO (Primary Tier-2 wall)** |
| **`microsandbox` (`libkrun`)** | Embeddable microVMs w/ dedicated guest kernel, OCI images, <100ms boot (Apache-2.0) | **Yes** (no Docker daemon) | Host runs `libfx`; VM wraps zone/CLI | **Yes** | **Yes** | Linux (KVM), macOS (HVF), Win (WHP) | Hardware kernel isolation; **blocker for universal default:** Linux requires `/dev/kvm`, which is unavailable in most cloud VMs & standard K8s pods without nested virtualization. | **GO as optional Tier-3 plugin** (aligns w/ Goal 277) |
| **Firecracker** | Linux KVM microVMM | Yes | Host `libfx`; VM wraps zone | Yes | Yes | Linux KVM only | Strongest Linux isolation, but no macOS/Windows support and heavy rootfs/TAP networking plumbing. | **No-Go** for default Control; cloud-only option |
| **Rootless Podman / Docker** | Linux namespaces + cgroups v2 + seccomp + nftables egress (as in `fxbot` `computer` plugin & Thermite v0.2) | No (needs container engine) | Host `libfx` or in-container | Yes | Yes | Linux, macOS (VM) | Proven wall for Thermite; works inside setups where `bwrap` userns isn't suitable, or for multi-tenant hosts; adds container-engine install friction. | **GO as optional Tier-3 plugin / fallback** |

---

## 3. Compatibility Checks Against Thermite v1 Control-Plane Requirements

### A. Git & Large Repositories (e.g., `llama.cpp`, C++/Zig/Rust Engines)
- **Virtual FS (`memfs` + `isomorphic-git`) is a No-Go for real repos:**
  - `isomorphic-git` parses packfiles and inflates tree/blob objects on the single-threaded JS heap (V8 ~1.4–4 GB cap). On large C++ repos, repeated `status`/`diff` calls stall the event loop and risk OOM when 4–16 concurrent lanes each hold a virtual checkout.
  - Diff fidelity and speed lag far behind native C Git (`mmap` packfiles, commit-graph, Histogram/Myers diff, binary diffs, pathspec globs like `git add -A -- ':(glob)...' && git diff --cached --binary` in `src/harness/agents/worker/tools.ts:273-278`).
- **Recommended workspace layout:** Control maintains one **bare Git mirror** per repo on host disk and checks out a lightweight **`git worktree`** per trial/zone. Object storage is shared across all lanes (tiny RAM/disk footprint), native `git` runs on the host or inside `wall-os`, and Control itself computes/validates the submission patch against `editable_paths` before dispatching the job + commit ref over NATS for the runner to fetch via Git-HTTP.

### B. Tool Execution Ergonomics (`run` vs `run_experiment`)
Today's built-in worker (`src/harness/agents/worker/tools.ts`, `src/harness/agents/lanetool.ts`) calls three classes of tools:
1. **Control-native RPCs (always in-host, zero sandbox needed):** `status`, `idea`, `note`, `fetch` (SSRF-filtered by Control), `kb_*`, kit MCP gateway, `submit_experiment`, and `run_experiment` (dispatched over NATS to a machine runner).
2. **Scoped file/search operations (`list_files`, `read_file`, `write_file`, `edit_file`, `search`):** Pure path-jailed I/O inside the trial's worktree (enforcing `realpath` containment and rejecting symlinks out of root, as `src/harness/agents/lanetool.ts:34-46` already does). Zero OS shell needed.
3. **Local inspection shell (`run`):** Agents frequently run `rg`, `git log`/`diff`, `python3 -c` quick math/parsing, or syntax/AST checks locally rather than paying a NATS round-trip to a busy GPU runner.
   - If a campaign disables local OS shell (e.g., pure research or strict `libfx`-only mode), **Tier 1 (`wall-tools`)** + optional **`bashkit-wasm` / `just-bash`** handles Unix pipelines (`grep | awk | sed | jq`) in-process with zero OS process spawning.
   - When agents need native local binaries (`python3`, `rg`, `clang-format`, `tree-sitter`), **Tier 2 (`wall-os`)** runs them in <10ms without any container engine.

### C. External CLI Harnesses (`harness-claude`, `harness-agy`, `harness-codex`)
- External coding agents bundle their own native/Node binaries, internal Bash tools, MCP clients, and session files — they **cannot** execute inside V8 isolates or WASI components.
- By putting the `Wall` boundary around the **worker zone** (workspace + process execution + egress proxy) rather than assuming an in-isolate agent loop, both `libfx` (in-host loop + walled tools) and external CLIs (walled process talking to Control's model proxy and `thermite-trial`/MCP over a scoped Unix socket or loopback token) work through the exact same `Wall` plugin seam.

### D. Security Boundary & Control-Plane Isolation Self-Test
Adapting Thermite's proof-based isolation model (`src/harness/selftest/index.ts`, `probes.ts`, `docs/plan/v1/README.md` §3) to the Control plane:

| Security Property | How Tier 1 (`wall-tools`) Enforces It | How Tier 2 (`wall-os`) Enforces It | Active Self-Test Proof (`wall.selfTest()`) |
| --- | --- | --- | --- |
| **Secret isolation** | Model keys, OAuth tokens, Postgres DSN, NATS creds never enter tool arguments or worktree; `libfx` uses Control's `fetch`/proxy. | Scrubbed child env; only scoped trial token + local model-proxy URL injected; Linux PID namespace hides host `/proc/*/environ`. | Probe reads own env + `/proc/*/environ` + Control secret file paths -> must all fail / return none. |
| **FS & cross-lane jail** | Canonical `realpath` jail + symlink refusal (`O_NOFOLLOW`) + `editable_paths` enforcement at patch time; no arbitrary exec. | Linux `bwrap` read-only root + bind-mounted trial worktree + private `/tmp` (or Landlock ruleset); macOS Seatbelt allowlist for worktree + private tmpdir. | Probe attempts read/list/write on Control state, judge code, git mirror, sibling zone, `/tmp` shared escape, and symlink traversal -> must all be refused. |
| **Network / SSRF control** | No raw socket tool; `fetch` runs through Control's SSRF-blocking `Fetcher` (refuses loopback, RFC 1918, link-local metadata). | Linux `--unshare-net` + Unix-socket bridge to host HTTP/SOCKS5 allowlist proxy; macOS Seatbelt blocks direct sockets except host proxy port (`srt` pattern). | Probe opens TCP to Postgres port, NATS port, loopback Control admin port, RFC 1918 / link-local metadata / K8s API -> must fail. |
| **CPU / RAM / FD / PID limits** | In-process byte/file/match caps (`MAX_READ_BYTES`, `MAX_SEARCH_FILES`) + WASM fuel/memory cap if virtual bash enabled. | Host-proportional `RLIMIT_AS`/`RLIMIT_NOFILE`/`RLIMIT_NPROC` or cgroup v2 slice (Linux), disk quota checks, and `-pgid` process-group kill on timeout (never killing the worker session). | Probe verifies timeout kills spawned grandchild process group cleanly and does not leak orphan processes. |

---

## 4. Architecture Sketch: Full-Isolate (Rejected) vs. Host-`libfx` + Pluggable `Wall` (Recommended)

```text
REJECTED: Full V8-Isolate / WASM Agent Zone
┌─────────────────────────────────────────────────────────────────────────┐
│ Control Host                                                            │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ V8 Isolate / WASM Sandbox (per worker)                            │  │
│  │  • libfx native addon FAILS; fx-core.wasm FAILS on Node 22 (JSPI) │  │
│  │  • memfs + isomorphic-git OOMs/stalls on large C++/Zig/Rust repos │  │
│  │  • External CLIs (claude, agy) CANNOT run here -> split codebase  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘

RECOMMENDED: Host-Orchestrated libfx + Swappable Wall Plugin
┌─────────────────────────────────────────────────────────────────────────┐
│ Control Host (Node.js LTS — zero container engine required)             │
│                                                                         │
│  [Sealed Secrets & Model Proxy]   [Postgres + NATS]   [Sans-I/O Core]   │
│         ▲                                                    ▲          │
│         │ (custom fetch; keys never leave host)              │ events   │
│  ┌──────┴────────────────────────────────────────────────────┴───────┐  │
│  │ Built-in libfx Loop (native N-API addon; built-in shell/FS OFF)   │  │
│  │   • Control RPC tools: run_experiment (NATS), kb, note, fetch     │  │
│  │   • Workspace/exec tools ────────────────────┐                    │  │
│  └──────────────────────────────────────────────┼────────────────────┘  │
│                                                 ▼                       │
│  ═══════════════════════════ Wall Interface (registerWall) ═══════════  │
│   │                         │                         │                 │
│   ▼                         ▼                         ▼                 │
│  [Tier 1: wall-tools]    [Tier 2: wall-os]         [Tier 3: plugins]    │
│  • Jailed git worktree   • Linux: bwrap+Landlock   • wall-container     │
│  • Structured FS tools     + netns -> host proxy     (rootless Podman/  │
│  • Optional bashkit-wasm • macOS: Seatbelt ->        Docker)            │
│    / just-bash             host proxy              • wall-microsandbox  │
│  • Zero OS shell         • Runs local run() shell    (libkrun microVM)  │
│  • Default for research    AND external CLIs                            │
│    & shell-free libfx      (harness-claude, agy)                        │
└─────────────────────────────────────────────────────────────────────────┘
             │ (job dispatch + commit ref over NATS; Git-HTTP fetch)
             ▼
    [Thin Machine Runner — bare metal / VM / container on GPU/target]
```

### Minimal `Wall` Plugin Seam (Plain TypeScript, `registerWall`)

Aligned with `v1`'s slim, class-free plugin model (`core/plugin` + proof-based trust in [`sansio-nats-contract.md`](./sansio-nats-contract.md)):

```ts
export type WallBoundary = "app" | "wasm" | "os" | "container" | "microvm";

export interface WallCapabilities {
  boundary: WallBoundary;
  localShell: boolean;     // supports arbitrary workspace exec()
  externalCli: boolean;    // can host harness-claude / harness-agy processes
  networkProxy: boolean;   // enforces egress allowlist / SSRF block
}

export interface ZoneSpec {
  runId: string;
  laneId: string;
  workspaceDir: string;    // Control-managed git worktree path
  scratchDir: string;      // private writable /tmp for this zone only
  readOnlyMounts?: string[]; // e.g. run research folder
  proxySocketOrUrl?: string; // scoped model + trial API proxy (no raw keys)
  limits: { memoryMb: number; diskMb: number; maxProcs?: number; timeoutMs?: number };
}

export interface ZoneExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  killedFor?: "timeout" | "memory" | "disk" | "cancelled";
}

export interface Zone {
  readonly id: string;
  readonly workspaceDir: string;
  readFile(relPath: string, opts?: { offset?: number; limit?: number }): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  editFile(relPath: string, oldText: string, newText: string, all?: boolean): Promise<number>;
  listFiles(relPath?: string, depth?: number): Promise<string[]>;
  searchFiles(pattern: string, relPath?: string): Promise<string[]>;
  exec?(argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal }): Promise<ZoneExecResult>;
  destroy(): Promise<void>;
}

export interface WallSelfTestReport {
  ok: boolean;
  wallId: string;
  boundary: WallBoundary;
  probes: Record<string, string>; // "refused" / "blocked" / "ALLOWED ..."
  skipped: string[];
}

export interface WallPlugin {
  readonly id: string;
  readonly version: string;
  capabilities: WallCapabilities;
  probeAvailable(): Promise<{ ok: boolean; reason?: string }>;
  createZone(spec: ZoneSpec): Promise<Zone>;
  selfTest(targets: { secretFile: string; stateDir: string; siblingDir: string; blockedTcp: { host: string; port: number }[] }): Promise<WallSelfTestReport>;
}
```

**Why this seam stays small and future-proof:**
- `v1.0` core only talks to `WallPlugin` + `Zone`, never naming `bwrap`, `sandbox-exec`, `podman`, or `microsandbox`. Control-plane `createZone(spec)` + `Zone.exec` + `selfTest()` refines [`sansio-nats-contract.md`](./sansio-nats-contract.md)'s `registerWall` (`prepare` / `exec` / `selfTest`) sketch and exposes `version` for audit/enrollment records.
- A campaign/harness requests capabilities (e.g., `harness-claude` requires `externalCli: true`; a research run needs only `localShell: false`), and Control picks the strongest available `WallPlugin` that passes `selfTest()`.
- Because `libfx` runs on the Control host, switching from `wall-tools` to `wall-os` to `wall-microsandbox` changes **zero lines** of `libfx`, NATS, Postgres, or Sans-I/O core logic.

---

## 5. Recommended Rollout & Open Owner Calls

### Practical Rollout Path (If Adopted)
1. **v1.0 MVP — Control-plane zones (`wall-tools` + `wall-os`):** Ship zero-container Control from day one (while compute runners keep `wall-container` as their `v1.0` default per [`sansio-nats-contract.md`](./sansio-nats-contract.md) and [`onboarding-and-mvp.md`](./onboarding-and-mvp.md)).
   - `wall-tools` covers pure research runs and shell-free `libfx` code runs everywhere (Linux, macOS, Windows, inside K8s pods with no special privileges).
   - `wall-os` (inspired by `@anthropic-ai/sandbox-runtime`, Apache-2.0: `bwrap` + Landlock + seccomp + netns proxy on Linux; `Seatbelt` + host proxy on macOS) covers local `run` shell tools and unlocks `harness-claude` / `harness-agy` plugins with zero Docker/Podman dependency.
2. **Post-MVP Control-plane hardening plugins (`wall-container`, `wall-microsandbox`):**
   - `wall-container` (rootless Podman/Docker) can also wrap Control-plane zones on locked-down Linux hosts where unprivileged user namespaces are disabled or operators want container-grade separation.
   - `wall-microsandbox` (`libkrun`, Apache-2.0) adds true guest-kernel isolation on KVM Linux & Apple Silicon macOS (aligning cleanly with Goal 277's runner study).

### Open Owner Calls

1. **Should `v1.0` `libfx` workers default to *no local OS shell* (`wall-tools` + remote `run_experiment`), or enable local sandboxed shell (`wall-os`) by default?**
   - *Tradeoff:* Shell-free `wall-tools` works on every OS/K8s pod with zero host dependencies and minimal attack surface, but forces any `python3`/compiler/test quick-check onto a compute runner over NATS. Enabling `wall-os` locally keeps quick inspection/scripting instant at the cost of requiring `bwrap` (Linux) or `Seatbelt` (macOS).
2. **Do we want an optional in-process virtual bash (`bashkit-wasm` or `just-bash`) inside `wall-tools`?**
   - *Tradeoff:* Gives shell-free `libfx` workers familiar Unix pipelines (`grep | awk | jq | sed`) over their worktree with zero OS processes, at ~1 dependency + small adapter cost. Alternatively, keep `v1.0` strictly to `read`/`write`/`edit`/`list`/`search` until real runs show LLMs miss pipes.
3. **Is Linux + macOS (`bwrap` + `Seatbelt`) sufficient for zero-container `wall-os`, with `wall-container` as fallback on restricted Linux hosts (e.g., K8s pods without userns)?**
   - *Note:* Native Windows process sandboxing (`srt` WFP/SID approach) is still alpha; Windows users could run `wall-tools` natively or WSL2/container for CLI harnesses.
4. **Keep `wall-microsandbox` (`libkrun`) strictly post-MVP (with Goal 277) rather than `v1.0`?**
   - *Why recommended:* Requires `/dev/kvm` on Linux (breaks in standard cloud VMs / K8s pods without nested virt), whereas `wall-tools` + `wall-os` covers 95%+ of local and server Control installs with less moving parts.
