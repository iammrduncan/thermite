---
title: "Plan delivery routes closer to the best known"
description: "Let agents improve a vehicle routing solver's moves while the judge runs it for a fixed time on standard instances, recomputes every route's cost itself, and keeps a change only if it holds on instances it never saw."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups]
  summary: "Agents improve a routing solver. The judge runs it for a fixed time, recomputes each route's cost itself, and a win must hold on larger instances they never see."
  measure: "Gap to the best known cost · routes valid, recomputed by the judge · larger instances"
sidebar:
  order: 2
---

Vehicle routing is the daily puzzle of every delivery fleet: which van visits which customers, in what order, within its capacity. The best solvers are heuristics, tuned by years of research, and small changes to their moves still win fractions of a percent, which at a fleet's scale is real fuel and real hours. The score is easy to check, because a route's cost can be recomputed exactly. Thermite can put agents on the solver and that check in the judge's hands.

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

## What the judge keeps out

A solver that reports its own cost can report a wrong one, and a move tuned on a few instances can fail on the next. The check recomputes the cost from the routes, and the hidden instances test the solver on problems it wasn't tuned on. Every version gets the same time on the same machine, so no comparison is unequal.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** an operations researcher with one computer and an idea for a move.
- **[Startups](../for/startups.mdx):** logistics software companies, testing on their customers' kinds of instances.

## What others have shown

VRPAgent had a language model write new moves for a routing solver, and beat the leading solver, HGS, on instances with 2,000 customers; the model calls of one search run with Gemini 2.5 Flash cost about $19 ([Hottung and others, 2025](https://arxiv.org/abs/2510.07073)).

## Start

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with a check that validates routes, and [test it](../../how-to/campaigns/test-a-kit.md) with a solver that misreports its cost: the check must fail it.
3. Real fleets add time windows and drivers' hours: model them in the kit.
