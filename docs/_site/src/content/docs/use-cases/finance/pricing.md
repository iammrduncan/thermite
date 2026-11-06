---
title: "Pricing and risk engine performance"
description: "Use Thermite to shorten a bank's pricing and risk runs, with every price and Greek checked against reference values and on a slice of the book the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [enterprises]
  summary: "Agents optimize the Monte Carlo and pricing code. The judge times a slice of the book on your machine and checks every price and Greek against reference values."
  measure: "Seconds to price a slice with Greeks · prices and Greeks within tolerance · a slice the agents never see"
sidebar:
  order: 2
---

A bank's trading desks reprice their books and compute risk many times a day, and the end-of-day batch must finish inside an overnight window. It prices every trade, computes its Greeks (the price's sensitivities to spot, rates, volatility and other inputs), revalues the book under historical scenarios for value at risk, and simulates future exposures for XVA, the valuation adjustments for counterparty credit and funding. Many exotics are priced by Monte Carlo simulation, usually with fixed seeds so that a rerun repeats its numbers. Greeks are often computed by bump and revalue: shift one input and price again, at one or two full pricings per input. The engines are in-house C++ libraries or open-source ones, such as QuantLib and, for XVA, the Open Source Risk Engine built on it, and run on grids of servers.

Making the batch faster is a long list of uncertain changes. Each must reproduce the prices and Greeks to the risk team's tolerance, without saving time by simulating fewer paths. Banks already check engines against reference prices on fixed sets of test trades. STAC-A2, the industry's benchmark suite for pricing and risk, compares technology stacks on a standard workload, not your engine on your book. Thermite gives the references and the check to a judge the agents can't reach, and times your engine on your machine.

## Where Thermite fits

The agents change the engine's code, each in its own copy: the Monte Carlo simulation, the pricers, the Greeks and the market-data objects. The judge builds each version, prices a slice of the book on its own clock, and compares every price and Greek with reference values. The agents never see the trades, the market data, the references or the hidden slice, and learn only the judge's verdict and its reasons.

## Example campaigns

### 1. A shorter end-of-day run, the same numbers

An equity derivatives desk prices autocallables and barrier options by Monte Carlo under local volatility, with bumped Greeks, and its batch is near the end of its window.

- **What the agents change:** path generation, payoff evaluation, the Greeks, and the curve and volatility-surface objects.
- **What the judge runs:** three slices of a few hundred to a few thousand trades, with one day's market data at the production path count: prices, deltas and vegas.
- **The number:** seconds to price the slice with its Greeks, on the judge's clock. Lower is better.
- **What must hold:** every price and Greek within its tolerance of the reference, or the check fails the run; and the root-mean-square price and Greek errors, against references with many more paths, no more than 2% worse in a step and 5% in all, so that a cut in paths shows.
- **Hidden from the agents:** a slice of another date's book, with a different mix of trades.
- **What agents would try:** paths simulated once for all the trades on an underlying; the same random numbers for base and bumped prices (common random numbers), which steady bumped Greeks; Sobol sequences with a Brownian bridge; a structure-of-arrays layout the compiler can vectorize; cached discount factors and volatility lookups; pathwise or adjoint Greeks in place of bumps.
- **What you get:** the fastest engine that held every tolerance, as a commit on the run's branch, and every attempt with its measurements and the judge's reasons.

### 2. Move the Monte Carlo engine to GPUs

A desk wants its Monte Carlo engine on NVIDIA GPUs, with evidence that the numbers do not move.

- **Mode:** a goal campaign on a CUDA rig, which ends when every required goal passes, twice.
- **The goals:** the engine builds with CUDA; prices and Greeks within tolerance of the CPU engine's on every test slice and on the hidden one; and at least the paths a second you set, on the judge's clock.
- **What you get:** CUDA kernels, with a counter-based random-number generator so that each GPU thread draws a reproducible stream, and the judge's measurements for each goal. Model validation is still separate.

### 3. Read the evidence on adjoint Greeks first

