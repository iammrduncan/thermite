---
title: "Write building and battery controllers, scored in a simulator"
description: "Let agents write the control code for a building's heating and cooling or a battery's charging, score it in a building simulator for energy, cost and comfort, and keep it only if it holds in buildings and weather it never saw."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises]
  summary: "Agents write the controller's code. A building simulator scores its energy and comfort, and a win must hold in buildings and weather they never see. No model runs the building."
  measure: "Energy or cost · comfort held · buildings and weather the agents never see"
sidebar:
  order: 1
---

Heating and cooling are a large share of a building's energy, and most buildings run on simple rules set years ago. A better controller has to save energy without making the people inside too hot or too cold. Building simulators, such as the BOPTEST test cases, score a controller on exactly that, for a year of weather in minutes. Thermite can put agents on the controller's code and the simulator in the judge's hands. The agents write code offline; no language model controls the building.

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

## What the judge keeps out

A controller can save energy by letting the building get uncomfortable, or learn the one building and the one year it was tuned on. Comfort is a guard, and the hidden buildings and weather catch a controller that only fits what it saw.

## Who it's for

- **[Startups](../for/startups.mdx):** energy software companies that need a controller to work in a customer's building, not only in the one it was tuned on.
- **[Enterprises](../for/enterprises.mdx):** building controls makers and owners of large estates.

## What others have shown

The CityLearn Challenge 2022 was set up like a Thermite kit: teams saw five buildings, and were scored on seven private ones they never saw ([Nweye and others, 2023](https://proceedings.mlr.press/v220/nweye23a.html)). A review of 66 studies of language models for heating and cooling found that they fit better as "semantic and workflow layers rather than autonomous HVAC controllers" ([the review](https://arxiv.org/abs/2609.05314)): here the model writes the controller, and the controller runs the building.

## Start

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around the simulator, and [test it](../../how-to/campaigns/test-a-kit.md) with your current controller and one that saves energy by being uncomfortable.
3. A simulated result needs a trial in a real building before it runs one.
