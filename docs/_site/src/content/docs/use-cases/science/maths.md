---
title: "Mathematical discovery"
description: "Use Thermite to search for larger cap sets, better packings and other extremal constructions, with every candidate checked exactly by a verifier the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, solo-builders]
  summary: "Agents improve programs that build constructions. The judge runs each program and checks its construction exactly, in integers or rationals, before the bound counts."
  measure: "The construction's size or score · checked exactly, in integers or rationals · a second, independent verifier"
sidebar:
  order: 1
---

Many problems in extremal combinatorics and discrete geometry ask for the best construction: the largest cap set (vectors with entries 0, 1 and 2, no three on a line), a two-colouring of a complete graph's edges with no clique of a given size in one colour, more spheres touching a central one, circles in a square with the largest total radius. Each better construction proves a better lower bound. Mathematicians find them by hand, with algebra and by computer search: SAT solvers such as CaDiCaL and Kissat, integer programming, simulated annealing, and now program search, where a language model writes the program that builds the construction, as in FunSearch and AlphaEvolve.

Progress is a long series of uncertain ideas: assume a symmetry, start from a product of smaller caps, change the order in which a greedy search adds points, add a local-search move. Each needs a run to show whether it helps. Checking the result is cheap and exact. Three different vectors lie on a line exactly when they sum to zero mod 3 in every coordinate, so a cap set's check is integer arithmetic over every pair; a packing's check is a set of inequalities that rational arithmetic decides with no rounding. Thermite gives that check to a judge the agents can't reach.

## Where Thermite fits

The agents change the search program, each in its own copy: its heuristics, its moves, its starting construction, its language. The judge runs the program and checks the construction it writes with the kit's verifier, which reports its size or score. The agents never see the verifier or the second verifier that confirms a win. They learn only the verdict and the check's reasons, such as "a vector repeats".

## Example campaigns

### 1. A larger cap set in dimension 8

A combinatorialist has a greedy cap set search in Python and wants a larger cap in dimension 8 than any published.

- **What the agents change:** the search program: the priority function that orders the points for a greedy skeleton, as in FunSearch, or the whole search.
- **What the judge runs:** the program for dimension 8, which writes one vector a line, then the verifier.
- **The number:** the cap's size, as the verifier reports it. Higher is better.
- **What must hold:** each line is 8 digits from 0, 1 and 2; no vector repeats; for each pair, the third point on their line, −(x + y) mod 3, is not in the set. All in integers.
- **Hidden from the agents:** the verifier, and a second verifier written separately in another language, which a win must also pass.
- **What agents would try:** a product of smaller caps as the seed (caps of sizes a and b in dimensions m and k give one of size ab in dimension m + k); priority functions that score a vector by its digits; invariance under a group, such as cyclic shifts of the coordinates; swaps that remove one vector and add two; a SAT solver to complete a partial cap.
- **What you get:** the largest cap the verifier accepted and the program that builds it, as a commit on the run's branch, with every attempt and the judge's reasons.

### 2. Circles in a square, checked without rounding

AlphaEvolve raised the best known sum of radii for 26 circles in a unit square from 2.634 to 2.635. On a problem like this, a check with a tolerance accepts circles that overlap by less than the tolerance.

- **What the agents change:** the optimizer: starting layouts, the solver over centres and radii, and the last step, which shrinks radii until every constraint holds exactly.
- **What the judge runs:** the program for 26 and for 32 circles, then a check that reads every number as an exact fraction, with Python's `fractions` module.
- **The number:** the sum of the radii. Higher is better.
- **What must hold:** every circle inside the square and every pair apart, (xᵢ − xⱼ)² + (yᵢ − yⱼ)² ≥ (rᵢ + rⱼ)², decided exactly.
- **Hidden from the agents:** 29 circles, on which a win must do no worse than the version before it.
- **What agents would try:** hexagonal seeds with varied radii, random restarts, SciPy's SLSQP followed by an exact repair step, symmetric layouts.
- **What you get:** layouts in exact fractions that anyone can check again, and the optimizer that made them.

### 3. Read the bounds first

