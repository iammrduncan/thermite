---
title: "Cluster and job scheduling"
description: "Use Thermite to improve job placement and scheduling heuristics, evaluated by replaying your own traces and validated on held-out weeks."
type: use-case
useCase:
  mode: climb
  personas: [enterprises, startups]
  summary: "Agents improve the placement or scheduling heuristic. The judge replays your traces, validates every placement and tests on held-out weeks."
  measure: "Stranded capacity or makespan · every job placed, no machine over · later weeks of traces"
sidebar:
  order: 1
---

Placement and scheduling heuristics decide which machine runs each job, and they run millions of times. Small improvements reduce stranded CPU and memory on a cluster, or idle time on a production line, without new hardware. The heuristic can be evaluated offline by replaying historical traces through a simulator. Thermite's agents improve the heuristic, and the replay is the judge's evaluation.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md), with `"direction": "min"` |
| **The number** | Stranded CPU and memory as a share of the fleet, or the makespan of a factory schedule, from the kit's simulator |
| **What must hold** | No machine goes over its capacity, and every job is placed; the time the rule takes to decide, as a guard |
| **Hidden from the agents** | Later weeks of traces, or other clusters, that a win must also pass |
| **Where it runs** | A CPU rig |

## How it runs

1. **You write a kit** whose cases are a week of your traces each, and whose check replays them through the simulator with the agents' rule and prints what was stranded.
2. **Agents try changes** to the rule: a better score for each machine, a look-ahead, a different order for large jobs.
3. **The judge scores each version** and keeps it only if it wastes less on every case, places every job, and holds on the hidden weeks.

## What the judge guards against

A heuristic tuned on one month of jobs can overfit to that workload, and heuristics found by search can degrade when the workload changes. Withheld weeks and clusters test every accepted heuristic. Thermite evaluates the heuristic offline; deploying it to the production scheduler remains your decision.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** teams that run large fleets of servers or GPUs, or plan a factory's lines.
- **[Startups](../for/startups.mdx):** GPU cloud and scheduling providers, where fleet utilization drives margin.

## Related work

AlphaEvolve found a heuristic for Google's cluster scheduler that "continuously recovers, on average, 0.7% of Google's worldwide compute resources"; it was checked on recent workloads it had not been tuned on before it went into production ([DeepMind's post](https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)). Herrmann and Pallez found that bin-packing heuristics found by language models "are not robust to distribution changes" ([the paper](https://arxiv.org/abs/2510.27353)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around a simulator and your traces, and [test it](../../how-to/campaigns/test-a-kit.md) with your current rule and one that overfills a machine.
