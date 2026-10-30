---
title: "Ports, volumes and secret files"
description: "Every port, network, volume and secret file of control and a rig, under compose, on machines, on clusters and on RunPod."
type: reference
sidebar:
  order: 14
---

This page lists where each part of Thermite listens, which networks join them, where they keep their state, and which secret files they read. It covers each way of running Thermite: the local compose stack, rigs that control sets up on machines over SSH or with a join command, rigs on Kubernetes clusters, and rigs and test pods on RunPod. The [glossary](glossary.md) explains the terms; [How the parts fit together](../explanation/how-it-fits-together.md) and [Trust between control and rigs](../explanation/trust.md) explain the design.

## Ports

| Port | Who listens | Who connects | Setting |
| --- | --- | --- | --- |
| 8800/tcp | Control: the dashboard (`/ui`), the REST API (`/v1`), MCP (`/mcp`) and `/metrics` | People, scripts and agents; every rig's supervisor | `THERMITE_CONTROL_LISTEN`, default `0.0.0.0:8800` |
| 8700/tcp | The harness API | The rig's own supervisor. Inside the harness container, its workers and tools on `127.0.0.1` | `THERMITE_LISTEN`, default `0.0.0.0:8700` |
| 8701/tcp, on the supervisor container's own `127.0.0.1` | The supervisor's health route, `GET /v1/health`: whether it is well, and its loops' ages to its token ([Health](rest-api.md#health)) | Its health check, inside the container: compose's, the machine's unit's and Kubernetes' probes. Nothing outside the container reaches it. Outside pull mode, it is the only port the supervisor listens on: it connects out to its harness and to control, and to the message bus when it has one | `THERMITE_SUPERVISOR_HEALTH_LISTEN`, default `127.0.0.1:8701` |
| 4222/tcp | The message bus: the NATS server of the compose stack's `nats` service, over TLS only, with the certificate control's own authority signs | Control and every rig's supervisor, always, each signed in with its own key ([Who may use the message bus](../explanation/how-the-parts-talk.md#who-may-use-the-message-bus)): the compose stack's rigs inside the stack, and the rigs control sets up on machines and clusters, or that you join, from outside it. A rig talks to control only on the bus, so a rig that can't reach this port doesn't work, and shows broken. Never the harness | `THERMITE_NATS_URL`, `nats://nats:4222` under compose; published on the host at `THERMITE_NATS_PUBLISH`, `127.0.0.1:4222` by default; `THERMITE_NATS_PUBLIC_URL` for the rigs outside |
| 8222/tcp, on the `nats` container's own `127.0.0.1` | The NATS server's monitoring | Its health check, inside the container. Nothing outside the container reaches it | Fixed in the compose file |
| 8790/tcp | The supervisor of a rig in [pull mode](../explanation/trust.md#rigs-in-pull-mode), on every interface | Control alone, through RunPod's proxy, under a random path. Everything else gets an empty 404 | `THERMITE_TUNNEL_PORT`, `8790` in control's launch values and in the one-container rig image |
| A free port on `127.0.0.1` | The supervisor in pull mode: its own calls to control wait there for control's next exchange | The supervisor alone: the port takes only a token that lives in the supervisor's memory, and answers anything else with an empty 404 | Chosen at start |
| 7422/tcp | The pod's own NATS server, the leaf node of a rig on RunPod, on every interface, over TLS only ([A rig on RunPod](../explanation/how-the-parts-talk.md#a-rig-on-runpod)) | Control's NATS server alone, at the public address and port RunPod gives it: the port takes only a client certificate control's authority signed for control's server | Fixed; the launch exposes it as TCP (`7422/tcp`) |
| 4222/tcp, on the pod's own `127.0.0.1` | The pod's own NATS server, for its supervisor, over TLS | The rig's supervisor alone, signed in with the rig's key on the bus | Fixed |
| 22/tcp, or the machine's own | A machine's SSH server | Control, to check the machine and set rigs up on it | The machine's **SSH port** on the Providers page, 22 by default |
| The cluster's API server | Kubernetes | Control's `kubectl`, to set rigs up on a cluster, and later to stop, start, restart, update or remove them | The cluster's kubeconfig |
| 8000/tcp | A RunPod test pod's probe | Control, through RunPod's proxy, at an address with a random token in its path | Fixed |
| 8810/tcp | The dashboard demo (`scripts/dev/dashboard-demo/main.ts`) | A browser | `--port` |

Two Unix sockets matter too:

| Socket | In | Who uses it |
| --- | --- | --- |
| `/run/thermite/broker.sock` | The harness container | The harness's controller asks the broker, which runs as root, to start work as a role's user. Socket 0660, root and group `thermite`; directory 0750 |
| `/run/thermite-advisors/runs.sock` | The supervisor container; the one-container rig image | The supervisor asks the advisors' runner, which runs as root, to start each advisor's program as an advisor user ([below](#the-supervisors-users)). Socket 0660, root and the supervisor's group; directory 0750 |
| `/run/engine.sock` | Control, with `compose.lifecycle.yaml` only | Control restarts compose rigs through the container engine's socket. For development only |

### Under compose

- Control's port is published on the host at `127.0.0.1` only, port `THERMITE_CONTROL_PORT` (default 8800): `http://127.0.0.1:8800/ui`.
- The harness's port is not published. Supervisors reach it as `http://harness:8700` (and `http://harness-2:8700` with the `two-rigs` profile).
- Supervisors reach control as `http://control:8800`.
- Control and the supervisors reach the message bus as `nats://nats:4222`, over TLS. Its port is published on the host at `THERMITE_NATS_PUBLISH`, `127.0.0.1:4222` by default: set it to `0.0.0.0:4222`, or to one of the host's addresses, for rigs on other machines and clusters to reach it ([Run the message bus](../how-to/operate/message-bus.md#let-rigs-on-other-machines-reach-it)).

### On machines and clusters

- A rig's supervisor reaches control at `THERMITE_CONTROL_PUBLIC_URL`, control's address for rigs, and the message bus at `THERMITE_NATS_PUBLIC_URL`, by default the same host on port 4222, over TLS. Neither the harness nor the rig takes any connection from outside: the supervisor connects out to both.
- On a machine, the supervisor reaches its harness at `http://thermite-<rig>-harness:8700`.
- On a cluster, a Service `thermite-<rig>-harness` serves port 8700 to the supervisor. The kubelet asks the harness's `/v1/health` on port 8700 for its startup, readiness and liveness probes; it asks the supervisor's inside its container, with a program (`node -e …`), so the supervisor still takes no connection.

## Networks

### Compose

| Network | Kind | Members |
| --- | --- | --- |
| `rig` | Internal: no way out | `harness`, `supervisor` |
| `rig2` | Internal | `harness-2`, `supervisor-2` (the `two-rigs` profile) |
| `control` | Normal | `control`, `nats`, `backup`, `supervisor`, `supervisor-2` |
| `rig-egress` | Normal: the first rig's way out | `harness`, `supervisor` |
| `rig2-egress` | Normal: the second rig's way out | `harness-2`, `supervisor-2` |

Each rig has a way out of its own, so one rig's harness and supervisor share no network with another rig's harness: neither reaches the other's harness API, its health route included. The two supervisors share only `control`, where neither listens.

The harness is not on the `control` network, so it never reaches control or the message bus. Control and the harness also get the host name `host.docker.internal`, so they can reach a model server on the host. A release's compose file also has an `init` service, which makes the local tokens: it has no network at all (`network_mode: none`).

### Machines

Control's Quadlet units make two Podman networks for each rig. Both containers join both.

| Network | Kind |
| --- | --- |
| `thermite-<rig>` | Internal: the harness and the supervisor only |
| `thermite-<rig>-egress` | The way out of the rig |

### Kubernetes

For a rig in a namespace control creates, or one joined with a namespace join command, control adds two NetworkPolicies:

| Policy | Rule |
| --- | --- |
| `thermite-<rig>-harness-net` | In: only from the rig's supervisor, on port 8700. Out: DNS (port 53, UDP and TCP), every address outside the private, shared and link-local ranges below, and each address in **Settings › Addresses cluster rigs may reach**, alone (`/32`, or `/128` for IPv6), on its listed TCP ports |
| `thermite-<rig>-supervisor-net` | In: nothing |

These ranges are the private ranges of RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12` and `192.168.0.0/16`), the shared range of RFC 6598 (`100.64.0.0/10`: carrier-grade NAT, the pod or service addresses of some managed clusters, and Tailscale's addresses), the link-local range (`169.254.0.0/16`, where a cloud serves its machines' metadata) and `0.0.0.0/8`. The harness reaches an address in them, such as a model server or a target on your own network or a Tailscale address, only when the owner lists it, with its TCP ports, in **Settings › Addresses cluster rigs may reach** ([Reach a model server on a private or Tailscale address](../how-to/install/rig-on-a-cluster.md#reach-a-model-server-on-a-private-or-tailscale-address)). Control writes the list into the rule of each rig in a namespace it created as soon as the list changes; a joined rig has the list as it was when its join command ran. <!-- public-check: allow (reserved ranges, not addresses of any network) -->

In a **slot**, a namespace the cluster's operators made for Thermite, the operators write the policies. Control refuses a slot unless some egress policy selects the harness and every egress rule that selects it reaches only DNS, addresses outside the same ranges, or exactly an address of **Settings › Addresses cluster rigs may reach** (`/32` or `/128`) on some of its listed TCP ports. A rule that opens a listed address on every port, on another port, over UDP or as a range of ports is refused, and so is any wider block. The rig's page lists each listed address its slot opens. Control takes a slot whose rules let pods other than the rig's supervisor connect to the harness, and the rig's page warns about it, with the rule that would let only the supervisor in ([What a slot needs](../how-to/install/rig-on-a-cluster.md#what-a-slot-needs)). NetworkPolicies need a cluster network plugin that enforces them. In every placement on a cluster, the rig's [isolation check](rig-checks.md#isolation-check) tries to reach the cluster's API server from a lane, and fails when it can.

## Volumes and state

### What each container keeps

| Container | Path | Holds |
| --- | --- | --- |
| Control | `/var/lib/thermite-control` (`THERMITE_CONTROL_DIR`) | `control.db` and, after an update that migrated it, its two newest copies from before (`control.db.v<version>.<time>.copy`); `control.db` holds rigs, reports, commands, providers, MCP servers with their secrets and sign-ins sealed, [Thermite's knowledge base](knowledge-base.md), the audit log); `control-signing.key` (0600) and `control-signing.pub`; with the message bus, `bus-ca.key` (0600) and `bus-ca.pem`, control's own certificate authority for the bus, and `bus-backup.seed` (0600), the backup's key on the bus; `secrets.key`, which seals every key and sign-in control stores; `kits/`, kits written or uploaded on the **New campaign** page; `exports/`, the [exports](exports.md#where-control-keeps-them) of rigs without a results repository; `kb-files/`, the [knowledge base's files](knowledge-base.md#files), each once by its SHA-256; after a [restore](../how-to/operate/backup-and-restore.md#restore-a-backup), `replaced-<time>/`, what it replaced |
| Control | `/keys` | `control-signing.pub`, copied there for rigs (`THERMITE_CONTROL_PUBKEY_EXPORT`), and `bus-ca.pem`, its authority's certificate, for the supervisors (`THERMITE_NATS_CA_EXPORT`) |
| Control | `/nats-config` | The message bus's files (`THERMITE_NATS_CONFIG_DIR`): `users.conf` (0644), the bus's users that control writes for the NATS server, each user's public key and what it may do, never a seed, and each rig on RunPod's account and its pod's address; `server-cert.pem` (0644) and `server-key.pem` (0640), the server's TLS certificate, which control's authority signs, good for a client too, and its key; `leaf-<rig>-ca.pem` (0644) for each rig on RunPod, the authority of its pod's certificate. Control's own two keys on the bus are in `control.db`, their seeds sealed with `secrets.key`; the backup's is in control's state folder |
| Harness | `/var/lib/thermite` | The ledger, its two newest copies from before a migration (`ledger.db.v<version>.<time>.copy`), and the rig's report key (`ledger/`), git mirrors (`git/`), kits (`kits/`), imports (`imports/`), models (`models/`), builds (`builds/`), the model route control set (`model-route.json`, root only), the rig's settings (`rig-settings.json`; one the harness can't read is kept aside as `rig-settings.json.unreadable-<time>`, logged and reported, and the defaults apply) and its copy of each run's past research (`knowledge/<run>/`) |
| Harness | `/scratch` | Workspaces, lane caches, the judge's runs and each run's research folder (`thermite/research/<run>/`, with its `knowledge/`). Emptied at every start, except each lane's cache folder, `thermite/lanes/<lane>/cache`, which a start keeps when it is a real folder its own lane's user owns ([below](#a-lanes-cache)) |
| Harness | `/controller/inbox` | Read-only: project and kit bundles and [model files](model-files.md) the supervisor fetched. Mounted in `/controller`, a folder of the harness image that only root and the controller's group may enter, so no role reaches it |
| Harness | `/outbox` | Exports, written by the harness |
| Harness | `/keys` | Read-only: control's public key |
| NATS, the `nats` service | `/data` | JetStream's store: the `EVENTS` stream, every rig's events, kept for good; the `REPORTS` stream, each rig's reports sent over the bus until control has taken or refused them; the `COMMANDS` stream, each rig's commands until its supervisor takes them; the `LIVE` stream, the newest live lines, an hour and 256 MiB at most; the `CONFIG` stream, the latest value of each rig's config keys, each sealed to the rig's seal key; and the `KB_FILES` stream, the knowledge base's files in chunks, each until control has taken it. Control's consumers of the reports and of the live lines, `control-reports` and `control-live`, and each rig's consumers of its commands and its config, `rig-<rig>-commands` and `rig-<rig>-config`, keep their places there |
| NATS, the `nats` service | `/etc/nats/thermite` | What control wrote for it: `users.conf`, `server-cert.pem`, `server-key.pem` and each `leaf-<rig>-ca.pem`. The server's own settings, which include `users.conf` from here, are written at its start in its own `/tmp/thermite.conf`; `users.conf` names the other files by their paths here |
| Supervisor | `/var/lib/thermite-supervisor` | Its relay and export state, the exports waiting to be sent to control (`export-uploads.json`), where each run's past research sync is (`kb-state.json`), its local results repository (`results.git/`), its fetch caches, advisor records and the `ssh` home (`home/`). Also `bus-key.seed` (0600): the seed of the rig's own key on the bus, which never leaves the file; and `bus-seal.pem` (0600): the private part of the seal key that opens the rig's config from the bus, which never leaves the file either. In pull mode also `tunnel/` (`THERMITE_TUNNEL_DIR`, 0700: the pod's keys, its enrollment and the nonces it has seen) and `enrolled/` (`THERMITE_TUNNEL_ENROLLED_DIR`: `control.pub`, `rig.json` and `rig.env` for the harness) |
| Supervisor | `/supervisor/inbox` | Read and write: what it fetches for the harness. Mounted in `/supervisor`, a folder of the supervisor image that only root and the supervisor's group may enter, so no advisor's program reaches it |
| Supervisor | `/outbox` | Read-only: the harness's exports |
| Supervisor | `/results` | Compose only: the local results repository the rigs share |
| Supervisor | `/etc/thermite/advisors` | Compose only, read-only: the advisors file, if there is one |
| Supervisor | `/var/lib/thermite-advisors` | On the container's own disk: one folder for each advisor call while it runs, made by the supervisor and given to the call's advisor user for the call, then removed. The supervisor's, mode 0711, emptied at every start |
| Supervisor | `/keys` | Read-only: `bus-ca.pem`, control's authority's certificate, which it trusts the bus's server through (`THERMITE_NATS_CA_FILE`). Under compose, control's `control-pub` volume; on a machine, the rig's `bus/` folder. On a cluster the certificate is in the supervisor's environment instead (`THERMITE_NATS_CA`) |

### A lane's cache

Each lane keeps a cache folder for its builds, `/scratch/thermite/lanes/<lane>/cache` (`$THERMITE_LANE_CACHE` and `CCACHE_DIR` in its commands, at most 8 GB). Its trials share it, so a fresh workspace does not rebuild everything; the judge builds without it. Each trial's checkout is a new folder, `/scratch/thermite/lanes/<lane>/<id>/repo`, so ccache gets `CCACHE_BASEDIR`, the lane's folder, and `CCACHE_NOHASHDIR=1`: it keys each compile on paths relative to the build folder. A build in the same folder of the checkout in each trial, such as `build/`, then hits what earlier trials compiled. The worker's brief says so. It outlives a restart of the harness, an image update and a restart of the rig wherever `/scratch` is on a volume that outlives the container:

| Where the rig runs | `/scratch` is | Its lane caches after a restart |
| --- | --- | --- |
| The compose stack | The named volume `harness-scratch` (`harness2-scratch` for the second rig) | Kept |
| A machine, set up by control | The Podman volume `thermite-<rig>-scratch` | Kept |
| A cluster, set up by control | The rig's data volume claim, subpath `scratch` | Kept |
| RunPod | The pod's container disk | Kept over a restart of the harness; lost when the pod stops |

A deployment of your own that puts `/scratch` on an empty folder at each start, such as an `emptyDir` or a `tmpfs`, loses them: each lane then rebuilds its project at its first trial after a restart. A full reset empties them too.

A full reset empties the harness's state, scratch and outbox, keeping only the rig's report key, and the supervisor's home, keeping only the rig's keys on the message bus (`bus-key.seed` and `bus-seal.pem`) and a pull mode rig's `tunnel/` and `enrolled/`. Control's knowledge base keeps the items the rig's runs reported before. See [Stop, restart, remove or reset a rig](../how-to/operate/rig-lifecycle.md).

### Compose volumes

| Volume or folder | Mounted in | At | Mode |
| --- | --- | --- | --- |
| `control-state` | control; backup | `/var/lib/thermite-control` | read-write |
| `control-pub` | control; harness, harness-2; supervisor, supervisor-2 | `/keys` | read-write in control; read-only in the harnesses and the supervisors |
| `nats-config` | control; nats; nats-init | `/nats-config` in control; `/etc/nats/thermite` in nats and nats-init | read-write in control; read in nats. `nats-init` gives the folder to control's user before the bus starts |
| `harness-state`, `harness2-state` | harness, harness-2 | `/var/lib/thermite` | read-write |
| `harness-scratch`, `harness2-scratch` | harness, harness-2 | `/scratch` | read-write |
| `./.dev/inbox` (a folder) | harnesses and supervisors | `/controller/inbox` in the harnesses; `/supervisor/inbox` in the supervisors | read-only in the harnesses; read-write in the supervisors |
| `outbox`, `outbox2` | a harness and its supervisor | `/outbox` | read-write in the harness; read-only in the supervisor |
| `supervisor-home`, `supervisor2-home` | supervisor, supervisor-2 | `/var/lib/thermite-supervisor` | read-write |
| `results` | both supervisors | `/results` | read-write. The default results repository is `file:///results/results.git` |
| `nats-data` | nats; nats-init; backup | `/data` in nats and nats-init; `/bus-store` in backup | read-write. `nats-init` gives each file the bus's user (10002) does not own yet to it before the bus starts, a store from before included. It holds the `EVENTS` stream, every rig's events, which control's records in `control-state` are applied from: keep the two together, as `thermite backup` does. Control refuses a store that applied the stream past its end. A restore's `--bus-store` moves its contents into `replaced-<time>/` inside it |
| `./.dev/advisors` (a folder) | both supervisors | `/etc/thermite/advisors` | read-only |
| `./.dev/backups` (a folder) | backup | `/backups` | read-write. `thermite backup` writes each backup here, and `thermite restore` reads it. The `backup` service runs as root with only the capabilities `CHOWN`, `DAC_OVERRIDE` and `FOWNER`, and gives what it writes here to the folder's owner |
| `.` (the folder that holds `compose.yaml`) | init, in a release's compose file | `/work` | read-write. It runs as root, with only the capabilities `CHOWN`, `DAC_OVERRIDE` and `FOWNER` |

The `init` service makes the `.dev/` folders, next to `compose.yaml`: it runs `thermite local init` with that folder mounted at `/work`. On a machine with NVIDIA GPUs, it also writes `compose.gpu.yaml` there, which gives the harness the machine's GPUs ([Use the machine's NVIDIA GPUs](../how-to/install/one-machine.md#use-the-machines-nvidia-gpus)). In a checkout of the source code, `npm run dev:init` makes the same folders. `docker compose down -v` removes the named volumes; without `-v` they keep their state.

### Machines

| What | Where |
| --- | --- |
| The rig's files | `$HOME/.local/share/thermite/rigs/<rig>` for a user, `/var/lib/thermite/rigs/<rig>` for root. Mode 0700: only the rig's user may open it. Its `keys/` folder is 0755, so that the harness's controller, which is not the container's root, can read control's public key. With the message bus, its `bus/` folder (0755) holds `bus-ca.pem`, control's authority's certificate, which the supervisor alone mounts at `/keys`; control writes it at setup and again at each update of the rig's images |
| The units | `$HOME/.config/containers/systemd` for a user, `/etc/containers/systemd` for root: `thermite-<rig>.network`, `thermite-<rig>-egress.network`, `thermite-<rig>-harness.container`, `thermite-<rig>-supervisor.container` |
| The services | `thermite-<rig>-harness.service`, `thermite-<rig>-supervisor.service` |

| Podman volume | Harness | Supervisor |
| --- | --- | --- |
| `thermite-<rig>-state` | `/var/lib/thermite` | |
| `thermite-<rig>-scratch` | `/scratch` | |
| `thermite-<rig>-inbox` | `/controller/inbox`, read-only | `/supervisor/inbox`, read-write |
| `thermite-<rig>-outbox` | `/outbox`, read-write | `/outbox`, read-only |
| `thermite-<rig>-supervisor` | | `/var/lib/thermite-supervisor` |

Removing a rig removes these five volumes, the two networks, the unit files and the rig's folder.

### Kubernetes

| Object | What |
| --- | --- |
| PersistentVolumeClaim `thermite-<rig>-data` | One volume, `ReadWriteOnce`, 100 GB unless set (1 to 10,000 GB), in the cluster's default storage class unless one is named |
| Its subpaths | `state` → `/var/lib/thermite`; `scratch` → `/scratch`; `inbox` → `/controller/inbox`, read-only, in the harness and `/supervisor/inbox` in the supervisor (the supervisor's, with the controller's group `thermite`, mode 2750, as `prepare` sets it); `outbox` → `/outbox` (read-only in the supervisor); `supervisor` → `/var/lib/thermite-supervisor` |
| Init container `prepare` | Runs the harness image to make the folders and set their owners before each pod starts: as root with the controller's group (10010), and only the `CHOWN`, `FOWNER` and `FSETID` capabilities |

Both pods run on the same node, so they can share the volume. An update to control's images or address (**Update to these images**, **Try the update again** or **Give it control's new address** on the rig's page) applies the rig's two Deployments again and leaves its volume claim, its Secret and its Service as they are, so the rig keeps its state and its tokens.

### RunPod test pods

A test pod has one container disk: 40 GB unless set, 10 to 2,000 GB. Control removes the pod, and its disk, when the test ends.

### Rigs on RunPod

| What | Where | Holds |
| --- | --- | --- |
| The pod's container disk | 40 GB unless set (`container_disk_gb`), emptied when the pod stops | The rig's live state in `/var/lib/thermite-rig`, and `/scratch` |
| The pod's volume | `/workspace`, 100 GB unless set (`volume_gb`), kept while the pod is stopped and removed with it | A sealed snapshot of the rig's state, in `/workspace/thermite`. The volume ignores file modes, so every user in the pod can read it: every file is encrypted and authenticated with the pod's snapshot key |

The [one-container rig image](harness-image.md#where-the-state-lives) says when the snapshot is taken, how it is sealed, and how a start checks and restores it.

## The supervisor's users

The supervisor's container runs as root a small entry, which starts everything else as a user of its own, as the harness's broker does. In the one-container rig image the broker does it.

| User | Ids | Runs | Reaches |
| --- | --- | --- | --- |
| root | 0 | The entry (`/opt/thermite/dist/supervisor/advisor-runs/main.js`): it closes the folders below, serves the advisors' runner and starts the supervisor, again whenever it exits. In the one-container rig image, the broker | Everything in the container |
| `supervisor` | uid and gid 10001 | The supervisor, with no capability, and Pi advisors in its own process | Its state, its secret files, the inbox, the outbox, the results |
| `advisor-1` to `advisor-8` | uid and gid 10081 to 10088, in none of the supervisor's groups | Each program an advisor runs in (Claude Code, OpenCode, the Codex CLI, a `cli` advisor's command): one user for each call while it runs, in a folder of `/var/lib/thermite-advisors` that is the user's for the call. Claude Code's token comes on its file descriptor 3, as before | Its prompt, its settings (its model route and the call's own credentials) and its folder. When the program exits or its time is up, every process of its user ends, and the folder is the supervisor's again, so it reads what the call left |

Before the supervisor starts, the entry closes `/run/secrets` and `/etc/thermite` to root and the supervisor's group (0750), and `/supervisor`, the inbox's folder, the same way; it makes the supervisor's state and `/results` the supervisor's, mode 0700; and it gives the inbox to the supervisor where the supervisor may not write in it yet (a machine's new volume). An inbox from your computer under compose keeps its owner and modes: its closed folder keeps the advisor users out. The [isolation check](rig-checks.md#the-supervisors-part) probes all of it. A container that does not run as root stops with `fatal: not root, so advisor programs cannot run as users of their own`, unless `THERMITE_ALLOW_UNSEPARATED=1` (development only) starts the supervisor without its runner.

The capabilities each placement gives the supervisor's container, for its entry only; the supervisor and the advisors' programs keep none, and nothing in the container can gain privileges:

| Placement | Capabilities | No new privileges |
| --- | --- | --- |
| Compose, and a release's `compose.yaml` | `cap_drop: [ALL]`, `cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID]` | `no-new-privileges:true` |
| A machine (Quadlet) | `DropCapability=ALL`, `AddCapability=CHOWN DAC_OVERRIDE FOWNER KILL SETGID SETUID` | `NoNewPrivileges=true` |
| A cluster | `runAsUser: 0`, `capabilities: {drop: [ALL], add: [CHOWN, DAC_OVERRIDE, FOWNER, KILL, SETGID, SETUID]}` | `allowPrivilegeEscalation: false` |
| The one-container rig image | The broker's, as before: nothing more | The broker starts the supervisor and each advisor's program with `setpriv --no-new-privs`, in the GPU fence with no card |

## Secret files

### What each container reads

| File | Read by | Setting | Holds |
| --- | --- | --- | --- |
| The owner's token | Control | `THERMITE_CONTROL_ADMIN_TOKEN_FILE` | For local use. Deployed, control takes the token's SHA-256 instead (`THERMITE_CONTROL_ADMIN_TOKEN_SHA256`). See [Tokens and roles](tokens.md) |
| The operator's, agent's and reader's tokens | Control | `THERMITE_CONTROL_OPERATOR_TOKEN_FILE`, `THERMITE_CONTROL_AGENT_TOKEN_FILE`, `THERMITE_CONTROL_READ_TOKEN_FILE` | Optional, as above |
| The secrets key | Control | `THERMITE_CONTROL_SECRETS_KEY_FILE`, default `secrets.key` in control's state folder | The key that seals every provider key, Git access, machine key, kubeconfig, RunPod key, MCP server's key, client secret and sign-in, and control's own keys on the message bus. Made on first start |
| Control's keys on the message bus | Control | `control.db`, sealed with the secrets key | Control's user and its system user, which asks the NATS server to reload its users and for its store's figures. Made at the first start with `THERMITE_NATS_URL` |
| The backup's key on the message bus | `thermite backup` and `thermite restore` | `bus-backup.seed` in control's state folder, 0600 | The seed of the backup's NATS user key, which may only take and restore a snapshot of the `EVENTS` stream. Control makes it at its first start with the bus, and writes its public part to the server's users |
| Control's signing key | Control | `control-signing.key` in control's state folder, 0600 | Signs every command to rigs. Made on first start |
| The bus's certificate authority | Control | `bus-ca.key` in control's state folder, 0600, beside `bus-ca.pem` | Signs the bus's server's certificate. Made at the first start with `THERMITE_NATS_URL`, valid for 10 years. Only its certificate leaves control, to every rig |
| The bus's server's key | The NATS server | `server-key.pem` in `THERMITE_NATS_CONFIG_DIR`, 0640, control's user and group | The key of the server's TLS certificate. Control makes it with each new certificate |
| The supervisor token | Harness and supervisor | `THERMITE_SUPERVISOR_TOKEN_FILE` (harness), `THERMITE_HARNESS_TOKEN_FILE` (supervisor) | The token the supervisor uses with its harness. Required |
| The proposer token | Harness | `THERMITE_PROPOSER_TOKEN_FILE` | Optional: lets a person or script submit changes with `thermite submit` |
| The model key | Harness | `THERMITE_MODEL_API_KEY_FILE` | The agents' model key, when the rig's own settings give the model. A model from control comes with its key instead |
| The rig's control token | Supervisor | `THERMITE_CONTROL_TOKEN_FILE` | The rig's token for control, which control made when it enrolled the rig; control keeps only its SHA-256. It authenticates the registration of the rig's keys on the message bus and the rig's results over HTTPS |
| Control's public key | Harness | `THERMITE_CONTROL_PUBKEY_FILE` | Checks every command's signature. The harness waits up to 120 s for it at start. In pull mode, enrollment leaves it in `control.pub` in `THERMITE_TUNNEL_ENROLLED_DIR`; in the one-container rig image, root checks its SHA-256 against the launch's and copies it to `THERMITE_CONTROL_PUBKEY_FILE` before the harness starts |
| The rig's report key | Harness | `ledger/rig-signing.key` in its state, 0600 | Signs the rig's reports. Made on first start |
| The rig's key on the message bus | Supervisor | `bus-key.seed` in its state folder, 0600 | The seed of the rig's NATS user key. Made at the supervisor's first start; only its public part goes to control, in the registration of its keys at each start. A full reset keeps it |
| The rig's seal key | Supervisor | `bus-seal.pem` in its state folder, 0600 | An X25519 private key, which opens the rig's config that control seals to it on the bus (its model routes' keys, its MCP servers' sign-ins and its Git accesses). Made beside the key above; only its public part goes to control, on the same call. A full reset keeps it |
| The pod's keys | Supervisor, in pull mode | `keys.json` in `THERMITE_TUNNEL_DIR`, 0600 | Sign the pod's answers to control and open what control seals to the pod. Made on first start; control pins their public halves at enrollment |
| The enrollment code | Supervisor, in pull mode | `THERMITE_TUNNEL_ENROLL_CODE` in the pod's environment | A one-time code. It never crosses the network, and the first enrollment spends it. The supervisor takes it out of its own environment at start |
| The pod's leaf node key | Supervisor, in pull mode, and the pod's NATS server | `THERMITE_LEAF_KEY` in the pod's environment; `leaf-key.pem` in `THERMITE_TUNNEL_DIR/bus`, 0600 | The TLS key of the pod's server, which control's server dials. Control makes a new one for each pod at its launch, with a certificate signed by an authority it makes for that pod alone and drops at once, and keeps neither key; RunPod keeps it in the pod's settings. The supervisor writes it to its file and takes it out of its own environment at start |
| The snapshot key | The broker (root), in the one-container rig image | `THERMITE_STATE_SNAPSHOT_KEY` in the pod's environment | Seals the rig's state snapshot on the pod's volume. Control makes a new one for each pod at its launch and keeps no copy; RunPod keeps it in the pod's settings. The broker takes it out of its own environment at start, so no part and no role has it |
| The results repository key | Supervisor | `THERMITE_RESULTS_KEY_FILE`, `THERMITE_RESULTS_KNOWN_HOSTS` | Optional: an SSH deploy key that can write to the results repository, and its host key. See [Set up the results repository](../how-to/operate/results-repository.md) |
| A knowledge base token | Supervisor | `kb.token_file` in the [advisors file](advisors-file.md) | Optional |
| A Hugging Face token | Supervisor | `THERMITE_HF_TOKEN_FILE` | Optional: for [gated model files](model-files.md#gated-models-on-hugging-face). Sent to Hugging Face only, never to the harness |
| An MCP server's key, client secret or OAuth sign-in | Control | Entered in **Settings › Providers › MCP servers**, or signed in on the server's page; kept sealed in `control.db` | Optional. Control hands a rig the server's sign-in as headers (an access token for OAuth and a client, never the refresh token or the client secret) only when a run it assigned that rig names the server. The supervisor and the harness keep it in memory; no lane can read it. See [Who holds your keys](../explanation/who-holds-your-keys.md#mcp-servers) |

At start, the harness's broker reads its secret files as root, gives their values only to the controller, and closes their folder to 0700. If a secret file and its folder both stay readable by other users, it stops with `fatal: a secret file stays readable by other users`. The supervisor's entry closes the supervisor's secret files' folder to root and the supervisor's group ([The supervisor's users](#the-supervisors-users)).

### Where they come from

| Way of running | Files | Mounted at |
| --- | --- | --- |
| Compose | The `init` service (`docker compose run --rm init`), or `npm run dev:init` in a checkout, writes them to `.dev/secrets/`, mode 0644: `control-admin-token`, `control-operator-token`, `control-rig-token`, `harness-supervisor-token`, `harness-proposer-token`, `model-api-key`, and the second rig's `control-rig-token-2`, `harness2-supervisor-token`, `harness2-proposer-token`. Each rig's `control-rig-token` file starts empty: at each `up`, the `enroll` service (`enroll-2` for the second rig) enrolls the rig with control and writes the token control made into it, before the rig's supervisor starts ([`thermite local enroll`](command-line.md#local-enroll)) | `/run/secrets/<name>`, each only in the containers that use it; the enroll service writes its rig's token file through `/enroll/<name>` |
| `thermite rig add --out DIR` | `secrets/control-rig-token` and `secrets/harness-supervisor-token` (0600, in a 0700 folder); `keys/control-signing.pub` and `keys/control-signing.fingerprint`; `keys/bus-ca.pem`; `rig.env` with `THERMITE_RIG_ID`, `CONTROL_URL` and `THERMITE_NATS_URL`; `README.txt`. Nothing at all when control has no address for rigs on its bus | Wherever your own deployment puts them |
| Machines (over SSH or a join command) | `secrets/control-rig-token`, `secrets/harness-supervisor-token`, `keys/control-signing.pub`, `keys/control-signing.fingerprint` and `bus/bus-ca.pem`, in the rig's folder | `/run/secrets/<name>` and `/keys`, read-only |
| Kubernetes | A Secret `thermite-<rig>` with `control-rig-token`, `harness-supervisor-token` and `control-signing.pub`. The supervisor's Deployment also carries the bus's address and control's authority's certificate, which is no secret, in its environment (`THERMITE_NATS_URL`, `THERMITE_NATS_CA`) | Each key as its own read-only file, at `/run/secrets/<name>` or `/keys/control-signing.pub` |
| RunPod test pods | None: the probe's report token is in the pod's environment | |

Control also writes short-lived files while it works: an SSH key and known hosts for each SSH call, and a kubeconfig for each `kubectl` call. Each is 0600 in its own 0700 temporary folder and is removed after the call. [Who holds your keys](../explanation/who-holds-your-keys.md) explains which keys are kept where.
