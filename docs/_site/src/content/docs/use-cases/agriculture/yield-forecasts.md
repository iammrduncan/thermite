---
title: "Crop yield forecasting"
description: "Use Thermite to improve a crop yield forecast, evaluated only on held-out seasons with the data available on the forecast date."
type: use-case
useCase:
  mode: climb
  personas: [enterprises, solo-builders]
  summary: "Agents improve the forecasting model. The judge evaluates it only on held-out seasons, with the data available on the forecast date."
  measure: "Error on unseen seasons · no data from after the forecast date · the latest seasons"
sidebar:
  order: 3
---

A yield forecast is useful only for seasons that have not happened yet. Many forecasts are nevertheless evaluated on random splits of historical data, where test records share seasons and weather with training records, which understates the real error. Thermite evaluates forecasts the way they are used: each test case is an entire held-out season, and the check rejects any data from after the forecast date.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md), with `"direction": "min"` |
| **The number** | Error on held-back seasons, such as the root mean square error as a share of the mean yield, reported by the kit's check |
| **What must hold** | Only data known on the forecast date is used; the forecast beats a trend or a farm-average baseline |
| **Hidden from the agents** | The latest seasons, and regions, that a win must also pass. Use yields the agents can't download: your own, or a season not yet published |
| **Where it runs** | A CPU rig, or a CUDA rig for larger models |

## How it runs

1. **You write a kit** whose cases are a season each, with training data up to that season and the forecast date's features. Its check scores the forecast and checks the features' dates.
2. **Agents try changes:** better features from weather and satellite data, a different model, a better treatment of trend.
3. **The judge scores each version** season by season. A win must hold on the hidden seasons too.

## What the judge guards against

Leakage from the future: random splits, features computed over the whole season, or test seasons seen in training. Each test case is a full season withheld from training, and the check rejects any feature dated after the forecast date.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** seed companies, crop insurers and agencies that publish forecasts.
- **[Solo builders](../for/solo-builders.mdx):** researchers starting from a public benchmark such as CY-Bench.

## Related work

On the same data, Morales and Villalobos measured a forecast error of 6% with a random split and 37% when forecasting future years; the best models, at 35 to 38%, did little better than the farm average at 42% ([the paper](https://doi.org/10.3389/fpls.2023.1128388)). CY-Bench, a benchmark for maize in 38 countries and wheat in 29, scores models by leaving a whole year out for this reason ([CY-Bench](https://github.com/WUR-AI/AgML-CY-Bench)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with a case for each season, and [test it](../../how-to/campaigns/test-a-kit.md) with a model that cheats by reading the future: the check must fail it.
