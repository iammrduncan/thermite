---
title: "Crop yield forecasting"
description: "Use Thermite to improve a regional crop yield forecast, scored season by season on data cut at the forecast date and checked on yields the agents can't download."
type: use-case
useCase:
  mode: climb
  personas: [enterprises, solo-builders]
  summary: "Agents improve a yield forecast's features and model. The judge trains it on earlier seasons, forecasts each test season from data cut at the forecast date and scores the error."
  measure: "Error as a share of mean yield · data cut at the forecast date · seasons the agents can't download"
sidebar:
  order: 3
---

Yield forecasts are made through the season by agencies, companies and researchers. The European Commission's Joint Research Centre publishes the MARS Bulletin each month, with yield forecasts for Europe's main crops built from satellite and weather observations, weather forecasts, crop growth models, statistics and expert judgement. USDA's National Agricultural Statistics Service (NASS) forecasts US yields monthly from a survey of growers and from counts of plants in sample fields, and assumes normal weather for the rest of the season. Seed companies, crop insurers and traders build their own forecasts, usually by region (county, province or district), from yield statistics, weather, satellite indices such as NDVI and fAPAR (measures of green, active canopy), soil moisture and soil properties, aligned to crop calendars and weighted by crop masks.

A forecast is a long chain of choices: which weather aggregates over which growth stages, how to model the yield trend that better varieties bring, which satellite composites, which learner, what to do with a region that has a short record. A change can help one crop or country and hurt another, and the only fair test is a season the model has not seen. Random splits put records of the same season, with the same weather, on both sides and understate the error. Benchmarks such as CY-Bench leave a whole year out instead, and report the root mean square error as a share of the mean yield (NRMSE) and the mean absolute percentage error (MAPE).

## Where Thermite fits

The agents change the forecasting code: features, trend model and learner. For each test season, the judge gives the code the yields of earlier seasons only and the predictors cut at the forecast date, collects a forecast for every region, and scores it against the reported yields with the kit's check. The agents never see the kit, the test seasons' yields or the hidden seasons.

## Example campaigns

### 1. A smaller error on the same date

A crop insurer forecasts county maize yields on 1 August, before harvest, to set its reserves.

- **What the agents change:** the code in `forecast/`: weather aggregates by growth stage, the trend, the learner and its settings.
- **What the judge runs:** one case for each season from 2016 to 2023. In each, the code trains on the seasons before it and forecasts that season from the data known on 1 August.
- **The number:** NRMSE over the counties in the season. Lower is better.
- **What must hold:** MAPE within 2% of the starting model's, so that a change which wins on large counties at the cost of small ones is a tradeoff; a run under 30 minutes, so the forecast can rerun weekly; a forecast for every county with a reported yield.
- **Hidden from the agents:** two recent seasons of the insurer's own farm yields, averaged by county, which are not published anywhere.
- **What agents would try:** hours above 30 °C around silking; rain minus reference evapotranspiration by growth stage; the NDVI peak and its integral to date; a trend fitted for each region with a robust regression; gradient-boosted trees in place of a linear model; forecasting the departure from trend instead of the yield.
- **What you get:** the forecast with the lowest error that held its guard, as a commit on the run's branch, and every attempt's error season by season.

### 2. A forecast a month earlier

The same team wants a forecast on 1 July that is as good as today's on 1 August.

- **Mode:** a goal campaign, which ends when every required goal passes, twice.
- **The goals:** on 1 July, NRMSE at or below the value the current model reaches on 1 August, on the test seasons and on the hidden ones; a forecast for every county; a run under 30 minutes.
- **What the agents change:** the features and model, with a month less of the season, and seasonal weather forecasts if the kit provides them, cut at the date.
- **What you get:** an earlier forecast with the judge's error for each goal, or evidence that the target can't be met, if the contract allows that ending.

### 3. Read the operational record first

