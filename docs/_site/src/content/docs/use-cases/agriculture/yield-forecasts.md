---
title: "Build a yield forecast that holds next season"
description: "Let agents improve a crop yield forecast while the judge scores it only on seasons it never saw, with features limited to what is known on the forecast date."
type: use-case
useCase:
  mode: climb
  personas: [enterprises, solo-builders]
  summary: "Agents improve the forecast. The judge scores it only on whole seasons it never saw, with data known by the forecast date, against a simple baseline."
  measure: "Error on unseen seasons · no data from after the forecast date · the latest seasons"
sidebar:
  order: 3
---

A yield forecast is useful only for a season that hasn't happened. Yet many forecasts are scored on a random split of past data, where the test rows share a season, and its weather, with the training rows. The error looks small on paper and large the next year. Thermite can put agents on a forecast with the honest test built in: every case is a whole season held back, and the check refuses data from after the forecast date.

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

## What the judge keeps out

Leaks from the future: a random split, a feature computed from the whole season, a test season the model saw in training. Each case is a season the model has not seen, and the check refuses a feature from after the forecast date.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** seed companies, crop insurers and agencies that publish forecasts.
- **[Solo builders](../for/solo-builders.mdx):** a researcher with a model and a public benchmark, such as CY-Bench, to start from.

## What others have shown

On the same data, Morales and Villalobos measured a forecast error of 6% with a random split and 37% when forecasting future years; the best models, at 35 to 38%, did little better than the farm average at 42% ([the paper](https://doi.org/10.3389/fpls.2023.1128388)). CY-Bench, a benchmark for maize in 38 countries and wheat in 29, scores models by leaving a whole year out for this reason ([CY-Bench](https://github.com/WUR-AI/AgML-CY-Bench)).

## Start

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with a case for each season, and [test it](../../how-to/campaigns/test-a-kit.md) with a model that cheats by reading the future: the check must fail it.
