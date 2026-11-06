---
title: "Pricing model validation"
description: "Use a Thermite goal campaign to bring a new pricing model to validation, with benchmark, no-arbitrage, convergence, stress and run-time tests in a kit the agents can't see, on market data from days they never see."
type: use-case
useCase:
  mode: goal
  personas: [enterprises, startups]
  summary: "Agents implement and fix a new pricing model. The judge runs the validation plan's tests, from benchmark prices and no-arbitrage to convergence and stress, and the run ends when every goal passes twice."
  measure: "Validation tests passed, goal by goal · benchmarks, no-arbitrage and convergence held · market data from unseen days"
sidebar:
  order: 4
---

Before a bank prices trades with a new model, its model risk management function validates it. The quants who built the model hand over its documentation and their own tests. Validators, independent of the desk, review the theory, rebuild parts of the implementation, compare its prices with other models and closed forms, test limit and stress cases, and record findings the developers must fix. In the US, the guidance is SR 26-2, which the Federal Reserve, the OCC and the FDIC issued in April 2026 in place of SR 11-7 of 2011. Its components of validation are conceptual soundness, outcomes analysis and ongoing monitoring. It calls model testing "a core component of model development", and says that validation "generally occurs prior to a model's first use."

Take a local-stochastic volatility (LSV) model for FX barrier and touch options, which pay or vanish when the exchange rate touches a level. It multiplies a stochastic volatility, such as Heston's, by a leverage function of spot and time, calibrated so that the model reprices the market's vanilla options. Much of what goes wrong is in the code, not the theory: a leverage function noisy in the wings, a grid too coarse near a barrier, a barrier observed once a day priced as if watched continuously, a calibration that fails on a stressed surface. Each finding goes back to the developers, and the validation waits. Thermite runs that loop as a goal campaign: each test in the validation plan is a goal, checked by a kit the agents can't see, on market data that includes days they never see.

## Where Thermite fits

The agents change the model's code, each in its own copy: the calibration, the grid (PDE) and Monte Carlo pricers, the volatility surface and the documentation. The judge builds each version and runs the kit's tests. The agents never see the market data, the benchmark prices, the tolerances or the hidden days, and learn only which goal failed and how. In [Pricing and risk engine performance](../finance/pricing.md), an approved engine must keep its numbers as it gets faster; here the prices are new by design, and what must hold is the validation plan. The result is the developers' evidence for the validators, whose review, own tests and approval stay with them.

## Example campaigns

### 1. An LSV model for FX barrier and touch options

An FX options desk wants to price one-touch, double-no-touch and knock-out options on EUR/USD and USD/JPY with an LSV model in place of its local volatility model. The validation team has set the tests it must pass before review.

