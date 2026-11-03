---
title: "Building energy control"
description: "Use Thermite to develop building and battery control logic in simulation, with comfort held and results validated on withheld buildings and weather."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises]
  summary: "Agents develop control logic offline. A building simulator scores energy and comfort, and results must hold in withheld buildings and weather."
  measure: "Energy or cost · comfort held · buildings and weather the agents never see"
sidebar:
  order: 1
---

Heating and cooling account for a large share of building energy use, and many buildings still run on fixed rules. A better controller must reduce energy use without reducing occupant comfort. Building simulators such as the BOPTEST test cases evaluate a controller on both, over a year of weather, in minutes. Thermite's agents develop the controller offline; no language model operates the building.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md), with `"direction": "min"` |
| **The number** | Energy, cost or emissions over the test period, from the simulator, reported by the kit's check |
| **What must hold** | Thermal discomfort, as a guard: it may not grow beyond the share you set |
| **Hidden from the agents** | Other buildings, weather periods and price scenarios that a win must also pass |
| **Where it runs** | A CPU rig |

## How it runs

1. **You write a kit** whose cases are a building, a weather period and a price scenario each, and whose check runs the simulation with the agents' controller and prints energy, cost and discomfort.
2. **Agents try changes:** pre-cooling before a price peak, a better setback schedule, charging a battery when power is cheap and clean.
3. **The judge scores each version** beside the best one so far, on every case, and on the hidden ones before a win counts.

## What the judge guards against

A controller can save energy by reducing comfort, or overfit to the one building and year it was tuned on. Comfort is enforced as a guard, and withheld buildings and weather periods test every accepted controller.

## Who it's for

- **[Startups](../for/startups.mdx):** energy software companies that need a controller to work in a customer's building, not only in the one it was tuned on.
- **[Enterprises](../for/enterprises.mdx):** building controls makers and owners of large estates.

## Related work

The CityLearn Challenge 2022 was set up like a Thermite kit: teams saw five buildings, and were scored on seven private ones they never saw ([Nweye and others, 2023](https://proceedings.mlr.press/v220/nweye23a.html)). A review of 66 studies of language models for heating and cooling found that they fit better as "semantic and workflow layers rather than autonomous HVAC controllers" ([the review](https://arxiv.org/abs/2609.05314)): here the model writes the controller, and the controller runs the building.

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around the simulator, and [test it](../../how-to/campaigns/test-a-kit.md) with your current controller and one that saves energy by being uncomfortable.
3. A simulated result needs a trial in a real building before it runs one.
