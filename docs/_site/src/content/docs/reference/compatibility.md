---
title: "Compatibility"
description: "The Node.js versions, operating systems, container engines, compose tools, Kubernetes, GPUs, CUDA and CPU architectures Thermite works with, and how each is tested."
type: reference
sidebar:
  order: 16
---

This page lists what Thermite needs and what it has been tested with. Each row says how it is tested, or **not tested** where nothing in the repository tests it. A version Thermite does not check is marked so: it may work, but nothing shows it. The [glossary](glossary.md) explains the terms.

## Node.js

| Where | Version | How it is tested |
| --- | --- | --- |
| Your computer, for the `thermite` command, the tests and the scripts | 22.19 or later (`engines` in `package.json`). The agent libraries need it | CI runs the type check, lint and tests on Node.js 22 and 24 |
| Inside the images | Node.js 22.23.4, from `node:22.23.4-bookworm-slim` pinned by digest | Every image build |

The images carry their own copy of Thermite, so a release's compose stack needs no Node.js on your computer. Node.js is needed only for the command line, and in a checkout of the source code for `npm run dev:init` and the test scripts.

## Operating systems

| System | Status | How it is tested |
| --- | --- | --- |
| Linux | Supported | CI runs on Ubuntu 24.04 |
| macOS | Supported, with Podman or Docker running their Linux virtual machine | Not in CI. The compose test scripts work with a Podman machine: they trim its disk after each run |
| Windows | Not tested | Nothing in the repository tests it |

### Machines that host rigs

A machine that control sets rigs up on, over SSH or with a join command, needs Linux with systemd and Podman. A rig that runs as a user other than root needs lingering on for that user.

| Machine's system | What control can install for you | How it is tested |
| --- | --- | --- |
| Debian, Ubuntu | Podman (apt), NVIDIA's container toolkit, lingering | Machines acceptance: control installs Podman on a Debian 12 container that stands in for the machine |
| Fedora, RHEL, CentOS, Rocky Linux, AlmaLinux, Amazon Linux | Podman (dnf), NVIDIA's container toolkit, lingering | Rig deploy acceptance: control turns lingering on and sets a CPU rig up on a Fedora 41 container with systemd and rootless Podman. The dnf installs are not tested |
| Any other Linux | Lingering only. Install the rest yourself: control says `control has no recipe for <os>: install it yourself` | Not tested |

Installs need `sudo` without a password. See [Add a rig on a machine over SSH](../how-to/install/rig-on-a-machine.md).

## Container engines and compose tools

| Tool | Status | How it is tested |
| --- | --- | --- |
| Docker with `docker compose` | Supported | CI runs the compose smoke test with it |
| Podman with `podman compose` | Supported | Every compose acceptance script takes it, and it is their default. Not in CI |
| podman-compose | Supported | The compose smoke test takes it (`COMPOSE="podman-compose"`). Not in CI |
| `docker-compose` 1.x (Compose v1) | Not supported: it stops at the top-level `name:` of `compose.yaml`. `thermite doctor` fails or warns when it finds it, as the command for Docker or the program behind `podman compose` | The doctor's tests |
| Podman on a machine that hosts rigs | 4.4 or later, for its Quadlet units | The rig deploy acceptance, on Fedora 41's Podman. Neither the join script nor setting up over SSH checks the version: the join script checks only that Podman is there |