Before a climb, a research campaign can answer a question such as "Which constructions and searches gave the best published lower bounds for cap sets in dimensions 7 to 10?" Its claims rest on quotes that code finds, word for word, in the pages it archived, and its report lists the sources to check a new record against.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "cap-set-dim8",
  "version": 1,
  "title": "A larger cap set in dimension 8",
  "mode": "hill_climb",
  "project": {
    "repo": "capset-search",
    "kit": { "repo": "capset-kit", "commit": "4e8a1c7b2d9f3e6a0b5c8d1e4f7a2b9c3d6e0f1a" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["search/**"],
  "objective": { "primary": { "metric": "cap_size", "direction": "max", "min_effect": 0.001 } },
  "guards": [],
  "hard_constraints": [{ "kind": "max", "metric": "run_s", "value": 600 }],
  "cells": ["dim8"],
  "held_out_cells": ["dim8-second-verifier"],
  "acceptance": { "equivalence_band": 0.0005 }
}
```

The kit holds both verifiers. Its run command runs the agents' program for the cell's dimension; its check rejects bad digits, wrong lengths and repeats, tests every pair, and prints one line, such as `{"pass": true, "cap_size": 512}` or `{"pass": false, "reasons": ["a vector repeats"]}`. The kit names `cap_size` as a number read from the check and `run_s` as the run's time on the judge's clock, which may not pass ten minutes. One more vector in a cap of 512 is a gain of 0.2%, so the contract counts gains from 0.1% and narrows the band within which two results are equal from its default of 0.5% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge runs each version several times, alternating with the best version so far, and confirms a win on fresh runs and with the second verifier. A check takes seconds, so the program sets the cost: keep it to minutes. It can be the search itself, or a short program that rebuilds a construction the agents' own search found in their lane.
- **Where the agents help most.** Trying many heuristics, symmetries and moves, and porting a search from Python to C. Everything runs on CPUs, and the agents can use a local model through Ollama or vLLM.
- **Where people stay.** Choosing the problem, writing the verifiers, checking that a record is new, proving upper bounds and writing the paper.

## What the judge guards against

A search scored by code finds that code's weak spots. Georgiev, Gómez-Serrano, Tao and Wagner saw AlphaEvolve exploit the numerical integration in one of their scoring functions. A check with a tolerance accepts a near miss, and a cap check that doesn't test for repeats counts a vector twice. Check in integers or rationals, reject malformed output before you score it, and confirm wins with a second verifier the agents never see. Write the check's `reasons` to say what failed, not how the check works.

## Limits

- A construction proves a lower bound. An upper bound needs a proof, and the judge reads only the check's `pass` and its numbers.
- A score that is an integral, as in the autocorrelation inequalities, can't be checked exactly. Search a finite form instead, such as step functions with fixed steps, as Georgiev and others suggest for one such problem.
- A rig measures on one machine. A search that needs a cluster must fit on one node.
- The agents can download published constructions. A construction is new only when a person has checked the literature.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** open research problems that run on a single computer with a local model.
- **[Solo builders](../for/solo-builders.mdx):** independent researchers and students who want to test an approach at scale.

## Related work

FunSearch found a cap set of size 512 in dimension 8, larger than any known before ([the paper in Nature](https://www.nature.com/articles/s41586-023-06924-6)). AlphaEvolve found 593 spheres that touch one sphere in 11 dimensions, a new lower bound for the kissing number ([DeepMind's post](https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)), and for 26 circles in a unit square "improved it to 2.635" from 2.634 ([the paper](https://arxiv.org/abs/2506.13131)). Working through 67 problems with AlphaEvolve, Georgiev, Gómez-Serrano, Tao and Wagner reported that on one of them it "always eventually figured out a way to cheat" their scoring function ([the paper](https://arxiv.org/abs/2511.02864)). A SAT computation settled Schur number five with a proof that "is two petabytes in size and was certified using a formally verified proof checker" ([Heule, 2017](https://arxiv.org/abs/1711.08076)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), and [run a model on your own computer](../../how-to/models/choose-a-model.md) for the agents.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) whose check is the verifier, and [test it](../../how-to/campaigns/test-a-kit.md) with a known construction, a near miss and a construction with a repeated vector.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
