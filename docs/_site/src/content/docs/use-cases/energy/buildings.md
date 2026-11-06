---
title: "Building energy control"
description: "Use Thermite to improve supervisory HVAC sequences or battery dispatch in a building simulator, with comfort and peak demand held and every win checked on a building the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises]
  summary: "Agents rewrite the supervisory controller offline. The judge runs it in BOPTEST or CityLearn, scores cost within a comfort budget, and checks it on a building the agents never see."
  measure: "HVAC cost per m² · comfort budget and peak demand held · a building and weather the agents never see"
sidebar:
  order: 1
---

A commercial building's heating, cooling and ventilation are run by a building management system (BMS): controllers on each air handler, chiller and zone box, programmed by a controls contractor to the sequence of operation that the mechanical engineer wrote. The sequence sets the supply-air temperature, the duct static pressure, each zone's setpoints and when the plant starts in the morning, and it is often a set of fixed schedules from the day the building opened. ASHRAE Guideline 36 sets out high-performance sequences for multiple-zone variable-air-volume (VAV) systems, with trim-and-respond resets that lower a setpoint until zones ask for more. Model predictive control, which plans setpoints from a model of the building and a weather forecast, is widely studied, but each building needs its own model.

Improving a sequence is a search through many small changes whose effect depends on the weather, the tariff and the building's thermal mass: a reset's limits, how early to pre-cool, how deep a night setback goes. A trial in a real building takes weeks for each season, and its savings are judged afterwards against a weather-adjusted baseline. Simulators shorten that loop. BOPTEST packages detailed Modelica models of buildings and their HVAC as test cases, many built on LBNL's Modelica Buildings Library. Each has two-week test periods, weather and price scenarios, and fixed KPIs: energy, cost and emissions per square metre, thermal discomfort in kelvin-hours per zone, and peak demand. CityLearn simulates a neighbourhood of homes with batteries and solar panels. Thermite gives the simulator to a judge the agents can't reach. The agents write the controller offline; no language model runs the building.

## Where Thermite fits

The agents change the supervisory controller: the code that reads the building's measurements at each step and writes setpoints. The judge simulates each test period with it, reads the KPIs, and compares them with the best controller so far. The agents never see the kit, its comfort budgets or the hidden building. They learn only the judge's verdict and its reasons.

## Example campaigns

### 1. Lower HVAC cost in an office, comfort held

An energy-services company wants lower bills for the VAV offices it controls, on a time-of-use tariff, without more complaints.

- **What the agents change:** the controller, which writes the air handler's supply-air temperature and duct static pressure setpoints and the zones' setpoints through BOPTEST's overwrite signals, such as `hvac_oveAhu_TSupSet_u`.
- **What the judge runs:** BOPTEST's `multizone_office_simple_air`, a five-zone VAV floor of a Chicago office, over its peak-cooling, typical-cooling and mixed two-week periods, on the dynamic and highly dynamic price scenarios.
- **The number:** operational cost per square metre over the period, BOPTEST's `cost_tot`. Lower is better.
- **What must hold:** thermal discomfort within a budget you set for each period; peak electric demand at most 5% above the starting controller's.
- **Hidden from the agents:** a model of one of your own buildings, with its weather and tariff: a BOPTEST-style Modelica test case, or an EnergyPlus model driven through its Python API.
- **What agents would try:** trim-and-respond resets of supply-air temperature and static pressure, after Guideline 36; pre-cooling the floor before the dynamic tariff's 2 pm to 7 pm summer peak; a later, weather-dependent morning start; wider zone deadbands; night cooling with outside air.
- **What you get:** the cheapest controller that held, as a commit on the run's branch, and every attempt with its KPIs and the judge's reasons.

### 2. Battery dispatch across a neighbourhood

A home-battery installer wants dispatch rules that lower the bill in every home, not only those they were tuned on.

- **What the agents change:** when each battery charges and discharges, from the hour, the price, solar output and the home's load.
- **What the judge runs:** a year of a CityLearn neighbourhood, such as the CityLearn Challenge 2022's homes, with the rules running every battery.
- **The number:** the district's electricity cost, divided by its cost with the batteries idle. Lower is better.
- **What must hold:** carbon emissions and ramping, as guards.
- **Hidden from the agents:** homes built from your own customers' meter data. The challenge's hidden homes are now public.
- **What agents would try:** charging from the midday solar surplus for the evening peak; a reserve before a cloudy day; staggering homes so that they don't make a new peak together.
- **What you get:** dispatch rules a firmware team can read, with their scores on every cell.

