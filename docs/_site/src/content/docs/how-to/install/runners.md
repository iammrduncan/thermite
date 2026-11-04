---
title: "Give a rig runners on other machines"
description: "Run a rig's builds, measurements and lanes' runs on GPUs of other machines, added and taken away while a run goes on."
type: how-to
sidebar:
  order: 6
---

A [rig](../../reference/glossary.md) is a core and its runners. The core keeps the run: its records, the planner, every lane's agent program and the judge's decisions. A runner is where work runs: one GPU, or a machine's CPUs. A rig of one machine is a core that is also its own runner. This page gives a rig runners on other machines, so that the core can stay on a machine without a GPU and every GPU does GPU work only.

The core asks each runner for its runs through control's message bus, as every rig already reports, so a runner can be anywhere control's bus reaches. A runner keeps no run of its own: the core sends it the commits it lacks, and its supervisor fetches a run's model files from their source.

## The pools

Each runner is in one pool. A runner takes one run at a time, so a measurement never shares its GPU with another run.

| Pool | Who runs there |
| --- | --- |
| `judge` | The judge alone: its builds and measurements |
| `shared` | The judge and every lane, in turn, first come, first served |
| `lane-1` to `lane-16` | That lane alone: its `run_experiment`. The judge never measures there |

A lane runs on its own runner first, then on a shared one; a lane that no runner serves runs on the core's machine. What a lane runs never counts: only the judge's measurement does.

## 1. Start a runner process

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

## 2. Add it to the rig

1. On the rig's page, press **Edit rig**.
2. Under **4 · Where it runs**, in **Runners**, write the runner process's name in **Add a runner you started yourself**, and in **Its runners' pools** one pool for each runner it serves, in order, separated by commas, such as `judge, shared`.
3. Press **Save changes**.

The rig's core takes the change at once, while its run goes on. The runner takes runs once it answers the core's check, within about 15 seconds. A script or an agent does the same with `runners` in [`POST /v1/rigs/<rig>/settings`](../../reference/rest-api.md#a-rigs-settings), or MCP's [`set_rig_settings`](../../reference/mcp-tools.md#set_rig_settings) with the owner's token: the whole list of the rig's runner processes, each `{name, pools}`.

A runner that answers but can't take the rig's runs says why on the rig's page: it measures on another kind of target than the rig's other runners, or it serves fewer runners than it is given pools.

## Change a pool, or take a runner away

On **Edit rig**, under **4 · Where it runs**, each runner process has a pool for each of its runners, and **Take it away**. Save the change: the rig's core takes it at once, and nothing pauses.

- A runner taken away, or given another pool, stops its run under way: the judge queues its job again, with no verdict, and a lane is told to run its command again.
- A runner that stops answering, two checks in a row, is away: the same happens to its run under way, and it takes runs again once it answers.
- A run waits while no runner of its pool is free.

## A core on a machine without a GPU

With `THERMITE_LOCAL_JUDGE=0` on the core's harness, and runners when it starts, the judge measures only on the runners. The rig then measures on its runners' kind of target, which a campaign's kit must measure on; its runners must all be of one kind. Without it, the judge measures on the core's machine too, and its runners must be of the core's kind.

## See them work

The rig's page has a **Runners** block ([The rig's page](../../reference/rig-page.md#blocks)): each runner, its pool, whether it answers, and what it runs now; then who waits for a runner.
