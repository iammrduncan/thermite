---
title: "Simulation speed and accuracy"
description: "Use Thermite to make molecular dynamics, CFD and PDE codes faster, with every change checked against reference runs, energy drift and convergence order on inputs the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups, enterprises]
  summary: "Agents change solver code, build settings and solver options. The judge times each version and checks it against reference runs, energy drift and convergence order."
  measure: "Time steps a second or time to solution · the same physics, within tolerances · input decks the agents never see"
sidebar:
  order: 2
---

Molecular dynamics (MD) groups run LAMMPS, GROMACS or their own codes and measure throughput in nanoseconds of simulated time a day (ns/day). CFD teams run OpenFOAM or in-house finite-volume codes, and groups that solve partial differential equations build on libraries such as PETSc. Run time limits the science: at an example 100 ns/day, one microsecond of a protein in water takes ten days. LAMMPS ships five benchmark problems of 32,000 atoms each, and each LAMMPS log reports time steps a second and, in physical units, ns/day.

Making a code faster is a search through many changes that might help or break something: neighbour-list settings, data layout, SIMD loops, OpenMP threads, a GPU kernel, another preconditioner. Correctness can't be checked bit for bit. Floating-point sums change with their order and MD trajectories diverge from tiny differences, so GROMACS's documentation calls any fast GPU implementation "non-reproducible by design". Practitioners compare with reference runs within tolerances instead: forces on a fixed configuration (LAMMPS's unit tests compare pair styles' forces and energies with stored values), energy drift in a constant-energy (NVE) run and, for PDE solvers, the order of convergence as the grid is refined. Thermite gives those checks to a judge the agents can't reach.

## Where Thermite fits

The agents change the code, its build settings and the run settings the kit allows, each in its own copy. The judge builds each version, runs the kit's input decks, times them on its own clock and compares the output with reference runs of the starting code. The agents never see the decks, the references or the tolerances. The time step and the number of steps are in the kit's decks, not in the agents' files: a longer time step raises ns/day by changing the physics.

## Example campaigns

### 1. More ns/day from a LAMMPS build

A group runs long simulations with its own pair style in a fork of LAMMPS and wants more ns/day from the same server.

