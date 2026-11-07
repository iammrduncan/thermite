---
title: "A rig over several machines"
description: "What runs on a rig's core and what on its runners, how they stay in touch, what a restart or a new image does to the work under way, and how to size each machine."
type: explanation
sidebar:
  order: 6
---

A rig is a **core** and its **runners**. A rig on one machine is a core that is also its own runner: everything below happens on one machine, and you can skip this page. A rig over several machines keeps the run on the core and does the heavy work on runners: GPUs, or a machine's CPUs, on other machines. This page explains how the two share the work, so that you can plan the machines and know what to expect while a run goes on. [Give a rig runners on other machines](../how-to/install/runners.md) has the steps.

## What runs where

The core is where the run lives. The runners are where builds and measurements happen.

| | On the core | On a runner |
| --- | --- | --- |
| **The run's record** | The ledger: every trial, attempt, verdict and champion, and the run's git | Nothing kept: each run there starts from what the core sends it |
| **The agents** | Every lane's agent program, the planner, and the supervisor with its advisors (teachers, auditor, review panel) | No agent ever runs here |
| **A lane's commands** | Its shell and its tools, in its own workspace, under the lane's limits: 2,048 MiB of memory for everything the lane runs at once, its agent program included, unless the contract sets more | Only its `run_experiment`, on the lane's own runner, the lanes' or a shared one |
| **The judge** | Its decisions: what to measure next, and the verdict from the measurements | Its builds and measurements, one job at a time |
| **The run's model files** | None, when the core judges on its runners alone (`THERMITE_LOCAL_JUDGE=0`) | One copy on each runner that needs them, fetched by the runner itself |
| **A GPU** | Not needed | One per runner, in one pool: the judge's, shared, the lanes', or one lane's |

So the core needs CPUs and memory for the agents, and disk for the ledger and the lanes' workspaces. Each runner needs its GPU, memory for the engine it builds and serves, and disk for the model and the builds.

## A lane's work on its runner

A lane's agent works in its workspace on the core: it reads code, edits files and runs short commands there. To build and run its change on real hardware, it calls `run_experiment`. The core reads the change from the lane's workspace and sends it to a runner of the lane's pool, the lane's own first, then one of the lanes' pool, which every lane uses and the judge never does, then a shared one, with the commit it starts from. The runner applies the change to a fresh copy of that commit and runs the command. Nothing an earlier run built there is kept, so a command that needs a build builds and runs in one go. What a lane runs never counts: only the judge's measurement does.

On its runner, a lane's run has the runner's memory, not the core's:

- **Memory.** A development run gets 4,096 MiB on the core. On the lane's own runner or one of the lanes' pool, when neither the contract nor the owner set `dev_run_rss_mib`, it gets the memory the runner may use, less the larger of 4 GiB and a tenth: on a runner whose container is limited to 108 GiB, about 97 GiB. The runner reads that limit from its container, not from the machine, so the run's own limit stops it, with a reason, before the container's would kill a process. Each run's answer gives the limit it had, `memory_limit_mib`, and the lanes' brief says so. A shared runner, which the judge uses too, keeps the default, so a lane's run never takes the memory a measurement needs ([Limits and pacing](../reference/limits-and-pacing.md#lanes-and-agents)).
- **Disk.** The workspace on the runner is counted against `workspace_mib` a step at a time, so a tree of many files never stalls the count, and no number of files ends a run.
- **The model files.** Each runner of a lane's pool, the lanes' or the shared one begins fetching the run's model files once the run is under way, so a lane's first `run_experiment` usually finds them there. While they are still on their way, it is told how the whole fetch stands, such as `12 of 33 files, 40.3 of 95.2 GiB`, and runs once they have arrived ([Model files on a rig](../reference/model-files.md#on-a-rigs-runners)).

## The judge's work on its runners

The judge decides on the core and measures on the runners of its pool, or the shared one, never on a lane's or the lanes'. Each measurement is one job, on one runner, from start to finish: the core sends the runner the kit's commit and the change, and the runner's own copy of the model files, which it fetches before its first build of the run. A runner takes one run at a time, so a measurement never shares its GPU with a lane's run or another measurement. Runners must all be of one kind of GPU, so that the run's verdicts compare.

A change that screens as a win is measured again, on fresh runs, before it becomes the champion. That second job queues behind the first and may wait while the judge works on other changes. The run's page shows each job, its runner and what waits ([The rig's page](../reference/rig-page.md#blocks)).

## How the core and its runners stay in touch

The core and its runners talk through control's message bus, as every rig reports to control. A runner can therefore be anywhere the bus reaches, and needs no address of its own. Every 15 seconds the core checks each runner. A runner that misses two checks in a row counts as away:

- the judge's job under way there goes back to the judge's queue, with no verdict, and starts again on a runner that answers;
- a lane's `run_experiment` under way there fails, and the lane is told to run it again;
- the runner takes runs again as soon as it answers.

No verdict is lost and nothing counts against a change, but the work under way is done again.

**Control's own restart drops the bus for a moment,** often for about half a minute. A runner counts as away only when two of the core's checks in a row fail, 15 seconds apart, so a drop of about 30 seconds may ride through or may not, depending on where the checks fall, and a longer one is likelier to count every runner as away. To restart control without losing work, choose a moment when no runner has a run under way:

1. On the rig's **Edit rig**, turn the **Judge** off. The job it is on finishes and records its verdict; no new job starts.
2. Wait until that job's verdict is in. Lanes that wait for the judge's verdicts start nothing new meanwhile, unless the run keeps working while the judge works.
3. Restart control, then turn the **Judge** on again.

## When the rig moves onto new images

A rig's runners move with it: **Update to these images** on the rig's page, or MCP's `update_rig_images`, updates the core and every runner. By default it drains first: no new trial, plan or judge's job starts, and the update waits until the trials and the job under way end, at most the drain's limit (60 minutes unless set), before it asks you under **Needs you** ([Move a rig onto new images](../how-to/operate/rig-lifecycle.md#move-a-rig-onto-new-images), [The drain card](../reference/rig-page.md#the-drain-card)). A trial cut short by an update without a drain goes back to the top of the run's queue, the same experiment, not a copy.

## Sizing the machines

- **The core.** For each lane at work at once, the 2,048 MiB its agent program and commands may use on the core (or the contract's `run_rss_mib`), plus the harness, and the supervisor: 4 GiB while the rig's agent programs run in their own terminals, 2 GiB headless. On a cluster, at least 1.5 CPUs and 8 GiB. Disk for the ledger, the run's git and each lane's workspace.
- **A runner's memory.** What the engine needs to build and serve the model, on the runner's container: set it with the runner's **Memory, in GiB** when you add it on a cluster. A lane's development runs there get it, less the margin above; a GPU whose memory is the machine's, such as a DGX Spark's, shares it with the engine's host memory.
- **A runner's volume.** The model's files, the engine's builds and their caches. It can't grow later: on a cluster, set **Volume, in GB** when you add the runner, such as 200 GB for a model of about 95 GiB.
- **Where the core runs.** On a machine without a GPU, or on one of the runners' machines. The core and a runner on one machine share its CPUs and memory, which can make the judge's timings noisier: the rig's page notes it when you add the rig.

## Common mix-ups

- **"The lane built it, so the judge will too."** A lane's builds on its runner are not kept, and the judge builds the change again on its own runner, from the commit. What a lane learns is in its notes and its change, never in a runner's files.
- **"The core needs a GPU."** It doesn't. A core with no GPU judges on its runners alone.
- **"A lane's shell has the runner's memory."** Only its `run_experiment` does. Its other commands run on the core, under the lane's limits there.
- **"A runner that drops off loses the run."** It loses only the run under way there, which is done again. The core keeps everything.
