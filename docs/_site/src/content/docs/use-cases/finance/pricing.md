---
title: "Make a pricing or risk engine faster, with the same numbers"
description: "Speed up the code that prices a portfolio or computes its risk while the judge checks every price and sensitivity against the reference, on portfolios the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [enterprises]
  summary: "Agents speed up the pricing code. The judge times each version and checks every price and sensitivity against the reference, on portfolios they never see."
  measure: "Instruments a second · prices and Greeks match the reference · other portfolios"
sidebar:
  order: 2
---

A bank reprices its books and computes their risk many times a day, and the overnight run has a deadline. Faster pricing code means more scenarios in the same window, or the same scenarios on fewer machines. Every change must give the same prices and sensitivities as before, to the tolerance the risk team sets. Thermite can put agents on the pricing code and that check in the judge's hands, on your own machines.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md) |
| **The number** | Instruments priced a second, or the time for a batch of sensitivities, from the judge's clock |
| **What must hold** | Prices and Greeks match the reference to the tolerance you set; with fixed seeds, a Monte Carlo run matches exactly |
| **Hidden from the agents** | Portfolios that a win must also pass |
| **Where it runs** | A CPU rig, or a CUDA rig for GPU pricing |

## How it runs

1. **You write a kit** that builds the engine, prices a portfolio for each case, and checks the results against reference values.
2. **Agents try changes:** vectorized loops, a better random number generator, caching of curves, a GPU kernel for a hot path.
3. **The judge times each change**, checks every number, and keeps it only if it also holds on the hidden portfolios.

## What the judge keeps out

Speed that comes from skipping work: fewer paths, a looser tolerance, a reference that an agent made easier to match. The check and the references are in the kit, which the agents can't read, and the judge counts only its own measurement.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** quantitative and risk teams at banks and asset managers. The code and the portfolios stay on your machines, with a local model for the agents if you choose.

## What others have shown

Sakana's "AI CUDA Engineer" claimed speed-ups of up to 100 times, then found that its system had exploited the evaluation code to skip the accuracy checks, and withdrew the claim ([TechCrunch's report](https://techcrunch.com/2025/02/21/sakana-walks-back-claims-that-its-ai-can-dramatically-speed-up-model-training/)). It is the reason the check must be out of the agents' reach.

## Start

1. [Install on one machine](../../tutorials/first-run.md), inside your network.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around an engine, such as QuantLib or your own, and [test it](../../how-to/campaigns/test-a-kit.md) with a change that cuts the paths: the check must fail it.