### 3. Read the benchmarks first

A research campaign can first ask "In published BOPTEST results, how much do model predictive and reinforcement-learning controllers save against each test case's baseline, and at what cost in thermal discomfort?" The agents record only claims whose quotes code finds, word for word, in the pages it archived, and a panel of models decides each question. [Interconnection and market rules](interconnection.md) sets out a research campaign in full, with its contract.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "office-hvac-cost",
  "version": 1,
  "title": "Lower HVAC cost in a five-zone office, comfort held",
  "mode": "hill_climb",
  "project": {
    "repo": "supervisory-controller",
    "kit": { "repo": "boptest-office-kit", "commit": "4e7a1c9b2d5f8a0e3b6c9d2f5a8b1e4c7d0a3f6b" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["controller/**"],
  "objective": { "primary": { "metric": "cost_per_m2", "direction": "min", "min_effect": 0.02 } },
  "guards": [
    { "metric": "peak_kw_per_m2", "direction": "min", "max_step_regression": 0.02, "max_total_regression": 0.05 }
  ],
  "cells": ["peak-cool-dynamic", "typical-cool-dynamic", "mix-highly-dynamic"],
  "held_out_cells": ["own-building-summer"]
}
```

The kit holds the test cases, your own building's among them, and each cell's comfort budget. Its run command starts a cell's test case, period and price scenario, and steps the agents' controller through it over BOPTEST's API, 15 minutes at a time. Its check reads BOPTEST's KPIs, fails the run when thermal discomfort is over the cell's budget, and prints one line, such as `{"pass": true, "cost_per_m2": 0.093, "peak_kw_per_m2": 0.036, "discomfort_kh": 3.1}`. The kit names `cost_per_m2` and `peak_kw_per_m2` as numbers read from the check. A gain counts only when it is at least 2% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** Each run simulates two weeks, and a five-zone office simulates more slowly than a single zone. The judge runs each change several times, alternating with the best controller so far, so an attempt costs several simulations of every cell. Time one run of each before you choose the cells.
- **Where the agents help most.** Resets, schedules, pre-cooling and dispatch rules, as plain code a controls engineer can read. Calibrating a predictive controller's model is a larger project.
- **Where people stay.** Setting comfort budgets and tariffs, porting the winner into the BMS, and the trial in a real building.

## What the judge guards against

A controller can save energy by letting rooms drift out of their comfort band, or move load into a new peak that a demand charge bills. The check fails a run over its comfort budget, and the guard holds peak demand. A controller tuned on one Chicago floor can also fail in another building, which is why the CityLearn Challenge 2022 scored teams on homes they had never seen. Keep the hidden building private: the agents' commands can reach the internet, and BOPTEST's and CityLearn's own cases can be downloaded.

## Limits

- A model is not the building: its savings are only as good as its calibration, and a result needs a trial in the real building before it runs one.
- The controller must run as code beside the simulator. Logic that exists only in a BMS vendor's tool has to be written out first, and the winner ported back by people.
- Each BOPTEST period is two weeks of one season. A year's savings need cells across the seasons.
- A rig measures on one machine, with its CPUs, which is all these simulators need.

## Who it's for

- **[Startups](../for/startups.mdx):** energy software companies that need a controller to work in a customer's building, not only in the one it was tuned on.
- **[Enterprises](../for/enterprises.mdx):** building controls makers and owners of large estates.

## Related work

The CityLearn Challenge 2022 gave teams five of a neighbourhood's 17 homes and scored their battery controllers on seven others they never saw ([Nweye and others, 2023](https://proceedings.mlr.press/v220/nweye23a.html)). A review of 66 studies of language models in HVAC operations found that the evidence supports them "primarily as semantic and workflow layers rather than autonomous HVAC controllers" ([the review](https://arxiv.org/abs/2609.05314)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on a machine with CPU cores to spare.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around the simulator, and [test it](../../how-to/campaigns/test-a-kit.md) with your current controller and one that saves energy by being uncomfortable: the check must fail it.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
