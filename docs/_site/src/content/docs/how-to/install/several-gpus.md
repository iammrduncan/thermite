---
title: "Give a rig several GPUs"
description: "Split a rig's GPUs between the judge and the agents, so neither waits for the other."
type: how-to
sidebar:
  order: 5
---

A [rig](../../reference/glossary.md) with one GPU shares it: while the judge measures, the agents' own test runs wait, so the judge's timings stay clean. With two or more GPUs, some are the judge's and the rest the agents', and neither waits for the other. This page shows every place the split is set. [Sharing a device](../../explanation/sharing-a-device.md) explains how to choose it.

## The rules

| GPUs on the rig | What happens |
| --- | --- |
| 0 | The rig measures on its CPUs |
| 1 | The judge and the agents share it |
| 2 to 16 | The first ones are the judge's, the rest the agents'. The judge takes 1 to 8, and the agents at most 8. Default: half for the judge, rounded up |

- More judge GPUs check more changes at once. More agent GPUs let more lanes test at once.
- The judge's GPUs must all be the same model. With different models, only the first one judges, and the rig's hardware report says so. Put different models in separate rigs.
- Only NVIDIA GPUs are supported.

## When you add the rig

**Rigs › Add a rig**, under **2 · GPUs and resources**:

| Where the rig goes | Choose the GPUs | Choose the judge's share |
| --- | --- | --- |
| A machine over SSH ([guide](rig-on-a-machine.md)) | Tick each GPU. The lowest-numbered are the judge's | **GPUs for the judge** |
| A Kubernetes cluster ([guide](rig-on-a-cluster.md)) | **GPUs**: how many the harness pod asks for, and **GPUs through** | **GPUs for the judge** |
| A machine you join yourself ([guide](join-a-rig.md)) | **GPUs on the machine**: their numbers as `nvidia-smi` lists them, such as `0,1,2,3` | **GPUs for the judge** |
| A namespace you join yourself | **GPUs**: up to 8 | **GPUs for the judge** |

Leave **GPUs for the judge** empty for half. The note under the fields says what you chose, for example "Judge: GPU 0, 1. Agents' test runs: GPU 2, 3. They never wait for each other." A share control would refuse, such as 10 of 12 GPUs, shows control's refusal there instead: "With 12 GPUs the judge takes 1 to 8 of them, and the agents at most 8." A GPU named twice is refused with "Name each GPU once."

On a machine, a GPU that another rig control set up there already uses shows "used by rig …" and can't be ticked.

