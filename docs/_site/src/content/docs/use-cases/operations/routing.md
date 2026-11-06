---
title: "Vehicle routing"
description: "Use Thermite to improve a vehicle routing solver at a fixed time limit, with every route's cost recomputed by the kit's check and every win confirmed on instances the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups]
  summary: "Agents change a routing solver's operators, neighbourhoods and parameters. The judge runs it for a fixed time, recomputes every route's cost and checks it on hidden instances."
  measure: "Cost against the best known, at a fixed time limit · every route valid, its cost recomputed · your own days of orders"
sidebar:
  order: 2
---

A carrier, a grocer or a field-service company plans its routes every day: which vehicle serves which customers, in what order, within each vehicle's capacity and, usually, each customer's time window and each driver's shift. The planning software hands a solver the day's orders, a travel-time matrix from the road network and a time limit. The solver may be Google's OR-Tools, which builds a first solution with a rule such as savings or cheapest arc and improves it with guided local search; a solver from research, such as PyVRP (an iterated local search) or HGS-CVRP (a hybrid genetic search for the capacitated problem); or a vendor's own. A route's cost is its distance or driving time, plus the vehicles and drivers' hours it uses, so a fraction of a percent saved every day adds up across a fleet.

Solvers improve through many uncertain changes: a new neighbourhood, a different perturbation, a population size, a penalty for routes over capacity. Each helps some instances and hurts others. The field compares solvers by running each for a fixed time on benchmark instances and reporting its gap to the best known solution. CVRPLIB keeps those instances and their best known solutions. Its X set, by Uchoa and others, has 100 instances of 100 to 1,000 customers that vary the depot's position, the customers' layout, the demands and the route lengths. A route's cost can be recomputed exactly from the solution, so nobody has to trust a solver's report of its own. Thermite gives that recomputation to a judge the agents can't reach.

## Where Thermite fits

The agents change the solver's source, each in its own copy. The judge builds it, runs it on every instance of a cell for the same time limit, and has the kit's check read the routes, test them against the instance and recompute their cost. The agents never see the check, the hidden instances or their reference costs. They learn only the judge's verdict and its reasons.

## Example campaigns

### 1. A lower cost at the same time limit

A routing team keeps its own copy of PyVRP and wants cheaper plans in the 60 seconds its planner allows for each depot.

- **What the agents change:** the solver's source: its operators, its neighbourhood, its perturbation and its parameters.
- **What the judge runs:** the solver on each of a cell's X instances, grouped by size, for 60 seconds each.
- **The number:** each instance's cost divided by its best known cost, averaged over the cell: 1.004 is 0.4% above the best known. Lower is better.
- **What must hold:** every customer visited exactly once and no route over capacity, with every cost recomputed by the check; the worst instance's ratio, as a guard; the run's time on the judge's clock, as a hard limit.
- **Hidden from the agents:** a month of your own days of orders, and instances made with CVRPLIB's generator, the one that made the X instances, from seeds you keep.
- **What agents would try:** an exchange of customers between routes without in-place insertion, like HGS-CVRP's SWAP\*; a wider or narrower granular neighbourhood (how many of each customer's nearest neighbours a move considers); more or fewer perturbations per iteration; penalties for overloaded routes that adapt faster; caching the cost of moves between iterations.
- **What you get:** the solver that planned cheapest at the limit, as a commit on the run's branch, and every attempt with its ratios and the judge's reasons.

### 2. Move the planner to another solver, with evidence

A company plans with OR-Tools and wants to know whether PyVRP plans its days for less in the same time before it changes production.

