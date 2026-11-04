---
title: "Cluster and job scheduling"
description: "Use Thermite to improve a cluster's placement rule or a factory's sequencing heuristic, scored by replaying your own traces or orders and checked on later weeks the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [enterprises, startups]
  summary: "Agents change the placement or sequencing rule. The judge replays your traces through a simulator, checks every placement itself, and scores stranded capacity or makespan."
  measure: "Stranded CPU and memory, or makespan · every job placed, no machine over · later weeks of your own traces"
sidebar:
  order: 1
---

A cluster scheduler decides which machine runs each job. In Kubernetes, kube-scheduler filters out the nodes that can't fit a pod's requests or constraints, then ranks the rest with scoring plugins: `NodeResourcesFit`'s default `LeastAllocated` strategy spreads pods, `MostAllocated` packs them, and a platform team weighs CPU, memory and GPUs by hand. HPC centres tune Slurm's job priorities and its backfill scheduler, which starts lower-priority jobs early when that won't delay the expected start of any job ahead of them. The largest fleets write their own. On a factory floor, a planner sequences orders through a line of machines that every job visits in the same order, a flow shop, to finish the batch sooner: a shorter makespan.

A placement rule runs for every job, so its waste repeats across the fleet. The usual waste is stranded capacity: a machine whose memory is all allocated can't take another job, however many cores it has free. Lowering it is a search through many small changes whose effect depends on the mix of jobs, and a change that helps one month can hurt the next. Teams test them offline by replaying traces: past weeks' job arrivals, requests and durations, run through a simulator of the fleet. Google publishes traces of its Borg clusters (ClusterData2019 covers eight of them over May 2019); your own scheduler's logs fit your fleet better. Thermite gives the replay to a judge the agents can't reach.

## Where Thermite fits

The agents change the rule, each in its own copy: a scoring function, a queue order, a sequencing heuristic. The judge replays each cell's trace with it, checks every placement against each machine's capacity, and measures what was stranded and how long jobs waited. The agents never see the traces the judge replays, the simulator or the hidden weeks. They learn only the judge's verdict and its reasons.

## Example campaigns

### 1. Pack a Kubernetes fleet tighter

A platform team sees nodes with free cores but no free memory.

- **What the agents change:** the node-scoring function, which takes what a Score plugin takes: the pod's requests and each feasible node's free CPU, memory and GPUs.
- **What the judge runs:** a week of the cluster's pod events, replayed onto the fleet as it was, so that pods queue at the peaks.
- **The number:** stranded CPU and memory, as a share of the fleet's capacity, averaged over the week. Lower is better.
- **What must hold:** every pod placed on a node with room, its node selectors and taints respected; mean slowdown (wait plus run time, over run time) and the replay's time, as guards, so that big pods don't starve and the rule stays cheap.
- **Hidden from the agents:** later weeks of the same cluster, and a week of another of your clusters.
- **What agents would try:** weighting each resource by its scarcity in the fleet; best fit on the pod's dominant resource; scores that leave remainders common pod shapes fit; keeping whole GPU nodes free for multi-GPU jobs; placing the largest pending pods first.
- **What you get:** the rule, as a commit on the run's branch, with every attempt's scores. A rule that fits `RequestedToCapacityRatio`'s shape becomes configuration; any other, a Score plugin your team writes in Go.

### 2. A shorter makespan on a flow line

A plant runs each day's orders through the same ten machines and wants the batch finished sooner.

- **What the agents change:** the sequencing heuristic: how it builds a first job order and how it improves it.
- **What the judge runs:** the heuristic on each instance for a fixed time; the check rebuilds the schedule from the job order and computes the makespan itself.
- **The number:** makespan divided by a reference for each instance: the best known upper bound for Taillard's 50 × 10, 100 × 10 and 200 × 10 instances, and a long run of the starting heuristic for the rest. Lower is better.
- **What must hold:** every job in the order exactly once; the time limit, on the judge's clock.
- **Hidden from the agents:** instances drawn with Taillard's published generator from seeds the agents never see, and a month of the plant's own orders.
- **What agents would try:** NEH, the standard insertion heuristic, with better tie-breaking; iterated greedy with a different number of jobs removed and reinserted, or another acceptance rule; evaluating all of a job's insertion positions in one pass.
- **What you get:** the heuristic that finished soonest, with its makespan on every instance.

