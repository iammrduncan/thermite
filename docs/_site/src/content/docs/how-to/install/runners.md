---
title: "Give a rig runners on other machines"
description: "Run a rig's builds, measurements and lanes' runs on GPUs of other machines, added and taken away while a run goes on."
type: how-to
sidebar:
  order: 6
---

A [rig](../../reference/glossary.md) is a core and its runners. The core keeps the run: its records, the planner, every lane's agent program and the judge's decisions. A runner is where work runs: one GPU, or a machine's CPUs. A rig of one machine is a core that is also its own runner. This page gives a rig runners on other machines, so that the core can stay on a machine without a GPU and every GPU does GPU work only.

The core asks each runner for its runs through control's message bus, as every rig already reports, so a runner can be anywhere control's bus reaches. A runner keeps no run of its own: the core sends it the commits it lacks, and its supervisor fetches a run's model files from their source the first time the judge or a lane needs them there, and keeps each once ([Model files on a rig](../../reference/model-files.md#on-a-rigs-runners)).

## The pools

Each runner is in one pool. A runner takes one run at a time, so a measurement never shares its GPU with another run.

| Pool | Who runs there |
| --- | --- |
| `judge` | The judge alone: its builds and measurements |
| `shared` | The judge and every lane, in turn, first come, first served |
| `lane-1` to `lane-16` | That lane alone: its `run_experiment`. The judge never measures there |

A lane runs on its own runner first, then on a shared one; a lane that no runner serves runs on the core's machine. What a lane runs never counts: only the judge's measurement does. On a runner, each `run_experiment` starts on a fresh copy of the lane's starting point with its change applied, its files the agent made and never staged too: what an earlier run built there is not kept, and the answer says so: `It ran on a fresh copy of your starting point with your change applied: what an earlier run built there is not kept, so build and run in the same command`. Reading the change leaves the lane's own git index as the agent left it, so a submission carries only its editable paths.

## When you add the rig

**Rigs › Add a rig** is a wizard. Under **What kind of rig?**, choose **Several machines** and press **Next**; then, a step at a time:

1. **The core** (**Where does the core run?**): where the core goes, any machine or free slot control knows, with the core's CPUs, memory and disk, filled in from the slot's quota, and on a cluster its **Node**. It needs no GPU.
2. **Runners** (**Which GPUs are its runners?**): none at first. **+ Add a runner** adds a row: choose its **Machine** (a machine over SSH, a node of a cluster, or a slot whose GPUs come through DRA), then its **GPU**, one of the machine's free ones, then **Its pool**: **The judge's**, **Shared: the judge and the lanes**, or a lane's. The first row is the judge's, the next ones shared, until you change them; a GPU another row took is not offered again, and **Remove** takes a row away. A runner on a GPU of a DRA class whose node control read from the cluster goes on that node. **Workers at a time** sets how many lanes work at once, 2 by default.
3. **Name and create** (**Name it and create it**): the rig's name, and the images: the core's, and the runners' CUDA image for their GPUs.

On the last step, **What this rig will be** says where the core runs, where the judge measures and where each lane tries its changes, and notes what would go wrong:

| Note | Create the rig |
| --- | --- |
| "Give the judge a runner, its own or a shared one: the core has no GPU to measure on." | Off |
| "The runners are of two kinds, …: a rig measures on one kind of target, so its verdicts compare. Use one kind, or make a rig for each." | Off |
| A runner that is a lane's beyond **Workers at a time**: "… it would stay idle." | On |
| The core and a runner on one machine, or in one slot: the judge's timings can be noisier | On |

The core's place is chosen first among those without a GPU, since the core needs none. **Next** stays off on a step until it is filled in, and on **Runners** while a note keeps **Create the rig** off.

Press **Create the rig**: control sets the core up, then each runner, named for its machine or node, such as `gpu-node-1`, or for its GPU, such as `gb10-1`, where control can't tell the node. The rig takes them, and its **Workers at a time**, once it reports: control keeps them until then, through a restart of its own, and gives them within a minute of the rig's first report. A core with no GPU of its own, given a runner of the judge's or a shared one, judges on its runners alone (`THERMITE_LOCAL_JUDGE=0`); MCP's `add_cluster_rig` takes `judge_on_runners` for the same. With no runner chosen, the core measures on its own CPUs, as a CPU rig.

## On a cluster or a machine control knows

