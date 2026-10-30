---
title: "Harness image"
description: "What the harness, supervisor and control images and the one-container rig image contain: base images, toolchains, users and groups, paths and build arguments."
type: reference
sidebar:
  order: 13
---

Thermite runs as three container images. The **harness** image holds a rig's judge, broker and agents; the **supervisor** image is the rig's link to the outside; the **control** image is the central service. A fourth, the **one-container rig image**, puts a rig's harness and supervisor in one container, for hosts that run one container per machine, such as RunPod. This page lists what each one contains. [Extend the harness image](../how-to/install/extend-harness-image.md) adds your project's tools, and [Push the images to your own registry](../how-to/install/own-registry.md) builds them. The [glossary](glossary.md) explains the terms.

Each image is built from the repository's root, from its own file:

| Image | Built from |
| --- | --- |
| Harness | `containers/harness/Containerfile` |
| Supervisor | `containers/supervisor/Containerfile` |
| Control | `containers/control/Containerfile` |
| One-container rig | `containers/rig/Containerfile`, on a harness image built first |

```sh
docker build -t thermite-harness -f containers/harness/Containerfile .
```

`podman build` takes the same arguments. In a checkout of the source code, `docker compose build` builds all three.

## Published images

For each release, the release workflow (`.github/workflows/release.yml`) builds the images from these files and pushes them to GitHub's container registry, under the repository owner's name. It builds every layer again, without the build cache, so each image has its base's newest system packages:

| Image | Name | Tags | Architectures |
| --- | --- | --- | --- |
| Control | `ghcr.io/iammrduncan/thermite-control` | The version, such as `0.1.0`, and the first 12 characters of the commit | amd64, arm64 |
| Harness, CPU | `ghcr.io/iammrduncan/thermite-harness` | The same | amd64, arm64 |
| Harness, CUDA 12 | `ghcr.io/iammrduncan/thermite-harness` | The same, each with `-cuda` added: `0.1.0-cuda`. For Pascal to Hopper, the P100 and V100 included | amd64 |
| Harness, CUDA 13 | `ghcr.io/iammrduncan/thermite-harness` | The same, each with `-cuda13` added: `0.1.0-cuda13`. For Turing to Blackwell, the DGX Spark included. Untested: see [Known limits](known-limits.md#the-cuda-13-harness-is-untested) | amd64, arm64 |
| Supervisor | `ghcr.io/iammrduncan/thermite-supervisor` | The version and the commit | amd64, arm64 |
| One-container rig, CUDA | `ghcr.io/iammrduncan/thermite-rig` | The version and the commit, each with `-cuda` added: `0.1.0-cuda` | amd64 |

Each image is pushed first with its commit's tag only. Then the workflow pulls each one by its digest, on a runner that never signed in, and checks it: it pulls without signing in, it is published for each architecture in the table, it reports the release's commit, it carries no Claude Code, it has no set-id file, and it sets no key, token or password in its environment. The harness images and the rig image also report their image ID and carry neither socat nor bubblewrap; the supervisor and the rig image name no STE checker, which is a deployment's own. Only an image that passes gets the version's tag, which names the same digest as the commit's. The run's step summary lists every image with its digest.

Between releases, a maintainer can publish a build by hand: the same images and checks, with the commit's tag only and no release. A lab pins such a build by its digest, for example as control's RunPod rig image.

The workflow builds the one-container rig image on the CUDA 12 harness it built in the same run, named by that image's digest. The workflow sets no `CLAUDE_CODE_VERSION`, so no published image carries Claude Code. The harness images and the supervisor image carry OpenCode and the Codex CLI, both open source, at their default versions. A release's `compose.yaml` names each image by its digest, not by a tag, and gives control the rig image as `THERMITE_RUNPOD_RIG_IMAGE`, the image a [rig launched on RunPod](rest-api.md#rigs-on-a-gpu-cloud) runs. Each image also has these labels (and, for an image of two architectures, the same annotations on its index):

| Label | Value |
| --- | --- |
| `org.opencontainers.image.source` | The repository, `https://github.com/iammrduncan/thermite`. GitHub links each package to the repository by it |
| `org.opencontainers.image.version` | The release's version, such as `0.1.0` |
| `org.opencontainers.image.revision` | The full commit the image was built from |
| `org.opencontainers.image.title`, `org.opencontainers.image.description` | The image's name and what it is |
| `org.opencontainers.image.licenses` | `MIT AND Apache-2.0` for the harness images, the rig image and the supervisor image: they carry the Codex CLI, under the Apache License 2.0 with its `NOTICE`, and OpenCode, under MIT, beside Thermite. `MIT` for control. Control's image also carries kubectl, under the Apache License 2.0, with its license file; its label stays `MIT` |

The workflow builds control, the harness images and the supervisor with `THERMITE_COMMIT` set to the full commit, so each service reports that commit with the version in its `package.json` ([Rig versions](rest-api.md#rig-versions)). It builds the harness images with `THERMITE_IMAGE_ID` too, set to the image's tag and short commit, such as `0.1.0-cuda+1a2b3c4d5e6f` or `0.1.0-cuda13+1a2b3c4d5e6f`: the harness reports it as its image in the rig's hardware report, which the rig's page shows. A build's key comes from the image's packages and compilers, not this name, so a new release on the same packages keeps the builds ([Build cache](kit-manifest.md#build-cache)). In an image built from a checkout without these arguments, both are empty, which counts as not set. The rig image's build passes neither: it keeps the CUDA harness's values, such as `0.1.0-cuda+1a2b3c4d5e6f`, so a rig on RunPod reports the CUDA harness it is built on.

## Build arguments

| Argument | Images | Default | Effect |
| --- | --- | --- | --- |
| `NODE_IMAGE` | All three | `docker.io/library/node:22.23.4-bookworm-slim`, pinned by its sha256 digest | The Node.js image every stage starts from |
| `BASE_IMAGE` | Harness | `NODE_IMAGE` | The harness's final base. GPU rigs set a CUDA 12 or CUDA 13 development image: see [The CUDA harness](#the-cuda-harness) |
| `OPENCODE_VERSION` | Harness, supervisor | `2.1.4` | The OpenCode release installed |
| `CLAUDE_CODE_VERSION` | Harness, supervisor | empty | A Claude Code release to install. Empty: Claude Code is not installed |
| `CODEX_VERSION` | Harness, supervisor | `0.162.1` | The Codex CLI release installed. Empty: the Codex CLI is not installed |
| `KUBECTL_VERSION` | Control | `v1.37.1` | The kubectl release installed. Its sha256 is pinned for amd64 and arm64 only |
| `THERMITE_COMMIT` | All three | empty | The source commit the image is built from. The image sets the environment variable of the same name, and the service reports it with Thermite's version: see [Rig versions](rest-api.md#rig-versions) |
| `HARNESS_IMAGE` | One-container rig | none: required | The harness image the rig image is built on. The release workflow names the CUDA 12 harness it built, by its digest. See [The one-container rig image](#the-one-container-rig-image) |
| `TARGETARCH` | All three | set by the builder | Chooses the arm64 or x64 package of OpenCode, Claude Code, the Codex CLI and kubectl |
| `THERMITE_IMAGE_ID` | Harness | empty | The image's identity, kept as the variable of the same name, which the harness reports. The release workflow sets it to the tag and the short commit |

## The harness image

### What it contains

| Part | Version | Where |
| --- | --- | --- |
| Node.js | The one in `NODE_IMAGE` (Node.js 22) | `/usr/local/bin/node`, copied from `NODE_IMAGE`. On another `BASE_IMAGE` only this binary is copied, without npm |
| Thermite | This repository's build, with its production dependencies, `node-pty` among them (below) | `/opt/thermite` (`dist/`, `node_modules/`, `package.json`) |
| `thermite` command | Thermite's command line | `/usr/local/bin/thermite`. See [Command line](command-line.md) |
| Compaction hook and plugin | Part of Thermite's build: Claude Code's PreCompact and PostCompact hook, run by Node, and Thermite's OpenCode plugin, which OpenCode loads through a link in the agent's own settings. Each runs as the agent's own user and keeps the conversation before each of that program's compactions ([Compaction](limits-and-pacing.md#compaction)); in a trial, the plugin also writes OpenCode's events to the trial's signals file and steers the owner's messages in | `/opt/thermite/dist/agents/programs/claude-code/compaction-hook.js`, `/opt/thermite/dist/agents/programs/opencode/plugin.js` |
| Trial hook | Part of Thermite's build: the hook program Claude Code and Codex run, by Node, at each of their hooks in a trial. It runs as the lane's user, writes each hook's signal to the trial's signals file, and gives the agent the owner's messages inside its turn, with the trial's token ([How the parts fit together](../explanation/how-it-fits-together.md#the-owners-messages)) | `/opt/thermite/dist/agents/programs/hooks/main.js` |
| Terminal host | Part of Thermite's build: the program that holds an agent program's own terminal UI in a pseudo-terminal, with the screen kept by a headless terminal emulator (xterm.js's `@xterm/headless`), types into it, interrupts and ends it, and copies its session log where the harness can read it. The broker runs it as the lane's user, under the lane's limits and the GPU fence, with the program under it ([Security model](../explanation/security-model.md#the-lanes)), for each trial on a rig whose agent programs run in their own terminal ([Agents in their own terminal](../explanation/agents-lanes-planner.md#agents-in-their-own-terminal)) | `/opt/thermite/dist/harness/terminal/main.js` |
| `node-pty` | 1.1.0, the terminal host's pseudo-terminals. Its native part is built in the image's last stage, where the compiler, `make` and Python are, with npm's `node-gyp` and the Node.js headers of `NODE_IMAGE` mounted for that step only, so the build downloads nothing more and neither stays in the image. Only the built module is kept: node-pty's sources, its prebuilt modules for other systems and the headers of `node-addon-api` are left out. With xterm.js's two packages, it adds about 3 MB to the image | `/opt/thermite/node_modules/node-pty`, its module `build/Release/pty.node` |
| `thermite-trial` | The tools an agent uses from its own shell under OpenCode, Claude Code or Codex: `submit`, `dev-run`, `status`, `idea` and `note` (a [field note](knowledge-base.md#field-notes)), and the `research` commands: all eleven for a research worker under OpenCode, and `fetch`, `read_source`, `search_corpus`, `add_claim` and `add_note` in a hill-climb or goal trial. See [Command line](command-line.md#thermite-trial) | `/usr/local/bin/thermite-trial` |
| OpenCode | `OPENCODE_VERSION`, 2.1.4 by default. Always installed. One of the [worker harnesses](glossary.md); Pi, the default one, is a library built into Thermite. Pi gives its workers Thermite's tools directly: in a code trial `note`, `fetch`, `read_source`, `search_corpus`, `add_claim` and `add_note` beside its others, and in a research trial `note` beside the research tools. OpenCode is under the MIT license; its release's `LICENSE` is kept beside it | `/usr/local/bin/opencode`, with its `LICENSE` in `/usr/local/share/doc/opencode` |
| Claude Code | `CLAUDE_CODE_VERSION`. Installed only when that argument names a version. It brings its own `ripgrep` for its Grep and Glob tools. The harness runs it with its own sandbox off, so the agent's commands run inside the rig's isolation, as OpenCode's do. An advisor's Claude Code, which has none of its own tools, also runs with its sandbox off, so the image has no `bubblewrap` | `/usr/local/bin/claude` |
| Codex CLI | `CODEX_VERSION`, 0.162.1 by default. Installed unless that argument is empty. OpenAI's coding agent, under the Apache License 2.0; one of the [worker harnesses](glossary.md), for a ChatGPT subscription or an OpenAI-compatible provider. Its release's whole Linux package is kept, with its `LICENSE` and `NOTICE` | `/opt/codex`, with `/usr/local/bin/codex` linked to `/opt/codex/bin/codex` |
| `thermite-devfence` | Built from `containers/harness/devfence.c` | `/usr/local/bin/thermite-devfence`. The GPU fence: it starts each role's command with the GPU device nodes it may not open left out, using the kernel's Landlock |
| C and C++ toolchain | From the base image's apt repository; not pinned | `gcc`, `g++`, `libc6-dev`, `make`, `cmake`, `ninja-build`, `ccache` |
| Python | From the base's apt repository; not pinned | `python3`, `python3-numpy` |
| Other packages | From the base's apt repository; not pinned | `git`, `tini`, `ca-certificates`. The build fails unless `setpriv`, `prlimit`, `taskset` and `setsid` exist |
| Smoke kits and projects | This repository's `kits/` and `examples/` | `/opt/thermite/checks/kits`, `/opt/thermite/checks/examples`. The [smoke check](rig-checks.md#smoke-check) uses them |

On the default base, the apt packages are Debian 12 ("bookworm") packages. The base must use apt (Debian or Ubuntu), because the image installs its packages with `apt-get`. Before it installs them, each build upgrades the base's own system packages (`apt-get upgrade`), so an image built again takes the distribution's fixes. The supervisor, rig and control images do the same.

### The CUDA harness

GPU rigs need the same image built on a CUDA development image, with `--build-arg BASE_IMAGE=<image>`. A development image is needed because the CUDA smoke kit builds with `nvcc`. No one CUDA serves every GPU, so the release workflow builds two, each on a base pinned by its digest:

| Image | Base | For |
| --- | --- | --- |
| CUDA 12 (`-cuda`) | `docker.io/nvidia/cuda:12.6.3-devel-ubuntu22.04`: Ubuntu 22.04's apt packages; amd64 | Pascal (P100, compute capability 6.0) and Volta (V100, 7.0) to Hopper. CUDA 12.6 knows no GPU newer than Hopper: on Blackwell, kernels run only from their PTX, and `nvcc` cannot build for it |
| CUDA 13 (`-cuda13`) | `docker.io/nvidia/cuda:13.0.3-devel-ubuntu24.04`: Ubuntu 24.04's apt packages; amd64 and arm64 | Turing (compute capability 7.5) to Blackwell, the DGX Spark's GB10 (12.1, on arm64) included. CUDA 13 builds for nothing older than Turing. 13.0 is the CUDA of NVIDIA's 580 drivers, so the image needs no newer driver |

Control sets rigs up from the CUDA 12 image (`THERMITE_RIG_HARNESS_CUDA_IMAGE`). For a deployment whose GPUs are Blackwell or DGX Sparks, set that setting to the CUDA 13 image. The CUDA 13 image has not yet run on a GPU ([Known limits](known-limits.md#the-cuda-13-harness-is-untested)). RunPod pods run the rig image, which is built on the CUDA 12 image, and test pods ask for hosts with CUDA 12.6 or later.

An agent's own commands under OpenCode, Claude Code or Codex get a fixed `PATH`, not the image's: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, with `/usr/local/cuda/bin` first where the image has it, so `nvcc` is found by name on a CUDA image. Pi's commands, and the judge's builds and timed runs, get the image's own `PATH`.

The CPU image has no `nvcc`, so it cannot build GPU kits. Control finds the CUDA image through `THERMITE_RIG_HARNESS_CUDA_IMAGE` (rigs it sets up, and the image it moves a cluster rig with GPUs onto) and `THERMITE_RUNPOD_TEST_IMAGE` (test pods). Under compose, the local stack's rig runs on the CPU image unless Thermite starts with `compose.gpu.yaml`, which `thermite local init` writes on a machine with NVIDIA GPUs. That file gives the harness the release's CUDA image, or the one `.env` names in `THERMITE_RIG_HARNESS_CUDA_IMAGE`; next to a checkout's `compose.yaml`, it builds the harness on the CUDA base instead, as `thermite-harness:local-cuda` ([Use the machine's NVIDIA GPUs](../how-to/install/one-machine.md#use-the-machines-nvidia-gpus)).

### Users and groups

The broker runs each kind of work as its own user. The numbers are fixed in the image and in the code; they must not change.

| User | uid | Group in the image (gid) | Runs |
| --- | --- | --- | --- |
| `thermite` | 10010 | `thermite` (10010) | The harness's controller: ledger, judge, scheduler, API |
| `builder` | 10020 | `builder` (10020) | Kit builds of candidates and champions on the first judge device |
| `builder-1` … `builder-7` | 10021 … 10027 | `builder-1` … `builder-7` (10021 … 10027) | Kit builds on judge GPUs 2 to 8, at the same time as the first's |
| `run` | 10030 | `gpu` (10500) | Timed runs on the first judge device |
| `run-1` … `run-7` | 10031 … 10037 | `gpu-j1` … `gpu-j7` (10511 … 10517) | Timed runs on judge GPUs 2 to 8 |
| `planner` | 10040 | `planner` (10040) | Planner calls under OpenCode, Claude Code or Codex |
| `model-check` | 10041 | `model-check` (10041) | The model check under OpenCode, Claude Code or Codex |
| `checker` | 10050 | `checker` (10050) | The kit's check of a run's outputs on the first judge device; the broker adds the `checkers` group |
| `checker-1` … `checker-7` | 10051 … 10057 | `checker-1` … `checker-7` (10051 … 10057) | The kit's check on judge GPUs 2 to 8, with the `checkers` group |
| `driver` | 10060 | `driver` (10060) | A kit's driver (`run.driver`) beside a timed run on the first judge device |
| `driver-1` … `driver-7` | 10061 … 10067 | `driver-1` … `driver-7` (10061 … 10067) | A kit's driver on judge GPUs 2 to 8 |
| `lane-1` … `lane-16` | 10101 … 10116 | `lane-1` … `lane-16` (10101 … 10116) | A lane's commands and file tools; OpenCode, Claude Code and Codex sessions |
| `lane-1-dev` … `lane-16-dev` | 10201 … 10216 | `gpudev` (10501) | A lane's development runs |
| `agent-1` … `agent-16` | 10301 … 10316 | `agent-1` … `agent-16` (10301 … 10316) | A lane's Pi worker process |

| Group | gid | Owns |
| --- | --- | --- |
| `gpu` | 10500 | The GPU device nodes on a rig with one shared device; the first judge GPU on a rig with dedicated GPUs |
| `gpudev` | 10501 | The first development GPU |
| `gpuctl` | 10502 | The control nodes every CUDA process needs, on a rig with dedicated GPUs |
| `gpu-j1` … `gpu-j7` | 10511 … 10517 | Judge GPUs 2 to 8 |
| `gpu-d1` … `gpu-d7` | 10521 … 10527 | Development GPUs 2 to 8 |
| `checkers` | 10049 | Nothing: the kits' and the baselines' folders in the harness's state are in it, so the checkers read them and no other role does |

The broker sets each process's groups by number when it starts it: a development run, for example, gets its device's group. The users have no home and no login shell. These numbers set the limits of a rig: 16 lanes, and 8 judge plus 8 development GPUs.

No two kinds of work share a user. When a user's work ends, the broker stops what that user still runs, so a shared user would let one task's cleanup stop another's work. So a planner call and a model check each have a user of their own, apart from every lane's, also at 16 lanes.

The [isolation check](rig-checks.md#isolation-check) tests these users, and [Isolation inside a rig](../explanation/isolation.md) explains them.

### How it runs

- **Entry point:** `tini`, then `node /opt/thermite/dist/harness/broker/main.js`.
- **As root.** The image sets no user. The broker needs root to start each role as its user, and stops at start with `fatal: not root, so roles cannot be separated` otherwise. Compose, the machine units and the cluster manifests keep only the capabilities `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETGID` and `SETUID`, and forbid gaining new privileges.
- **What a role's process sees.** Builds and timed runs get only `PATH`, `LANG=C.UTF-8`, `HOME` and `TMPDIR` (both the run's own directory) and `USER`, plus `CUDA_VISIBLE_DEVICES` on a rig with dedicated GPUs. Other `ENV` lines in a derived image do not reach them. A lane's commands also get their build cache: `THERMITE_LANE_CACHE` and `CCACHE_DIR` (both the lane's cache folder) and `CCACHE_MAXSIZE=8G`.
- **Port:** 8700, the harness API (`THERMITE_LISTEN`). No port is published.
- **Also set:** `NODE_OPTIONS=--disable-warning=ExperimentalWarning`, and `THERMITE_COMMIT` and `THERMITE_IMAGE_ID` from their build arguments (see [Published images](#published-images)).

### Paths

| Path | What | Owner and mode |
| --- | --- | --- |
| `/var/lib/thermite` | State: the ledger, git mirrors, kits, imports, models, builds and the harness's copy of each run's past research, `knowledge/<run>/` (`THERMITE_STATE_DIR`) | `thermite`, 0711. `ledger`, `git`, `kits` and `imports` are 0700; `models` and `builds` 0711, reachable only by exact path |
| `/scratch` | Workspaces, lane caches, the judge's runs and each run's research folder, `thermite/research/<run>/` with its [`knowledge/`](knowledge-base.md#a-runs-knowledge-folder) (`THERMITE_SCRATCH_DIR`). Emptied at every start, except each lane's cache folder, `thermite/lanes/<lane>/cache` ([A lane's cache](ports-volumes-secrets.md#a-lanes-cache)); the harness puts a run's `knowledge/` back from its state when the run next needs it | root, 0755 |
| `/controller` | The folder the inbox is mounted in | root, with the controller's group `thermite`, 0750: no role may enter it |
| `/controller/inbox` | What the supervisor fetched for the harness: project and kit bundles, models (`THERMITE_INBOX_DIR`) | Mounted read-only |
| `/outbox` | Exports the supervisor pushes (`THERMITE_OUTBOX_DIR`) | `thermite` with the supervisor's group (10010:10001), 2750 |
| `/keys` | Control's public key, `control-signing.pub` | Mounted read-only |
| `/run/thermite` | The broker's socket, `broker.sock` (`THERMITE_BROKER_DIR`) | Directory root and group `thermite`, 0750; socket 0660 |
| `/run/secrets` | Secret files | The broker closes their directory to 0700 at start |

At start the broker also closes `/tmp`, `/var/tmp` and `/dev/shm` to the roles (root and group `thermite`, mode 1770): each role has its own temporary directory. [Ports, volumes and secret files](ports-volumes-secrets.md) lists the volumes behind these paths.

## The supervisor image

| Part | Detail |
| --- | --- |
| Base | `NODE_IMAGE` |
| Packages | `git`, `openssh-client`, `tini`, `ca-certificates`, `python3`, after the base's own are upgraded |
| Thermite | `/opt/thermite`, with its production dependencies but `node-pty`, which only the harness's terminal host uses, and the `thermite` command at `/usr/local/bin/thermite` |
| Compaction hook and plugin | The same as in the harness image, for advisors in Claude Code and OpenCode: `/opt/thermite/dist/agents/programs/claude-code/compaction-hook.js` and `/opt/thermite/dist/agents/programs/opencode/plugin.js`. Each keeps an advisor's conversation before each of that program's compactions ([Compaction](limits-and-pacing.md#compaction)) |
| Claude Code | `/usr/local/bin/claude`, only when built with `CLAUDE_CODE_VERSION`. Advisors on a Claude subscription need it |
| OpenCode | `/usr/local/bin/opencode`, at `OPENCODE_VERSION` (2.1.4 by default), as in the harness image, for [advisors in OpenCode](advisors-file.md#opencode-opencode-v2-in-the-supervisor). Always installed. Its MIT `LICENSE` is in `/usr/local/share/doc/opencode` |
| Codex CLI | `/opt/codex`, with `/usr/local/bin/codex` linked to `/opt/codex/bin/codex`, at `CODEX_VERSION` (0.162.1 by default), as in the harness image, for [advisors in Codex](advisors-file.md#codex-the-codex-cli-in-the-supervisor). Installed unless that argument is empty. Its `LICENSE` (the Apache License 2.0) and `NOTICE` are in `/usr/local/share/doc/codex` |
| Users | `supervisor`, uid and gid 10001, home `/var/lib/thermite-supervisor/home`, where `ssh` keeps `~/.ssh`. `advisor-1` to `advisor-8`, uid and gid 10081 to 10088, in none of the supervisor's groups: each advisor's program runs as one of them ([The supervisor's users](ports-volumes-secrets.md#the-supervisors-users)) |
| Paths it owns | `/var/lib/thermite-supervisor` (its state), `/results`, and `/supervisor/inbox`, where the inbox is mounted, in `/supervisor`: root's, with the supervisor's group, 0750. `/outbox` is 10010:10001, 2750 |
| Entry point | `tini`, then `node /opt/thermite/dist/supervisor/advisor-runs/main.js` as root, which starts the supervisor, `node /opt/thermite/dist/supervisor/main.js`, as `supervisor` ([below](#how-the-supervisor-image-starts)) |
| Ports | None |

### How the supervisor image starts

1. The entry, as root, closes what the advisor users must not reach: `/run/secrets` and `/etc/thermite` become root's with the supervisor's group (0750), as does `/supervisor`, the inbox's folder; the supervisor's state (`THERMITE_SUPERVISOR_HOME`) and `/results` become the supervisor's, mode 0700. Where the supervisor may not write in the inbox, the entry gives it to the supervisor. It makes `/var/lib/thermite-advisors`, the runs' root, empty, the supervisor's, mode 0711. It logs what it did as `the supervisor's folders`. When it can't, it stops with `fatal: could not close the supervisor's folders`: the container needs `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETGID` and `SETUID`.
2. It serves the advisors' runner on `/run/thermite-advisors/runs.sock` (root and the supervisor's group, 0660), and logs `serving`.
3. It starts the supervisor as `supervisor` (10001), with no capability, in its own process group, with the runner's socket and the runs' root in its environment (`THERMITE_ADVISOR_SOCKET`, `THERMITE_ADVISOR_RUNS_DIR`). When the supervisor exits, the entry ends what it left running and starts it again, as the broker starts the controller: after a second if it ran for more than a minute, otherwise twice as long as the last time, up to 30 seconds; it logs `supervisor exited; restarting`. A full reset's restart of the supervisor goes this way.
4. For each call, the supervisor makes a fresh folder in the runs' root and writes the program's own settings there. The runner hands the folder to a free advisor user (the folder 2750, with the supervisor's group), starts the program as that user in it, with only the call's environment, its prompt on standard input and Claude Code's token on file descriptor 3, and, when the program exits, its time is up or the supervisor's call ends, kills every process of that user. It then gives the folder back to the supervisor, which reads what the call left (its answer, its compactions) and has the runner remove it. Eight calls can run at once; a ninth is refused with `every advisor user is busy`.

On `SIGTERM` or `SIGINT` the entry passes the signal to the supervisor and exits with its code once it has ended; a second signal ends it at once. `SIGUSR2` goes on to the supervisor too. Started as another user than root, the entry stops with `fatal: not root, so advisor programs cannot run as users of their own`; with `THERMITE_ALLOW_UNSEPARATED=1`, for development only, it starts the supervisor without the runner, and the supervisor logs `advisor programs run as the supervisor's own user: no advisors' runner was started with it`. Pi advisors run in the supervisor's own process in every case.

## The one-container rig image

A RunPod pod runs one container. The one-container rig image runs a rig's harness and its supervisor in it, in [pull mode](../explanation/trust.md#rigs-in-pull-mode): control connects to the supervisor's port, control's message bus dials the pod's own bus server, and the rig never connects to control. The broker runs as root, as in the harness image, and also starts the supervisor under the supervisor's own user, beside the role users, and serves its advisors' runner, which runs each advisor's program as an advisor user of its own. The owner launches it on RunPod from control, over the REST API, MCP or the command line ([Rigs on a GPU cloud](rest-api.md#rigs-on-a-gpu-cloud)). The dashboard launches it too, with **Launch on RunPod** ([Run a rig on RunPod](../how-to/install/runpod-rig.md)).

Each release publishes it on the CUDA harness, as `ghcr.io/iammrduncan/thermite-rig` ([Published images](#published-images)), and the release's `compose.yaml` makes it control's `THERMITE_RUNPOD_RIG_IMAGE`. [Use a rig image of your own](../how-to/install/runpod-rig.md#use-a-rig-image-of-your-own) builds and pushes one.

It is the harness image with the supervisor added. Build the harness image first, on a CUDA 12.x base for a GPU pod, and name it in `HARNESS_IMAGE`. The CPU harness image works the same, for a test:

```sh
podman build -t thermite-harness -f containers/harness/Containerfile .
podman build -t thermite-rig --build-arg HARNESS_IMAGE=localhost/thermite-harness \
  -f containers/rig/Containerfile .
```

### What it adds to the harness image

| Part | Detail |
| --- | --- |
| Thermite | Nothing: the harness image's `/opt/thermite` already holds the supervisor's code |
| Packages | `openssh-client`, as in the supervisor image, for Git over SSH, after the harness image's own are upgraded |
| Users | `supervisor`, uid and gid 10001, home `/var/lib/thermite-supervisor/home`, as in the supervisor image. `/var/lib/thermite-supervisor` and its `home` are mode 0700. `advisor-1` to `advisor-8`, uid and gid 10081 to 10088, as in the supervisor image |
| Set-id files | None. The build removes every setuid and setgid bit after the last package, and fails if one is left. RunPod does not stop a process from gaining privileges through such a file (`no_new_privs` is off there), so a role could otherwise run a setuid program as its owner |
| `thermite-rig-start` | `/usr/local/bin/thermite-rig-start`, the entry point. See [How it starts](#how-it-starts) |
| `nats-server` | `/usr/local/bin/nats-server`, the [NATS server](https://github.com/nats-io/nats-server) 2.15.1: the program alone, 17.4 MB, copied from the bus's image that `compose.yaml` pins, by the same digest. The supervisor runs it as the pod's own server, which control's server dials as a leaf node ([A rig on RunPod](../explanation/how-the-parts-talk.md#a-rig-on-runpod)) |
| Entry point | `thermite-rig-start`, then `tini`, then `node /opt/thermite/dist/harness/broker/main.js` |
| Ports | 8790 (`EXPOSE 8790 7422`), the supervisor's port for control: the launch exposes it as HTTP, and RunPod's proxy makes it reachable. 7422, the pod's leaf node: the launch exposes it as TCP, and RunPod gives it a public address and port |

### Settings the image sets

The launch gives the rest: control's launch values for [pull mode](settings.md#pull-mode) (the rig's ID, the random path, the SHA-256 of control's key, the rig's key at control and the one-time enrollment code), the leaf node's (the pod's TLS certificate and key, and control's authority: `THERMITE_LEAF_CERT`, `THERMITE_LEAF_KEY` and `THERMITE_LEAF_CONTROL_CA`), the key the state's snapshot is sealed with (`THERMITE_STATE_SNAPSHOT_KEY`), and RunPod's `RUNPOD_POD_ID`.

| Variable | Value | Effect |
| --- | --- | --- |
| `THERMITE_ONE_CONTAINER` | `1` | The broker also prepares and starts the supervisor. The isolation check also checks the container as a whole |
| `THERMITE_FATAL_HOLD_SECONDS` | `60` | A fatal error at start is held for a minute before the broker exits, so the pod's log keeps it and RunPod does not restart the container every few seconds |
| `THERMITE_STATE_DIR` | `/var/lib/thermite-rig/harness` | The harness's state, on the container's own disk |
| `THERMITE_OUTBOX_DIR` | `/var/lib/thermite-rig/outbox` | The outbox, read by both parts |
| `THERMITE_INBOX_DIR` | `/var/lib/thermite-rig/inbox` | The inbox, read by both parts |
| `THERMITE_SUPERVISOR_HOME` | `/var/lib/thermite-rig/supervisor` | The supervisor's state |
| `THERMITE_SUPERVISOR_TOKEN_FILE` | `/var/lib/thermite-rig/secrets/supervisor-token` | The token between the two parts, made at first start |
| `THERMITE_STATE_SNAPSHOT_DIR` | `/workspace/thermite` | Where root keeps a snapshot of the state, on RunPod's volume (mounted at `/workspace`, kept when a pod stops). See [Where the state lives](#where-the-state-lives) |
| `THERMITE_CONTROL_PUBKEY_FILE` | `/etc/thermite/control-signing.pub` | Root's copy of control's key, the only key the harness reads |
| `THERMITE_LISTEN` | `127.0.0.1:8700` | The harness API answers on loopback only |
| `HARNESS_URL` | `http://127.0.0.1:8700` | The supervisor reaches the harness there |
| `THERMITE_TUNNEL_PORT` | `8790` | Pull mode, on this port |
| `THERMITE_TUNNEL_DIR` | `/var/lib/thermite-rig/supervisor/tunnel` | The pod's own keys and its enrollment. The harness gets it too: its isolation check makes sure no role can read the keys |
| `THERMITE_TUNNEL_ENROLLED_DIR` | `/var/lib/thermite-rig/supervisor/enrolled` | Where enrollment leaves control's key and the rig's settings |

### Where the state lives

RunPod empties a pod's container disk when the pod stops, and keeps its volume. The volume refuses even root a change of owner, and the rig keeps its parts and roles apart by owner. So the rig's state lives on the container's disk, in `/var/lib/thermite-rig`, where each part and role keeps its own folders as in the harness image. Root keeps a **snapshot** of it on the volume, and puts it back after a stop.

RunPod's volume also ignores file modes: a folder of mode 0700 keeps no user out, and every part and role can list it, read in it and write in it. So the snapshot is **sealed** with the key control makes for each pod at its launch (`THERMITE_STATE_SNAPSHOT_KEY`, 32 random bytes), which only root holds:

- **Every file is encrypted and authenticated**, with AES-256-GCM and a fresh nonce for each file. A part or role that reads the volume learns nothing of the ledger, the pod's keys or the token, and a change to any byte is found.
- **Each file's name is a keyed hash of its content** (HMAC-SHA-256), in hexadecimal: it tells nothing about the file but which files are the same.
- **The manifest is sealed too.** It lists each file and folder: its part, its path, its owner, mode, time and size, the name of its sealed file and the SHA-256 of its content. A restore checks the manifest and checks each file against it.
- **One key for each purpose.** The file contents, the names and the manifest each have a key of their own, derived from the snapshot key with HKDF-SHA-256, so a sealed file can't pass for a manifest.
- **The key is root's alone.** The broker reads it at start and takes it out of its own environment before it starts anything; the process that takes a snapshot gets it on its standard input, never in its arguments, which any user can read. No part, no role and no program they start has it, and the [isolation check](rig-checks.md#the-one-container-image) looks for it in every environment it can read.

| When | Root |
| --- | --- |
| At a start, first | Makes the snapshot folder, `THERMITE_STATE_SNAPSHOT_DIR`, its own with mode 0700, and never gives anything in it another owner. As the controller's user, the supervisor's and `agent-1`, it tries to list the folder and to write in it, and records what each user met in `snapshot.json` in its socket's folder, for the isolation check. It logs `the snapshot folder is closed to the parts and the roles` with the owner and mode the volume shows, or, on a volume that lets them in, `the snapshot folder is open to other users: its snapshot is sealed`. Without the key it logs `no snapshot key: no snapshot is taken or restored` with why, and does neither. When it can't make the folder at all, it logs `could not make the snapshot folder: no snapshot is taken or restored`, and nothing is kept over a stop |
| At a start on an empty disk | When the live folders hold nothing, restores the newest snapshot whose manifest and every file verify, as below, and logs `restored the rig's state from its snapshot` with its number (`seq`), when it was taken, and the files, folders and bytes of each part. With no snapshot yet it logs `no snapshot yet: the rig starts with a fresh state`. When the live folders hold the state already (a restart that kept the disk), it restores nothing |
| Every 5 minutes | Takes a snapshot (`THERMITE_STATE_SNAPSHOT_MINUTES`) |
| After each export | Takes a snapshot once a new export is in the outbox. It looks every 10 seconds |
| After enrollment | Takes a snapshot at once: the pod's keys and its enrollment are then kept |
| At a stop | Takes a snapshot on `SIGTERM`, before it tells the two parts to stop, and waits for it up to 8 seconds (`THERMITE_STATE_SNAPSHOT_STOP_SECONDS`). A second signal ends it at once. Either way the last complete snapshot stays |

Each snapshot logs `took a snapshot of the rig's state`, with why (`reason`), its number (`seq`, one more than the snapshot before it), the files and bytes it holds, how many it sealed now (`sealed`) and how many it found sealed already (`reused`), how many sealed files no manifest names any more it removed (`removed`), and how long it took. A snapshot holds the harness's state, the outbox, the inbox, the supervisor's state (with the pod's keys, its enrollment and the nonces it has seen) and root's copy of the supervisor's token. It leaves out what is made again at every start or is not done yet: the supervisor's `tmp` and its copy of the token, exports still being written (names starting with `.` in the outbox), and the ledger's write-ahead files.

- **The ledger** is copied with SQLite's backup, by a process that runs as the controller's user, never as a plain copy of a file being written. The copy is consistent: a transaction is in it whole or not at all. It is copied first, so an export the ledger records is in the outbox's copy too.
- **Only what changed is sealed.** A file that has not changed since the last snapshot (the same size and time), and whose sealed file is still there, is not read again. A file whose content is sealed there already, under another path or from before, is not sealed again. Once the new manifest is in place, the sealed files no manifest names are removed.
- **Only plain files and folders of the part's own user** are taken: a link, a device, a pipe, a socket or another user's file is left out and named in the log line (`skipped_first`).
- **A new manifest, then a rename.** Each new file is sealed into a file of its own (`.new-` and a random name) and renamed to its sealed name once written. The manifest is written last, as `manifest.new`, then renamed to `manifest`. The snapshot before it stays whole until then. A snapshot that fails, such as on a full volume, leaves the one before it, logs `could not take a snapshot of the rig's state: the last one stays`, and is tried again a minute later. When the manifest before it does not verify, the log line says so (`before`) and every file is sealed again.
- **Inside the folder.** Root works from inside the snapshot folder, by bare names. A user who renames the folder or puts a link in its place can't send root's writes, reads or removals anywhere else.
- **Out of the judge's way.** The snapshot runs in a process of its own, at a low CPU and disk priority but at a stop, so it never holds up the broker, which times the judge's runs. One that falls due while a timed run is at work waits for it to end, up to 5 minutes.

A restore takes the newest manifest that verifies: `manifest`, or a `manifest.new` that a stop cut off before its rename. The manifest must be this rig's (`THERMITE_RIG_ID`), and every file it names must be there, a plain file of the size sealing gives, and must verify: its tag, and the SHA-256, size and keyed hash of its content against the manifest. If any of it does not, the whole snapshot is refused: nothing of it is restored, the broker logs `the snapshot did not verify: <why>`, naming the file or the manifest, and the rig starts with an empty state. A pod in [pull mode](settings.md#pull-mode) then has no keys and can't enroll again, since its code is spent: [Troubleshooting](../how-to/operate/troubleshoot.md#a-runpod-rig-lost-its-state-over-a-stop) says what to do.

The restore writes only plain files and folders, under the parts the rig has and the names a snapshot holds: a name that climbs out of its part is refused and counted in the log line, even in a manifest that verifies. Each restored file and folder gets its part's owner, as a start gives it, and the mode it had, with no set-user-id or set-group-id bit on a file. Each part is written beside its live folder, then renamed into place once every part is written and verified: a restore that fails for another reason, such as a full disk, changes nothing, logs `fatal: could not restore the rig's state from its snapshot`, and is tried again at the next start.

An image from before sealing kept its snapshot unsealed, in `snapshot/`. It is never restored. Where no other user may write in the folder, the broker removes it and logs `removed an unsealed snapshot an older image left: it is not restored`; where one may, it stays (a removal there could be sent elsewhere), the broker says so, and the isolation check fails until the owner removes it.

What sealing does not stop: a part or role that can write on the volume can still delete the snapshot, or put back an older sealed snapshot of the same pod that it kept a copy of. Either takes effect only at the next start on an empty disk: a deleted snapshot gives a fresh state, and an older one gives the state as it was then; the rig can't tell an older snapshot from the newest. What the rig did since, and had not sent out, is lost; what left the pod for control stays on control. Nor does sealing hide how many files the snapshot holds, their sizes, or which of them have the same content.

| Part | Owner it is restored with |
| --- | --- |
| The harness's state | `thermite` (10010:10010) |
| The outbox | `thermite`, with the supervisor's group (10010:10001) |
| The inbox | `supervisor`, with group `thermite` (10001:10010) |
| The supervisor's state | `supervisor` (10001:10001) |
| Root's copy of the token | root |

The container's disk holds the live state, models and builds among it, and the volume a copy of it: give both room for the state, as [Run a rig on RunPod](../how-to/install/runpod-rig.md#2-choose-the-gpu-the-limits-and-the-name-and-launch) says.

### How it starts

1. `thermite-rig-start` removes every `RUNPOD_` variable from the environment: RunPod's API key, the pod's ID and the others. It passes the pod's ID on as `THERMITE_TUNNEL_POD`, unless that is set already. Then it starts `tini`, so no process of the rig has RunPod's variables, PID 1 included.
2. The broker, as root, takes the snapshot key out of its own environment first, so nothing it starts has it. It makes the snapshot folder and records whether the parts and the roles can open it. On an empty disk, such as after a stop, it restores the state from the sealed snapshot once it verifies ([Where the state lives](#where-the-state-lives)).
3. The broker prepares the harness's places as in the harness image, and the supervisor's:
   - its state folder, `THERMITE_SUPERVISOR_HOME`: the supervisor's, mode 0700, with a folder `tmp` emptied at every start. `/tmp` is closed to the supervisor, as to the roles;
   - the inbox: the supervisor's, with the controller's group `thermite`, mode 2750;
   - the token the supervisor uses on the harness API: made at first start in `THERMITE_SUPERVISOR_TOKEN_FILE` (root's, 0600, in a folder of mode 0700), and copied at every start to `harness-token` in the supervisor's state folder (the supervisor's, 0600);
   - in pull mode, it removes the harness's copy of control's key from an earlier start. A start without `THERMITE_RIG_ID`, `THERMITE_CONTROL_PUBKEY_FILE` or a `THERMITE_TUNNEL_CONTROL_KEY_SHA256` of 64 hexadecimal characters stops with `fatal: pull mode needs the launch's values`.
4. As the supervisor's user, started the way the supervisor is, it tries to open each GPU device node. It records what happened in `supervisor.json` in its socket's folder, for the isolation check.
5. It serves the advisors' runner on `/run/thermite-advisors/runs.sock` (root and the supervisor's group, 0660, in a folder of mode 0750), and logs `serving the advisors' runner`. Each advisor's program runs as an advisor user of its own, in a folder of `/var/lib/thermite-rig/thermite-advisors` (the supervisor's, 0711, emptied at every start), as in the [supervisor image](#how-the-supervisor-image-starts), and also with no_new_privs and in the GPU fence with no card.
6. It starts the supervisor as `supervisor` (10001), with no_new_privs (`setpriv --no-new-privs`), and in the GPU fence with no card where the kernel has Landlock: neither the supervisor nor an advisor's program can open the GPU. The supervisor serves the pull mode port and waits for control to enroll the pod. With the leaf node's launch values, it also writes the pod's server's files in `THERMITE_TUNNEL_DIR/bus` (its key 0600, the folder 0700), takes `THERMITE_LEAF_KEY` out of its own environment, starts `nats-server` as its own child with an empty environment, and starts it again 5 seconds after it exits; its log says `the pod's bus server started: control's server dials it as a leaf node`. The server listens for the supervisor on `127.0.0.1:4222`, which only the rig's key on the bus signs in to, and for control's server on 7422, which takes only a client certificate of control's authority.
7. The broker waits for enrollment, and logs `waiting for enrollment: the harness starts once control has enrolled the pod` at once and every 10 minutes after. When the supervisor has written `control.pub` in `THERMITE_TUNNEL_ENROLLED_DIR`, root reads what enrollment left, as data:
   - `control.pub` and `rig.env` must be plain files of the supervisor's own, not links, of at most 16 KiB;
   - `control.pub` must be an Ed25519 public key whose SHA-256 is `THERMITE_TUNNEL_CONTROL_KEY_SHA256`, the one the launch named;
   - `rig.env` must hold only `NAME=value` lines for `THERMITE_RIG_ID`, which must be the launch's, and the settings control gives a rig (`THERMITE_TARGET`, `THERMITE_TARGET_CLASS`, `THERMITE_GPUS`, `THERMITE_GPU_INDEX`, `THERMITE_DEV_GPU_INDEX`, `THERMITE_JUDGE_GPUS`, `THERMITE_MAX_TRIALS`, `THERMITE_TRIAL_MINUTES` and `THERMITE_PROMOTION`), each once, with values of letters, digits and `. _ , : -`. Nothing in it is run or expanded.

   Anything else is refused, and the broker logs `refused what enrollment left: the harness waits` with the reason, again when the reason changes and every 10 minutes.
8. Root writes control's key to `THERMITE_CONTROL_PUBKEY_FILE`, in a folder of its own (mode 0755), as a new file of mode 0644, and logs `enrolled: the harness starts with control's key from enrollment` with the names of the settings. It takes a snapshot of the state. It adds the settings to the controller's environment, regroups the GPUs if they changed, and starts the controller as `thermite`, as in the harness image. A key the supervisor writes after that changes nothing: root copied the key once, at this start, after checking it.

A pod that restarts does not enroll again: the supervisor writes the same files again at start, and the broker checks them again before the controller starts. After a stop, the pod's keys and its enrollment come back from the snapshot.

The supervisor's environment is the broker's, without RunPod's variables, the snapshot key and the harness's secret files, with `HOME` (its passwd home), `TMPDIR` (its `tmp`), `USER=supervisor` and `THERMITE_HARNESS_TOKEN_FILE` set. It takes the enrollment code and the leaf node's key out of its own environment at start. The controller gets no `RUNPOD_` variable, in every image, no snapshot key, none of the leaf node's values, and none of pull mode's launch values but `THERMITE_TUNNEL_DIR` and `THERMITE_TUNNEL_CONTROL_KEY_SHA256`, which its isolation check reads. The roles get what they get in the harness image.

### Restarts and stops

| When | The broker |
| --- | --- |
| The controller exits | Does what it does in the harness image: ends the controller's processes and every role's, and starts it again, with the key root copied at this start |
| The supervisor exits | Ends whatever the supervisor started (its process group and every process of its user, the pod's bus server among them), logs `supervisor exited; restarting`, and starts it again |
| A part exits again soon | Waits 2 seconds before the next start, then twice as long each time, up to 30 seconds. After a run of more than a minute it waits 1 second |
| It gets `SIGTERM` or `SIGINT`, as when the pod stops | Takes a snapshot of the state first, for up to 8 seconds ([Where the state lives](#where-the-state-lives)). Then passes the signal to both parts and starts neither again. Once both have ended, it ends every role's processes, logs `stopped` and exits with the controller's exit code. A stop while it waits for enrollment ends the supervisor the same way. The supervisor logs `stopping`, closes pull mode's ports at once, and stops the pod's bus server: its calls that wait for control's next exchange end with 503, so it ends within seconds whether or not control is connected |

### Paths

| Path | What | Owner and mode |
| --- | --- | --- |
| `/var/lib/thermite-rig` | The live state's folder, on the container's disk | root, 0711 |
| `/var/lib/thermite-rig/harness` | The harness's state | As `/var/lib/thermite` in the harness image |
| `/var/lib/thermite-rig/outbox` | Exports for the supervisor | `thermite` with the supervisor's group (10010:10001), 2750 |
| `/var/lib/thermite-rig/inbox` | What the supervisor fetched for the harness | `supervisor` with group `thermite` (10001:10010), 2750 |
| `/var/lib/thermite-rig/supervisor` | The supervisor's state, its `harness-token`, its `tmp`, the pod's keys (`tunnel/`) and what enrollment left (`enrolled/`) | `supervisor`, 0700 |
| `/var/lib/thermite-rig/secrets` | Root's copy of the token between the two parts | root, 0700 |
| `/workspace/thermite` | The state's sealed snapshot, on RunPod's volume: `manifest`, the sealed files (each named by 64 hexadecimal characters), and `manifest.new` and `.new-…` files while one is written | root, 0700. RunPod's volume lets every user in all the same: everything in it is sealed |
| `/run/thermite/snapshot.json` | The broker's record of the snapshot folder: its owner and mode, what each user met trying to open it, and whether the launch gave the key (`sealed`; `off` says why not) | root, 0644, in the broker's folder |
| `/etc/thermite/control-signing.pub` | Control's key, copied by root from enrollment once checked | root, 0644, in a folder of root's (0755) |
| `/run/thermite/supervisor.json` | The broker's record of the supervisor's user, fence and GPU access | root, 0644, in the broker's folder (root and group `thermite`, 0750) |
| `/scratch` | As in the harness image, on the container's own disk | root, 0755 |

The [isolation check](rig-checks.md#the-one-container-image) checks the supervisor, set-id files, files with capabilities, RunPod's variables, the enrollment code and the leaf node's key, control's key, the snapshot folder and the snapshot key in this image too.

## The control image

| Part | Detail |
| --- | --- |
| Base | `NODE_IMAGE` |
| Packages | `tini`, `ca-certificates`, `git` and `openssh-client` (for machines over SSH and Git over SSH), after the base's own are upgraded |
| kubectl | `KUBECTL_VERSION`, v1.37.1 by default, checked against a pinned sha256, at `/usr/local/bin/kubectl`. The build stops with `no pinned kubectl for <arch>` on any architecture but amd64 and arm64. kubectl is under the Apache License 2.0: the `LICENSE` of the Kubernetes repository at that tag is kept in `/usr/local/share/doc/kubectl`, from `containers/control/kubectl/LICENSE` |
| Thermite | `/opt/thermite`, with its production dependencies but `node-pty`, which only the harness's terminal host uses, and the `thermite` command at `/usr/local/bin/thermite` |
| User | `thermite`, uid and gid 10001, home `/var/lib/thermite-control`. It has a passwd entry because OpenSSH refuses a user without one |
| Paths it owns | `/var/lib/thermite-control` (its state, `THERMITE_CONTROL_DIR`), `/keys` |
| Entry point | `tini`, then `node /opt/thermite/dist/control/main.js` |
| Port | 8800 (`THERMITE_CONTROL_LISTEN`) |

[Compatibility](compatibility.md) lists the architectures and versions each image is built and tested on.
