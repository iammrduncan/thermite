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
| 8701/tcp, on the supervisor container's own `127.0.0.1` | The supervisor's health route, `GET /v1/health`: its loops' ages ([Health](rest-api.md#health)) | Its health check, inside the container: compose's, the machine's unit's and Kubernetes' probes. Nothing outside the container reaches it. Outside pull mode, it is the only port the supervisor listens on: it connects out to its harness and to control, and to the message bus when it has one | `THERMITE_SUPERVISOR_HEALTH_LISTEN`, default `127.0.0.1:8701` |
| 4222/tcp | The message bus: the NATS server of the compose stack's `nats` service, over TLS only, with the certificate control's own authority signs | Control, always, and the supervisors, when their `THERMITE_NATS_URL` names it, each signed in with its own key ([Who may use the message bus](../explanation/how-the-parts-talk.md#who-may-use-the-message-bus)): the compose stack's rigs inside the stack, and the rigs control sets up on machines and clusters from outside it. Never the harness | `THERMITE_NATS_URL`, `nats://nats:4222` under compose; published on the host at `THERMITE_NATS_PUBLISH`, `127.0.0.1:4222` by default; `THERMITE_NATS_PUBLIC_URL` for the rigs outside |
| 8222/tcp, on the `nats` container's own `127.0.0.1` | The NATS server's monitoring | Its health check, inside the container. Nothing outside the container reaches it | Fixed in the compose file |
| 8790/tcp | The supervisor of a rig in [pull mode](../explanation/trust.md#rigs-in-pull-mode), on every interface | Control alone, through RunPod's proxy, under a random path. Everything else gets an empty 404 | `THERMITE_TUNNEL_PORT`, `8790` in control's launch values and in the one-container rig image |
| A free port on `127.0.0.1` | The supervisor in pull mode: its own calls to control wait there for control's next exchange | The supervisor alone: the port takes only a token that lives in the supervisor's memory, and answers anything else with an empty 404 | Chosen at start |
| 22/tcp, or the machine's own | A machine's SSH server | Control, to check the machine and set rigs up on it | The machine's **SSH port** on the Providers page, 22 by default |
| The cluster's API server | Kubernetes | Control's `kubectl`, to set rigs up on a cluster, and later to stop, start, restart, update or remove them | The cluster's kubeconfig |
| 8000/tcp | A RunPod test pod's probe | Control, through RunPod's proxy, at an address with a random token in its path | Fixed |
| 8810/tcp | The dashboard demo (`scripts/dev/dashboard-demo/main.ts`) | A browser | `--port` |

Two Unix sockets matter too:

| Socket | In | Who uses it |
| --- | --- | --- |
| `/run/thermite/broker.sock` | The harness container | The harness's controller asks the broker, which runs as root, to start work as a role's user. Socket 0660, root and group `thermite`; directory 0750 |
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
| `egress` | Normal: the way out | `harness`, `supervisor`, `harness-2`, `supervisor-2` |

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
| `thermite-<rig>-harness-net` | In: only from the rig's supervisor, on port 8700. Out: DNS (port 53, UDP and TCP), and addresses outside the private ranges of RFC 1918 |
| `thermite-<rig>-supervisor-net` | In: nothing |

In a **slot**, a namespace the cluster's operators made for Thermite, the operators write the policies. Control refuses a slot unless some egress policy selects the harness and every egress rule that selects it reaches only DNS or addresses outside the private ranges. NetworkPolicies need a cluster network plugin that enforces them.

## Volumes and state

### What each container keeps

| Container | Path | Holds |
| --- | --- | --- |
| Control | `/var/lib/thermite-control` (`THERMITE_CONTROL_DIR`) | `control.db` and, after an update that migrated it, its two newest copies from before (`control.db.v<version>.<time>.copy`); `control.db` holds rigs, reports, commands, providers, MCP servers with their secrets and sign-ins sealed, [Thermite's knowledge base](knowledge-base.md), the audit log); `control-signing.key` (0600) and `control-signing.pub`; with the message bus, `bus-ca.key` (0600) and `bus-ca.pem`, control's own certificate authority for the bus, and `bus-backup.seed` (0600), the backup's key on the bus; `secrets.key`, which seals every key and sign-in control stores; `kits/`, kits written or uploaded on the **New campaign** page; `exports/`, the [exports](exports.md#where-control-keeps-them) of rigs without a results repository; `kb-files/`, the [knowledge base's files](knowledge-base.md#files), each once by its SHA-256; after a [restore](../how-to/operate/backup-and-restore.md#restore-a-backup), `replaced-<time>/`, what it replaced |
| Control | `/keys` | `control-signing.pub`, copied there for rigs (`THERMITE_CONTROL_PUBKEY_EXPORT`); with the message bus, `bus-ca.pem`, its authority's certificate, for the supervisors (`THERMITE_NATS_CA_EXPORT`) |
| Control | `/nats-config` | With the message bus (`THERMITE_NATS_CONFIG_DIR`): `users.conf` (0644), the bus's users that control writes for the NATS server, each user's public key and what it may do, never a seed; `server-cert.pem` (0644) and `server-key.pem` (0640), the server's TLS certificate, which control's authority signs, and its key. Control's own two keys on the bus are in `control.db`, their seeds sealed with `secrets.key`; the backup's is in control's state folder |
| Harness | `/var/lib/thermite` | The ledger, its two newest copies from before a migration (`ledger.db.v<version>.<time>.copy`), and the rig's report key (`ledger/`), git mirrors (`git/`), kits (`kits/`), imports (`imports/`), models (`models/`), builds (`builds/`), the model route control set (`model-route.json`, root only), the rig's settings (`rig-settings.json`; one the harness can't read is kept aside as `rig-settings.json.unreadable-<time>`, logged and reported, and the defaults apply) and its copy of each run's past research (`knowledge/<run>/`) |
| Harness | `/scratch` | Workspaces, lane caches, the judge's runs and each run's research folder (`thermite/research/<run>/`, with its `knowledge/`). Emptied at every start, except each lane's cache folder, `thermite/lanes/<lane>/cache`, which a start keeps when it is a real folder its own lane's user owns ([below](#a-lanes-cache)) |
| Harness | `/inbox` | Read-only: project and kit bundles and [model files](model-files.md) the supervisor fetched |
| Harness | `/outbox` | Exports, written by the harness |
| Harness | `/keys` | Read-only: control's public key |
| NATS, the `nats` service | `/data` | JetStream's store: the `EVENTS` stream, every rig's events, kept for good; the `REPORTS` stream, each rig's reports sent over the bus until control has taken or refused them; the `COMMANDS` stream, each rig's commands until its supervisor takes them; the `LIVE` stream, the newest live lines, an hour and 256 MiB at most; the `CONFIG` stream, the latest value of each rig's config keys, each sealed to the rig's seal key; and the `KB_FILES` stream, the knowledge base's files in chunks, each until control has taken it. Control's consumers of the reports and of the live lines, `control-reports` and `control-live`, and each rig's consumers of its commands and its config, `rig-<rig>-commands` and `rig-<rig>-config`, keep their places there |
| NATS, the `nats` service | `/etc/nats/thermite` | What control wrote for it: `users.conf`, `server-cert.pem` and `server-key.pem`. The server's own settings, which include them, are written at its start beside the folder, in `/etc/nats/thermite.conf` |
| Supervisor | `/var/lib/thermite-supervisor` | Its relay and export state, the exports waiting to be sent to control (`export-uploads.json`), where each run's past research sync is (`kb-state.json`), its local results repository (`results.git/`), its fetch caches, advisor records and the `ssh` home (`home/`). With the message bus also `bus-key.seed` (0600): the seed of the rig's own key on the bus, which never leaves the file; and `bus-seal.pem` (0600): the private part of the seal key that opens the rig's config from the bus, which never leaves the file either. In pull mode also `tunnel/` (`THERMITE_TUNNEL_DIR`, 0700: the pod's keys, its enrollment and the nonces it has seen) and `enrolled/` (`THERMITE_TUNNEL_ENROLLED_DIR`: `control.pub`, `rig.json` and `rig.env` for the harness) |
| Supervisor | `/inbox` | Read and write: what it fetches for the harness |
| Supervisor | `/outbox` | Read-only: the harness's exports |
| Supervisor | `/results` | Compose only: the local results repository the rigs share |
| Supervisor | `/etc/thermite/advisors` | Compose only, read-only: the advisors file, if there is one |
| Supervisor | `/keys` | With the message bus, read-only: `bus-ca.pem`, control's authority's certificate, which it trusts the bus's server through (`THERMITE_NATS_CA_FILE`). Under compose, control's `control-pub` volume; on a machine, the rig's `bus/` folder. On a cluster the certificate is in the supervisor's environment instead (`THERMITE_NATS_CA`) |

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
| `nats-config` | control; nats | `/nats-config` in control; `/etc/nats/thermite` in nats | read-write in control; read in nats, which gives the folder to control's user as it starts |
| `harness-state`, `harness2-state` | harness, harness-2 | `/var/lib/thermite` | read-write |
| `harness-scratch`, `harness2-scratch` | harness, harness-2 | `/scratch` | read-write |
| `./.dev/inbox` (a folder) | harnesses and supervisors | `/inbox` | read-only in the harnesses; read-write in the supervisors |
| `outbox`, `outbox2` | a harness and its supervisor | `/outbox` | read-write in the harness; read-only in the supervisor |
| `supervisor-home`, `supervisor2-home` | supervisor, supervisor-2 | `/var/lib/thermite-supervisor` | read-write |
| `results` | both supervisors | `/results` | read-write. The default results repository is `file:///results/results.git` |
| `nats-data` | nats; backup | `/data` in nats; `/bus-store` in backup | read-write. It holds the `EVENTS` stream, every rig's events, which control's records in `control-state` are applied from: keep the two together, as `thermite backup` does. Control refuses a store that applied the stream past its end. A restore's `--bus-store` moves its contents into `replaced-<time>/` inside it |
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
| `thermite-<rig>-inbox` | `/inbox`, read-only | `/inbox`, read-write |
| `thermite-<rig>-outbox` | `/outbox`, read-write | `/outbox`, read-only |
| `thermite-<rig>-supervisor` | | `/var/lib/thermite-supervisor` |

Removing a rig removes these five volumes, the two networks, the unit files and the rig's folder.

### Kubernetes

| Object | What |
| --- | --- |
| PersistentVolumeClaim `thermite-<rig>-data` | One volume, `ReadWriteOnce`, 100 GB unless set (1 to 10,000 GB), in the cluster's default storage class unless one is named |
| Its subpaths | `state` → `/var/lib/thermite`; `scratch` → `/scratch`; `inbox` → `/inbox` (read-only in the harness); `outbox` → `/outbox` (read-only in the supervisor); `supervisor` → `/var/lib/thermite-supervisor` |
| Init container `prepare` | Runs the harness image to make the folders and set their owners before each pod starts |

Both pods run on the same node, so they can share the volume. An update to control's images or address (**Update to these images**, **Try the update again** or **Give it control's new address** on the rig's page) applies the rig's two Deployments again and leaves its volume claim, its Secret and its Service as they are, so the rig keeps its state and its tokens.

### RunPod test pods

A test pod has one container disk: 40 GB unless set, 10 to 2,000 GB. Control removes the pod, and its disk, when the test ends.

### Rigs on RunPod

| What | Where | Holds |
| --- | --- | --- |
| The pod's container disk | 40 GB unless set (`container_disk_gb`), emptied when the pod stops | The rig's live state in `/var/lib/thermite-rig`, and `/scratch` |
| The pod's volume | `/workspace`, 100 GB unless set (`volume_gb`), kept while the pod is stopped and removed with it | A sealed snapshot of the rig's state, in `/workspace/thermite`. The volume ignores file modes, so every user in the pod can read it: every file is encrypted and authenticated with the pod's snapshot key |

The [one-container rig image](harness-image.md#where-the-state-lives) says when the snapshot is taken, how it is sealed, and how a start checks and restores it.

## Secret files

### What each container reads

| File | Read by | Setting | Holds |
| --- | --- | --- | --- |
| The owner's token | Control | `THERMITE_CONTROL_ADMIN_TOKEN_FILE` | For local use. Deployed, control takes the token's SHA-256 instead (`THERMITE_CONTROL_ADMIN_TOKEN_SHA256`). See [Tokens and roles](tokens.md) |
| The operator's, agent's and reader's tokens | Control | `THERMITE_CONTROL_OPERATOR_TOKEN_FILE`, `THERMITE_CONTROL_AGENT_TOKEN_FILE`, `THERMITE_CONTROL_READ_TOKEN_FILE` | Optional, as above |
| The rig tokens file | Control | `THERMITE_CONTROL_RIG_TOKENS_FILE` | `{"<rig>": "<token>"}` for rigs not enrolled through control. Read once, at start |
| The secrets key | Control | `THERMITE_CONTROL_SECRETS_KEY_FILE`, default `secrets.key` in control's state folder | The key that seals every provider key, Git access, machine key, kubeconfig, RunPod key, MCP server's key, client secret and sign-in, and control's own keys on the message bus. Made on first start |
| Control's keys on the message bus | Control | `control.db`, sealed with the secrets key | With the message bus: control's user and its system user, which asks the NATS server to reload its users and for its store's figures. Made at the first start with `THERMITE_NATS_URL` |
| The backup's key on the message bus | `thermite backup` and `thermite restore` | `bus-backup.seed` in control's state folder, 0600 | The seed of the backup's NATS user key, which may only take and restore a snapshot of the `EVENTS` stream. Control makes it at its first start with the bus, and writes its public part to the server's users |
| Control's signing key | Control | `control-signing.key` in control's state folder, 0600 | Signs every command to rigs. Made on first start |
| The bus's certificate authority | Control | `bus-ca.key` in control's state folder, 0600, beside `bus-ca.pem` | With the message bus: signs the bus's server's certificate. Made at the first start with `THERMITE_NATS_URL`, valid for 10 years. Only its certificate leaves control, to every rig on the bus |
| The bus's server's key | The NATS server | `server-key.pem` in `THERMITE_NATS_CONFIG_DIR`, 0640, control's user and group | With the message bus: the key of the server's TLS certificate. Control makes it with each new certificate |
| The supervisor token | Harness and supervisor | `THERMITE_SUPERVISOR_TOKEN_FILE` (harness), `THERMITE_HARNESS_TOKEN_FILE` (supervisor) | The token the supervisor uses with its harness. Required |
| The proposer token | Harness | `THERMITE_PROPOSER_TOKEN_FILE` | Optional: lets a person or script submit changes with `thermite submit` |
| The model key | Harness | `THERMITE_MODEL_API_KEY_FILE` | The agents' model key, when the rig's own settings give the model. A model from control comes with its key instead |
| The rig's control token | Supervisor | `THERMITE_CONTROL_TOKEN_FILE` | The rig's token for control |
| Control's public key | Harness | `THERMITE_CONTROL_PUBKEY_FILE` | Checks every command's signature. The harness waits up to 120 s for it at start. In pull mode, enrollment leaves it in `control.pub` in `THERMITE_TUNNEL_ENROLLED_DIR`; in the one-container rig image, root checks its SHA-256 against the launch's and copies it to `THERMITE_CONTROL_PUBKEY_FILE` before the harness starts |
| The rig's report key | Harness | `ledger/rig-signing.key` in its state, 0600 | Signs the rig's reports. Made on first start |
| The rig's key on the message bus | Supervisor | `bus-key.seed` in its state folder, 0600 | With the message bus: the seed of the rig's NATS user key. Made at the first start with `THERMITE_NATS_URL`; only its public part goes to control, on the supervisor's regular call. A full reset keeps it |
| The rig's seal key | Supervisor | `bus-seal.pem` in its state folder, 0600 | With the message bus: an X25519 private key, which opens the rig's config that control seals to it on the bus (its model routes' keys and its MCP servers' sign-ins). Made beside the key above; only its public part goes to control, on the same call. A full reset keeps it |
| The pod's keys | Supervisor, in pull mode | `keys.json` in `THERMITE_TUNNEL_DIR`, 0600 | Sign the pod's answers to control and open what control seals to the pod. Made on first start; control pins their public halves at enrollment |
| The enrollment code | Supervisor, in pull mode | `THERMITE_TUNNEL_ENROLL_CODE` in the pod's environment | A one-time code. It never crosses the network, and the first enrollment spends it. The supervisor takes it out of its own environment at start |
| The snapshot key | The broker (root), in the one-container rig image | `THERMITE_STATE_SNAPSHOT_KEY` in the pod's environment | Seals the rig's state snapshot on the pod's volume. Control makes a new one for each pod at its launch and keeps no copy; RunPod keeps it in the pod's settings. The broker takes it out of its own environment at start, so no part and no role has it |
| The results repository key | Supervisor | `THERMITE_RESULTS_KEY_FILE`, `THERMITE_RESULTS_KNOWN_HOSTS` | Optional: an SSH deploy key that can write to the results repository, and its host key. See [Set up the results repository](../how-to/operate/results-repository.md) |
| A knowledge base token | Supervisor | `kb.token_file` in the [advisors file](advisors-file.md) | Optional |
| A Hugging Face token | Supervisor | `THERMITE_HF_TOKEN_FILE` | Optional: for [gated model files](model-files.md#gated-models-on-hugging-face). Sent to Hugging Face only, never to the harness |
| An MCP server's key, client secret or OAuth sign-in | Control | Entered in **Settings › Providers › MCP servers**, or signed in on the server's page; kept sealed in `control.db` | Optional. Control hands a rig the server's sign-in as headers (an access token for OAuth and a client, never the refresh token or the client secret) only when a run it assigned that rig names the server. The supervisor and the harness keep it in memory; no lane can read it. See [Who holds your keys](../explanation/who-holds-your-keys.md#mcp-servers) |

At start, the harness's broker reads its secret files as root, gives their values only to the controller, and closes their folder to 0700. If a secret file and its folder both stay readable by other users, it stops with `fatal: a secret file stays readable by other users`.

### Where they come from

| Way of running | Files | Mounted at |
| --- | --- | --- |
| Compose | The `init` service (`docker compose run --rm init`), or `npm run dev:init` in a checkout, writes them to `.dev/secrets/`, mode 0644: `control-admin-token`, `control-operator-token`, `control-rig-tokens.json`, `control-rig-token`, `harness-supervisor-token`, `harness-proposer-token`, `model-api-key`, and the second rig's `control-rig-token-2`, `harness2-supervisor-token`, `harness2-proposer-token` | `/run/secrets/<name>` (`control-rig-tokens.json` as `control-rig-tokens`), each only in the containers that use it |
| `thermite rig add --out DIR` | `secrets/control-rig-token` and `secrets/harness-supervisor-token` (0600, in a 0700 folder); `keys/control-signing.pub` and `keys/control-signing.fingerprint`; with the message bus, `keys/bus-ca.pem`; `rig.env` with `THERMITE_RIG_ID` and `CONTROL_URL`, and with the bus `THERMITE_NATS_URL`; `README.txt` | Wherever your own deployment puts them |
| Machines (over SSH or a join command) | `secrets/control-rig-token`, `secrets/harness-supervisor-token`, `keys/control-signing.pub`, `keys/control-signing.fingerprint`, and with the message bus `bus/bus-ca.pem`, in the rig's folder | `/run/secrets/<name>` and `/keys`, read-only |
| Kubernetes | A Secret `thermite-<rig>` with `control-rig-token`, `harness-supervisor-token` and `control-signing.pub`. With the message bus, the supervisor's Deployment also carries the bus's address and control's authority's certificate, which is no secret, in its environment (`THERMITE_NATS_URL`, `THERMITE_NATS_CA`) | Each key as its own read-only file, at `/run/secrets/<name>` or `/keys/control-signing.pub` |
| RunPod test pods | None: the probe's report token is in the pod's environment | |

Control also writes short-lived files while it works: an SSH key and known hosts for each SSH call, and a kubeconfig for each `kubectl` call. Each is 0600 in its own 0700 temporary folder and is removed after the call. [Who holds your keys](../explanation/who-holds-your-keys.md) explains which keys are kept where.