- **Mode:** a goal campaign, which ends when every required goal passes, twice.
- **The goals:** PyVRP reads the company's days, with their time windows, vehicle types and shift lengths; every route is feasible on last quarter's days; total cost is at or below OR-Tools' on the same days at the same limit; the hidden month passes too.
- **What the agents change:** the adapter from the company's data to PyVRP's model, and PyVRP's settings.
- **What you get:** a migrated planner and, for each goal, the judge's measurements. If the days need what the open-source PyVRP doesn't model, such as driver breaks, the campaign's evidence shows it.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "cvrp-60s",
  "version": 1,
  "title": "Cheaper routes in 60 seconds, every route checked",
  "mode": "hill_climb",
  "project": {
    "repo": "routing-solver",
    "kit": { "repo": "cvrp-kit", "commit": "2b8f5d1a9c4e7b0d3f6a9c2e5b8d1f4a7c0e3b6d" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["pyvrp/**"],
  "objective": { "primary": { "metric": "cost_ratio", "direction": "min", "min_effect": 0.001 } },
  "guards": [
    { "metric": "worst_ratio", "direction": "min", "max_step_regression": 0.002, "max_total_regression": 0.005 }
  ],
  "hard_constraints": [{ "kind": "max", "metric": "wall_s", "value": 620 }],
  "cells": ["x-small", "x-medium", "x-large"],
  "held_out_cells": ["own-days", "generated-unseen"]
}
```

The kit holds the instances, a reference cost for each (CVRPLIB's best known for the X instances, a long run of the starting solver for the rest) and the check. Each cell has ten instances. Its run command solves each for 60 seconds and stops the solver if it overruns; its check reads each solution, confirms that every customer is visited exactly once and no route exceeds the vehicle's capacity, recomputes each route's cost from the coordinates with the instance's own rounding, and prints one line, such as `{"pass": true, "cost_ratio": 1.0043, "worst_ratio": 1.0121}`. The kit names `cost_ratio` and `worst_ratio` as numbers read from the check and `wall_s` as the run's time on the judge's clock, which may not pass 620 seconds. A gain counts only when it is at least 0.1% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** Ten instances at 60 seconds make one run of a cell ten minutes. The judge runs each change several times, alternating with the best solver so far, so an attempt over three cells takes several hours. A shorter limit is cheaper, but the gain must show at the limit you plan with.
- **A quiet machine.** On a CPU rig the agents' builds share the cores with the judge, which waits for the load to drop before each block ([Sharing a device](../../explanation/sharing-a-device.md)). Fewer lanes mean shorter waits.
- **Where the agents help most.** Operators, neighbourhoods and parameters in a solver with a clear structure, such as PyVRP's separate operators and search. New constraints in the model suit a goal campaign.
- **Where people stay.** Choosing a time limit and instances that match how you plan, deciding which constraints are hard, and putting the solver in front of dispatchers.

## What the judge guards against

A solver that reports its own cost can misreport it, and an operator tuned to the X instances' layouts can fail on a real city's streets. The check recomputes every route, the judge holds every version to the same limit on the same machine, and each win must hold on your own days. Keep those days private: the agents' commands can reach the internet, and CVRPLIB's instances and solutions can be downloaded.

## Limits

- Benchmark instances such as the X set use straight-line distances. Put real travel times in your own instances.
- The judge measures a plan for a day's known orders, not dispatching as orders arrive during the day, unless the kit simulates that.
- A rig measures on one machine, with its CPUs. Planning that runs across many machines at once is not a target.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** operations researchers testing new solver operators on a single computer.
- **[Startups](../for/startups.mdx):** logistics software companies, testing on their customers' kinds of instances.

## Related work

VRPAgent had a language model write operators for a large-neighbourhood search. On capacitated instances of 500 to 2,000 customers, its average cost was below that of HGS and of the strongest hand-built baseline in the study, on a single CPU core. A discovery run with Gemini 2.5 Flash cost "nearly $20" in model calls ([Hottung and others, 2025](https://arxiv.org/abs/2510.07073)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on a machine with CPU cores to spare.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with a check that validates routes, and [test it](../../how-to/campaigns/test-a-kit.md) with a solver that misreports its cost: the check must fail it.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