On the rig's page, press **Edit rig**. Under **4 · Where it runs**, **Add a runner** lists each free GPU of the machines and clusters control knows, as Add a rig's **2 · Runners** does, such as `gpu-node-1 · NVIDIA GB10 · DRA class gb10-gpus · a node of cluster-1 · slot thermite-slot-2`, with a slot that holds this rig's core or runners among them. Choose one and **Its pool**, then press **Add**: the GPU joins the list of runners, marked **new**, with its pool, which you can still change, and **Remove**. Add more the same way, then press **Save changes**. A lane's pool is offered up to the rig's **Workers at a time**: raise it first for a runner of a new lane. **Volume, in GB** sets the volume of each runner added on a cluster on that save, for its builds and a run's [model files](../../reference/model-files.md#on-a-rigs-runners), 100 when left empty. A volume can't grow later: for a bigger one, remove the runner, press **Save changes**, then add it again with the size. A GPU of a node that joined the cluster after control last checked it is offered once control checks the cluster again: **Settings › Machines**, the cluster, **Check**.

On **Save changes**, control sets each one's harness and supervisor up on the node, or as Quadlet units on the machine, named for the runner, started as a runner, with volumes and a token of their own, then gives it to the rig: at once if the rig reports, or within a minute of the rig's first report, such as a rig whose core is set up after its runners. The rig's **History** says each step, and the runner takes runs once it answers the rig's core. A script or an agent does the same on a cluster with [`POST /v1/rigs/<rig>/runners`](../../reference/rest-api.md#a-rigs-runners-on-clusters), or MCP's `add_cluster_runner`, with the owner's token; on a machine, as a rig there, from the dashboard only. A GPU of a machine that a rig or another runner uses is refused.

When the rig moves onto control's newer images, its runners move with it; when the rig is removed, so are they.

## 1. Start a runner process yourself

A runner process is the harness image and the supervisor image, started as a runner. Each GPU it gives the harness is one runner, in order. Start them as for a rig you set up yourself, with these settings ([Settings](../../reference/settings.md)):

| Container | Setting | Value |
| --- | --- | --- |
| Both | `THERMITE_ROLE` | `runner` |
| Both | `THERMITE_RIG_ID` | The rig's name |
| Supervisor | `THERMITE_RUNNER` | The runner process's name in the rig, such as `box-2`: 2 to 40 lowercase letters, digits and dashes |
| Supervisor | `CONTROL_URL` and `THERMITE_CONTROL_TOKEN_FILE` | Control's address, and the rig's token, with which the supervisor registers the runner's key on the bus |
| Supervisor | `THERMITE_NATS_URL` and `THERMITE_NATS_CA_FILE` | The message bus, as for the rig's own supervisor |
| Harness | `THERMITE_TARGET` and its GPUs | As for any rig: `cuda-gpu` with the GPUs it serves, or `cpu` |

The runner's supervisor registers its key with control, then answers the core's asks on its own subject of the bus. Its harness listens only to its supervisor.

## 2. Add the one you started to the rig

1. On the rig's page, press **Edit rig**.
2. Under **4 · Where it runs**, open **A runner process you started yourself**, write the runner process's name in **Its name**, and in **Its runners' pools** one pool for each runner it serves, in order, separated by commas, such as `judge, shared`.
3. Press **Save changes**.

The rig's core takes the change at once, while its run goes on. The runner takes runs once it answers the core's check, within about 15 seconds. A script or an agent does the same with `runners` in [`POST /v1/rigs/<rig>/settings`](../../reference/rest-api.md#a-rigs-settings), or MCP's [`set_rig_settings`](../../reference/mcp-tools.md#set_rig_settings) with the owner's token: the whole list of the rig's runner processes, each `{name, pools}`.

A runner that answers but can't take the rig's runs says why on the rig's page: it measures on another kind of target than the rig's other runners, or it serves fewer runners than it is given pools.

## Change a pool, or take a runner away

On **Edit rig**, under **4 · Where it runs**, each runner is a row: its name, where it is, whether it answers, its GPU, its pool, what it runs now, and **Remove**. **Remove** marks the runner to leave when you press **Save changes**, and its row then says what happens to the run there, such as "Leaves when you save: the judge's job goes back to the judge's queue and starts again on another of its runners. No verdict is lost and nothing counts against the change."; **Keep it** undoes it. The form's own **Save changes** and **Cancel** decide: nothing asks again in the row. A new pool says "Moves to the shared pool when you save". The notes below the list say what would go wrong: no runner left for the judge of a core that judges on its runners alone, or a new runner of another kind of GPU than the rig's. **What changes when you save** lists each change. Press **Save changes**: the rig's core takes it at once, and nothing pauses.

- A runner taken away, or given another pool, stops its run under way: the judge queues its job again, with no verdict, and a lane is told to run its command again.
- A runner control set up: what it set up on the cluster goes too, and its token stops working. MCP's `remove_runner` and `DELETE /v1/rigs/<rig>/runners/<runner>` do the same.
- A runner that stops answering, two checks in a row, is away: the same happens to its run under way, and it takes runs again once it answers.
- A run waits while no runner of its pool is free.

## A core on a machine without a GPU

With `THERMITE_LOCAL_JUDGE=0` on the core's harness, the judge measures only on the runners, and its jobs wait until one of the judge's or the shared pool answers. The rig then measures on its runners' kind of target, which a campaign's kit must measure on, and reports it to control as its target, so **Start a run** and the **New campaign** page offer the rig to a kit of that kind; its runners must all be of one kind. Without it, the judge measures on the core's machine too, and its runners must be of the core's kind.

## See them work

The rig's page has a **Runners** block ([The rig's page](../../reference/rig-page.md#blocks)): each runner, its pool, whether it answers, and what it runs now; then who waits for a runner.
