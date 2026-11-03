---
title: "Vehicle routing"
description: "Use Thermite to improve a vehicle routing solver, with every route's cost recomputed by the judge and results validated on held-out instances."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups]
  summary: "Agents improve a routing solver's operators. The judge runs it on a fixed time budget, recomputes every route's cost and tests on held-out instances."
  measure: "Gap to the best known cost · routes valid, recomputed by the judge · larger instances"
sidebar:
  order: 2
---

Vehicle routing determines which vehicle serves which customers, in what order, within its capacity. State-of-the-art solvers are heuristics refined over years of research, and further gains are measured in fractions of a percent, which is significant at fleet scale. Route cost can be recomputed exactly, so results are straightforward to verify. Thermite's agents improve the solver, and the judge verifies every solution.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md), with `"direction": "min"` |
| **The number** | The mean gap to the best known solution, after a fixed time on each instance, reported by the kit's check |
| **What must hold** | The check recomputes every route's cost itself, and checks that every customer is visited once and no van is over capacity |
| **Hidden from the agents** | Other instances, and larger ones, that a win must also pass |
| **Where it runs** | A CPU rig: the judge gives each version the same time on the same machine |

## How it runs

1. **You write a kit** around a solver, such as PyVRP, and a set of standard benchmark instances or your own. Its run command solves each instance for a fixed time; its check validates the routes and prints the gap.
2. **Agents try changes** to the solver's moves, its order of search and the way it escapes a local optimum.
3. **The judge scores each version** on the same budget as the best version, and keeps it only if it holds on the hidden instances too.

## What the judge guards against

A solver that reports its own cost can misreport it, and operators tuned on a few instances can fail on others. The check recomputes every route's cost, withheld instances test every accepted change, and every version runs with the same time budget on the same machine.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** operations researchers testing new solver operators on a single computer.
- **[Startups](../for/startups.mdx):** logistics software companies, testing on their customers' kinds of instances.

## Related work

VRPAgent had a language model write new moves for a routing solver, and beat the leading solver, HGS, on instances with 2,000 customers; the model calls of one search run with Gemini 2.5 Flash cost about $19 ([Hottung and others, 2025](https://arxiv.org/abs/2510.07073)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with a check that validates routes, and [test it](../../how-to/campaigns/test-a-kit.md) with a solver that misreports its cost: the check must fail it.
3. Real fleets add time windows and drivers' hours: model them in the kit.