A research campaign can first answer a question such as "What do published studies report about the cost of adjoint algorithmic differentiation (AAD) Greeks relative to one valuation, in Monte Carlo pricing and XVA?" The agents read open-access papers, a claim counts only when code finds its quotes word for word in the archived page, and a review panel of models decides.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "eod-risk-speed",
  "version": 1,
  "title": "Shorter end-of-day risk, prices and Greeks held",
  "mode": "hill_climb",
  "project": {
    "repo": "pricing-engine",
    "kit": { "repo": "pricing-kit", "commit": "c41d7e09a2b85f36e1d0a4c7b9e2f5813a6d0b4e" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["src/montecarlo/**", "src/pricers/**", "src/greeks/**", "src/market/**"],
  "objective": { "primary": { "metric": "risk_s", "direction": "min", "min_effect": 0.03 } },
  "guards": [
    { "metric": "price_rmse_bp", "direction": "min", "max_step_regression": 0.02, "max_total_regression": 0.05 },
    { "metric": "greeks_rmse_pct", "direction": "min", "max_step_regression": 0.02, "max_total_regression": 0.05 }
  ],
  "cells": ["autocall-400", "barrier-1500", "worst-of-300"],
  "held_out_cells": ["book-other-date"]
}
```

The kit holds each slice's trades and market data, the reference prices and Greeks (from the current engine with many more paths, or from closed forms) and the check. The run receives only the trades and market data, and writes each trade's price, delta and vega. The check fails the run if any trade is outside its tolerance, and prints one line, such as `{"pass": true, "price_rmse_bp": 0.041, "greeks_rmse_pct": 0.62}`, with price errors in basis points of notional. `risk_s` is the run's time on the judge's clock, and the errors are read from the check. Halving the paths raises the errors by about two-fifths; set the guards' allowances from how far the errors move between seeds. A gain counts only when it is at least 3% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge runs each change several times on every slice, alternating with the best version so far, then fresh runs and the hidden slice for a win, so an attempt takes several times one slice's run. Keep slices to minutes.
- **Where the agents help most.** The implementation: memory layout, vectorization, path reuse, caching, random numbers and Greeks. A new model changes the prices by design, and belongs to the quants and to model validation.
- **Where people stay.** The tolerances and the path count, reading every change to a pricer, model validation, and the move into the production batch.

## What the judge guards against

Speed gained by doing less work: fewer paths, fewer time steps, a looser tolerance, or references made easier to match. The references and tolerances are in the kit, which only the check reads, and the error guards catch a change that stays within each trade's tolerance but is less accurate across the slice. A win must also hold on a slice of your own trades, which the agents never saw and can't download.

## Limits

- A rig measures on one machine, with its CPUs or NVIDIA GPUs. A compute grid is not a target: measure one node's share of the batch.
- Vectorization, fused multiply-add and thread counts move a result's last digits; set tolerances that allow it. For a change that must not move a number, the check can keep the starting engine's outputs and compare each candidate with them.
- A faster engine is not a validated model. Model validation and model risk governance stay with people.
- The trades and market data stay on your machine. An external model receives the engine's code; use a local model if the code must not leave.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** quantitative and risk teams at banks and asset managers. The code and the portfolios stay on your machines, with a local model for the agents if you choose.

## Related work

Giles and Glasserman's adjoint method for Monte Carlo Greeks "outperforms a forward implementation in calculating the sensitivities of a small number of outputs to a large number of inputs", such as a book's sensitivities to the points of a forward curve or a volatility surface ([Giles and Glasserman, 2005](https://ora.ox.ac.uk/objects/uuid:f536b1a8-c988-4bda-9c5f-a322652139fd)). Sakana's AI CUDA Engineer claimed speed-ups of up to 100 times, but its system had found loopholes in the evaluation code that bypassed accuracy checks, and Sakana said it would revise its results ([TechCrunch's report](https://techcrunch.com/2025/02/21/sakana-walks-back-claims-that-its-ai-can-dramatically-speed-up-model-training/)). It is the reason the check must be out of the agents' reach.

## Get started

1. [Install on one machine](../../tutorials/first-run.md), inside your network, then [add a rig](../../how-to/install/rig-on-a-machine.md) on a server like the batch's nodes, or one with an NVIDIA GPU.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around your engine, or QuantLib, and [test it](../../how-to/campaigns/test-a-kit.md) with a change you know is slower and one that halves the paths: the first must lose, and the guards must stop the second.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