- **What the agents change:** the pair style's source, the CMake options and compiler flags, and a settings file the decks include: neighbour skin and rebuild settings, OpenMP threads, an accelerator package (OPENMP, INTEL, KOKKOS or GPU).
- **What the judge runs:** a deck based on the Lennard-Jones benchmark in LAMMPS's `bench` folder and one of the group's own system, each from a stored, equilibrated configuration, for a fixed number of steps.
- **The number:** time steps a second on the judge's clock: ns/day at the deck's fixed time step. Higher is better.
- **What must hold:** energies, pressure and temperature within a relative tolerance of the reference over the first few hundred steps, before trajectories diverge; forces on a fixed configuration within a tighter one; `Dangerous builds = 0` in the log, so no neighbour was missed (a run that doesn't check them fails); energy drift over the NVE run below the limit you set.
- **Hidden from the agents:** the group's system at a larger size and another density.
- **What agents would try:** a larger skin with fewer neighbour-list builds; no `pow` or `sqrt` in the inner loop, or a tabulated potential; structure-of-arrays storage and `#pragma omp simd`; the OPENMP package's styles; the INTEL package's mixed precision, which the drift limit decides; the KOKKOS or GPU package on a CUDA rig.
- **What you get:** the fastest version that held the physics, as a commit on the run's branch, with every attempt and the judge's reasons.

### 2. Port a kernel to a GPU

A group's in-house finite-volume code in C++ spends most of its time in one flux kernel, and the group wants it on a GPU.

- **Mode:** a goal campaign on a CUDA rig, which ends when every required goal passes, twice.
- **The goals:** the code builds with CUDA; on every test case, the fields after a fixed number of steps match the CPU version's within a relative L2 error the group sets, such as 1e-10 in double precision; mass and energy totals hold to the CPU version's bounds; and the large case reaches the steps a second the group sets. A case with other boundary conditions is held out.
- **What the agents change:** the kernel, the data layout, the transfers between CPU and GPU memory, and the build files.
- **What you get:** the ported code and, for each goal, the judge's measurements.

### 3. Faster implicit solves, the same answer

A PDE code built on PETSc spends most of its time in linear solves.

- **What the agents change:** the solver and preconditioner (PETSc's `-ksp_type` and `-pc_type` options, hypre's BoomerAMG parameters) and the code around the solves.
- **What the judge runs:** the case to its end time on three grids, each twice as fine as the last.
- **The number:** wall time on the judge's clock. Lower is better.
- **What must hold:** the error against a manufactured solution (an exact solution the kit builds the source term from) within 1% of the starting code's on each grid, and the observed order of accuracy within 0.1 of the scheme's. A solver tolerance loose enough to change the answer fails here.
- **Hidden from the agents:** a finer grid, and a case with variable coefficients.
- **What agents would try:** algebraic multigrid (PETSc's GAMG or BoomerAMG) in place of ILU; conjugate gradients for symmetric systems; a preconditioner reused over several time steps; the last step's solution as the first guess.
- **What you get:** the fastest solver set-up that kept the error and the order, as a commit on the run's branch.

An OpenFOAM case works the same way, with `system/fvSolution` as the agents' file and a drag coefficient within 0.5% of the reference run in place of the manufactured solution.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "md-throughput",
  "version": 1,
  "title": "More time steps a second, the same physics",
  "mode": "hill_climb",
  "project": {
    "repo": "lammps-lab",
    "kit": { "repo": "md-kit", "commit": "7c2e9a4f1b8d3e6c0a5f2b9d4e7a1c8f3b6d0e2a" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["src/**", "cmake/presets/**", "settings/**"],
  "objective": { "primary": { "metric": "steps_per_s", "direction": "max", "min_effect": 0.03 } },
  "guards": [],
  "hard_constraints": [{ "kind": "max", "metric": "energy_drift", "value": 1e-5 }],
  "cells": ["lj-bench", "lab-system"],
  "held_out_cells": ["lab-system-large"]
}
```

The kit holds the decks with their time step and step count, a stored configuration for each, and the starting build's reference logs and forces. Its build runs CMake with the candidate's preset; its run command runs `lmp` on one cell's deck; its check compares the log with the reference, reads `Dangerous builds`, works out the relative energy drift over the NVE run, and prints one line, such as `{"pass": true, "energy_drift": 2.1e-6}`. The kit names `steps_per_s` as a rate, the cell's step count over the run's time on the judge's clock, and `energy_drift` as a number read from the check. A gain counts only when it is at least 3% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge builds each version, then runs it several times, alternating with the best version so far. A LAMMPS build takes minutes, so keep each deck to a minute or two.
- **Where the agents help most.** Hot loops, data layout, build flags, accelerator and solver settings: changes a profile points to and a reference run can check. A port to a GPU suits a goal campaign.
- **Where people stay.** Choosing the decks, tolerances and drift limit; deciding whether a change of model, such as a longer time step, a shorter cutoff or a coarser grid, is acceptable science; validation against experiment.

## What the judge guards against

A fast simulation that gives wrong results is worse than a slow one, because the error may go unnoticed. After a change of summation order small differences are normal, so the check needs tolerances, and a search uses whatever they allow: check short windows of the trajectory, forces, averages and drift together. The decks, references and tolerances belong to the kit, so no agent can change what it is compared with, and hidden decks catch a change tuned to one system.

## Limits

- A rig measures on one machine. A run across several nodes is not a target: measure on one node, with its MPI ranks and threads.
- A change of model can pass a tolerance and still change the science. Keep the time step, the cutoffs and the mesh in the kit, outside `editable_paths`.
- LAMMPS is under the GPL-2.0, OpenFOAM under the GPL-3.0 and GROMACS under the LGPL-2.1. A patched version that you distribute carries those terms.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** graduate students and researchers whose work depends on simulation run time.
- **[Startups](../for/startups.mdx):** simulation software companies that need both speed and accuracy.
- **[Enterprises](../for/enterprises.mdx):** national laboratories and engineering teams with their own codes and machines.

## Related work

CodePDE had language models write solvers for partial differential equations: on Burgers' equation its best solver's error was 1.06e-4, against 3.55e-4 for the reference solver, but 60.5% of its solvers for compressible Navier–Stokes failed the convergence test ([the paper](https://arxiv.org/abs/2505.08783)). McGreivy and Hakim found that 79% of papers that claimed machine learning beats numerical methods for such equations compared with a weak baseline ([the paper](https://arxiv.org/abs/2407.07218)). GROMACS's user guide lists what makes two runs differ, from the number of cores to the order of reductions on a GPU ([Reproducibility](https://manual.gromacs.org/current/user-guide/managing-simulations.html)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on the machine that runs your code.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with reference runs and a check with tolerances, and [test it](../../how-to/campaigns/test-a-kit.md) with a change that is faster but wrong, such as a shorter cutoff in the code, to see that the check fails it.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