The local stack's rig is not added there: it gets every NVIDIA GPU of its machine, up to 16, from `compose.gpu.yaml`, which `thermite local init` writes. With 2 to 9 GPUs the judge gets 1 and the agents the rest; with 10 or more, the agents get 8 and the judge the rest ([Use the machine's NVIDIA GPUs](one-machine.md#use-the-machines-nvidia-gpus)). Change the split as below.

## Change the split later

Once a rig has its GPU set, these places change the judge's share. When the share changes, the rig's harness restarts to regroup the GPUs, so running trials and judge jobs start again.

- **Edit rig**: on the rig's page press **Edit rig**, then under **4 · Where it runs** set **GPUs for the judge**. It says "Now: 2 for the judge, 2 for the agents." The box **What changes when you save** lists the restart. Press **Save changes**.
- **Edit rig from a script or an agent**: `judge_gpus` in `POST /v1/rigs/<rig>/settings`, or the owner's MCP `set_rig_settings` ([A rig's settings](../../reference/rest-api.md#a-rigs-settings)). `GET` on the same address, or MCP's `rig_settings`, reads the split now as `gpu_split`. An operator's `set_rig_settings` can't change it.
- **New campaign**: under **Where it runs** › **Advanced**, **GPUs for the judge**.
- **A campaign's page**: press **Start a run** at the top. The panel has **GPUs for the judge** under **More options**.
- **From a script or an agent**: `--judge-gpus` on `thermite run start`, `judge_gpus` in `POST /v1/campaigns/<campaign>/runs`, or the owner's MCP `start_run` ([Start a run from a script or an agent](../campaigns/start-from-dashboard.md#start-a-run-from-a-script-or-an-agent)). An operator's `start_run` can't change it.

:::caution[A campaign changes the whole rig]
The last three change the rig's split for every run on it, not just the new one, and the restart ends the trials and judge jobs of the other runs there too; they start again. Leave **GPUs for the judge** empty to keep the rig's current split.
:::

A rig without a GPU set of two or more has no such field on Edit rig. From a campaign it says "rig-1 has no GPU set to split: its GPUs are set where it is deployed."

## Change the number of GPUs later

A rig that control set up on a Kubernetes cluster can take more GPUs, or fewer, and keep its volume, tokens, runs and results:

- **Edit rig**: under **4 · Where it runs**, set **GPUs** (1 to 16), and, for a rig with two or more GPUs, **GPUs for the judge**, which is then the judge's share of the new GPUs. **What changes when you save** says the new split, such as "The judge gets 2 of the 4 GPUs, the agents 2.", and that the rig's pods restart. Press **Save changes**.
- **From a script or an agent**: `gpus` in `POST /v1/rigs/<rig>/cluster/resources`, or MCP's `set_cluster_rig_resources`, with `judge_gpus` for the judge's share ([A cluster rig's GPUs, CPUs and memory](../../reference/rest-api.md#a-cluster-rigs-gpus-cpus-and-memory)). An operator's token may change `gpus`, but not `judge_gpus`.

With a new number of GPUs and no share given, the judge gets half, rounded up, as when the rig was added, and a share the rig kept from **Edit rig** follows it. The rig's pods restart with the new GPUs; a rig at work drains first, as for new images. In a slot, the slot's quota must allow them (`requests.nvidia.com/gpu`, or the devices of its DRA class). A rig on GPUs keeps at least one, and a rig on the CPU takes none: add a new rig for that. The steps, the drain and what stays are in [Change the rig's GPUs, CPUs and memory](rig-on-a-cluster.md#change-the-rigs-gpus-cpus-and-memory).

A rig on a machine, joined, or on RunPod keeps the GPUs it was set up with: add a new rig with the GPUs you want ([goal 104](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/104-change-a-cloud-rigs-gpu.goal) plans it for RunPod).

## The settings behind the split

Control writes these settings on the harness of each rig it sets up, and `thermite local init` writes them in `compose.gpu.yaml` for the local stack's rig. They are here for reference: no guide covers running a GPU harness by other means. Such a harness would need them set on its container:

| Setting | Value |
| --- | --- |
| `THERMITE_TARGET` | `cuda-gpu` |
| `THERMITE_GPUS` | The rig's GPU set, as the container numbers them: `0,1,2,3` |
| `THERMITE_JUDGE_GPUS` | The judge's share of the set: `2`. Default: half, rounded up |

With `THERMITE_GPUS`, Edit rig and campaigns can change the share later; their choice comes before `THERMITE_JUDGE_GPUS`.

Instead, the cards can be named outright: `THERMITE_GPU_INDEX` for the judge (`0,1`) and `THERMITE_DEV_GPU_INDEX` for the agents (`2,3`). These lists come before `THERMITE_GPUS`, and then the split can't be changed from the dashboard. A card may not be in both lists, and every card the container sees must be in one of them.

`THERMITE_RUN_CPUS` sets the CPUs timed runs are pinned to: `auto` (the default on a GPU rig: the CPUs close to each judge card), `off`, or a CPU list.


## Check the split

- On the rig's page, **What it runs on** shows the **Judge** and **Dev runs** GPUs. With a shared GPU, **Dev runs** says "share the judge's device, and wait for it".
- Open **Every detail** at the foot of the **What it runs on** block: its table lists each device with **Used by**: Judge, Dev runs, or Judge + dev runs.
- The **Isolation** check's result names the layout, for example `devices: dedicated: judge …, development …`. Run it after a change ([Check a rig](../operate/check-a-rig.md)).