Apart from Compose v1, no minimum version of Docker, Docker Compose, Podman or podman-compose is stated or checked for the compose stack. `compose.yaml` uses secrets from files, profiles, internal networks, `extra_hosts` with `host-gateway`, dropped and added capabilities, `no-new-privileges`, restart policies, a health check (the `nats` service's), a service's `user` with a group, and `${VAR:-default}` defaults. Docker Compose 5.1 and podman-compose 1.0.6, 1.2, 1.5 and 1.6 were checked to read them. A release's compose file uses the same, images pinned by digest alone (`name@sha256:…`), and `network_mode: none` for its `init` service, which you start with `compose run --rm`.

Two acceptance tests need Podman and refuse Docker: rig deploy and cluster. [Install Thermite on one machine](../how-to/install/one-machine.md) gives the commands for each tool.

## Kubernetes

| Point | Status | How it is tested |
| --- | --- | --- |
| Kubernetes version | No minimum is stated. Control's image carries `kubectl` v1.37.1 | A kind cluster on Podman (cluster acceptance), with kind's default node image. The kind version is not pinned |
| APIs used | `v1`, `apps/v1`, `networking.k8s.io/v1`; `resource.k8s.io/v1` for GPUs through dynamic resource allocation | |
| Placements | `created` (control makes the namespace), `slot` (a namespace made for Thermite), `joined` (a namespace join command) | Cluster acceptance tests `created` and `slot`, with CPU rigs only. In the slot it also moves the rig onto newly tagged images (**Update to these images**), and checks that the rig reports again with its volume claim and secret unchanged |
| GPUs through the device plugin (`nvidia.com/gpu`) | Control can set a rig up this way | Not tested |
| GPUs through dynamic resource allocation (a device class) | Control can set a rig up this way | Not tested |
| NetworkPolicy | Control writes them for `created` and `joined` placements, and checks a slot's rules before it uses the slot. They need a network plugin that enforces them, and the rig's isolation check fails when a lane reaches the cluster's API server | Cluster acceptance: a created namespace gets its policies, and a slot without the needed rule is refused |
| Running control itself on Kubernetes | No manifest or chart ships. [Goal 058](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/058-helm-and-npm.goal) plans one | Not tested |

See [Add a rig on a Kubernetes cluster](../how-to/install/rig-on-a-cluster.md).

## GPUs, CUDA and drivers

| Point | Status | How it is tested |
| --- | --- | --- |
| GPU vendor | NVIDIA only: `nvidia-smi`, `/dev/nvidia*` device nodes, CDI on machines, the device plugin or dynamic resource allocation on clusters | |
| GPUs on one rig | Up to 8 for the judge and 8 for the agents, and 16 in a rig's GPU set (`THERMITE_GPUS`). Up to 16 on a rig control sets up on a machine or cluster, on a machine you join, and on the local stack's rig; 8 on a joined namespace; 1 to 8 in a RunPod pod | The multi-GPU acceptance, with four fake GPUs (plain files and a stand-in `nvidia-smi`) |
| Several judge GPUs | They must be the same model. Otherwise only the first one judges, and the rig's hardware report says why | Not tested |
| CUDA | Two published CUDA harnesses, each on a CUDA development image pinned by digest in the release workflow ([The CUDA harness](harness-image.md#the-cuda-harness)). CUDA 12 (`-cuda`, on `nvidia/cuda:12.6.3-devel-ubuntu22.04`): Pascal (P100) and Volta (V100) to Hopper. CUDA 13 (`-cuda13`, on `nvidia/cuda:13.0.3-devel-ubuntu24.04`): Turing to Blackwell, the DGX Spark included; CUDA 13 builds for nothing older than Turing. Control sets GPU rigs up from the one `THERMITE_RIG_HARNESS_CUDA_IMAGE` names, the CUDA 12 image unless it is set. RunPod test pods ask for hosts with CUDA 12.6 or later | No test in the repository. A RunPod test pod checks one real GPU host: see [Test a GPU on RunPod](../how-to/install/runpod-test.md) |
| GPU architecture of the CUDA smoke kit | With CUDA 12, native code for `sm_60`, `sm_70`, `sm_75`, `sm_80`, `sm_86`, `sm_89` and `sm_90`; with CUDA 13, for `sm_75`, `sm_80`, `sm_86`, `sm_89`, `sm_90`, `sm_100` and `sm_120`, whose code also runs on the DGX Spark's `sm_121`. Each with PTX for newer GPUs: a run on one of those generations does not compile the kernel at start ([The smoke kits](rig-checks.md#the-smoke-kits-and-contract)) | |
| NVIDIA driver | No minimum is stated or checked. A machine's check reports the driver and CUDA versions | Not tested |
| NVIDIA container toolkit | 1.20.1-1 when control installs it, with a CDI specification for Podman | Not tested: the machines acceptance installs only Podman |
| Landlock (Linux kernel) | Used for the GPU fence when the kernel has it | Multi-GPU acceptance; the RunPod test's probe |
| GPU rigs under compose | The local stack's rig, `local-1`, with `compose.gpu.yaml`, which `thermite local init` writes: Docker with NVIDIA's runtime, Podman with a CDI spec ([Use the machine's NVIDIA GPUs](../how-to/install/one-machine.md#use-the-machines-nvidia-gpus)) | Unit tests of the file and of what each kind of machine gets; the file merged by `docker compose config` and `podman compose config`. Podman with a CDI spec was checked once by hand on a machine with one real NVIDIA GPU, under rootless Podman with podman-compose, from a checkout of the source code: the rig started, and passed its isolation check and the CUDA smoke check. Docker with NVIDIA's runtime: not yet on a real GPU ([goal 037](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/_completed/037-gpu-compose.goal)) |
| AMD GPUs | Found by `thermite doctor` and `thermite local init`, not used: the GPU images are CUDA only | |
| A Mac's Apple GPU | Not reachable: containers on macOS run in a Linux virtual machine. The rig gets the virtual machine's CPUs and memory | |

Without Landlock, and with device nodes that cannot be given their own groups, a GPU rig neither times nor allows development runs; it never falls back to sharing. [Sharing a device](../explanation/sharing-a-device.md) explains why, and [Give a rig several GPUs](../how-to/install/several-gpus.md) shows how to set the split.

## CPU architectures

| Image | Architectures | How it is tested |
| --- | --- | --- |
| Control | amd64 and arm64. Its build stops on any other: `kubectl` is pinned for these two only | CI builds it on amd64 (GitHub's `ubuntu-24.04` runners). The release workflow builds it for amd64 and arm64 |
| Harness, CPU | amd64 and arm64. It installs the arm64 package of OpenCode, Claude Code and the Codex CLI on arm64, and the x64 package on any other architecture | CI builds it on amd64. The release workflow builds it for amd64 and arm64 |
| Harness, CUDA 12 | amd64 | The release workflow builds it for amd64 only |
| Harness, CUDA 13 | amd64 and arm64, as its CUDA base is published | The release workflow builds it for amd64 and arm64, and its checks hold it to both. It has not yet run on a GPU ([Known limits](known-limits.md#the-cuda-13-harness-is-untested)) |
| Supervisor | amd64 and arm64. Claude Code, when built in, comes as its arm64 or x64 package | CI builds it on amd64. The release workflow builds it for amd64 and arm64 |
| One-container rig, CUDA | amd64, as the CUDA 12 harness it is built on | CI builds the rig image on the CPU harness, on amd64. The release workflow builds it on the CUDA 12 harness, for amd64 only |

The release workflow builds the arm64 images under emulation, on amd64 runners; no test runs them. Each published image of control, the CPU harness, the CUDA 13 harness and the supervisor is one name for both architectures, and Docker or Podman pulls the one that fits the machine. [Push the images to your own registry](../how-to/install/own-registry.md) builds them yourself, and [Harness image](harness-image.md) lists what each contains.

## Control and rig versions

Control, each rig's harness and each rig's supervisor report their Thermite version, the commit their image was built from, and their protocol: the version of the contract between control and a rig. Control compares each rig's with its own. The REST API, MCP's `list_rigs` and `thermite rig list` show a rig as `behind` when it runs an older version that control still works with, with a notice to update its images. [Rig versions](rest-api.md#rig-versions) gives every field and message. On the dashboard, **Rigs** shows each rig's version, with **needs update** when it is behind or refused ([The Rigs list](rigs-list.md#version)), and a rig's page shows its version and a banner when it is behind, ahead or refused, with **Update to** control's version for a rig control set up ([A rig's page](rig-page.md#the-version-banner)).

Control can move a rig it set up, on a machine or a cluster, onto the images it now deploys (**Update to** control's version on the rig's page; on a cluster, **Update to these images** too); joined rigs keep their images ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)).

| Case | What happens | How it is tested |
| --- | --- | --- |
| A rig runs a build from before version checks | It reports no version. Control shows its version as `unknown`, and never refuses it for that: its reports and commands go through as before | `tests/control/versions.test.ts` |
| A rig runs an older version, on a protocol control works with | Control takes its reports and sends it commands, and marks it `behind` | `tests/control/versions.test.ts` |
| A rig's protocol and control's do not meet | Control refuses its reports and commands, and says why in the rig lists, in the audit log (`rig_refused`) and in its supervisor's log. When the rig reports a build control works with, the refusal ends | `tests/control/versions.test.ts` |
| Control is updated | A new release keeps working with the protocol before its own, so an update of control never cuts off the rigs on the release before it, with one exception: a rig of v0.1.0 reports over HTTP, which v0.1.1 no longer takes (the next row). At start, control checks the rigs it refused again | `tests/core/version.test.ts` and `tests/control/versions.test.ts` |
| A rig's supervisor is newer than control | Control takes its figures, daily reports and exports, drops the fields it does not know, and marks the rig `ahead`. The harness's signed reports stay exact: a field a newer harness signs fails the signature. See [Fields control does not know](rest-api.md#fields-control-does-not-know) | `tests/control/versions.test.ts` |
| A rig runs v0.1.0, and control v0.1.1 | The rig reports, takes its commands and gets its config over HTTP, and v0.1.1 talks to a rig only on its message bus. Control refuses the supervisor's call with 409 `this rig has no keys on the message bus: …`, takes nothing from the rig, sends it nothing, and shows it **Broken** on its page, on **Rigs** and under **Needs you**. Set the rig up again with this version: [A rig from before the bus](../how-to/operate/message-bus.md#a-rig-from-before-the-bus) | `tests/control/bus/reach.test.ts` |
| Control's knowledge base has kinds of item a rig's build does not know | The rig's past-research sync leaves those items out, logs each kind once, and goes on. When the rig runs images that know the kind, its runs sync again from the beginning. See [What syncs and how often](knowledge-base.md#what-syncs-and-how-often) | `tests/supervisor/kb-sync.test.ts` |
| A rig's harness is older than control | It refuses a command kind it does not have with `malformed command`, and a payload its own schema does not allow with `bad payload: …`. A harness from before messages could be kept in force refuses `unkeep_message` and a `message_agent` to `all`, `teachers`, `auditor` or `review_panel`, and drops `keep` from other messages, which then are not kept in force; its message lines carry no message number, so a run's **Live** shows them without **To …**, and it writes no read lines. A harness from before the experiment queue refuses `queue_add`, `queue_move`, `queue_edit`, `queue_drop`, `queue_accept` and `drop_directive` with `malformed command`, and starts a run with an empty queue whatever `assign_campaign`'s `queue` holds. A harness from before a research run's hypotheses changed status by command refuses `hypothesis_status` with `malformed command`. Control signs a rule's direction as its name, so a harness from before rules named directions takes it, but its planner doesn't design a new direction: such a rule holds by name only, and control lists its direction with `to_design` until an experiment has it. Its planner doesn't convert an old rule in words either: the rule stays, marked legacy, until the harness is updated | Not tested |
| A harness opens a ledger an older harness wrote | It first copies the ledger beside itself (`ledger.db.v<version>.<time>.copy`, a consistent snapshot; the two newest copies are kept), then upgrades the ledger. The owner's messages from before read receipts count as read by the lane or the planner they were delivered to, and a message to the advisors as read by each of them, so none is given again | `tests/harness/ledger/migrations.test.ts`, with a ledger v0.1.0 wrote |
| A harness opens a ledger a newer harness upgraded | It refuses the ledger, and the harness does not start: `this ledger is at schema version <n>, newer than this code's <m>: run a newer Thermite, or restore the ledger from before the upgrade (the copy made then: <path>)`. The copy is named when one is beside the ledger. A rig moved back onto an older image can hit this | The harness's tests |
| Control opens a store an older control wrote | It copies `control.db` beside itself (`control.db.v<version>.<time>.copy`; the two newest copies are kept), then migrates it, each step in a transaction of its own: a step that fails leaves the store as it was before that step. A store v0.1.0 wrote has no schema version: it counts as version 0 | `tests/control/store/schema.test.ts`, with a store v0.1.0 wrote |
| Control opens a store that keeps the rigs' events in its events table (v0.1.0's, or one from before control published each report's events to its message bus first) | It migrates the store to version 11, then, before it takes a report, moves the table's rows to the bus's `EVENTS` stream, checks that the stream holds them all, and drops the table (version 12), with a copy of the store from just before kept beside it as `control.db.v11.<time>.kept` until you remove it: the rotation of the `.copy` files never removes it. A stream that does not hold the table whole stops control at start, and the table stays. See [the first start of a store from before](../how-to/operate/message-bus.md#the-first-start-of-a-store-from-before-its-events-table-moved) | `tests/system/events-move.test.ts`, with a store v0.1.0 wrote and one from before; `tests/control/store/schema.test.ts` |
| Control opens a store a newer control migrated | It refuses the store, and control does not start: `this control store is at schema version <n>, newer than this code's <m>: run a newer Thermite, or restore the control store from before the upgrade (the copy made then: <path>)` | `tests/control/store/schema.test.ts` |

## What is not known

- The oldest Docker, Docker Compose, Podman or podman-compose that runs the compose stack.
- The oldest Kubernetes that runs a rig, and whether GPU rigs work on a real cluster.
- The oldest NVIDIA driver that works.
- Windows, and whether the arm64 images work: no test runs them.
- How much memory and disk the stack needs. Lane build caches can reach 8 GB each. A cluster rig with resources set needs at least 1.5 CPUs and 8 GiB of memory while its agent programs run in their own terminal, the default, or 6 GiB headless ([The supervisor's share](../how-to/install/rig-on-a-cluster.md#the-supervisors-share)).
