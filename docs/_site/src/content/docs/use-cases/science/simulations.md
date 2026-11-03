---
title: "Make a simulation faster or more accurate"
description: "Speed up a molecular dynamics, fluid or PDE code, or make a solver more accurate, while the judge checks every change against a reference solution and the physics the code must keep."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups, enterprises]
  summary: "Agents change a solver's code. The judge times each version, compares it with a reference solution, and checks that it still converges and keeps its energy."
  measure: "Steps a second, or error against a reference · same physics · inputs the agents never see"
sidebar:
  order: 2
---

A thesis, a design study or a product can wait days on one simulation. Some of that time is the code: a kernel that could use the cache better, a solver that could take larger steps, a loop that could run in parallel. Thermite can put agents on the code, and a judge on its answers. Every change is timed, and every change is checked against a reference solution and against the physics that it must keep, so a faster code that is wrong never wins.

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

## What the judge keeps out

A fast simulation that gives the wrong answer is worse than a slow one, because nobody notices. The checks belong to the kit, which the agents never see, and the judge runs them on every change. A claim of a better solver must beat a reference that you chose, not one that the agents chose.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** a graduate student whose thesis waits on a simulation, with one workstation.
- **[Startups](../for/startups.mdx):** simulation software that has to be fast and right.
- **[Enterprises](../for/enterprises.mdx):** national laboratories and engineering teams with their own codes and machines.

## What others have shown

CodePDE had language models write solvers for partial differential equations: on Burgers' equation its best solver's error was 1.06e-4, against 3.55e-4 for the reference solver, but 60.5% of its solvers for compressible Navier–Stokes failed the convergence test ([the paper](https://arxiv.org/abs/2505.08783)). McGreivy and Hakim found that 79% of papers that claimed machine learning beats numerical methods for such equations compared with a weak baseline ([the paper](https://arxiv.org/abs/2407.07218)).

## Start

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on the machine that runs your code.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with reference runs and a check with tolerances, and [test it](../../how-to/campaigns/test-a-kit.md): include a change that is faster but wrong, and make sure the check fails it.
3. Patches to code under the GPL stay under the GPL.
