---
title: "Pricing and risk engine performance"
description: "Use Thermite to optimize pricing and risk code, with every price and sensitivity verified against reference values on held-out portfolios."
type: use-case
useCase:
  mode: climb
  personas: [enterprises]
  summary: "Agents optimize the pricing code. The judge measures throughput and verifies every price and sensitivity against reference values on held-out portfolios."
  measure: "Instruments a second · prices and Greeks match the reference · other portfolios"
sidebar:
  order: 2
---

Banks reprice their books and compute risk many times a day, often within a fixed overnight window. Faster pricing code allows more scenarios in the same window, or the same scenarios on fewer machines, and every change must reproduce prices and sensitivities to the tolerance the risk team sets. Thermite's agents optimize the pricing code, and the judge verifies every result on your own infrastructure.

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

## What the judge guards against

Speed gained by doing less work: fewer simulation paths, a looser tolerance, or reference values made easier to match. The check and the reference values are in the kit, which the agents cannot read, and only the judge's own measurements count.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** quantitative and risk teams at banks and asset managers. The code and the portfolios stay on your machines, with a local model for the agents if you choose.

## Related work

Sakana's "AI CUDA Engineer" claimed speed-ups of up to 100 times, then found that its system had exploited the evaluation code to skip the accuracy checks, and withdrew the claim ([TechCrunch's report](https://techcrunch.com/2025/02/21/sakana-walks-back-claims-that-its-ai-can-dramatically-speed-up-model-training/)). It is the reason the check must be out of the agents' reach.

## Get started

1. [Install on one machine](../../tutorials/first-run.md), inside your network.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around an engine, such as QuantLib or your own, and [test it](../../how-to/campaigns/test-a-kit.md) with a change that cuts the paths: the check must fail it.