- **Mode:** a goal campaign. It ends when every required goal passes on two checks of the best version, hidden days included, or, as this contract allows, when three different approaches have each been tried and failed: evidence the validators can read too.
- **The goals:**
  - the model builds with the kit's toolchain, and its unit tests pass;
  - calibration: it reprices each vanilla quote it was calibrated to (at-the-money, 25-delta and 10-delta risk reversals and butterflies at each tenor: the FX market's standard quotes) within 0.1 volatility points, on each test day. The benchmark, no-arbitrage, convergence and stress goals require it, so they run only once it passes;
  - limit cases: with the leverage function at one, vanilla prices match the Heston model's semi-closed form; with no volatility of volatility, barrier prices match the local volatility model's;
  - benchmark: barrier and touch prices within tolerance of an independent implementation, QuantLib's Heston stochastic local volatility model;
  - no arbitrage: put-call parity holds, a knock-out and its knock-in add up to the vanilla, and call prices fall and are convex in strike;
  - convergence: as the grid and the paths double, each price moves less than its tolerance, and less each time;
  - stress: on shocked market data, the calibration converges, the leverage function stays finite and positive, and the no-arbitrage checks hold;
  - run time: the 200-trade test book calibrates and prices in 120 seconds or less, on the judge's clock;
  - for a review panel of models: the documentation states the model's purpose, theory, assumptions, calibration and limitations, and every test with its result.
- **What the agents change:** `src/lsv/`, `src/calibration/`, `src/pricers/` and `model-docs/`.
- **What agents would try:** calibrating the leverage function by Monte Carlo, with paths grouped by spot, or through the forward Fokker–Planck equation on a grid, as QuantLib's `HestonSLVMCModel` and `HestonSLVFDMModel` do; an arbitrage-free interpolation of the volatility surface; grids concentrated near spot and the barriers; a correction for barriers observed once a day; fully implicit first time steps, so that the payoff's kinks don't oscillate.
- **What you get:** a branch with the model and its documentation and, for each goal, the errors the judge measured on each test day.

### 2. A new SOFR curve build

A rates desk moves its USD curve, built from SOFR futures and overnight index swaps, to a new interpolation and a new treatment of the year-end turn.

- **The goals:** every input instrument reprices to its quote within a tolerance you set, such as 0.01 basis points; discount factors within tolerance of the current build where the two methods should agree; the sensitivities to each input quote add up, within tolerance, to the sensitivity to a parallel shift; each curve builds in under a second; all of it also on curve dates from the desk's own marks that the agents never see.
- **What you get:** a curve build that meets each goal, with the judge's evidence for each.

### 3. Read the published tests first

A research campaign can first answer a question such as "Which tests do published studies of LSV calibration use, and where do they report it failing?" The agents read papers in arXiv's HTML versions and open-source test suites, a claim counts only when code finds its quotes word for word in the archived page, and a review panel of models decides. [Research from public filings](../finance/filings-research.md) describes a larger research campaign in finance.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "fx-lsv-validation",
  "version": 1,
  "title": "An LSV model for FX barriers, ready for validation",
  "mode": "goal",
  "project": {
    "repo": "fx-models",
    "kit": { "repo": "fx-lsv-validation-kit", "commit": "8d2f4a6c1e9b3d5f7a0c2e4b6d8f1a3c5e7b9d0f" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["src/lsv/**", "src/calibration/**", "src/pricers/**", "model-docs/**"],
  "forbidden_patterns": ["HestonSLV", "hestonslv"],
  "goals": [
    { "id": "builds", "description": "builds with the kit's toolchain, and the unit tests pass", "verify": { "type": "code", "verifier": "builds" } },
    { "id": "calibration", "description": "reprices every calibration quote within 0.1 volatility points, on each test day", "verify": { "type": "code", "verifier": "calibration" } },
    { "id": "limit-cases", "description": "matches the Heston semi-closed form with the leverage at one, and the local volatility model with no volatility of volatility", "verify": { "type": "code", "verifier": "limit-cases" } },
    { "id": "benchmark", "description": "barrier and touch prices within tolerance of QuantLib's Heston stochastic local volatility model", "verify": { "type": "code", "verifier": "benchmark" } },
    { "id": "no-arbitrage", "description": "put-call and in-out parity hold; call prices fall and are convex in strike", "verify": { "type": "code", "verifier": "no-arbitrage" } },
    { "id": "convergence", "description": "each price moves less than its tolerance, and less each time, as the grid and the paths double", "verify": { "type": "code", "verifier": "convergence" } },
    { "id": "stress", "description": "on shocked market data, the calibration converges and the no-arbitrage checks hold", "verify": { "type": "code", "verifier": "stress" } },
    { "id": "run-time", "description": "calibrates and prices the 200-trade test book in 120 seconds or less", "verify": { "type": "metric_threshold", "metric": "book_s", "op": "<=", "value": 120, "cells": ["book-200"] } },
    { "id": "documentation", "description": "the documentation is ready for the validators", "verify": { "type": "review", "criteria": ["states the model's purpose and intended use", "gives the theory, the assumptions and the calibration method", "names the model's limitations", "describes every test and its result"] } }
  ],
  "deliverable": "a branch with the model, its documentation and the judge's evidence for each goal",
  "insufficient": ["a tolerance or a test loosened in the model's code", "special cases for the test days or trades"],
  "adversarial_checklist": ["a pricer that recognizes the test trades or dates", "a calibration that stops early and reports success", "a timed run on a coarser grid than the convergence test's"],
  "infeasibility": { "allowed": true, "min_refuted_approaches": 3 },
  "held_out_cells": ["eurusd-hidden-days", "usdjpy-hidden-days"]
}
```

The kit holds the market data for each test day (spot, rates and volatility quotes), the shocked scenarios, the benchmark prices, the tolerances and the check. Its verifier `builds` has priority 1; `calibration` and `limit-cases` require it, with priority 10; `benchmark`, `no-arbitrage`, `convergence` and `stress` require `calibration`, with priority 20, so the slow goals run only once the cheap ones pass. `calibration` and `benchmark` have a cell for each currency pair and test day, and the held-out cells `eurusd-hidden-days` and `usdjpy-hidden-days`: the desk's own end-of-day marks for days the agents never see, which are not on the internet. Each run writes its repricing errors and prices, and the check prints one line, such as `{"pass": true, "max_vol_error": 0.04, "max_price_error_bp": 0.6, "trades": 412}`, with `pass` false when any figure is outside its tolerance. `book_s` is the `book-200` cell's time on the judge's clock. The forbidden patterns refuse an added line that names QuantLib's SLV classes or headers, so the benchmark can't price itself ([Contract](../../reference/contract.md#goal), [Kit manifest](../../reference/kit-manifest.md#verifiers)).

## What to expect

- **Time per check.** A goal's check is a build, then calibration and pricing on each test day. The convergence goal prices the book at several grid sizes and is the slowest, and the run-time goal runs its cell five times (`threshold_reps`). After each promotion, the judge checks every goal.
- **Where the agents help most.** The numerical work between findings: stable calibration in the wings, grids and time steps, barrier observation, and the documentation kept in step with the code.
- **Where people stay.** The choice of model and its theory; the validation plan, the tolerances and the benchmarks; the validators' own review and tests; approval, the model's limits of use, and monitoring once it is in production.

## What the judge guards against

The easiest way through a validation test is to change the test. Here the tests, the tolerances, the benchmark prices and the market data belong to the kit, which only the check reads. The forbidden patterns keep the benchmark's code out of the model, and the auditor reads every promotion against the adversarial checklist. The timed cell's prices are held to the same tolerances, so a coarser grid shows there too. The hidden days catch a model tuned to the visible ones: the agents learn that a hidden check failed and how, never which day.

## Limits

- Thermite doesn't validate the model. SR 26-2 asks for effective challenge by people with "sufficient independence to maintain objectivity". A review panel of models is not that, and its pass on the documentation is not a validator's.
- Ongoing monitoring, and outcomes analysis against the desk's real trading, happen once the model is in use. A goal tests the model only on the past data the kit holds.
- A rig measures on one machine, with its CPUs or NVIDIA GPUs, and reads no live market data. A model that passes every goal can still fail on a product outside the test book, such as a window barrier.
- Market data licences can restrict this use. The data stays on your machine; the agents' model provider receives the model's code, so use a local model if the code must not leave.
- The tolerances here are examples. Set yours with the validators.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** quant teams at banks, and the validation teams who set their tests, on your own machines. SR 26-2 is "expected to be most relevant to banking organizations with over $30 billion in total assets regulated by the Federal Reserve".
- **[Startups](../for/startups.mdx):** vendors of pricing models and libraries. Banks validate vendor models too, and SR 26-2 says that "the principles of model risk management remain applicable".

## Related work

[SR 26-2](https://www.federalreserve.gov/supervisionreg/srletters/SR2602.htm) (April 17, 2026) "supersedes and replaces SR letter 11-7". Its [guidance](https://www.federalreserve.gov/supervisionreg/srletters/SR2602a1.pdf) defines effective challenge as "critical analysis conducted by objective experts who evaluate model risk and effect appropriate changes", and says conceptual soundness may be assessed by "benchmarking to other models". [QuantLib](https://github.com/lballabio/QuantLib)'s two Heston stochastic local volatility models can serve a kit as the independent benchmark.

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [run a first goal campaign](../../tutorials/first-goal-campaign.md) on the sample project.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md#7-add-verifiers-for-goal-campaigns) with the validation plan's tests as verifiers, and [test it](../../how-to/campaigns/test-a-kit.md) with a version you know fails, such as a calibration stopped after one iteration: its goals must fail.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign. When it ends, hand the branch and the evidence to the validators.
