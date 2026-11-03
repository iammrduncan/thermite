---
title: "Simulation speed and accuracy"
description: "Use Thermite to make simulation code faster or more accurate, with every change verified against a reference solution and the physical invariants it must preserve."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups, enterprises]
  summary: "Agents optimize solver code. The judge measures each version against a reference solution and checks convergence and conservation."
  measure: "Steps a second, or error against a reference · same physics · inputs the agents never see"
sidebar:
  order: 2
---

Research and engineering schedules often depend on simulation run time, and part of that time is in the code: memory access patterns, step sizes, parallelism. Thermite's agents optimize the solver code, and the judge verifies every change against a reference solution and the physical invariants the code must preserve, so a faster but incorrect solver is never accepted.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md): on speed with accuracy held, or on accuracy with run time held |
| **The number** | Time steps a second or nanoseconds a day, from the judge's clock; or the error against a reference solution, with `"direction": "min"` |
| **What must hold** | Energy, pressure and temperature traces within a tolerance of a reference run; energy drift bounded; the error shrinking at the expected rate as the grid is refined |
| **Hidden from the agents** | Other input decks, system sizes and initial conditions, that a win must also pass |
| **Where it runs** | A CPU rig, or a CUDA rig for GPU codes. A code that needs many nodes needs a cluster target, which Thermite doesn't have yet |

## How it runs

1. **You write a kit** that builds the code, runs it on a set of input decks, and checks the output against reference runs. Floating-point sums change with their order, so the check uses a tolerance, not bit-for-bit equality.
2. **Agents try changes** to the hot loops, the data layout, the parallel code or the numerical method.
3. **The judge times each change** and runs its checks. A change that is faster but drifts in energy, or more accurate on one case but unstable on another, is not a win.
4. **A goal campaign can port the code**: to a GPU, or to a new library version, with goals that the ported code matches the original on each test case.

## What the judge guards against

A fast simulation that produces wrong results is worse than a slow one, because the error may go unnoticed. The checks belong to the kit, which the agents never see, and the judge runs them on every change. A claimed improvement must beat a reference solution that you chose, not one the agents chose.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** graduate students and researchers whose work depends on simulation run time.
- **[Startups](../for/startups.mdx):** simulation software companies that need both speed and accuracy.
- **[Enterprises](../for/enterprises.mdx):** national laboratories and engineering teams with their own codes and machines.

## Related work

CodePDE had language models write solvers for partial differential equations: on Burgers' equation its best solver's error was 1.06e-4, against 3.55e-4 for the reference solver, but 60.5% of its solvers for compressible Navier–Stokes failed the convergence test ([the paper](https://arxiv.org/abs/2505.08783)). McGreivy and Hakim found that 79% of papers that claimed machine learning beats numerical methods for such equations compared with a weak baseline ([the paper](https://arxiv.org/abs/2407.07218)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on the machine that runs your code.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with reference runs and a check with tolerances, and [test it](../../how-to/campaigns/test-a-kit.md): include a change that is faster but wrong, and make sure the check fails it.
3. Patches to code under the GPL stay under the GPL.
