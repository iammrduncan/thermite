---
title: "Irrigation and fertiliser planning"
description: "Use Thermite to improve irrigation and nitrogen rules in a calibrated crop model such as DSSAT, scored over many weather years and checked on seasons the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, enterprises]
  summary: "Agents write irrigation and nitrogen rules from field readings. The judge runs them through a calibrated crop model over many seasons, with yield and leaching held."
  measure: "Irrigation water or nitrogen a hectare · yield and leaching held · weather years the agents never see"
sidebar:
  order: 1
---

Agronomists, extension services and crop consultants give irrigation and nitrogen advice, and most of it is a rule. Irrigation is scheduled from soil moisture probes or a water balance: the crop's daily water use is the reference evapotranspiration from a weather station (what well-watered grass would lose) times a crop coefficient for its growth stage, the method of FAO Irrigation and Drainage Paper 56 (FAO-56). The farmer irrigates before the root zone loses more than a set share of its available water; FAO-56 gives 0.55 for grain maize. Nitrogen is split, part before planting and part side-dressed or fertigated (dissolved in irrigation water) as uptake rises, at a rate taken from nitrogen rate trials. Each trial takes a season, and the best rate moves from year to year with the weather.

Crop models let a rule be tried over many seasons first. DSSAT, APSIM, AquaCrop and WOFOST (in Python, through PCSE) simulate a crop day by day from weather, soil and management, once calibrated to the cultivar and soil against local trials. Improving a rule is still a search through many uncertain changes: a threshold, the timing of a split, a response to forecast rain. A change can save water in a wet year and lose yield in a dry one. Today a rule is judged by its water, nitrogen and yield over simulated or real seasons, and by an agronomist's view of whether a farmer could follow it.

## Where Thermite fits

The agents change the rule: a program the kit calls each simulated day, which returns how much water and nitrogen to apply. The judge runs it through the calibrated model over every season of each case and reads irrigation, nitrogen, yield and nitrate leached from the output. The rule gets only what a farmer could know that day; the agents never see the kit, its weather files, the calibration or the hidden seasons.

## Example campaigns

### 1. Less irrigation water, the same yield

An extension service advises maize growers with centre pivots on sandy soil, and wants a schedule that uses less water.

- **What the agents change:** the irrigation rule in `policy/`: when to irrigate and how much.
- **What the judge runs:** DSSAT's maize model through gym-DSSAT, which steps it a day at a time, over twenty weather years at each of two calibrated sites, with the growers' usual nitrogen schedule.
- **The number:** mean seasonal irrigation, in mm. Lower is better.
- **What must hold:** mean yield within 1% of the starting rule's; nitrate leached no more than 5% above it; worst-year yield above a floor the service sets, such as 7,000 kg/ha; no pass above a limit, such as 25 mm.
- **Hidden from the agents:** twenty seasons from DSSAT's WGEN weather generator, fitted to each site's records and run from a seed the agents never see, and a third site with the service's own station records.
- **What agents would try:** a threshold on soil water depletion that tightens from tasselling to early grain fill, when maize is most sensitive to drought; smaller, more frequent passes on sand, which holds little water; skipping a pass when rain is forecast; stopping at physiological maturity; an FAO-56 water balance in place of a calendar.
- **What you get:** the rule that used the least water with yield held, as a commit on the run's branch, and every attempt with its numbers for each site.

### 2. Split nitrogen, less of it leached

A cooperative's agronomists want to cut nitrate losses on irrigated sand without losing yield.