### 3. Read the evidence first

A research campaign can first ask "In published evaluations on cluster traces, which placement heuristics kept their gains when the workload changed, and how was that tested?" The agents record only claims whose quotes code finds, word for word, in the pages it archived, and a panel of models decides each question.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "fleet-packing",
  "version": 1,
  "title": "Less stranded CPU and memory, every pod placed",
  "mode": "hill_climb",
  "project": {
    "repo": "placement-policy",
    "kit": { "repo": "trace-replay-kit", "commit": "7c2e9a4f1b8d3c6e0a5f2b9d4c7e1a3f8b6d0c2e" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["policy/**"],
  "objective": { "primary": { "metric": "stranded", "direction": "min", "min_effect": 0.02 } },
  "guards": [
    { "metric": "slowdown", "direction": "min", "max_step_regression": 0.02, "max_total_regression": 0.05 },
    { "metric": "replay_s", "direction": "min", "max_step_regression": 0.1, "max_total_regression": 0.25 }
  ],
  "cells": ["week-1", "week-2", "week-3", "week-4"],
  "held_out_cells": ["week-6", "second-cluster-week-6"]
}
```

The kit holds the traces, the fleet's machine shapes and an event simulator. Its run command replays one cell's week with the agents' rule and writes every placement. Its check rebuilds each node's allocation from those placements, fails the run if a node goes over capacity, a constraint is broken or a pod is never placed, and prints one line, such as `{"pass": true, "stranded": 0.087, "slowdown": 1.21}`. The kit names `stranded` and `slowdown` as numbers read from the check, and `replay_s` as the run's time on the judge's clock. A gain counts only when it is at least 2% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)). For a Kubernetes rule, kube-scheduler-simulator, which runs the real scheduler against a simulated cluster, can check the winner a second time.

## What to expect

- **Time per attempt.** A replay runs much faster than the week it replays, and grows with the number of pods and nodes. The judge runs each change several times, alternating with the best rule so far, so an attempt costs several replays of every cell.
- **Where the agents help most.** Short, readable rules: scores, weights, queue orders and sequencing heuristics.
- **Where people stay.** Choosing the weeks and the constraints the check enforces, reading the rule, and rolling it out to part of the fleet first.

## What the judge guards against

A rule tuned on one month of jobs can overfit to that month's mix, as bin-packing rules evolved for one distribution of item sizes fail on another ([Related work](#related-work)). Every win must hold on weeks and a cluster the agents never replayed. The check rebuilds every node's allocation from the placements, so a rule that tampers with the simulator's own accounting is caught. Keep the hidden weeks private: the agents' commands can reach the internet, and Google's traces can be downloaded.

## Limits

- A replay doesn't answer back. In a live cluster, users resubmit, autoscalers add nodes and jobs run differently on different machines; only a rollout shows that.
- Traces record what jobs requested. A rule measured on requests packs requests, not what the jobs use.
- A flow-shop model leaves out setups, breakdowns and due dates unless the kit adds them.
- A rig measures on one machine, in replay. Deploying the rule to a production scheduler stays your decision.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** teams that run large fleets of servers or GPUs, or plan a factory's lines.
- **[Startups](../for/startups.mdx):** GPU cloud and scheduling providers, where fleet utilization drives margin.

## Related work

AlphaEvolve found a heuristic for Borg, Google's cluster manager, that "continuously recovers, on average, 0.7% of Google's worldwide compute resources" ([DeepMind's post](https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)). Before it went into production, it was measured "on an unseen test dataset of recent workloads and capacity to ensure generalization" ([the paper](https://arxiv.org/abs/2506.13131)). Herrmann and Pallez confirmed that bin-packing heuristics evolved by language models "are not robust to variations in the data distribution", and derived a simpler two-parameter rule that generalizes further ([the paper](https://arxiv.org/abs/2510.27353)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on a machine with CPU cores to spare.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around a simulator and your traces, and [test it](../../how-to/campaigns/test-a-kit.md) with your current rule and one that overfills a machine: the check must fail it.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
