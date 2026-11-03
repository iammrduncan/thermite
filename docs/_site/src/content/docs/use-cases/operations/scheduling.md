---
title: "Pack work onto machines with less waste"
description: "Let agents improve the rule that places jobs on machines, or orders jobs on a factory line, while the judge replays your own traces in a simulator and keeps the rule only if it holds on later weeks."
type: use-case
useCase:
  mode: climb
  personas: [enterprises, startups]
  summary: "Agents improve the placement or scheduling rule. The judge replays your own traces, checks every job fits, and a win must hold on later weeks they never see."
  measure: "Stranded capacity or makespan · every job placed, no machine over · later weeks of traces"
sidebar:
  order: 1
---

A scheduler's rule, the code that decides which machine takes each job, is small, but it runs millions of times. A slightly better rule leaves less CPU and memory stranded on a cluster, or less idle time on a factory line, on the same hardware. The rule can be scored offline: replay a record of real jobs through a simulator of the cluster or the line, and measure what was wasted. Thermite can put agents on the rule and that replay in the judge's hands.

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

## What the judge keeps out

A rule tuned on one month of jobs can learn that month. When the mix of work changes, a rule found by search can fall apart. The hidden weeks, and a cluster the agents never saw, test it on work it wasn't tuned on. Thermite only scores the rule: putting it into the live scheduler is your change to make.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** teams that run large fleets of servers or GPUs, or plan a factory's lines.
- **[Startups](../for/startups.mdx):** GPU cloud and scheduling companies, for whom a share of a fleet is the margin.

## What others have shown

AlphaEvolve found a heuristic for Google's cluster scheduler that "continuously recovers, on average, 0.7% of Google's worldwide compute resources"; it was checked on recent workloads it had not been tuned on before it went into production ([DeepMind's post](https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)). Herrmann and Pallez found that bin-packing heuristics found by language models "are not robust to distribution changes" ([the paper](https://arxiv.org/abs/2510.27353)).

## Start

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around a simulator and your traces, and [test it](../../how-to/campaigns/test-a-kit.md) with your current rule and one that overfills a machine.
