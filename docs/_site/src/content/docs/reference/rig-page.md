---
title: "A rig's page"
description: "Every part of a rig's page on the dashboard: its state and version banners, Update to control's version, Check again, a drain and the trials it waits for, its facts, and a RunPod rig's pod, limits, lifecycle, pod log and history."
type: reference
sidebar:
  order: 21
---

A [rig](glossary.md)'s page shows one rig: whether it reports, its version against control's, what runs on it, its checks, and what you can do to it. Open it from [**Rigs**](rigs-list.md): press the rig's row. Its address is `/ui/rigs/<rig>`. This page describes each part, from the top down. [Stop, restart, remove or reset a rig](../how-to/operate/rig-lifecycle.md) and [Run a rig on RunPod](../how-to/install/runpod-rig.md) give the steps.

## Places on the page

Other pages link to these places with the address and the anchor, for example `/ui/rigs/rig-1#version`. The Rigs list's **needs update** opens `#version`, and its rows open the place of the rig's state ([Where a row leads](rigs-list.md#where-a-row-leads)).

| Anchor | What it is | When the page has it |
| --- | --- | --- |
| `#reporting` | The banner for a rig that does not report: stale or offline | The rig is stale or offline, is not a stopped RunPod rig, and control does not refuse it |
| `#version` | The banner for the rig's version, or for its last update | Its version is behind or ahead of control's, control refuses it, or an update began in the last day |
| `#drain` | The card for a drain: since when, who asked, why, and what it waits for | The rig's last report says it drains |
| `#pod` | The pod: its cost, its limits and its lifecycle | The rig was launched on RunPod |
| `#limits` | The form that changes the spend limit and the idle stop | The same, while the pod exists |
| `#results` | The results that must leave the pod before it ends | The same, while the pod exists |
| `#podlog` | **Pod log**: the pod's log, read from RunPod | The same, while the pod exists |
| `#hist` | The history, with its filters | The rig was launched on RunPod |

## The top

The title is the rig's name. The line beside it says the rig's state:

| It says | When |
| --- | --- |
| `live` | The rig reported within the stale window (`THERMITE_CONTROL_STALE_SECONDS`, 180 s by default) |
| `stale · no report for 6 minutes` | No report for longer than the stale window |
| `offline · no report for 3 h 12 min`, or `offline · no report yet` | No report for longer than the offline window (`THERMITE_CONTROL_OFFLINE_SECONDS`, 900 s by default), or never |
| `refused · 0.0.7` | Control refuses the rig: its protocol and control's do not meet. The version is the rig's |
| `stopped` | A rig on RunPod whose pod is stopped. It is not called stale or offline |

After it, the line adds `0.1.0, behind control` or `0.2.0, ahead of control` when the rig's version differs from control's. A rig on RunPod adds `RunPod`, and its price per hour while its pod runs, such as `RunPod · $0.50/h`.

The buttons at the right:

- **Edit rig** opens the rig's settings and models.
- **Live** opens what the rig's agents and judge do now.
- **Export** opens a choice under **What to export**: **What changed** (what the rig recorded since its last export) or **Full export** (also a snapshot of the ledger, every run's research folder, finished or not, and the pages each run fetched). On a run's page, **This run** comes first and is chosen: the run alone ([A run's export](exports.md#a-runs-export)). Its **Export** button sends the signed `export_now` command with `full`, or `run`, as you chose, and a line at the top of the page says the export was asked for and that it shows on the **Exports** page when all its files reach control. The **Exports page** link in it, and **its exports on control** on the **Results** row of a rig that sends its exports to control, open the [Exports page](exports.md#download-an-export) for this rig.
- **⋯** has **Restart the rig's containers** (with a deployment driver only), **Full reset** (type `reset <rig>`) and **Retire it** (type `retire <rig>`). For a rig on RunPod it has only **Retire it**, and says that its pod's changes are on the page, under **The pod**. Retiring stops nothing: a pod that still exists keeps running and costing money, and the menu says to terminate it instead.

A button that needs typed words stays off until the words are typed exactly. Control checks them again when the form arrives.

The first lines under the title say, in a few sentences: for a RunPod rig, its pod and what it has cost; whether it reports; that it drains, and what for, such as `rig-1 drains: it starts nothing new, and waits for 2 trials to end.`; what runs on it; what its judge does; a check that failed; a key that waits for you; for a RunPod rig, a connection to its pod that failed.

When control can't read the rig's events now, the first lines say `Control can't read its events now.`, and a card under them says why in words, such as the event its view failed on. Until control can, the page shows no runs, checks or judge's jobs for the rig; the rest of it is from the rig's last report. This lasts until the rig's next full reset gives it a new ledger. Every other rig, and every other page, shows as before.

A card after an action says what happened: its words in green, or **Not done.** and the reason. A button that sends a command to the rig, such as **Export**, **Run it** or **Pause**, says at once that the click took, and the page follows the command to its outcome with no refresh: see [Signed commands](signed-commands.md#on-the-dashboard). After **Save changes** on **Edit rig**, the green line here goes on with how the settings' command stands, such as `rig-1 took it at 03:41 UTC. This page shows the change when the rig next reports.`

## The reporting banner

| State | Title | What it says | Buttons |
| --- | --- | --- | --- |
| Stale | `No report for 6 minutes.` | The stale and offline windows. A stale rig may still be at work: its runs go on, and what they did arrives with its next report. Then what control found when it last checked where the rig runs, or that it has not checked yet. For a rig control can't reach: check it there | **Check again**, **Restart the rig** |
| Offline | `Offline: no report for 3 h 12 min.` | When its last report came, in UTC, and how many lanes its runs had at work then; what control found when it last checked; that what it did since arrives with its next report | **Check again** (**Check the cluster** for a rig on a cluster), **Restart the rig**, **Retire it** |

**Check again** and **Restart the rig** show only where control can do them:

| The rig | Check again | Restart the rig |
| --- | --- | --- |
| Set up by control on a machine | Over SSH: whether its two services are active, its containers' states, and the supervisor's last 3 log lines | Restarts both services over SSH (the same as **Restart them** in **Set up by control**) |
| Set up by control on a cluster | **Check the cluster**: reads its two deployments from the cluster's API, and how many of their pods are ready | Restarts both deployments (the same as **Restart them**) |
| Launched on RunPod | None: **The pod** shows RunPod's status, read every 30 seconds | Stops the pod and starts it again |
| Joined yourself | None: control can't reach it | None |
| Any other, such as the compose stack | None | With a deployment driver only: restarts its containers |

Control also checks a rig it set up, on a machine or a cluster, by itself: once when the rig turns stale, and once more when it turns offline. **Check again** checks now. What a check found goes in the banner and in the history, for example `Both containers run: the harness is running (up 3 days), the supervisor is running (up 3 days). The supervisor's last log lines: control: connection refused`, or `cluster-1's API did not answer: …`. The supervisor's log lines are cut to 200 characters each, and tokens in them are hidden.

## The version banner

Control compares the rig's version with its own ([Rig versions](rest-api.md#rig-versions)). A rig that runs control's version, or sends no version, has no banner: the **Version** fact says it.

| State | Title | What it says | Buttons |
| --- | --- | --- | --- |
| Behind | `rig-1 runs Thermite 0.1.0. Control runs 0.2.0.` | They work together, so nothing stops. Update the rig when its runs allow. Then what the update does, or how to do it yourself | **Update to 0.2.0**, for a rig control can update |
| Ahead | `rig-1 runs Thermite 0.3.0, newer than control's 0.2.0.` | They work together. Update control when you can | None |
| Refused, older | `Control refuses this rig: its version is too old.` | Both versions and the reason. Control takes none of its reports and sends it no commands. What the page shows is from its last report that control took. How many of its calls control refused, and when the last came. How to fix it | **Update to 0.2.0**, for a rig control can update; **Retire it** |
| Refused, newer | `Control refuses this rig: its version is too new.` | The same, and to update control to the rig's version or later. The refusal then ends by itself | **Retire it** |
| Updated | `Updated. It runs Thermite 0.2.0, as control does.`, or `The last update stopped, but it runs Thermite 0.2.0, as control does.` | The steps of the last update | None |
| Update, version unknown | `The update to 0.2.0 is under way. Control does not know the rig's version.` (or `stopped`) | The notice, and the update's steps | None |

When the update can't come from control, the banner says how to do it:

- a rig set up by control whose place is gone or not ready: why, such as `The machine gpu-host-1 is no longer in Settings › Providers, so control can't reach it.`, or control's missing images or address;
- a rig on RunPod: `Control can't move a pod onto another image. To run 0.2.0, terminate this rig and launch a new one on control's image.`;
- any other rig: `Pull the 0.2.0 images where the rig runs, and start it again with them.`

### Update to control's version

**Update to** moves a rig control set up, on a machine or on a cluster, onto the images control deploys now: `THERMITE_RIG_HARNESS_IMAGE` (`THERMITE_RIG_HARNESS_CUDA_IMAGE` for a rig with GPUs) and `THERMITE_RIG_SUPERVISOR_IMAGE`. Control needs its address for rigs, `THERMITE_CONTROL_PUBLIC_URL`. One update runs on a rig at a time. The steps show in the banner as they happen, with the one under way. The page follows them by itself until the update ends: you do not need to refresh it.

| Step | What control does | Waits at most | When it can't |
| --- | --- | --- | --- |
| Update to control's version asked | Notes the versions, from and to, and who asked | | |
| Its runs paused at a safe point | Sends `pause_run` for each running run, with the reason `control updates the rig to <version>`, and waits until the rig takes them | 5 minutes | It goes on, and says so. A refused rig takes no command, and a rig that does not report can't take one: their runs are not paused |
| Its containers moved onto control's images | **On a machine:** over SSH, pulls both images while the rig still runs, writes its two container units again, and restarts both services. **On a cluster:** applies its two deployments again, as **Update to these images** does | 30 minutes over SSH | It stops here: the rig keeps the images it had, and its paused runs resume |
| A report reached control from control's version | Waits for a report in which both parts run control's version | 20 minutes | It stops here, with what the rig reports, and its paused runs resume |
| The isolation check after the update | Sends `rig_check` for the isolation check, and waits for its result | 30 minutes | It says why: it failed, the rig refused it (such as `not now: …`, while a judge job waits), or no result came |
| Its runs resumed | Sends `resume_run` for each run it paused | | |

The rig's volumes, tokens, key, ledger, runs and results stay. A trial in progress stops, and its experiment goes back to the top of the queue. On a machine the update writes only the two container units: the rig's secrets, keys, volumes and networks stay as they were. If a step fails, the banner shows **The update stopped**, and its steps say why. An update that a restart of control cut short ends when control starts again: its paused runs resume, and the step **The update stopped** says `control restarted while it was` and what it was doing.

## The drain card

A rig drains before its images change, or before control gives it a new number of GPUs, CPUs or memory: it starts no new trial, plan or judge job, and the work under way ends as it would ([`drain_rig`](signed-commands.md#drain_rig)). While its last report says it drains, a card comes after the banners:

- **The title:** how long it has drained and since when, such as `Draining for 5 h 24 min, since 04:10 UTC.`
- **Who asked, and why**, from what the rig recorded: `The owner asked for it over REST: its images are about to change.` The dashboard's buttons say `on the dashboard`, an operator's token `An operator asked for it over MCP`, and control's own ask after the rig's harness started again `Control asked for it again, after the rig's harness started again`. A harness older than goal 136 records no one: `It was asked for`.
- **What it waits for:** `It waits for 2 trials and the judge's job.` (`the judge's 2 jobs` while it builds two changes at once), or, once nothing runs, `Nothing runs any more: it is ready for what the drain is for.` A rig control set up on a cluster adds `Control restarts its pods once nothing runs.` A harness older than goal 136 says how many trials run but not which: `Its harness is too old to say which trials, or to stop one: update it.`
- **Trials stopped during the drain**, once they ended: `stopped lane-1's trial, stopped at 09:40 UTC: it ended as interrupted, with its counters, and its task went back to the top of the run's queue.` A stop the rig did not take says why.
- **Its deadline**, from a harness with goal 173: `Its deadline is 05:10 UTC, in 46 min. Then it stops waiting by itself and asks you: go ahead now, or end the drain.` A drain waits at most the minutes its command gives (`deadline_minutes`, such as an update's `drain_minutes`), else the rig's [`THERMITE_DRAIN_MINUTES`](settings.md#places-exports-and-the-broker), 60 by default.
- **End the drain** sends `drain_rig` with `drain: false` and the reason `the owner ended the drain`: the rig goes back to work on its images. On a rig control set up on a cluster, it is **Call the update off** (or **Call the change off**): the change the rig drains for does not happen. Whoever asked for the drain then moves the rig without one, or asks again.

### At its deadline

At its deadline the drain stops waiting by itself. The rig records the step (the event `rig_drain` with `deadline_reached`), and control adds `drain_deadline` to the rig's history: `its deadline passed after 60 min, with 1 trial and the judge's job still at work: it starts nothing new until you choose, under Needs you or on its page`. The rig still starts nothing new: nothing is chosen for you. The card says `Its deadline passed at 05:10 UTC. It still starts nothing new, and waits for your choice: nothing is chosen for you.`, and its two buttons take the place of **End the drain**. The same choice is a card under **Needs you**, `rig-1's drain passed its deadline`:

| Button | What it does |
| --- | --- |
| **Update it now** (a cluster rig that drains for new images) | Its pods restart now on control's images. A trial in progress stops and its task goes back to its run's queue; the judge's job under way is taken back at the next start |
| **Change its size now** (a cluster rig that drains for new GPUs, CPUs or memory) | Its pods restart now with the new size, stopping what still runs in the same way |
| **Stop what still runs** (any other rig) | Sends [`stop_trial`](signed-commands.md#stop_trial) for each trial the drain waits for: each ends as interrupted, and its task goes back to its run's queue. The judge's job under way ends as it would. The rig still drains, for the change you drained it for |
| **End the drain** | The rig goes back to work as it is. On a cluster rig the change is called off: ask for it again later |

Each choice is a step in the rig's history. Under **Needs you**, **Leave it** keeps the rig draining, and the trials go on. A drain whose work ends by itself, before or after its deadline, goes ahead as it would have.

## The disk card

A rig keeps free space on each place it writes to: its state, its scratch and its outbox ([`THERMITE_DISK_FLOOR_GIB`](settings.md#places-exports-and-the-broker), 5 GiB by default). When one has less, its next report says so, and a card comes after the banners: `Its disk is at its floor for 12 min, since 08:00 UTC.` It says which place, such as `its outbox has 3.1 GiB free`, and what it holds: no new trial, judge's job or export starts until there is room again, and the work under way ends as it would, so the judge's job in flight still writes its verdict. Then how to make room: exports wait in the outbox until they leave the rig, and the scratch holds the lanes' build caches. The rig goes back to work by itself once each place has 1 GiB more than its floor. The same card is under **Needs you**: `rig-1 holds new work: its disk is at its floor`.

### The trials it waits for

Under **At work**, each trial the drain waits for has a row under its lane's: `The drain waits for it · last did something 1m ago`, or `· nothing in Live from it yet`. Open it for:

| Fact | What it says |
| --- | --- |
| **Running for** | How long the trial has run, and since when: `7 h 33 min, since 02:10 UTC`. A trial has no time limit unless one is set |
| **Last did something** | Its newest tool call in **Live**, how long ago, and the harness's answer: `1m ago: fetch https://…/guide.pdf, answered: refused: larger than 5000000 bytes`, and `the model wrote since` when its newest line is the model's. Live keeps a trial's lines while control and the harness run |
| **Same request** | Only for a trial that asked again for a page the run refused before for a reason that lasts, such as its size ([Research](../explanation/campaign-modes.md#research)): how many times this trial asked, the page and why it was refused, how many times the run asked for it, and when it last did. The harness answers each such ask at once, with no download |
| **Work so far** | Its turns, tool calls and tokens in, as its worker last reported them, and, in a research run, the verified claims it recorded: `214 turns · 196 tool calls · 3.1M tokens in · 4 verified claims` |

A trial that asked again for a refused page has `repeats a refused request` beside its focus, and its row comes open: it may be stuck on that page. Nothing ends a trial for it: you decide.

**Stop this trial…** asks first: `Stop lane-1's trial now? It ends as interrupted. Its sources, claims and counters stay. Its task goes back to the top of the run's queue, so a lane takes it up again after the drain.`, then what the drain still waits for, such as `The drain then waits only for 1 trial.` **Stop the trial** sends [`stop_trial`](signed-commands.md#stop_trial). The row then says how the stop stands, such as `Stop sent at 09:40 UTC. Sent to rig-1 at 09:40 UTC. Waiting for the rig to take it.` and `rig-1 took your stop at 09:40 UTC: the trial ends as interrupted within seconds.` Once the trial has ended, the rig's next report no longer lists it, and the card says it was stopped.

## Blocks

A key that waits for you has a card under the banners, with its fingerprint and **Accept this key**: see [Accept a rig's key](../how-to/operate/accept-a-rig-key.md).

**At work** lists the runs at work now; a stuck trial's lane has a chip, `quiet for 4 h 24 min` or `repeats the same calls`, that leads to its card under **Needs you** ([Stuck trials](../how-to/campaigns/decide-what-waits.md#stuck-trials)); while the rig drains, each trial it waits for has its facts and **Stop this trial…** under its lane ([The trials it waits for](#the-trials-it-waits-for)). **Checks** lists the rig's three [checks](rig-checks.md), each with **Run it**, and its state: **not run yet**, **sent**, **running** with the time so far, **passed** or **failed**, or why the rig did not run it ([Where results show](rig-checks.md#where-results-show)); for a refused rig it says `Control sends no command to a refused rig, so its checks can't run. Update it first.` **Runs on this rig** lists every run; for a rig that does not report, or that control refuses, its heading says `as of its last report`. **The judge's last jobs** lists its last 8 jobs. A rig on RunPod has **Pod log** under it ([Pod log](#pod-log)).

**What it runs on** shows the rig's hardware, from its signed report. Its **Disk free** is each report's reading of the places the rig writes to, with its floor: `state 40.2 of 100 GiB · scratch 61.0 of 100 GiB · outbox 3.1 of 100 GiB · floor 5 GiB`. A harness older than goal 173 reports it only once, at its start.

**The rig** shows its facts:

| Fact | What it says |
| --- | --- |
| **Version** | The rig's version, and how it stands: `0.2.0 · as control`; `0.1.0 · control 0.2.0 · they work together`; `0.3.0 · newer than control's 0.2.0 · they work together`; the rig's version in red, `· control 0.2.0 can't work with it`; or `not reported · control 0.2.0`. When the harness and the supervisor differ, both: `harness 0.1.0, supervisor 0.2.0` |
| **Last report** | How long ago, and the time in UTC. For a refused rig, the last one control took |
| **Calls refused** | Only for a refused rig: how many of its calls control refused since the refusal began, and when the last came |
| **Placed on** | Where it runs: a machine over SSH, a cluster and namespace, a RunPod pod, or a place you set it up on yourself |
| **Key** | The fingerprint of its report key, or `not pinned` |
| **Ledger** | Its ledger's id |
| **Results**, **Models**, **Advisors** | From its supervisor's figures (unsigned) |

Then the block of how it was set up, if control set it up: **Set up by control** (a machine or a cluster), **You run it yourself** (joined), or **Pull mode** (RunPod).

**Recent** lists what happened, newest first: the rig's events, and the lines of its state:

- `Control refused the rig.` and the reason, and `Control refused a call from the rig (N calls since the refusal began; shown once).`;
- `Control runs 0.2.0, and this rig runs 0.1.0: they work together.`, at the later of control's update and the rig's report of its build;
- `Stale: no report for 3 minutes.` and `Offline: no report for 15 minutes.`, at the time each began;
- each check of where the rig runs, and each step of an update.

## The pod

A rig launched on RunPod has **The pod**, under the banners. Its heading has the pod's state at RunPod (**Running**, **Stopped**, **Terminated**, a change under way such as **stopping…**, or RunPod's own word), the cloud, the data center, the pod's id, and when control last read the pod.

| Fact | What it shows |
| --- | --- |
| **Cost now** | While the pod runs: its price per hour, from RunPod's price for it (the GPU's list price times its GPUs until RunPod gives one). While it is stopped: `storage only`. Once it is terminated: `none` |
| **Spent so far** | What it cost while it ran, since launch, as control counts it every 30 seconds. With a spend limit: `of $20.00 · about 38 h of work left`, and a bar. It leaves out what RunPod bills for a stopped pod's volume |
| **Spend limit** | The limit, or `none` |
| **Idle stop** | The minutes, or `never`. Under it: how long no run has been at work, `a run is at work`, or that it counts once the pod enrolls or while it runs |

**Change the spend limit or the idle stop** opens a form with **Spend limit (USD)** and **Stop when idle for (minutes)**. An empty field clears that limit. The idle stop is 5 minutes or more. A limit the pod has reached already stops it at control's next check, within 30 seconds, its results sent out first. The page then says, for example, `Saved. No spend limit. It stops after 30 minutes with no run at work.`

The idle stop counts the time no run is at work on the rig: no campaign runs, or every run is paused, blocked or finished ([When a rig is idle](rest-api.md#when-a-rig-is-idle)). Starting or resuming a run on the stopped pod starts it again.

### Start, stop and end it

Five boxes, each with what it does and its button. A box that does not apply now is grey, says why, and its button is off.

| Box | Button | Applies when | Typed words |
| --- | --- | --- | --- |
| **Stop** | **Stop the pod** | The pod runs, and no change or full reset is under way | |
| **Start** | **Start the pod** | The pod is stopped, and no change or full reset is under way | |
| **Restart** | **Restart the pod** | The pod runs, and no change or full reset is under way | |
| **Full reset** | **Start the full reset** | The pod runs, and no change or full reset is under way | `reset <rig>` |
| **Terminate** | **Terminate** | No change or full reset is under way | `terminate <rig>` |

After a button, the page says what began: `Stopping: its runs are paused and its results go out first, then the pod stops.`, `Starting: RunPod starts the pod, and its paused runs resume once it runs.`, `Restarting: the pod stops, then starts again.`, or `Terminating: its runs are paused, and the pod is removed only once every result has left it.` A refusal shows **Not done.** with RunPod's or control's reason, such as `RunPod has no free GPU for pod … now, so the pod stays stopped (…)`. The full reset goes on as for any rig: [Fully reset a rig](../how-to/operate/rig-lifecycle.md#fully-reset-a-rig).

While a change is under way, a card shows it in words, such as `stopping: waiting for its export`, who asked and when, and its steps: done, under way, and still to come.

| Change | Its steps |
| --- | --- |
| Stop | Pause the runs at a safe point. Send the waiting results out of the pod. Wait until they have left the pod (15 minutes at most). Ask RunPod to stop the pod |
| Start | Ask RunPod to start the pod. Wait for the pod to run. Resume the runs the stop paused |
| Restart | Ask RunPod to stop the pod. Wait for the pod to stop. Ask RunPod to start it again, and wait for it to run. The harness starts again: a trial that was in progress is planned again. A restart pauses no run |
| Terminate | Pause the runs at a safe point. Wait until no judge job and no command waits on the rig (1 hour at most). Make a full export (30 minutes at most). Wait until every result has left the pod (1 hour at most). Ask RunPod to delete the pod and its volume |

What went wrong last shows in red under them. An error from control's last read of the pod goes at its next good read. A refused terminate, `Not terminated: …`, stays until you stop, start, restart or terminate the pod, or until a newer step in its history, such as a full reset.

### Results in the pod

What must leave the pod before it ends, from the rig's supervisor's last report:

| Row | What it says |
| --- | --- |
| Exports waiting to leave the pod | How many exports wait, and where they go: control, or the results repository |
| Champions' patches waiting to reach control | How many wait |
| The last export | The export the change under way or the last stop made: out, on its way, or can't leave, with why |

Its heading says `N waiting`, `all out`, or `not reported`.

### History

A rig on RunPod has **History** in place of **Recent**, with filters: **All**, **The pod**, **Runs** and **The judge**. **The pod** lists its launch, each stop, start, restart and terminate, and each full reset, with what happened, such as `Pod stopped: its GPU is no longer billed, and its volume stays: …`. **Runs** and **The judge** list the rig's events.

### Pod log

**Pod log** shows the pod's log as RunPod keeps it: what the rig image printed and RunPod's own steps. Before the rig enrolls, it is the one place that says why a pod runs but never enrolls. Control reads it from RunPod's API (`GET /v2/pods/<pod>/logs`) with the GPU cloud's key from **Settings › Providers**. A read asks for the newest 200 lines and stops once they came, once no line came for 2 seconds, or after 10 seconds.

| Part | What it shows |
| --- | --- |
| The lines | Oldest first, the newest at the bottom, in a box that opens scrolled to the newest. Each line has its source, `container` (what the rig image printed) or `system` (RunPod's own, such as the image pull), and its time in UTC; the full time shows when you point at it |
| Under them | `Read 2m ago, at 14:05 UTC: 57 lines, container and system, oldest first.` A read over MCP or REST for one source only says `system lines only` or `container lines only` |
| **Read the log** or **Read again** | Reads the log now. The button says `Reading…` until the lines come, and the block is drawn again with them, with no refresh |
| A refusal | `Not read:` and why, in red, such as `RunPod refused to show pod …'s log with this key: the key may not read pod logs. A key with read access to pods can` |
| Nothing read | `Not read yet.`, or `Not read yet. Reading it…` while the page reads it by itself |
| An empty log | `RunPod has no line in this pod's log yet.` |

Loading the page never reads RunPod: a read holds RunPod's stream open for up to 10 seconds, and the page's script loads the page again every few seconds while it follows a button. Control keeps each rig's last read in memory until it restarts, and a read over REST or MCP shows here too. Before the rig's first report, when control has no read of the log yet, the page's script presses **Read the log** once the page has opened; after the first report, the block waits for you to press it. After the first report, **Pod log** is in the left column, below **The judge's last jobs**.

Before control shows a line, it takes out what looks like a credential: a URL's user and password, a bearer token, keys with a known prefix, such as `hf_`, `ghp_` or `rpa_`, which become `hf_***`, a query string's or a header's token or key (`access_token=***`, `x-api-key: ***`), and the value of a `THERMITE_` or `RUNPOD_` variable whose name ends in `KEY`, `CODE`, `TOKEN`, `SECRET` or `PREFIX`, such as `THERMITE_STATE_SNAPSHOT_KEY=***`. It also takes out a terminal's colour codes, and cuts a line at 2,000 characters. A pod that is terminated has no **Pod log**: RunPod no longer has it.

### Before its first report, and after its end

Before the rig's first report, its page shows **Getting it ready**: the launch, the pod pulling the image and running, control enrolling it with its one-time code, and the rig's first report, each done, under way or still to come. Then **Pod log**, **The pod**, its history and **Pull mode**.

Once the pod is terminated, the rig is retired. Its page says so, with **Bring it back**, and shows what the pod cost in all, its facts and its history.
