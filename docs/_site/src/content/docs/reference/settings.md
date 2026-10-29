---
title: "Settings"
description: "Every environment variable of control, the harness, the supervisor and the command line, with its type, default and meaning."
type: reference
sidebar:
  order: 1
---

Thermite's three services read their settings from environment variables when they start: **control** (the dashboard, API and MCP), and the two containers of each [rig](glossary.md): the **harness**, where the judge and the agents work, and the **supervisor**, which relays to control. This page lists every variable each one reads, grouped by what it is for.

```sh
THERMITE_CONTROL_PORT=8801 THERMITE_MAX_TRIALS=2 docker compose up -d
```

Settings that belong to one campaign live in its [contract](contract.md) or in the command that starts its run: budgets, limits, the trial length and the run's promotion policy. Those come before the rig's defaults on this page.

## How settings are read

- **Files for secrets.** A variable ending in `_FILE` names a file. Thermite reads the value from the file and trims spaces and line ends. No setting holds a secret's value itself.
- **Hashes for control's tokens.** A variable ending in `_SHA256` holds a token's SHA-256 as 64 hexadecimal characters, not the token. `thermite token new` prints it. See [Tokens and roles](tokens.md).
- **Empty values.** A variable that is left out always takes its default, and so does a number setting that is empty. Path and name settings use an empty value as it is. An empty `THERMITE_DEV_GPU_INDEX` or `THERMITE_GPUS` is an error.
- **Numbers.** The **Type** column says what each number setting takes. A value that is not a number, or is outside that, stops the service at start with the setting's name and what it takes, for example `THERMITE_POLL_SECONDS takes a number of seconds above 0, not "30s"`. Fractions work unless the type says integer or whole.
- **Required settings.** A missing required setting stops the service at start with `missing environment variable <NAME>`. A required secret file that is empty stops it with `secret file for <NAME> is empty`.
- **Addresses.** A `_LISTEN` setting is `host:port`. An empty host means every interface (`0.0.0.0`). A bad value stops the service with `bad listen address <value>`.
- **Logs.** Every service writes one JSON object per line to its output: `{"at", "level", "component", "msg", ...}`, with the `run`, `trial`, `attempt`, `command` or `rig` the line is about among its fields. `level` is `debug`, `info`, `warn` (something went wrong and the service goes on: a refusal, a retry, a fallback) or `error` (something failed). A service writes the lines at its [`THERMITE_LOG_LEVEL`](#every-service) and above. `SIGUSR2` switches a running service between that level and `debug`, and back, and says so in a line; sent to a rig's broker, it reaches the rig's harness and supervisor too.

The "Secret" column says whether a value is secret: **no**; a **path to a secret** (the file must be kept private); a **hash** (safe to keep in plain configuration); a **directory with secrets** (a volume that holds keys); or a **one-time code**, which is good for one enrollment only.

## Every service

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_LOG_LEVEL` | `debug`, `info`, `warn` or `error` | `info` | no | The lowest level of the log lines the service writes. Anything else stops the service at start with `THERMITE_LOG_LEVEL takes debug, info, warn, error, not "<value>"` |

## Control

### Address and state

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_CONTROL_LISTEN` | `host:port` | `0.0.0.0:8800` | no | Where control serves the dashboard, the REST API and MCP |
| `THERMITE_CONTROL_DIR` | path | `/var/lib/thermite-control` | directory with secrets | Control's state: its store (`control.db`, which also holds [Thermite's knowledge base](knowledge-base.md)), its command-signing key pair (`control-signing.key` and `.pub`, made at first start), the secrets key when `THERMITE_CONTROL_SECRETS_KEY_FILE` is not set, the message bus's certificate authority (`bus-ca.pem` and `.key`) and the backup's key on it (`bus-backup.seed`), the kits written on the **New campaign** page (`kits/`), the [exports](exports.md#where-control-keeps-them) rigs without a results repository send it (`exports/`), and the [knowledge base's files](knowledge-base.md#files), each once by its SHA-256 (`kb-files/`). `thermite backup` and `thermite restore` read it too ([Back up and restore control](../how-to/operate/backup-and-restore.md)) |
| `THERMITE_CONTROL_PUBKEY_EXPORT` | path | not set | no | A second place to write control's command-signing public key, so that rigs can verify [signed commands](signed-commands.md). The local compose file writes it to a volume the harness reads |
| `THERMITE_CONTROL_SECRETS_KEY_FILE` | path | `secrets.key` in `THERMITE_CONTROL_DIR`, made on first use | path to a secret | The key that encrypts what control keeps for you: model providers' keys and sign-ins, Git access, GPU cloud keys, machines' SSH keys, cluster kubeconfigs, and MCP servers' keys, client secrets and sign-ins. It must hold a 32-byte key in base64. Without the same key, the stored secrets cannot be read |
| `THERMITE_CONTROL_STALE_SECONDS` | seconds, above 0 | `180` | no | A rig that has sent no report for this long shows as stale: **Stale** on **Rigs**, `stale` in the [rig lists](rest-api.md#reporting-stale-and-offline). A stopped RunPod pod shows **Stopped** on **Rigs** instead |
| `THERMITE_CONTROL_OFFLINE_SECONDS` | seconds, above 0 | `900` | no | A rig that has sent no report for this long is `offline` in the rig lists of the REST API, MCP and `thermite rig list`, and on its page, and **Offline** on **Rigs**. A value below `THERMITE_CONTROL_STALE_SECONDS` counts as that value |
| `THERMITE_CONTROL_SESSION_DAYS` | days, above 0 | `30` | no | How long an unused dashboard sign-in lasts |
| `THERMITE_DISK_FLOOR_GIB` | GiB, 0 or more | `5` | no | The free space control keeps on its state folder (`THERMITE_CONTROL_DIR`) and in the message bus's store, the room JetStream has left under its limit as the server's monitoring gives it. Control looks every minute. Below it on either, control holds new runs: **Start a run**, `thermite run start` and `assign_campaign` are refused with the reason (`409` over REST), **Needs you** shows a card with what is full and what to do, its [health](rest-api.md#health) says `"degraded":true` with the reading and still answers 200, and `/metrics` gives `thermite_control_disk_free_bytes` and `thermite_control_disk_low`. It drops nothing: reports, commands and the runs under way go on. It lets go once each place has 1 GiB more than the floor. The same setting and default as a rig's ([Places, exports and the broker](#places-exports-and-the-broker)). Fractions work. `0`: no floor. It is a mechanical limit, never a limit on research ([Troubleshoot](../how-to/operate/troubleshoot.md#controls-disk-is-at-its-floor)) |

### Tokens

Each role takes one of its two variables: a hash, or a file that holds the token. [Tokens and roles](tokens.md#rules) has the rules.

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_CONTROL_ADMIN_TOKEN_SHA256` | SHA-256 | required, this or the next | hash | The owner's token, as its hash. Without either variable control stops at start with ``control needs the owner's credential: THERMITE_CONTROL_ADMIN_TOKEN_SHA256 (from `thermite token new`) or THERMITE_CONTROL_ADMIN_TOKEN_FILE`` |
| `THERMITE_CONTROL_ADMIN_TOKEN_FILE` | path | required, this or the previous | path to a secret | The owner's token, as a file. Meant for local development |
| `THERMITE_CONTROL_OPERATOR_TOKEN_SHA256` | SHA-256 | not set | hash | The operator's token, as its hash |
| `THERMITE_CONTROL_OPERATOR_TOKEN_FILE` | path | not set | path to a secret | The operator's token, as a file |
| `THERMITE_CONTROL_AGENT_TOKEN_SHA256` | SHA-256 | not set | hash | The agent's token, as its hash |
| `THERMITE_CONTROL_AGENT_TOKEN_FILE` | path | not set | path to a secret | The agent's token, as a file |
| `THERMITE_CONTROL_READ_TOKEN_SHA256` | SHA-256 | not set | hash | The reader's token, as its hash |
| `THERMITE_CONTROL_READ_TOKEN_FILE` | path | not set | path to a secret | The reader's token, as a file |
| `THERMITE_CONTROL_RIG_TOKENS_FILE` | path to a JSON file | not set | path to a secret | Rig tokens kept in a file: `{"<rig>": "<token>"}`. Read once, at start. Rigs enrolled through control (**Add a rig**, a join command or `thermite rig add`) need no entry here |
| `THERMITE_CONTROL_REQUIRE_KEY_ACCEPT` | `1` | off | no | `1`: control takes no report from a new rig until the owner accepts the rig's report-signing key on the dashboard. A change of a rig's key always waits for the owner. See [Accept a rig's key](../how-to/operate/accept-a-rig-key.md) |

Setting both variables of one role stops control at start with `set THERMITE_CONTROL_<ROLE>_TOKEN_SHA256 or _FILE, not both`. A `_FILE` whose file is missing or empty counts as not set.

### Rigs that control sets up

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_CONTROL_PUBLIC_URL` | URL | not set | no | Control's address as rigs and machines reach it, for example `https://control.example.com`. Rigs that control sets up report there. Not set: **Add a rig** and join commands are blocked, a machine's check skips the "reaches control" test, and a cluster rig's image update is refused. It is also where an MCP server's OAuth sign-in page sends your browser back (`/v1/mcp-oauth/callback`); not set, that is the address you reached control at |
| `THERMITE_RIG_HARNESS_IMAGE` | image reference | not set | no | The harness image for CPU rigs that control sets up on machines and clusters. Needs `THERMITE_RIG_SUPERVISOR_IMAGE` too: without both, control can't set rigs up |
| `THERMITE_RIG_SUPERVISOR_IMAGE` | image reference | not set | no | The supervisor image for those rigs |
| `THERMITE_RIG_HARNESS_CUDA_IMAGE` | image reference | not set | no | The harness image for rigs with GPUs. A release's `compose.yaml` sets the CUDA 12 image (`-cuda`), for Pascal to Hopper; for Blackwell GPUs or DGX Sparks, set the CUDA 13 image (`-cuda13`) instead ([The CUDA harness](harness-image.md#the-cuda-harness)). Not set: a rig with GPUs is refused with "Control has no CUDA harness image configured (THERMITE_RIG_HARNESS_CUDA_IMAGE)." |
| `THERMITE_RUNPOD_TEST_IMAGE` | image reference | not set | no | The image a [RunPod test pod](../how-to/install/runpod-test.md) runs when the test names none. It must be an image RunPod can pull. A release's `compose.yaml` sets it to the release's [published rig image](harness-image.md#published-images), pinned by digest |
| `THERMITE_RUNPOD_RIG_IMAGE` | image reference | not set | no | The [one-container rig image](harness-image.md#the-one-container-rig-image) (CUDA) a [rig launched on RunPod](rest-api.md#rigs-on-a-gpu-cloud) runs when the launch names none. It must be an image RunPod can pull. Not set, and none given: the launch is refused. A release's `compose.yaml` sets it to the release's [published rig image](harness-image.md#published-images), pinned by digest |

Without `THERMITE_RIG_HARNESS_IMAGE` and `THERMITE_RIG_SUPERVISOR_IMAGE`, **Add a rig** says "Control has no rig images configured (THERMITE_RIG_HARNESS_IMAGE, THERMITE_RIG_SUPERVISOR_IMAGE), so it can't set rigs up yet." Without `THERMITE_CONTROL_PUBLIC_URL` it says "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL), so a rig would not know where to report."

A rig keeps the images it was set up with. When control restarts with other image names in these settings, each rig it set up on a cluster offers the new images on its page: "Control now deploys other images:", the two names and **Update to these images**. The MCP tool [`update_rig_images`](mcp-tools.md#update_rig_images) does the same. When the last change to the rig's pods failed, the page offers control's images again with **Try the update again**. A rig that is still being set up is not offered them. A rig with GPUs is compared with `THERMITE_RIG_HARNESS_CUDA_IMAGE`, any other with `THERMITE_RIG_HARNESS_IMAGE`, and both with `THERMITE_RIG_SUPERVISOR_IMAGE`. Control compares the names, not the images' contents. A rig control set up on a machine or a cluster whose Thermite version is behind control's, or which control refuses for an older version, also offers **Update to** control's version on its page, which moves it onto these images ([A rig's page](rig-page.md#update-to-controls-version)). Joined rigs are not offered an update ([goal 035](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/035-rig-upgrades.goal)).

### Restarts and full resets

A lifecycle driver lets control restart a rig's containers: the button **Restart the rig's containers** on the rig's page, and the last step of a full reset. Without a driver, the rig's page says `No deployment driver: restarts are not available.`, and a full reset still ends: the rig's containers restart themselves after the wipe. See [Stop, restart, remove or reset a rig](../how-to/operate/rig-lifecycle.md).

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_LIFECYCLE` | `compose` or `kubernetes` | not set: no driver | no | Which driver control uses. Any other value counts as not set |
| `THERMITE_ENGINE_SOCKET` | path | `/run/engine.sock` | no | `compose`: the container engine's API socket (Docker, or Podman's Docker-compatible API) inside control's container. Meant for local development |
| `THERMITE_COMPOSE_PROJECT` | string | `thermite` | no | `compose`: the compose project the rigs' containers belong to |
| `THERMITE_COMPOSE_SERVICES` | JSON | `{}` | no | `compose`: each rig's service names, as `{"<rig>": {"harness": "<service>", "supervisor": "<service>"}}` |
| `THERMITE_K8S_API` | URL | `https://<KUBERNETES_SERVICE_HOST>:<KUBERNETES_SERVICE_PORT>`, else `https://kubernetes.default.svc` | no | `kubernetes`: the cluster's API server |
| `THERMITE_K8S_TOKEN_FILE` | path | `/var/run/secrets/kubernetes.io/serviceaccount/token` | path to a secret | `kubernetes`: control's service account token. Read again at each restart, so a rotated token is used |
| `THERMITE_K8S_CA_FILE` | path | `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt` | no | `kubernetes`: the API server's certificate authority |
| `THERMITE_K8S_NAMESPACE` | template | `thermite-{rig}` | no | `kubernetes`: each rig's namespace. `{rig}` is replaced with the rig's name; so is `{unit}`, the placeholder's older name. Empty counts as not set |
| `THERMITE_K8S_SELECTOR_HARNESS` | label selector | `app.kubernetes.io/component=harness` | no | `kubernetes`: how control finds a rig's harness pods |
| `THERMITE_K8S_SELECTOR_SUPERVISOR` | label selector | `app.kubernetes.io/component=supervisor` | no | `kubernetes`: how control finds a rig's supervisor pods |
| `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT` | address, port | set by Kubernetes in every pod; port `443` | no | Read for the default of `THERMITE_K8S_API` |

The `kubernetes` driver restarts a component by deleting its pods, which the rig's Deployment then makes again. Its service account lists and deletes pods in each rig's namespace. It is for rigs deployed on Kubernetes by other means. Rigs that control sets up on a cluster don't use it: control restarts them with the cluster's kubeconfig (**Restart them** on the rig's page), and names the namespaces it creates from the cluster's **Namespace for each rig**, `thermite-{rig}` by default, the same as the driver's default. If your rigs' namespaces have other names, set `THERMITE_K8S_NAMESPACE` to match them.

### The message bus

Rigs' reports and live lines reach control over a message bus, a NATS server with JetStream, instead of each supervisor posting them to control's API, and control's commands and each rig's config reach the rigs over it as soon as control has them. Control needs it: it keeps every rig's events there, however they came, and writes what it derives from them from there ([Control's events on the message bus](../explanation/how-the-parts-talk.md#controls-events-on-the-message-bus)). The compose stack runs the bus beside control. Control says who may use the bus: it writes the server's users file and has the server reload it. Every connection to the bus is over TLS: control makes its own certificate authority, signs the server's certificate with it, and hands the authority's certificate to every rig it sets up. See [Run the message bus](../how-to/operate/message-bus.md), [Reports over the message bus](../explanation/how-the-parts-talk.md#reports-over-the-message-bus), [Commands over the message bus](../explanation/how-the-parts-talk.md#commands-over-the-message-bus), [Live lines over the message bus](../explanation/how-the-parts-talk.md#live-lines-over-the-message-bus) and [Who may use the message bus](../explanation/how-the-parts-talk.md#who-may-use-the-message-bus).

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_NATS_URL` | `nats://` address | not set | no | Required: the NATS server control keeps every rig's events on, reads rigs' reports from and sends commands on, as control reaches it: `nats://nats:4222` in the compose stack, which fixes it. Control connects over TLS, and trusts the server only through its own certificate authority (below). Control makes the `EVENTS` stream there, copies every event it takes to it, by HTTP or from the bus, and writes what it derives from the events from it, in its order. Control makes the `REPORTS` stream there, an inbox that keeps each report until control has taken or refused it, and reads it as each report arrives, with the same checks as a report posted to its API, which it still takes too. It also makes the `COMMANDS` stream, and publishes each command it issues to the rig's subject there, as well as keeping it pending for the rig's poll over HTTP, and publishes its pending commands there again as it starts; a publish that fails says so in its log, as `command not on the bus; its rig's poll fetches it`. It makes the `LIVE` stream too, and folds the rigs' live lines from it into its live view, with the same checks as lines posted to its API, which it still takes too; a message it refuses is logged as `live lines from the bus refused`, and passed over. It makes the `CONFIG` stream, and every 5 seconds writes each rig's model route, advisors' routes and MCP servers there, each sealed to the rig's seal key, when a value changed; a value it can't make is logged once as `a rig's config not written: control can't make it`, and one the bus does not take as `a rig's config not written to the bus; trying again`. Every 5 seconds, too, it makes the two consumers of each rig with a user on the bus, of its commands and of its config, and every minute it looks at every rig's again; one it can't make is logged once as `a rig's consumers on the bus not made; trying again`. A server it can't reach is tried again every 5 seconds; its log says so once, as `following failed; trying again` or `making the stream failed; trying again`, until it works. Control signs in with its own key, which it makes at its first start with the setting and keeps sealed in its store. Not set stops control at start with `control needs its message bus: set THERMITE_NATS_URL to its NATS server, such as nats://nats:4222. Control keeps every rig's events in the bus's EVENTS stream and derives its records from them there, whether a rig reports over the bus or over HTTP`; a rig whose supervisor has no `THERMITE_NATS_URL` still reports over HTTP. Anything but a `nats://` address stops control at start with `THERMITE_NATS_URL takes a nats:// address, such as nats://nats:4222, not "<value>"` |
| `THERMITE_NATS_CONFIG_DIR` | path | not set | no | Required: the folder control writes the bus's server's files to, which the server's settings include, `/nats-config` in the compose stack. `users.conf` (0644) names control's own user, which may do everything on the bus; a user for each rig whose supervisor registered its key, which may publish only its own reports and the live lines of its own runs and its own, and take only its own commands; and control's system user, which only asks the server to reload. Each is a NATS user's public key, with no seed. `server-cert.pem` (0644) and `server-key.pem` (0640, for the server to read through control's group) are the server's TLS certificate and its key: control signs the certificate with its own authority, for the host of `THERMITE_NATS_URL` and of the rigs' address (`THERMITE_NATS_PUBLIC_URL`), valid for 397 days, and makes a new one at start or at its next look when the names change, the authority changed, or it ends within 30 days; its log says `the bus's server certificate made`, with why. Control writes the users at start, when a rig's key is new or changed, when a rig is retired or brought back, and when control's run registry gives a rig a run (it looks every 5 seconds); each time a file changed, it asks the server to reload, and its log says `the bus's server reloaded its users`. A reload that fails is tried again at the next look, with `the bus's server did not reload its users; trying again` in the log once, until one works; a file it can't write, with `the bus's files not written; trying again`. Not set stops control at start with `control needs THERMITE_NATS_CONFIG_DIR: the folder control writes the bus's users and TLS certificate to, which the server's configuration includes` |
| `THERMITE_NATS_PUBLIC_URL` | `nats://` address | the host of `THERMITE_CONTROL_PUBLIC_URL`, port 4222 | no | The bus as the rigs control sets up reach it, on machines, on clusters and where the owner joins them: for example `nats://control.example.com:4222`. Control gives it to each of those rigs' supervisors with its authority's certificate, and names its host in the server's certificate. Without it and without `THERMITE_CONTROL_PUBLIC_URL`, those rigs get no bus. A rig on RunPod never uses it: it keeps pull mode. Anything but a `nats://` address stops control at start, as for `THERMITE_NATS_URL` |
| `THERMITE_NATS_CA_EXPORT` | path | not set | no | A file control also writes its authority's certificate to at each start (0644), for rigs beside control that read it from there: `/keys/bus-ca.pem` in the compose stack, on the volume the supervisors mount |

Control keeps its own certificate authority for the bus in its state folder, beside its signing key: `bus-ca.pem`, its certificate, and `bus-ca.key` (0600), its key. Control makes them at its first start with the bus, valid for 10 years, and never makes another by itself. A state folder with one of the two, or with two that don't make one authority, stops control at start with `the bus's certificate authority … delete both bus-ca.pem and bus-ca.key from control's state folder for a new one, then move every rig on the bus onto its images again, so that it gets the new certificate`.

## Harness

The harness container runs a **broker**, which runs as root and starts the other processes as separate users, and the **controller**, which is the harness service itself. Both read the variables below.

### The rig and its target

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_RIG_ID` | string | required | no | The rig's name, as control knows it |
| `THERMITE_TARGET` | `cpu` or `cuda-gpu` | `cpu` | no | The [target](glossary.md) driver. Anything else stops the harness with `no target driver <value>; this build has cpu and cuda-gpu` |
| `THERMITE_TARGET_CLASS` | string | `generic-cpu` on `cpu`, `cuda-gpu` on `cuda-gpu` | no | A name for the kind of device. The dashboard shows it with the rig's hardware, and the **New campaign** page and the smoke check copy it into the contracts they write. Nothing compares it |
| `THERMITE_CONTROL_PUBKEY_FILE` | path | required | no | Control's command-signing public key, to verify signed commands. The harness waits up to 120 seconds for the file to appear, then stops with `timed out waiting for <path>`. In the one-container rig image in pull mode, the broker writes it from enrollment before it starts the harness |
| `THERMITE_LISTEN` | `host:port` | `0.0.0.0:8700` | no | Where the harness serves its API, for the rig's supervisor, a proposer's `thermite submit` and the agents' tools. Rigs that control sets up expect port 8700 |

### The one-container rig image

The [one-container rig image](harness-image.md#the-one-container-rig-image) sets `THERMITE_ONE_CONTAINER` itself, with the places it uses. The broker then also reads the supervisor's `THERMITE_SUPERVISOR_HOME` and `THERMITE_INBOX_DIR`, to prepare them, and the isolation selftest probes them. In [pull mode](#pull-mode), which the image turns on, the broker also reads `THERMITE_TUNNEL_ENROLLED_DIR` and `THERMITE_TUNNEL_CONTROL_KEY_SHA256`, and starts the harness once the pod is enrolled ([How it starts](harness-image.md#how-it-starts)).

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_ONE_CONTAINER` | `1` | off | no | `1`: the rig's supervisor runs in this container. The broker prepares its places and its token, and starts it as its own user. A broker that is not root then stops with `fatal: the one-container image must run as root`, and one without `THERMITE_SUPERVISOR_TOKEN_FILE` with `fatal: the one-container image needs THERMITE_SUPERVISOR_TOKEN_FILE`. With `THERMITE_TUNNEL_PORT` set too, it starts the harness only once root has checked control's key from enrollment against the launch's SHA-256 and copied it to `THERMITE_CONTROL_PUBKEY_FILE` |

### The state's snapshot

Where a host empties the container's disk when it stops, as RunPod does, the broker keeps the rig's state on that disk and a sealed snapshot of it on the host's volume. The [one-container rig image](harness-image.md#where-the-state-lives) sets `THERMITE_STATE_SNAPSHOT_DIR`, and control gives each pod it launches on RunPod its `THERMITE_STATE_SNAPSHOT_KEY`. Compose and Kubernetes rigs keep their state on volumes and take no snapshot.

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_STATE_SNAPSHOT_DIR` | path | not set: no snapshot | no | The folder, on the host's volume, where root keeps a snapshot of the harness's state and outbox (in the one-container rig image also the inbox, the supervisor's state and root's copy of its token). Root makes it with mode 0700 and never gives anything in it another owner. Every live folder must be outside it, or the broker stops with `fatal: the state snapshot can't be set up`. At a start on an empty disk the broker restores the newest snapshot that verifies. A broker that is not root takes and restores none |
| `THERMITE_STATE_SNAPSHOT_KEY` | 32 bytes in base64url (43 characters) | not set: no snapshot | secret | A launch value: the key the snapshot is sealed with. Control makes a new one for each pod it launches on RunPod and puts it in the pod's environment, with the other [launch values](#pull-mode); control keeps no copy, and RunPod keeps it in the pod's settings while the pod is stopped. The broker reads it at start and takes it out of its own environment before it starts anything: no part, no role and no program they start has it. Without it, or with a value that is not 32 bytes in base64url, the broker logs `no snapshot key: no snapshot is taken or restored` with why, and the rig's state does not outlive a stop |
| `THERMITE_STATE_SNAPSHOT_MINUTES` | minutes, above 0 | `5` | no | How often the broker takes a snapshot. It also takes one after each export, after enrollment and at a stop. Fractions work; 0 or less stops the broker with `fatal: a snapshot setting is not valid` |
| `THERMITE_STATE_SNAPSHOT_STOP_SECONDS` | seconds, above 0 | `8` | no | How long a stop waits for its snapshot before the broker stops the two parts. Keep it, and the seconds the parts need to stop, within the time the host gives a stop. A snapshot cut short leaves the last complete one |

### GPUs and CPUs

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_GPU_INDEX` | GPU index or list (`0`, `0,1`) | `0` | no | The judge's GPU, or several. Each judge GPU times runs on its own. At most 8 |
| `THERMITE_DEV_GPU_INDEX` | GPU index or list | not set | no | GPUs for the agents' development runs, never one of the judge's. At most 8. Not set: development runs share the judge's GPU and wait for it. Needs `THERMITE_TARGET=cuda-gpu`, or the harness stops with `THERMITE_DEV_GPU_INDEX needs THERMITE_TARGET=cuda-gpu` |
| `THERMITE_GPUS` | GPU list (`0,1,2,3`) | not set | no | The rig's GPU set, in place of the two lists above. The first GPUs are the judge's and the rest the agents'. One GPU is shared by both. At most 16: up to 8 for the judge and 8 for the agents. With it, `THERMITE_GPU_INDEX` is ignored. It is itself ignored when `THERMITE_DEV_GPU_INDEX` is set |
| `THERMITE_JUDGE_GPUS` | integer, 1 or more | half of `THERMITE_GPUS`, rounded up | no | With `THERMITE_GPUS`: how many are the judge's at first. The rig's own setting (**GPUs for the judge** on **Edit rig**, or the campaign deployed on the rig) comes first. A value that does not fit (below 1, the whole set, or more than 8 on either side) is ignored |
| `THERMITE_RUN_CPUS` | `auto`, `off` or a CPU list (`0-7`, `0,2,4`) | `auto` on `cuda-gpu`, otherwise `off` | no | The CPUs that timed runs are pinned to. `auto`: each judge GPU's local CPUs. A list is shared out between the judge GPUs, with no CPU in two. A bad list stops the harness with `not a CPU list: <value>` |

A bad GPU list stops the harness with one of these messages:

- `<VARIABLE> is a GPU index or a list of them, such as 0 or 0,1: not "<value>"`
- `<VARIABLE> names a GPU twice: "<value>"`
- `<VARIABLE> names <n> GPUs; a rig takes at most 8 of each kind`, for `THERMITE_GPU_INDEX` and `THERMITE_DEV_GPU_INDEX`
- `THERMITE_GPUS names <n> GPUs; a rig takes at most 16`

When the agents have GPUs of their own, the broker does not set up a layout where a GPU is in both lists (`a judge card and a development card are both index <n>`), or one that leaves out a GPU the container can see (`more cards than the layout covers: <devices>`). The harness then starts, reports the error with its hardware, and neither times runs nor allows development runs. [Give a rig several GPUs](../how-to/install/several-gpus.md) shows how the settings fit together.

### Judging

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_CALIBRATION_BLOCKS` | integer, 0 or more | `6` | no | Blocks in each A/A calibration: the judge times a running hill-climb run's champion against itself, to measure the rig's noise. Below 2: no calibration |

### The rig's settings

These four give the rig's settings their first values. **Edit rig** changes the rig's settings. Once they have been changed, by **Edit rig** or by a campaign deployed on the rig, the harness keeps them in its state, and these variables no longer apply. None of them ends a campaign: a trial's length and turns end one trial. See [Limits and pacing](limits-and-pacing.md).

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_PROMOTION` | `auto` or `owner_approval` | `auto` | no | The promotion policy for runs started without their own. `auto`: a confirmed win becomes the champion on its own, after the auditor's clear when the campaign calls for an audit and the rig has an auditor; a run's `ask_owner` makes some wait. `owner_approval`: every promotion waits for the owner. Anything else stops the harness with `THERMITE_PROMOTION must be auto or owner_approval, not <value>` |
| `THERMITE_MAX_TRIALS` | integer, 0 to 16 | `1` | no | How many trials run at once on this rig, one agent each. **Edit rig** calls it **Workers at a time**. 0 starts no trials: the rig only judges, or runs its advisors. A rig has users for lanes 1 to 16 only: anything else stops the harness with `THERMITE_MAX_TRIALS takes a whole number from 0 to 16 (0: no trials), not "<value>"` |
| `THERMITE_TRIAL_MINUTES` | whole minutes, 1 to 1,440 | not set: none | no | How long one trial lasts when the campaign's contract sets no `trial_minutes`. Unset or empty: no limit; a trial lasts until its worker submits, or stops and answers a nudge without any work. **Edit rig** calls it **One trial lasts (minutes)**. Anything else stops the harness with `THERMITE_TRIAL_MINUTES takes a whole number of minutes from 1 to 1440, not "<value>"` |
| `THERMITE_MAX_TURNS` | integer, 1 or more | not set: no limit | no | The most model turns one trial may take. **Edit rig** calls it **Turns per trial** |

### Budgets and research

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_LLM_USD_PER_MTOK_IN` | US dollars, 0 or more | not set | no | The model's price per million input tokens. A contract's `llm_usd` budget is counted only when both prices are set |
| `THERMITE_LLM_USD_PER_MTOK_OUT` | US dollars, 0 or more | not set | no | The model's price per million output tokens |
| `THERMITE_RESEARCH_MAX_MB` | mebibytes (MiB), above 0 | not set: no limit | no | The most one run may archive in its corpus: a research run's, or the sources a hill-climb or goal run's workers fetch. When the corpus is full, more sources are refused with `the corpus is full (<n> MiB archived)`; the run goes on |

### The rig's own model

A model chosen for the rig on control (**Settings › Providers**, or **Edit rig**) comes before these and needs none of them: the supervisor hands it, with its key, to the harness. These variables are for a rig that keeps its own model. Agents use it only when the base URL, the model and the key are all set; a server that takes no key still needs a key file with any text in it. Without a model, the harness logs `agents wait for a model route`. See [Choose a model](../how-to/models/choose-a-model.md).

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_MODEL_BASE_URL` | URL | not set | no | The provider's endpoint. For `openai`, an OpenAI-compatible endpoint with tool calling: the address before `/chat/completions`, usually ending in `/v1`. For `anthropic`, the address without `/v1` |
| `THERMITE_MODEL` | string | not set | no | The model's name at that endpoint |
| `THERMITE_MODEL_API_KEY_FILE` | path | not set | path to a secret | The endpoint's key. For `THERMITE_MODEL_API=claude`, the subscription's token |
| `THERMITE_MODEL_CONTEXT_WINDOW` | tokens: an integer, 0 or more | `0`: unknown | no | The model's context per request. When it is known, the agents' conversations are compacted near it, and, when a reply limit is known too (`THERMITE_MODEL_MAX_TOKENS`, or the model's maximum output from control's route), each reply is limited to the room left |
| `THERMITE_MODEL_COMPACT_AT` | percent: an integer, 50 to 95 | not set: 80 | no | The share of the context window at which an agent's conversation is [compacted](limits-and-pacing.md#compaction) and goes on. Anything else stops the harness with `THERMITE_MODEL_COMPACT_AT takes a whole number of percent from 50 to 95, not "<value>"` |
| `THERMITE_MODEL_MAX_TOKENS` | tokens: an integer, 0 or more | `0`: none | no | The most tokens in one reply, thinking included. Unset or `0`: none is sent, and the provider's own limit applies; Anthropic's API, which needs one, gets 32,000. A route from control carries the model's maximum output from the provider's model list instead |
| `THERMITE_MODEL_REASONING_EFFORT` | `none`, `off`, `low`, `medium` or `high` | not set: nothing is sent | no | Sent as `reasoning_effort`. `off` is sent as `none`. Anything else stops the harness with `THERMITE_MODEL_REASONING_EFFORT must be none, low, medium or high, not <value>` |
| `THERMITE_MODEL_API` | `openai`, `anthropic`, `opencode`, `claude` or `chatgpt` | `openai` | no | The provider's API. `openai`: OpenAI-compatible chat completions. `anthropic`: Anthropic's Messages API. `opencode`: OpenCode's own models, which only the OpenCode worker harness reaches. `claude`: a Claude subscription. `chatgpt`: a ChatGPT sign-in. Its access token lasts an hour, and control renews it only for a model set on control. Anything else: `THERMITE_MODEL_API must be openai, anthropic, opencode, claude or chatgpt, not <value>` |
| `THERMITE_AGENT_HARNESS` | `pi`, `opencode`, `claude-code` or `codex` | `pi` | no | The [worker harness](glossary.md), the program the agents work in: Pi (built into the harness), OpenCode, Claude Code or the Codex CLI. Anything else: `THERMITE_AGENT_HARNESS must be pi, opencode, claude-code or codex, not <value>` |
| `THERMITE_OPENCODE_BIN` | name or path | `opencode` on the `PATH` | no | The OpenCode program. The supervisor reads it too, for advisors in OpenCode |
| `THERMITE_CLAUDE_BIN` | name or path | `claude` on the `PATH` | no | The Claude Code program. The supervisor reads it too |
| `THERMITE_CODEX_BIN` | name or path | `codex` on the `PATH` | no | The Codex CLI program. The supervisor reads it too, for advisors in Codex |

This one applies to every model the agents use, a route from control or the rig's own:

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_MODEL_STALL_SECONDS` | seconds, 0 or more | `600` | no | How long a model call's stream may send no data before it is broken off as the provider's passing fault: the agent waits and goes on in the same conversation ([Limits and pacing](limits-and-pacing.md#the-model-provider)). It detects a silent network connection; it is not a cap on research. A call that keeps sending data is never cut, however long it lasts; keep-alive comment lines and pings are not data. Raise it for a model that thinks for longer than this without sending anything. `0` turns it off. It covers every call in Pi (the workers and research workers, the planner, the summaries of compactions and the model checks) and the model proxy's calls for OpenCode and Codex; not Claude Code on a subscription, which reaches Anthropic directly. The supervisor reads it too, for its advisors' calls, in Pi and through its own model proxy. Anything else stops the service with `THERMITE_MODEL_STALL_SECONDS takes a number of seconds from 0 (0: off), not "<value>"` |

A Claude subscription and Claude Code go only together. Any other pairing stops the harness with `a Claude subscription (THERMITE_MODEL_API=claude) runs only with THERMITE_AGENT_HARNESS=claude-code, and that harness only with it`.

The Codex CLI speaks only OpenAI's Responses API, so `codex` goes only with `THERMITE_MODEL_API` `openai` (or not set) or `chatgpt`. With `openai`, the base URL's server must answer `/responses`, as OpenAI's own API does. Any other pairing stops the harness with `the Codex CLI speaks only OpenAI's Responses API: THERMITE_AGENT_HARNESS=codex needs THERMITE_MODEL_API chatgpt or openai`.

### Tokens

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_SUPERVISOR_TOKEN_FILE` | path | required | path to a secret | The token the rig's supervisor uses on the harness API. The supervisor's `THERMITE_HARNESS_TOKEN_FILE` holds the same token |
| `THERMITE_PROPOSER_TOKEN_FILE` | path | not set | path to a secret | A proposer's token, for a person or script that submits changes with `thermite submit` |

### Places, exports and the broker

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_STATE_DIR` | path | `/var/lib/thermite` | directory with secrets | The ledger, the rig's key, kits, builds, models, the rig's settings, the model set on control, and the harness's copy of each run's past research (`knowledge/<run>/`) |
| `THERMITE_SCRATCH_DIR` | path | `/scratch` | no | Workspaces, builds in progress and runs. The broker empties it at every start |
| `THERMITE_INBOX_DIR` | path | `/controller/inbox` | no | Where imports arrive from the supervisor. The harness only reads it; the local compose file mounts it read-only. The default is in `/controller`, a folder of the harness image that only root and the controller's group may enter, so no role reaches the inbox |
| `THERMITE_OUTBOX_DIR` | path | `/outbox` | no | Where exports wait for the supervisor |
| `THERMITE_OUTBOX_GID` | group id: an integer, 0 or more | `10001` | no | The supervisor's group, which may read the outbox |
| `THERMITE_EXPORT_MINUTES` | minutes, above 0 | `60` | no | How often the harness exports its results. Fractions work |
| `THERMITE_DISK_FLOOR_GIB` | GiB, 0 or more | `5` | no | The free space the rig keeps on each place the harness writes to: its state, its scratch and its outbox. Below it on any of them, the rig holds new work: no trial, plan, judge's job or export starts, the work under way ends as it would (so the judge's job in flight still writes its verdict), and the ledger records the event `rig_disk`. It goes back to work by itself once each place has 1 GiB more than the floor. Its report carries the free space on each place, and control shows it on the rig's page and under **Needs you** ([The disk card](rig-page.md#the-disk-card)); an export command is refused in words. 5 GiB: an export copies the whole ledger into the outbox, and a judge's build writes the candidate's build tree, each up to a few GiB on a large run, and the ledger needs room to commit the verdict in flight. The broker reads it too: a [state snapshot](#the-states-snapshot) waits while its folder has less, and the last complete one stays. The supervisor reads it for model downloads ([Places and advisors](#places-and-advisors)). Fractions work. `0`: no floor. It is a mechanical limit, never a limit on research |
| `THERMITE_DRAIN_MINUTES` | whole minutes, 1 to 10,080 | `60` | no | How long a [drain](signed-commands.md#drain_rig) waits for the work under way when its command gives no deadline of its own, such as an update's `drain_minutes`. At its deadline the drain stops waiting by itself: the rig records it and asks the owner under **Needs you**, and goes on starting nothing new until the owner chooses to go ahead now or to end the drain ([At its deadline](rig-page.md#at-its-deadline)). Nothing stops by itself at the deadline |
| `THERMITE_BROKER_DIR` | path | `/run/thermite` | no | The directory of the broker's socket, `broker.sock` |
| `THERMITE_TUNNEL_DIR` | path | not set | no | Only where the harness shares its container with a supervisor in [pull mode](#pull-mode): the supervisor's tunnel directory. The isolation self-test then checks that no role can read the keys in it |
| `THERMITE_CHECKS_DIR` | path | `/opt/thermite/checks` in the image; outside it, the checkout | no | Where the [smoke check](rig-checks.md) finds its kits and projects |
| `THERMITE_ALLOW_UNSEPARATED` | `1` | off | no | `1`: when the harness container does not run as root, the broker starts the harness anyway, with no separate users for the roles. Meant for development only. Without it, a broker that is not root stops with `fatal: not root, so roles cannot be separated` |
| `THERMITE_FATAL_HOLD_SECONDS` | seconds, 0 or more | `0`: no hold | no | After a fatal error at start (`fatal: …` in the broker's log), how long the broker waits before it exits, at most 600. The [one-container rig image](harness-image.md#the-one-container-rig-image) sets 60: a host that starts a stopped container again at once, such as RunPod, then keeps the error in the [pod's log](rig-page.md#pod-log) |
| `THERMITE_IMAGE_ID` | string | the image's: set in the published harness images, such as `0.1.0+1a2b3c4d5e6f`; empty in an image built from a checkout | no | Reported as the image in the rig's hardware report. Empty counts as not set. See [Published images](harness-image.md#published-images) |
| `THERMITE_TOOLCHAIN_ID` | string | not set | no | Goes into every build's key beside the image's installed packages and compilers, for a tool the image has that its package list doesn't show, such as a compiler unpacked into `/opt`: change it, and the rig builds afresh. Empty counts as not set. See [Build cache](kit-manifest.md#build-cache) |

## Supervisor

### The rig, its harness and control

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_RIG_ID` | string | required | no | The rig's name. The same as its harness's |
| `HARNESS_URL` | URL | required | no | The rig's harness, for example `http://harness:8700` |
| `THERMITE_HARNESS_TOKEN_FILE` | path | required | path to a secret | The supervisor's token for the harness: the same token as the harness's `THERMITE_SUPERVISOR_TOKEN_FILE` |
| `CONTROL_URL` | URL | not set | no | Control's address. Not set: the supervisor reports nowhere and fetches no commands |
| `THERMITE_CONTROL_TOKEN_FILE` | path | not set | path to a secret | The rig's token for control. Without it the supervisor still starts, but sends control nothing and fetches nothing from it: no reports, commands, live view, model, advisors' models or past research |
| `THERMITE_NATS_URL` | `nats://` address | not set | no | The message bus control reads reports from and sends commands on, for example `nats://nats:4222` in the compose stack, which sets it by default; control sets it on the rigs it sets up from `THERMITE_NATS_PUBLIC_URL`. The supervisor connects over TLS, trusting the server through `THERMITE_NATS_CA` or `THERMITE_NATS_CA_FILE`, or else through the system's certificate authorities. Set, the supervisor publishes each report to it instead of posting it to control, and moves on once the bus has it; when control's answer to its figures shows that control is still behind what it sent a round before, it sends again from where control is. It takes its rig's commands from the bus as control issues them, and asks control for pending commands over HTTP only every 3 minutes, in place of `THERMITE_COMMAND_POLL_SECONDS`. It publishes the live lines to the bus too, every `THERMITE_LIVE_INTERVAL_MS`, each run's source to its own subject, and no longer posts them to control; its figures count the lines it published and dropped there. It takes its rig's model route, advisors' routes and MCP servers from the bus as control writes them, and applies each at once, in place of asking control for them every `THERMITE_MODEL_ROUTE_POLL_SECONDS`; its figures count the updates it took and refused. The rest still comes and goes over HTTP. A page of events too large for one message (8 MiB with its headers) goes as two halves instead; a single event too large for one stops the reports there, and the supervisor's log says so. It signs in with the rig's own key: made at its first start with the setting, its seed kept in `bus-key.seed` in its state folder (0600), and its public part sent to control on its regular call, once before its first report and with every call after; control gives it a user on the bus. That file, if it holds no user key's seed, stops the supervisor at start with `<path> does not hold a NATS user key's seed: delete it, and the supervisor makes a new key at its next start (control records the change)`. Beside it, it makes the seal key control seals the rig's config to, in `bus-seal.pem` (0600), and sends its public part on the same call; that file, if it holds no X25519 private key, stops the supervisor at start with `<path> does not hold an X25519 private key: delete it, and the supervisor makes a new seal key at its next start (control records the change)`. Not set: reports and live lines go to control's API, and commands come from it. Anything but a `nats://` address stops the supervisor at start, as for control |
| `THERMITE_NATS_CA` | PEM certificate | not set | no | With `THERMITE_NATS_URL`: the certificate of the authority the supervisor trusts the bus's server through, control's own, in the setting itself. Control sets it on the rigs it sets up on a cluster, in the supervisor's deployment, so that every update of the rig's images carries the authority control has then. Anything but an authority's certificate stops the supervisor at start with `THERMITE_NATS_CA takes the PEM certificate of the authority that signed the bus's server's certificate`; both it and `THERMITE_NATS_CA_FILE` set, with `set THERMITE_NATS_CA or THERMITE_NATS_CA_FILE, not both` |
| `THERMITE_NATS_CA_FILE` | path | not set | no | With `THERMITE_NATS_URL`: a file that holds the same certificate, read at each connection to the bus, so that it may appear after the supervisor starts: `/keys/bus-ca.pem` in the compose stack, where control writes it (`THERMITE_NATS_CA_EXPORT`), and on the rigs control sets up on machines, where it is written with the rig's files. A file missing or that holds no certificate fails each connection, and the bus's log line says why: `following failed; trying again` |

### Pull mode

In [pull mode](../explanation/trust.md#rigs-in-pull-mode), the supervisor never connects to control: control connects to it. A rig on RunPod runs this way. Control makes the launch values below for each rig, as public material and one one-time code, and puts them in the pod's environment when the owner [launches a rig on RunPod](rest-api.md#rigs-on-a-gpu-cloud), with the key the pod's [state snapshot](#the-states-snapshot) is sealed with (`THERMITE_STATE_SNAPSHOT_KEY`), which only the broker reads. A missing or bad value stops the supervisor at start: `pull mode needs <NAME>`, `THERMITE_TUNNEL_PORT takes a whole number from 1 to 65535, not "<value>"`, `THERMITE_TUNNEL_CONTROL_BOX is not a public key`, `THERMITE_TUNNEL_CONTROL_KEY_SHA256 must be 64 hexadecimal characters` or `THERMITE_TUNNEL_ENROLL_UNTIL must be an ISO time`.

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_TUNNEL_PORT` | port: an integer, 1 to 65535 | not set: no pull mode | no | Turns pull mode on. The supervisor serves this port, on every interface, for control alone. `CONTROL_URL` and `THERMITE_CONTROL_TOKEN_FILE` are not read: the supervisor's calls to control go to a port of its own on `127.0.0.1` and wait there for control. Control's launch values set it to `8790` |
| `THERMITE_TUNNEL_POD` | string | `RUNPOD_POD_ID`, which RunPod sets in every pod | no | The pod's ID. Every request from control names it, and a request for another pod is refused. The one-container rig image's entry point sets it from `RUNPOD_POD_ID`, which it then removes |
| `THERMITE_TUNNEL_PREFIX` | 64 hexadecimal characters | required in pull mode | no | A launch value: the random path the port answers under. A request to any other path is refused before its body is read |
| `THERMITE_TUNNEL_CONTROL_KEY_SHA256` | SHA-256 | required in pull mode | hash | A launch value: the SHA-256 of control's command-signing public key. Control's first request brings the key; the pod takes it only if its SHA-256 is this one |
| `THERMITE_TUNNEL_CONTROL_BOX` | base64 | required in pull mode | no | A launch value: the rig's public key at control (X25519, on one line). What the pod sends control is sealed to it |
| `THERMITE_TUNNEL_ENROLL_CODE` | 64 hexadecimal characters | required in pull mode | one-time code | A launch value: the enrollment code. It never crosses the network: each side proves that it holds it. The supervisor takes it out of its own environment at start, so nothing it starts inherits it. The pod's first enrollment spends it |
| `THERMITE_TUNNEL_ENROLL_UNTIL` | ISO time | not set: the code does not expire | no | A launch value, only when the launch set an expiry: after this time the pod refuses to enroll |
| `THERMITE_TUNNEL_DIR` | path | `tunnel` in `THERMITE_SUPERVISOR_HOME` | directory with secrets | The pod's own keys (made at its first start, file `keys.json`, mode 0600), its enrollment, and the request nonces it has seen. Mode 0700. A full reset keeps it, so control's trust in the pod stays. Give the harness the same value: its isolation self-test then checks that no role can read the keys |
| `THERMITE_TUNNEL_ENROLLED_DIR` | path | `enrolled` in `THERMITE_SUPERVISOR_HOME` | no | Where enrollment leaves public files: control's key (`control.pub`), and the rig's settings from control (`rig.json`, and `rig.env` as `NAME=value` lines). `control.pub` is written last. In the one-container rig image, root checks them and gives the harness its own copy of the key. A full reset keeps it |

In pull mode the supervisor also takes `RUNPOD_API_KEY`, which RunPod puts in a pod's environment, out of its own environment. Thermite never uses it on the pod: control holds its own RunPod key.

### How often it talks to control

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_POLL_SECONDS` | seconds, above 0 | `60` | no | How often it reports the harness's events to control and pushes new exports to the results repository, or, without one, sends them to control. The pause between the advisors' rounds is the same interval, but at least 30 seconds. On a rig with teachers, a message from the owner to the teachers of a running run, or a planner's round that left a running run's queue below its [target](contract.md#lanes), ends the pause early: during it, the supervisor looks for either every 5 seconds |
| `THERMITE_COMMAND_POLL_SECONDS` | seconds, 0 or more | `5` | no | How often it fetches control's commands. `0`: commands are fetched with each report instead. With `THERMITE_NATS_URL` set, commands come over the message bus, and the supervisor fetches them every 180 seconds whatever this says, for any that never reached the bus |
| `THERMITE_LIVE_INTERVAL_MS` | milliseconds, 0 or more | `3000` | no | How often it relays the live view: it reads its harness's new live lines and posts them to control, or, with `THERMITE_NATS_URL`, publishes them to the message bus. `0` turns the live view off |
| `THERMITE_MODEL_ROUTE_POLL_SECONDS` | seconds, 0 or more | `30` | no | How often it asks control for the rig's model and hands a change to the harness. A round that fails is tried once more 5 seconds later (or after this interval, if it is shorter); only a second failure logs `model route error`, once until a round works again. Each round also asks control for the rig's [MCP servers](../how-to/operate/mcp-servers.md#what-a-rig-gets), hands the harness its workers' and planner's share, and keeps the advisors' in memory; a failure logs `MCP servers error` once, and the servers given last stay. With `THERMITE_NATS_URL`, it asks control nothing: these values come from the rig's config on the bus as control writes them, and on this beat it only looks at its own harness and hands it again what it lost, such as its MCP servers after a restart. `0` turns both off |
| `THERMITE_KB_SYNC_SECONDS` | seconds, 0 or more | `180` | no | How often it asks control for the past research each running run's campaign may read, and hands the new and changed items to the harness, for the run's [`knowledge/` folder](knowledge-base.md#a-runs-knowledge-folder). Only with `CONTROL_URL` and the rig's token. `0` turns it off |

### The results repository

See [Set up the results repository](../how-to/operate/results-repository.md).

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_RESULTS_REMOTE` | Git URL | not set: exports go to control, or, without control, stay in the supervisor's volume | no | The repository the supervisor pushes exports to. Without it, the supervisor sends them to control instead: see [Exports](exports.md#where-exports-go) |
| `THERMITE_RESULTS_KEY_FILE` | path | not set | path to a secret | An SSH key for the results repository, also used to fetch private sources over SSH |
| `THERMITE_RESULTS_KNOWN_HOSTS` | path | not set | no | A known-hosts file for the results repository's host. With it, Git accepts only the host keys in the file. It takes effect together with `THERMITE_RESULTS_KEY_FILE` |

### Places and advisors

| Variable | Type | Default | Secret | Meaning |
| --- | --- | --- | --- | --- |
| `THERMITE_SUPERVISOR_HOME` | path | `/var/lib/thermite-supervisor` | no | The supervisor's state: where it is in the event stream, exports done, champions waiting to reach control, exports waiting to be sent to control (`export-uploads.json`), advisors' records, where each run's past research sync is (`kb-state.json`), the local results repository (`results.git`) and fetched sources (`sources/`) |
| `THERMITE_INBOX_DIR` | path | `/inbox` | no | The harness's inbox. The supervisor writes imports there, [model files](model-files.md#where-the-file-goes) it downloads among them |
| `THERMITE_HF_TOKEN_FILE` | path | not set | path to a secret | A Hugging Face token, for [gated model files](model-files.md#gated-models-on-hugging-face). The supervisor reads it when it starts and sends it to Hugging Face only. The harness never gets it |
| `THERMITE_OUTBOX_DIR` | path | `/outbox` | no | The harness's outbox. The supervisor reads exports from it |
| `THERMITE_DISK_FLOOR_GIB` | GiB, 0 or more | `5` | no | The free space a [model download](model-files.md) leaves where it lands, as the harness keeps on its places ([Places, exports and the broker](#places-exports-and-the-broker)). A download that would go below it is refused, and the command's outcome says why: `not enough free space for model <name>: it needs 2.0 GB more, and 6.4 GB is free where it goes (the inbox's models), and the rig keeps 5 GiB free (THERMITE_DISK_FLOOR_GIB)`. The supervisor looks again after each MiB it writes, so a download whose server gives no size stops at the floor too, and deletes what it had downloaded. Fractions work. `0`: no floor |
| `THERMITE_SUPERVISOR_HEALTH_LISTEN` | `host:port` | `127.0.0.1:8701` | no | Where the supervisor answers its health route, `GET /v1/health`: its report, command and live loops, each with the seconds since it came around, and 503 when one is late ([Health](rest-api.md#health)). On the container's loopback by default, so only a check inside the container reaches it, as compose's, the machines' units' and Kubernetes' do. A bad value stops it at start with `bad listen address <value>` |
| `THERMITE_ADVISORS_FILE` | path to a JSON file | not set | path to a secret | The [advisors file](advisors-file.md), the advisors' models when control gives them none: the teachers, their merged by model, the auditor and the review panel. A role given a model on **Edit rig** uses that model instead. Not set, and no role given a model: no advisors run |
| `THERMITE_CLAUDE_BIN` | name or path | `claude` on the `PATH` | no | The Claude Code program, for advisors that run in Claude Code |
| `THERMITE_STE_CHECKER` | path to a script | not set | no | A Simplified Technical English checker for the final writer's research papers, which the deployment provides: Thermite ships none. The supervisor runs it with Node as `node <path> --json --mode descriptive -`, the text on its input, and reads its JSON report; it runs it itself on each paper it posts, and the harness refuses a paper it found an error in. The script must exit with 0, or 1 when it found an error, within 120 s; a checker that fails holds the paper back, and the writer tries again 30 minutes later. The guide `reference/ste-guide.md` beside the script's folder, when there is one, goes in the writer's prompt. The compose file and the rigs control sets up do not set it. Not set: papers are not checked for STE, and the run's page and journal say so ([The research paper](../explanation/campaign-modes.md#the-research-paper)) |

## Command line

The `thermite` command takes control's or the harness's address and a token file as options (`--control` or `--harness`, and `--token-file`), never from the environment. See [Command line](command-line.md).

Two commands read variables. `thermite doctor` reads `THERMITE_CONTROL_PORT`, the port the compose file publishes control on, as its default for `--port`. `thermite selftest isolation`, which runs inside the harness container, reads the harness's own settings, with the same defaults:

- the secret files it checks no role can read: `THERMITE_SUPERVISOR_TOKEN_FILE`, `THERMITE_PROPOSER_TOKEN_FILE` and `THERMITE_MODEL_API_KEY_FILE`, and, when `THERMITE_TUNNEL_DIR` is set, the pull mode keys in it (`keys.json`);
- the places: `THERMITE_BROKER_DIR`, `THERMITE_STATE_DIR`, `THERMITE_SCRATCH_DIR` and `THERMITE_OUTBOX_DIR`;
- the GPU settings: `THERMITE_GPU_INDEX`, `THERMITE_DEV_GPU_INDEX`, `THERMITE_GPUS` and `THERMITE_JUDGE_GPUS`;
- in the one-container rig image, `THERMITE_ONE_CONTAINER`, and the supervisor's places it probes: `THERMITE_SUPERVISOR_HOME` and `THERMITE_INBOX_DIR`; in pull mode also `THERMITE_CONTROL_PUBKEY_FILE` and `THERMITE_TUNNEL_CONTROL_KEY_SHA256`, to check the key the harness trusts;
- `THERMITE_STATE_SNAPSHOT_DIR`, the state's snapshot folder, which must hold only sealed files, and which no role may list or write in where the volume keeps file modes.

## Rigs that control sets up

A rig set up from **Add a rig**, on a machine or a cluster, or with a join command, gets these settings from control. Everything else takes its default.

| Container | Settings |
| --- | --- |
| Harness | `THERMITE_RIG_ID`; `THERMITE_TARGET` (`cpu`, or `cuda-gpu` with GPUs); for one GPU, `THERMITE_GPU_INDEX=0`; for several, `THERMITE_GPUS` and `THERMITE_JUDGE_GPUS`; `THERMITE_CONTROL_PUBKEY_FILE`; `THERMITE_SUPERVISOR_TOKEN_FILE` |
| Supervisor | `THERMITE_RIG_ID`; `HARNESS_URL` (port 8700); `CONTROL_URL` (from `THERMITE_CONTROL_PUBLIC_URL`); `THERMITE_HARNESS_TOKEN_FILE`; `THERMITE_CONTROL_TOKEN_FILE`; when control has an address of its message bus for rigs, `THERMITE_NATS_URL` (from `THERMITE_NATS_PUBLIC_URL`, or the host of `THERMITE_CONTROL_PUBLIC_URL`) and control's authority's certificate: `THERMITE_NATS_CA_FILE` on a machine, `THERMITE_NATS_CA` on a cluster |

An image update of a rig on a cluster writes its two deployments again from control's settings at that moment, so the supervisor's `CONTROL_URL` is taken from `THERMITE_CONTROL_PUBLIC_URL` again, and its bus's address and authority from control's as they are then; an update of a rig on a machine writes its units and the authority's file again the same way. Without `THERMITE_CONTROL_PUBLIC_URL`, the update is refused: `Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report.` When only this address changed, the rig's page offers **Give it control's new address**, and the MCP tool [`update_rig_images`](mcp-tools.md#update_rig_images) does the same: the rig's pods restart with the new address, on the same images. The page compares the address control recorded when it set the rig up or last updated it; a rig set up before control kept that record shows the button only after its next update.

## Older names

Some settings were renamed. These older names are still read when the new name is not set.

| Older name | Read as | Still works |
| --- | --- | --- |
| `THERMITE_UNIT_ID` | `THERMITE_RIG_ID` | Yes, in the harness and the supervisor. It logs `THERMITE_UNIT_ID is deprecated; set THERMITE_RIG_ID` |
| `THERMITE_CONTROL_UNIT_TOKENS_FILE` | `THERMITE_CONTROL_RIG_TOKENS_FILE` | **No.** It is declared as an older name, but control does not read it. Use `THERMITE_CONTROL_RIG_TOKENS_FILE` |

The model settings have only the names in [The rig's own model](#the-rigs-own-model). Names they had before are not read.

## The compose file

`compose.yaml` runs control and one rig on one machine: the repository's builds the images from the source code, and a release's runs the published images. It passes some settings from your shell or a `.env` file next to it, and fixes the rest. A setting it does not list needs an edit to the compose file. Each service also has a health check, and its log is bounded ([Where the logs are](../how-to/operate/troubleshoot.md#where-the-logs-are)): control's, the harness's and the supervisor's check runs `node -e` with a program that asks the part's `/v1/health` inside its container, every 30 seconds, and counts three failures running as `unhealthy`, after 5 minutes to start ([Health](rest-api.md#health)).

| Service | Passed from your shell or `.env`, with its default | Fixed in `compose.yaml` |
| --- | --- | --- |
| control | `THERMITE_CONTROL_STALE_SECONDS` (180); `THERMITE_CONTROL_OFFLINE_SECONDS` (900); `THERMITE_CONTROL_PUBLIC_URL`, `THERMITE_RIG_HARNESS_IMAGE`, `THERMITE_RIG_HARNESS_CUDA_IMAGE`, `THERMITE_RIG_SUPERVISOR_IMAGE`, `THERMITE_RUNPOD_RIG_IMAGE`, `THERMITE_RUNPOD_TEST_IMAGE`, `THERMITE_CONTROL_REQUIRE_KEY_ACCEPT`, `THERMITE_CONTROL_SESSION_DAYS`, `THERMITE_LIFECYCLE` and `THERMITE_NATS_PUBLIC_URL` (all empty); `THERMITE_DISK_FLOOR_GIB` (empty: 5) | `THERMITE_CONTROL_DIR`, `THERMITE_CONTROL_LISTEN`, `THERMITE_CONTROL_ADMIN_TOKEN_FILE`, `THERMITE_CONTROL_OPERATOR_TOKEN_FILE`, `THERMITE_CONTROL_RIG_TOKENS_FILE`, `THERMITE_CONTROL_PUBKEY_EXPORT` (`/keys/control-signing.pub`), `THERMITE_COMPOSE_PROJECT`, `THERMITE_COMPOSE_SERVICES`, `THERMITE_NATS_URL` (`nats://nats:4222`), `THERMITE_NATS_CONFIG_DIR` (`/nats-config`), `THERMITE_NATS_CA_EXPORT` (`/keys/bus-ca.pem`) |
| harness | `THERMITE_PROMOTION` (`auto`); `THERMITE_CALIBRATION_BLOCKS` (6); `THERMITE_MODEL_BASE_URL`, `THERMITE_MODEL` and `THERMITE_MODEL_REASONING_EFFORT` (empty); `THERMITE_MODEL_CONTEXT_WINDOW` (0); `THERMITE_MODEL_MAX_TOKENS` (empty); `THERMITE_MAX_TRIALS` (1); `THERMITE_TRIAL_MINUTES` (empty); `THERMITE_MAX_TURNS`, `THERMITE_RESEARCH_MAX_MB`, `THERMITE_LLM_USD_PER_MTOK_IN` and `THERMITE_LLM_USD_PER_MTOK_OUT` (empty); `THERMITE_EXPORT_MINUTES` (60); `THERMITE_DISK_FLOOR_GIB` and `THERMITE_DRAIN_MINUTES` (empty: 5 and 60) | `THERMITE_RIG_ID` (`local-1`), `THERMITE_TARGET` (`cpu`), `THERMITE_CONTROL_PUBKEY_FILE`, `THERMITE_SUPERVISOR_TOKEN_FILE`, `THERMITE_PROPOSER_TOKEN_FILE`, `THERMITE_MODEL_API_KEY_FILE` |
| supervisor | `THERMITE_POLL_SECONDS` (60); `THERMITE_COMMAND_POLL_SECONDS` (5); `THERMITE_MODEL_ROUTE_POLL_SECONDS` (30); `THERMITE_LIVE_INTERVAL_MS` (3000); `THERMITE_RESULTS_REMOTE` (`file:///results/results.git`, a repository on a shared volume); `THERMITE_ADVISORS_FILE` (empty); `THERMITE_KB_SYNC_SECONDS` (180); `THERMITE_NATS_URL` (`nats://nats:4222`; set to nothing, the rig reports over HTTP); `THERMITE_DISK_FLOOR_GIB` (empty: 5) | `THERMITE_RIG_ID` (`local-1`), `HARNESS_URL`, `CONTROL_URL`, `THERMITE_HARNESS_TOKEN_FILE`, `THERMITE_CONTROL_TOKEN_FILE`, `THERMITE_NATS_CA_FILE` (`/keys/bus-ca.pem`) |

Each service's build in the repository's `compose.yaml` also takes `THERMITE_COMMIT` from your shell or `.env` (empty), as the [build argument](#build-arguments) of the same name: for example `THERMITE_COMMIT=$(git rev-parse HEAD) docker compose build`.

The defaults match the code's, except `THERMITE_RESULTS_REMOTE` and `THERMITE_NATS_URL`, which the code leaves unset. A release's `compose.yaml` passes the same settings with the same defaults, with one difference: `THERMITE_RIG_HARNESS_IMAGE`, `THERMITE_RIG_HARNESS_CUDA_IMAGE`, `THERMITE_RIG_SUPERVISOR_IMAGE`, `THERMITE_RUNPOD_RIG_IMAGE` and `THERMITE_RUNPOD_TEST_IMAGE` default to that release's published images, pinned by digest (both RunPod settings to its rig image). It builds nothing, so it takes no `THERMITE_COMMIT`: the published images carry their commit already. The second rig of the `two-rigs` profile (`harness-2` and `supervisor-2`, rig `local-2`) takes the same settings, except that its harness does not pass `THERMITE_RESEARCH_MAX_MB` or the two prices.

The compose file also has a `nats` service, the message bus: the NATS server from its official image, pinned by digest, with JetStream. It always runs beside control, and control always uses it. Both supervisors use it unless `THERMITE_NATS_URL` is set to nothing in `.env`, which keeps the two rigs off the bus, reporting over HTTP; control's own `THERMITE_NATS_URL` is fixed, and never reads it:

```sh title=".env (part)"
THERMITE_NATS_URL=
```

Its settings are fixed in the compose file but two: the largest message, 8 MiB, which the reports', the commands' and the live lines' contracts keep to; monitoring on the container's own loopback, for its health check; JetStream's store on its volume, at most `THERMITE_NATS_STORE`; a memory limit, `THERMITE_NATS_MEMORY`, of which Go is told 78% (`GOMEMLIMIT`), so that it frees what a read loaded before the limit is reached; TLS on its port, with the certificate and key control writes; and the users file control writes. Both are on the `nats-config` volume, and the server includes them. It starts once control has written them, and says `waiting for control to write the bus's users and certificate` until then. It runs as root with control's group, `0:10001`, so that it reads the certificate's key, which only control's user and group may read. Every connection is over TLS and signs in with a key the server has from the users file: control's, and each rig's once its supervisor registered it. The harnesses are not on the `control` network, so they never reach it; control still checks each report's signature, and the harness each command's, as over HTTP. [Run the message bus](../how-to/operate/message-bus.md) says how to check it, what to open for rigs on other machines, and how to keep the rigs off it.

It also has a `backup` service, in the `backup` profile, which `up` never starts: control's image, with control's state, the bus's store at `/bus-store` and `.dev/backups` at `/backups`, on the `control` network, as root with only the capabilities `CHOWN`, `DAC_OVERRIDE` and `FOWNER`. It fixes `THERMITE_CONTROL_DIR` (`/var/lib/thermite-control`) and `THERMITE_NATS_URL` (`nats://nats:4222`), as control has them, for `thermite backup` and `thermite restore` ([Back up and restore control](../how-to/operate/backup-and-restore.md)).

On a machine with NVIDIA GPUs, `thermite local init` also writes `compose.gpu.yaml`, which changes the harness of `local-1` only: `THERMITE_TARGET` `cuda-gpu`, `THERMITE_GPUS` and `THERMITE_JUDGE_GPUS` (or `THERMITE_GPU_INDEX` `0` for one GPU), the GPUs themselves, and the CUDA image: beside a release's `compose.yaml`, the release's CUDA harness, which `THERMITE_RIG_HARNESS_CUDA_IMAGE` in `.env` replaces; beside the repository's, one it builds on the CUDA base. See [`local init`](command-line.md#local-init).

These five are read by the compose files. Thermite's services never read them; `thermite doctor` reads `THERMITE_CONTROL_PORT` to find control's port:

| Variable | Default | Meaning |
| --- | --- | --- |
| `THERMITE_CONTROL_PORT` | `8800` | The port on `127.0.0.1` where control is published. Inside the stack control stays at `control:8800` |
| `THERMITE_NATS_PUBLISH` | `127.0.0.1:4222` | Where the message bus's port is published on this machine: an address and a port. Rigs on other machines reach the bus here: `0.0.0.0:4222` publishes it on every address. Inside the stack the bus stays at `nats:4222` |
| `THERMITE_NATS_MEMORY` | `256m` | The message bus's memory limit, as compose writes one, such as `512m` or `1g`. The server tells Go 78% of it. It holds the index of each stream's subjects and the blocks a read loads, not the messages, which are on disk. A [restore](../how-to/operate/backup-and-restore.md#restore-a-backup) needs more for its run: about 1 KiB a message over 128 MiB, which `thermite restore` prints |
| `THERMITE_NATS_STORE` | not set | The most the message bus keeps on its volume, such as `20G`. Not set: 75% of the volume's free space when the server starts. Keep it under what the disk has free: a server whose disk is full turns JetStream off |
| `THERMITE_ENGINE_SOCKET_HOST` | `/var/run/docker.sock` | `compose.lifecycle.yaml` only: the container engine's socket on the host, mounted into control as `/run/engine.sock` |

## Scripts and test images

The smoke and acceptance scripts in `scripts/` read these. They are not settings of a deployment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPOSE` | `podman compose` | The compose command the scripts run: `podman compose`, `podman-compose` or `docker compose` |
| `KEEP` | not set | `1`: leave the stack and its volumes up when the script ends |
| `THERMITE_PROJECT` | not set | A compose project name, so a second stack can run beside the usual one, with its own `THERMITE_CONTROL_PORT` and `THERMITE_NATS_PUBLISH` |
| `THERMITE_CONTROL_PORT` | `8800` | Where the scripts reach control, as in the compose file |
| `THERMITE_ENGINE_SOCKET_HOST` | Podman's socket, when Podman has one | The steering acceptance: the engine socket for `compose.lifecycle.yaml`. With none, the restarts are not tested |
| `MINUTES`, `PACE_SECONDS`, `SEEDS` | `125`, `120`, two built-in pages | The research long run (`scripts/acceptance/research-longrun.mjs`): its length in minutes, the wait at the start of each trial in seconds, and its seed pages as comma-separated URLs |
| `THERMITE_FAKE_CLAUDE` | not set | `1`: lets the stand-in for Claude Code in the Claude Code acceptance's test image run. Without it, or a marker file in that image, the stand-in refuses to run |
| `THERMITE_FAKE_CODEX` | not set | `1`: lets the stand-in for the Codex CLI in the Codex acceptance's test image run. Without it, or a marker file in that image, the stand-in refuses to run |

## Build arguments

The images take these build arguments. [Harness image](harness-image.md) says what each image holds.

| Argument | Images | Default | Meaning |
| --- | --- | --- | --- |
| `NODE_IMAGE` | control, harness, supervisor | Node.js 22 on Debian bookworm (slim), pinned by digest | The Node.js image each image is built from |
| `BASE_IMAGE` | harness | `NODE_IMAGE` | The harness's base. For GPU rigs, a CUDA development image: CUDA 12.x for the `-cuda` harness, CUDA 13.x for the `-cuda13` one |
| `OPENCODE_VERSION` | harness, supervisor | `2.1.4` | The OpenCode version installed: for the workers and the planner, and for advisors in OpenCode |
| `CLAUDE_CODE_VERSION` | harness, supervisor | empty: Claude Code is not installed | The Claude Code version to download at build time, for agents or advisors on a Claude subscription |
| `CODEX_VERSION` | harness, supervisor | `0.162.1` | The Codex CLI version installed: for the workers and the planner, and for advisors in Codex. Empty: the image has no Codex CLI |
| `KUBECTL_VERSION` | control | `v1.37.1` | The kubectl version installed, checked against a pinned checksum |
| `THERMITE_IMAGE_ID` | harness | empty | The image's identity, kept as the environment variable of the same name ([above](#places-exports-and-the-broker)). The release workflow sets it to the image's tag and short commit, such as `0.1.0-cuda+1a2b3c4d5e6f` |
| `THERMITE_COMMIT` | control, harness, supervisor | empty | The source commit the image is built from: 7 to 64 hexadecimal characters, such as the output of `git rev-parse HEAD`. The image sets the environment variable of the same name, and the service reports it with Thermite's version from `package.json` ([Rig versions](rest-api.md#rig-versions)). Empty, or anything else: the service reports no commit |
| `HARNESS_IMAGE` | one-container rig | none: required | The harness image the one-container rig image is built on |

## Set by Thermite itself

Thermite also sets variables for its own child processes: the harness's address and a trial's token for the agents' tools, where Thermite's OpenCode plugin keeps a conversation before a compaction, the secret values the broker hands to the controller, the build cache of each lane, and the probe a RunPod test pod runs. They are not settings, and setting them yourself has no use.