- **What the agents change:** the nitrogen rule: the total, its split between planting, side-dress and fertigation, and what moves it.
- **What the judge runs:** the same seasons, with the irrigation rule fixed.
- **The number:** mean nitrate leached below the root zone, in kg N/ha. Lower is better.
- **What must hold:** yield within 1% of the starting rule's; total nitrogen no higher; no dose above a limit the agronomists set.
- **Hidden from the agents:** the generated seasons, and the same seasons in a second crop model calibrated to the same trials, where a rule that exploits one model's leaching routine fails.
- **What agents would try:** less nitrogen before planting, when the crop takes up little; a side-dress around V6 (six leaves) sized by a soil nitrate test; small doses through the pivot during rapid uptake; holding a dose when heavy rain is forecast.
- **What you get:** the split with the least leaching at the same yield and rate.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "maize-irrigation",
  "version": 1,
  "title": "Less irrigation water, maize yield held",
  "mode": "hill_climb",
  "project": {
    "repo": "irrigation-rules",
    "kit": { "repo": "maize-dssat-kit", "commit": "4c8e2a7f1b9d3e6a0c5f8b2d7e4a1c9f6b3d0e8a" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["policy/**"],
  "objective": { "primary": { "metric": "irrigation_mm", "direction": "min", "min_effect": 0.03 } },
  "guards": [
    { "metric": "yield_kg_ha", "direction": "max", "max_step_regression": 0.005, "max_total_regression": 0.01 },
    { "metric": "n_leached_kg_ha", "direction": "min", "max_step_regression": 0.02, "max_total_regression": 0.05 }
  ],
  "hard_constraints": [{ "kind": "min", "metric": "worst_yield_kg_ha", "value": 7000 }],
  "cells": ["sand-site-a", "sand-site-b"],
  "held_out_cells": ["sand-site-a-generated", "service-station-site"]
}
```

The kit holds gym-DSSAT, each site's calibrated soil and cultivar files, and the weather years. Its run command steps the model through each season of one case and calls the rule daily with days after planting, growth stage, soil water at the probes' depths, the day's weather and a five-day forecast made from the coming days' weather with added error. The model's internal stress indices, which gym-DSSAT exposes by default, are left out. Each case averages twenty seasons, so its values stay above zero when a wet year needs no irrigation. The check fails the run when a pass breaks the limit, and prints one line, such as `{"pass": true, "irrigation_mm": 212.4, "yield_kg_ha": 11240, "n_leached_kg_ha": 31.8, "worst_yield_kg_ha": 8920}`. The kit names all four as numbers read from the check. A gain counts only when it is at least 3% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** A simulated season takes seconds. The judge runs each change several times, alternating with the best rule so far, so an attempt costs several passes over every case: minutes on a CPU rig.
- **Where the agents help most.** A rule's structure: thresholds by growth stage, splits, responses to rain and forecasts, tried over more seasons than a trial covers.
- **Where people stay.** Calibration, limits and floors, judging whether a farmer can follow the rule, and the field trial.

## What the judge guards against

A rule tuned to a few seasons fits their weather, and one that reads the season's weather in advance is no use to a farmer. Crop models also have weak spots a search will find. In CropGym, LINTUL-3 computes nitrogen loss as a fixed share of the fertiliser applied, whatever the timing or weather, so a season's nitrogen could go on in one dose at no cost; the authors limited each application to 40 kg/ha so that their agent could not do it. The kit sets limits of the same kind, gives the rule only field readings, and holds back seasons a win must also pass. Keep those private: historical weather for most places can be downloaded.

## Limits

- A rule is only as good as the model's calibration. Leaching, which few trials measure, is harder to calibrate than yield.
- DSSAT and its peers simulate one uniform plot. Advice for a field's management zones needs a case for each zone.
- A rig measures on one machine. Thermite does not drive a pivot or read live sensors: the result is a hypothesis for a field trial, not a replacement for one.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** agricultural researchers with a calibrated crop model and a single computer.
- **[Enterprises](../for/enterprises.mdx):** extension services, cooperatives and irrigation equipment makers, testing advice before it reaches a field.

## Related work

In a simulated Florida maize season in gym-DSSAT, a policy driven by a language model used 122 kg of nitrogen a hectare instead of 360, and 192 L/m² of water instead of 394, for 11,402 kg/ha of grain instead of 10,772, against rates from a Florida production guide ([Wu and others, 2024](https://arxiv.org/abs/2403.19839)). It is one season, with no year held back. CropGym's authors capped their agent's nitrogen doses because their crop model's losses did not depend on timing ([Kallenberg and others, 2023](https://doi.org/10.1017/eds.2023.28)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md). A CPU rig is enough.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around your calibrated model and sites, and [test it](../../how-to/campaigns/test-a-kit.md) with your current rule and with one that applies more than the limit in one pass: the check must fail the second.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
