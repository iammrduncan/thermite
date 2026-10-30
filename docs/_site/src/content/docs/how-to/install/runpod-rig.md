---
title: "Run a rig on RunPod"
description: "Launch a rig on a RunPod GPU from the dashboard, set its spend limit and idle stop, stop, start and terminate it, and keep its results."
type: how-to
sidebar:
  order: 8
---

:::caution[This spends money]
A rig on RunPod is a real RunPod pod. RunPod bills its GPU by the hour from the launch until the pod is stopped or removed, and its volume while the pod exists. Thermite sets no limit of its own: give each launch a **spend limit**, an **idle stop**, or both, as in step 2. The launch form fills in an idle stop of 30 minutes, which you can change or clear. A launch from the command line, the REST API or MCP has none unless it names one.
:::

A [rig](../../reference/glossary.md) on RunPod runs on a GPU you rent by the hour. Control launches the pod, connects to it through RunPod's proxy, follows its price and what it has cost, and stops it at the limits you set. This page launches one from the dashboard, runs it, and terminates it with every result kept on control. The command line, the REST API and MCP do each step too; each step gives the command.

## Before you start

- **A RunPod account in Settings › Providers**, added with an API key that may write. [Test a GPU on RunPod](runpod-test.md#1-add-the-runpod-account) gives the steps. A test pod there is a cheap way to check a GPU type first.
- **The rig image, on control.** A pod runs the [one-container rig image](../../reference/harness-image.md#the-one-container-rig-image): the CUDA harness and the supervisor in one container. Each release publishes it on `ghcr.io` ([Published images](../../reference/harness-image.md#published-images)), and the release's `compose.yaml` gives it to control, pinned by its digest, in `THERMITE_RUNPOD_RIG_IMAGE`. With a release's `compose.yaml` there is nothing to do: a launch runs that image. A control that runs from the source code's `compose.yaml` has no rig image until you name one in `.env`: a published one, such as `ghcr.io/iammrduncan/thermite-rig:0.1.0-cuda`, or [one of your own](#use-a-rig-image-of-your-own). Without one, the launch form offers only **Your own image**.
- **The owner's sign-in.** Only the owner may launch, stop, start or terminate a rig on RunPod. The dashboard signs in with the owner's token. For the command line, keep the token in a file: on the local compose stack it is `.dev/secrets/control-admin-token`.
- **A way out to the internet for control and its message bus.** Control needs no public address: it connects to the pod through RunPod's proxy, its message bus connects to the pod's own bus server, and the pod never connects to control ([A rig on RunPod](../../explanation/how-the-parts-talk.md#a-rig-on-runpod)). The local compose stack is enough. A firewall in front of control must let the bus's `nats` service reach any TCP port on the internet: RunPod chooses the pod's public port.

The command-line examples run [the command line](one-machine.md#the-command-line) in your `thermite-source` folder, with the local stack's address and token file. Put yours in their place.

```sh
c="--control http://127.0.0.1:8800 --token-file .dev/secrets/control-admin-token"
```

## 1. Open Launch on RunPod

Open **Rigs** in the sidebar, press **Add a rig**, and choose your RunPod account under "Or launch it on a GPU you rent by the hour". **Launch on RunPod** at the top of **Rigs**, and **Launch a rig** on the account's row in **Settings › Providers**, open the same page.

**Launch on RunPod** shows the account, its pods running now, and when control last read RunPod's prices and stock. Press **Read again** to read them now.

## 2. Choose the GPU, the limits and the name, and launch

The form lists RunPod's GPU types on Secure cloud, cheapest first, with their memory, their price per GPU per hour and their stock. Types with no stock there are hidden, and the page says how many.

| Field | Default | What it does |
| --- | --- | --- |
| **GPU** | the cheapest in stock | The GPU type of the pod |
| **How many GPUs** | `1` | 1 to 8 GPUs in the pod. RunPod refuses the launch when it has fewer free |
| **GPUs for the judge** | half, rounded up | Only with 2 GPUs or more: how many the judge measures on, the lowest-numbered. The rest are the agents' for their own test runs |
| **Cloud** | Secure cloud, on demand | The only choice for now. Community cloud and spot pods come later |
| **Data center** | Any data center | Where the pod runs. Any: RunPod picks one with the GPU free |
| **Volume size (GB)** | `100` | The pod volume at `/workspace`, which keeps a snapshot of the rig's state while the pod is stopped. 10 to 10000 GB |
| **Image** | Thermite's rig image, as control names it | Or **Your own image**, with its name and tag in **Your image** |
| **Spend limit (USD)** | none | Control stops the pod once it has cost this much since launch |
| **Stop when idle for (minutes)** | `30` | Control stops the pod once no run has been at work on it for this long: 5 minutes or more. Clear the field and the pod never stops by itself. A refused launch keeps what you typed, an empty field too. See [step 5](#5-watch-its-cost-and-change-its-limits) |
| **Rig name** | `rp-` and 8 characters | The rig's name: 2 to 40 lowercase letters, digits and dashes. It can't change later |

The rig works on the pod's own disk, 40 GB, which RunPod empties when the pod stops, and keeps a snapshot of its state on the volume ([step 6](#6-stop-and-start-it)). Both hold the rig's state, its model files and builds among it: give the volume room for it. A launch from the command line (`--disk`), the REST API or MCP (`container_disk_gb`) can give the pod's own disk more room too.

Every label has an **i**: hover it for what the field means. The price under the form follows each choice: the GPU's price on Secure cloud times the GPUs, such as `$0.50 an hour`. RunPod also bills the container disk and the volume by the GB. The sentence under the price says what the launch starts and what stops it, and what to fix while a field is wrong.

Press **Launch · $0.50/h**. The rig's page opens and says `Launched: RunPod bills pod … from now at $0.50 an hour. Control enrolls it once it runs.` A launch that control or RunPod refuses starts nothing and leaves no rig: the form comes back with what you typed, **Not launched.** and the reason, such as `RunPod answered 400 for POST /v2/pods (Bad Request: …)`. RunPod's stock changes by the minute: when it has none of the GPU you chose, the reason starts `RunPod has no 1 × RTX A4500 free on Secure cloud now:` and ends `No pod was started and nothing is billed. Choose another GPU, or try again in a few minutes.`

The pod's settings, which RunPod's console shows, hold only what the pod needs to enroll and to join the message bus: the rig's name, a random path, a public key for what the pod sends to control, the SHA-256 of control's command-signing key (not the key), a one-time enrollment code, and the pod's own TLS certificate and key for its bus server, with control's authority's certificate. Control's RunPod key and every other secret stay on control ([Rigs in pull mode](../../explanation/trust.md#rigs-in-pull-mode)); control keeps neither the pod's key nor anything that could sign another certificate for the pod. The launch exposes the pod's port 8790 as HTTP, for control's calls through RunPod's proxy, and 7422 as TCP, for the bus.

The same launch from the command line has no idle stop unless you give `--idle-stop`; this one stops after 60 minutes with no run at work:

```sh
npx thermite runpod launch runpod --gpu "RTX A4000" --gpus 2 --spend-limit 20 --idle-stop 60 $c
```

`runpod` is the account's name in **Providers**. It prints the rig on one line, then `Launched: RunPod bills the pod from now. Control enrolls it once it runs; follow it with npx thermite runpod list.` [`npx thermite runpod launch`](../../reference/command-line.md#runpod-launch) lists every option, such as `--setting THERMITE_JUDGE_GPUS=1` and `--image`. Over the REST API, or with the MCP tool [`runpod_launch`](../../reference/mcp-tools.md#runpod_launch):

```sh
curl -sS -X POST http://127.0.0.1:8800/v1/gpu-clouds/runpod/rigs \
  -H "Authorization: Bearer $(cat .dev/secrets/control-admin-token)" \
  -H 'content-type: application/json' \
  -d '{"gpu":"RTX A4000","spend_limit_usd":20,"idle_stop_minutes":60}'
```

## 3. Wait until it reports

The rig's page shows **Getting it ready**, with each step as it happens: the pod pulls the image and runs, which takes a few minutes; control enrolls it through RunPod's proxy with its one-time code and pins its keys; the rig's first report reaches control. Press **refresh** in the status bar to follow it. **The pod** under it shows RunPod's status and the cost, and **Pull mode** shows control's last connection to the pod.

Meanwhile **Rigs** lists it as **Getting ready**, with its price under **Per hour**: the pod costs money from its launch. Once the rig reports, it shows **Live** there, and its page is a normal rig page, with **The pod** at the top. Check that its **Isolation** check at start passed ([Check a rig](../operate/check-a-rig.md)). `npx thermite runpod list $c` shows the same: the line ends with `enrolled`, and the status is `RUNNING`.

If it never enrolls, **Pull mode** shows the last error, and `npx thermite runpod list` shows `last error:` for control's last read of the pod.

Once the pod runs, RunPod gives its port 7422 a public address and port, and control's bus dials the pod's bus server there: **History** shows `Control's bus dials the pod's leaf node at the address RunPod gave it: 203.0.113.5:40123.`, and `GET /v1/rigs/<rig>/runpod` answers it in `bus_leaf`. From then on the rig's reports, commands, live lines, config and knowledge base go over the bus. While `bus_leaf` stays `null`, RunPod has given the port no public address yet, and the rig's reports wait: control's bus log, `docker compose logs nats`, names each pod it dials and why a connection failed. [A rig on RunPod](../operate/message-bus.md#a-rig-on-runpod-its-leaf-node) says what to look at.

### A pod that runs but never enrolls: read its log

Before a rig enrolls, control sees nothing of it, and the pod's log is the one place that says why. **Pod log**, under **Getting it ready**, reads it from RunPod's API with the key you gave in **Settings › Providers**, so you need no RunPod console. The first time the page opens, it reads the log by itself; after that it shows the last read, and **Read again** reads the newest lines. Each line is marked `container`, for what the rig image printed, or `system`, for RunPod's own steps, such as the image pull. The newest line is at the bottom.

Look for the last thing the image printed: an image that failed to pull, a crash at start, or a supervisor that could not reach control. A read that RunPod refuses says why in the block, such as `Not read: RunPod refused to show pod …'s log with this key: the key may not read pod logs.`: give control a key with read access to pods. Over the REST API, `GET /v1/rigs/<rig>/runpod/logs` gives the same lines, and so does the MCP tool [`runpod_rig_logs`](../../reference/mcp-tools.md#runpod_rig_logs).

## 4. Start runs on it

Start campaigns on it as on any rig: [from the dashboard](../campaigns/start-from-dashboard.md) or [from the command line](../campaigns/start-from-command-line.md).

When its pod is stopped, starting or resuming a run on it starts the pod first: **Start a run**, a new campaign's first run and **Resume** on the dashboard, `POST /v1/commands` and `POST /v1/campaigns/<campaign>/runs`, the MCP tools `issue_command` and `start_run`, and `thermite assign`, `thermite run start` or `thermite command`. The run starts once the pod runs. The dashboard and the command line say `rp-1a2b3c4d's pod was stopped: control started it. The run starts once the pod runs.` Only the owner's token starts a pod: an operator's or an agent's command for a stopped pod is refused. When RunPod has no GPU free, or the pod has cost its spend limit, the run is not started, and the reason says why.

## 5. Watch its cost and change its limits

**The pod** shows four facts: **Cost now** (its price per hour while it runs, `storage only` while it is stopped), **Spent so far** (what it cost while it ran, since launch, with a bar when a spend limit is set), **Spend limit** and **Idle stop**. Under **Idle stop** it says `a run is at work` while one is, and otherwise how long no run has been at work, such as `no run at work for 4 min of 30 min`, from control's check every 30 seconds. **Rigs** shows the cost now and the spend so far under **Per hour**, and a pod its idle stop stopped as **Stopped**, with `its idle stop stopped it` and `a new run wakes it` ([The Rigs list](../../reference/rigs-list.md#a-stopped-pod)).

To change them, open **Change the spend limit or the idle stop**, fill in or clear the fields, and press **Save**. The page says, for example, `Saved. No spend limit. It stops after 30 minutes with no run at work.` An empty field clears that limit. From the command line:

```sh
npx thermite runpod limits rp-1a2b3c4d --spend-limit 40 --idle-stop off $c
```

A number sets a limit, `off` clears it, and a limit you leave out stays.

**The idle stop** counts the time no run is at work on the rig: no campaign runs, or every run is paused, blocked or finished. A run is at work while a lane's trial is in progress or a judge job is queued for it; a run whose lanes all wait for your decision is blocked. The idle time counts from the pod's enrollment, its last start, or when you set the stop, whichever is latest ([When a rig is idle](../../reference/rest-api.md#when-a-rig-is-idle)).

A pod that reaches a limit is stopped as in step 6: its runs are paused and its results sent out first. It is never removed. While the pod has cost its spend limit, control refuses to start it: raise or clear the limit first.

**Control checks the limits, not the pod.** Control looks at each pod every 30 seconds while it runs, and the pod can't stop itself. While control is down, a pod goes on costing past its limits. When control starts again, its first look stops a pod that passed a limit meanwhile, and the pod's notes say `Control was not running from` the time it last looked.

## 6. Stop and start it

A stopped pod costs nothing for its GPU, and keeps its volume, with the snapshot of the rig's state, until you start it again.

Under **Start, stop and end it**, press **Stop the pod**. The page says `Stopping: its runs are paused and its results go out first, then the pod stops.`, and a card shows the stop's steps as they happen. Control pauses the rig's running runs, asks for an export, and stops the pod once that export, and every export and champion's patch waiting on the rig, has reached control. If they can't leave within 15 minutes, it stops the pod all the same, and what did not leave stays on the volume. Then the pod's state says **Stopped**, and **Cost now** says `storage only`. A stopped rig is not called stale or offline.

**What a stop keeps.** RunPod empties the pod's own disk when it stops, and keeps its volume. The rig works on its own disk, and keeps a snapshot of its state on the volume: the ledger, kits, builds, model files, the exports and imports waiting, the supervisor's state, and the pod's keys and enrollment. It takes one every 5 minutes, after each export, after enrollment, and as the pod stops, before its two parts stop. Each is written beside the last and swapped in only once it is whole, so a stop cut short keeps the last whole one, and loses only what changed after it. Control's stop pauses the runs and sends an export out first, and that export makes a snapshot too.

RunPod's volume lets every user in the pod read and write on it, whatever its file modes say, so the snapshot is sealed: encrypted and authenticated with a key control makes for this pod at its launch and puts in the pod's settings, where RunPod keeps it while the pod is stopped. Control keeps no copy. An agent on the rig can read nothing in the snapshot, and a snapshot that anyone changed is refused whole at the next start. [Where the state lives](../../reference/harness-image.md#where-the-state-lives) says what a snapshot holds, how it is sealed, and what sealing does not stop.

Press **Start the pod** to start it again. RunPod gives a stopped pod's GPU to whoever asks next. When it has no GPU free for the pod, the start is refused and says so: `RunPod has no free GPU for pod … now, so the pod stays stopped (…). Its volume stays. Try again later, or terminate it and launch a new rig.` Once the pod runs, the rig checks the snapshot and restores its state from it onto the fresh disk, and its log says `restored the rig's state from its snapshot`. Control resumes the runs the stop paused. The rig reports again with the same keys and enrollment: it does not enroll again. If its log says `the snapshot did not verify` instead, see [A RunPod rig lost its state over a stop](../operate/troubleshoot.md#a-runpod-rig-lost-its-state-over-a-stop).

RunPod may give a pod that starts again another public address. Control reads the new one, and its bus dials the pod there: **History** shows the new address. While the pod is stopped, control's bus dials nothing.

**Restart the pod** stops the pod and starts it again, with no export: the snapshot it takes as it stops keeps the rig's state. It does not pause the runs. A trial in progress stops: the harness records it as interrupted, and its experiment goes back to the top of the queue. A restart can meet the same lack of a free GPU.

From the command line: `npx thermite runpod stop rp-1a2b3c4d $c`, `npx thermite runpod start …` and `npx thermite runpod restart …`.

## 7. Get its results

A rig on RunPod has no results repository: it sends its exports, and its champions' patches, to control, which checks every file. **Results in the pod** on its page says what still waits on the pod. [Get a rig's results from control](../operate/exports-on-control.md) lists and downloads them. Each stop and the terminate below send what waits on the pod first.

## 8. Terminate it

Terminating removes the pod and its volume at RunPod. Control does it only once every result has left the pod.

In the **Terminate** box, type `terminate rp-1a2b3c4d` and press **Terminate**. The page says `Terminating: its runs are paused, and the pod is removed only once every result has left it.` Control pauses the runs, waits until no judge job and no command waits on the rig, asks for a full export, and waits until it, and everything else that waits on the pod, has reached control. Then RunPod removes the pod, and control retires the rig: it leaves the rig lists, and its records and exports stay on control. Its page then says what the pod cost in all.

If a result can't leave, the terminate is refused, and the pod keeps running with its runs paused. The page shows `Not terminated: …` with the reason, such as a supervisor that has nowhere to send its exports, and `npx thermite runpod list` shows it as `last error:`. It stays there until you stop, start, restart or terminate the pod, or reset it. Fix the cause, then terminate again, or resume the runs.

A stopped pod is terminated at once when its last stop sent every result out. Otherwise the terminate is refused: start the pod, so its results can leave, then terminate it.

From the command line: `npx thermite runpod terminate rp-1a2b3c4d $c`.

To check that nothing is left at RunPod, press **Read again** on the account's row in **Providers**: **Pods** no longer lists `thermite-rp-1a2b3c4d`.

## Fully reset it

A full reset wipes the rig's state and keeps the pod and its GPU. Every result leaves the pod first, then you check the export and confirm the wipe. In the **Full reset** box, type `reset rp-1a2b3c4d` and press **Start the full reset**, then go on as [Fully reset a rig](../operate/rig-lifecycle.md#fully-reset-a-rig) says. From the command line:

```sh
npx thermite runpod reset rp-1a2b3c4d $c
npx thermite runpod confirm-wipe rp-1a2b3c4d $c
```

Run the second only after you have checked the export on control. `npx thermite runpod cancel-reset` cancels it before the wipe. The reset needs the pod running: a stopped pod's results can't leave it.

## Every change is in the rig's history

**History** on the rig's page lists the launch, each stop, start, restart and terminate, and each full reset, with what happened, beside the rig's runs and its judge. Its filters show **The pod**, **Runs** or **The judge** alone. `GET /v1/rigs/<rig>/runpod` answers the rig with its `history`, oldest first, and the MCP tool [`rig_setup`](../../reference/mcp-tools.md#rig_setup) lists the same steps. The MCP tool [`runpod_rig`](../../reference/mcp-tools.md#runpod_rig) stops, starts, restarts, terminates and resets a rig, with the owner's token. [A rig's page](../../reference/rig-page.md#the-pod) describes every part of **The pod**.

## Use a rig image of your own

Build the rig image yourself when the published one does not fit: you [added your project's tools to the harness](extend-harness-image.md), you changed Thermite's code, or you want a build of your own commit. RunPod must pull the image without a login, because control gives RunPod no registry credentials.

1. Build the CUDA harness and push it to your registry, as [Push the images to your own registry](own-registry.md) says. The rig image is built on it.
2. Build the rig image on that harness, then push it:

   ```sh
   r=registry.example.com/thermite
   tag=$(git rev-parse --short=12 HEAD)
   docker build -t $r/thermite-rig:$tag-cuda --build-arg HARNESS_IMAGE=$r/thermite-harness:$tag-cuda \
     -f containers/rig/Containerfile .
   docker push $r/thermite-rig:$tag-cuda
   ```

   Build both images for amd64, as the release does. On a Mac with Apple silicon, add `--platform linux/amd64` to each `docker build`. Use a new tag for every build.
3. Tell control. Name the image in `.env` next to `compose.yaml`, then run `docker compose up -d` with your `-f` options:

   ```sh title=".env (part)"
   THERMITE_RUNPOD_RIG_IMAGE=registry.example.com/thermite/thermite-rig:1a2b3c4d5e6f-cuda
   ```

   Every launch then runs it. Or give it to one launch only: **Your own image** on the launch form, `--image` on the command line, `"image"` over the REST API, or `image` in the MCP tool `runpod_launch`.

To tell that it worked: `GET /v1/rigs/<rig>/runpod` answers the launched rig with your image in `image`.

## What does not work yet

- **Community cloud and spot pods.**
- **Network volumes.** A rig's volume is its pod's, and goes with the pod.
- **Another image for a running rig.** Control can't move a pod onto another image: terminate the rig and launch a new one.
- **Gated models.** A Hugging Face token for gated models can't reach a pod yet: a rig's supervisor reads one from `THERMITE_HF_TOKEN_FILE` ([Model files on a rig](../../reference/model-files.md)), but a launch from control gives a pod no such file ([goal 108](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/108-gated-models-on-cloud-rigs.goal)).
- **Registry sign-in.** The image must be pullable without a login.