A research campaign can ask: "How large are the MARS Bulletin's and USDA's forecast errors at each month of the season, and which predictors add skill over the trend by mid-season?" A claim counts only when its quotes are found word for word in the pages the fetcher archived.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "county-maize-forecast",
  "version": 1,
  "title": "Smaller error in the 1 August maize forecast",
  "mode": "hill_climb",
  "project": {
    "repo": "yield-forecast",
    "kit": { "repo": "yield-forecast-kit", "commit": "b3d81f6a0c2e9475d8a1b6c3f0e7d2a9c5b84e1f" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["forecast/**"],
  "objective": { "primary": { "metric": "nrmse", "direction": "min", "min_effect": 0.02 } },
  "guards": [
    { "metric": "mape", "direction": "min", "max_step_regression": 0.01, "max_total_regression": 0.02 }
  ],
  "hard_constraints": [{ "kind": "max", "metric": "run_s", "value": 1800 }],
  "cells": ["s2016", "s2017", "s2018", "s2019", "s2020", "s2021", "s2022", "s2023"],
  "held_out_cells": ["own-2024", "own-2025"]
}
```

The kit holds the yield statistics, the predictors and, for each case, a snapshot cut at the forecast date: yields up to the season before, and weather, satellite and soil moisture data up to 1 August of the season itself. Its run command trains and forecasts from that snapshot only. The season's reported yields stay with the check, which fails the run when a county is missing or a forecast is not a positive number, and prints one line, such as `{"pass": true, "nrmse": 0.112, "mape": 0.094}`. The kit names `run_s` as the run's time on the judge's clock, and `nrmse` and `mape` as numbers read from the check ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge runs each change several times, alternating with the best version so far, so an attempt costs several trainings and forecasts for each season. Prepare the predictors once, in the kit, so a run only trains and forecasts.
- **Where the agents help most.** Features and model choices, tried season by season with the same rules each time.
- **Where people stay.** Choosing the regions, the statistics that count as truth and the forecast date, and the analyst's judgement that agencies add before publishing.

## What the judge guards against

Leakage from the future: random splits, a trend or a scaling fitted over every season, satellite indices taken over the whole season, or test seasons seen in training. The kit cuts every input at the forecast date and trains each case on earlier seasons only. That is stricter than leaving one year out, which still trains on the years after it, and it matches what a forecaster has. Published yields can be downloaded, so a model could also learn them; the hidden seasons, from yields no one has published, catch it.

## Limits

- Statistics are revised, and some regions report late or not at all. The kit decides which version is the truth.
- Eight test seasons give a noisy average, and one drought year can decide a verdict. Read the error season by season.
- A regional forecast is only as good as the crop mask and the statistics. A field-level forecast needs field data.
- A rig measures on one machine, with CPUs or NVIDIA GPUs. Process large satellite archives into the kit's snapshots beforehand.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** seed companies, crop insurers and agencies that publish forecasts.
- **[Solo builders](../for/solo-builders.mdx):** researchers starting from a public benchmark such as CY-Bench.

## Related work

On simulated wheat and sunflower yields for farms in Spain, Morales and Villalobos found that a random split understated the error by up to a factor of five. Forecasting later years, their best models, random forests, had errors of 35 to 38%, against 42% for the farm's average yield ([the paper](https://doi.org/10.3389/fpls.2023.1128388)). CY-Bench, a benchmark for maize in 38 countries and wheat in 29, scores models by leaving whole years out ([CY-Bench](https://github.com/WUR-AI/AgML-CY-Bench)). NASS describes its surveys, field counts and assumption of normal weather in [The Yield Forecasting Program of NASS](https://www.nass.usda.gov/Publications/Methodology_and_Data_Quality/Advanced_Topics/Yield%20Forecasting%20Program%20of%20NASS_2023.pdf).

## Get started

1. [Install on one machine](../../tutorials/first-run.md). A CPU rig is enough for most models.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with a case for each season, and [test it](../../how-to/campaigns/test-a-kit.md) with the trend alone, which sets the bar, and with a model that tries to read the season's yields, which the snapshot must make impossible.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
