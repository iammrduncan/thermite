---
title: "Tune a greenhouse climate controller in simulation"
description: "Let agents write the controller for a greenhouse's heating, lighting, CO2 and ventilation, score it in a greenhouse simulator for profit and energy, and keep it only if it holds in weather it never saw."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises]
  summary: "Agents write the climate controller. A greenhouse simulator scores its returns and energy, the crop's limits must hold, and a win must hold in weather they never see."
  measure: "Revenue over cost, or energy a kilogram · climate within limits · weather the agents never see"
sidebar:
  order: 2
---

A greenhouse's controller decides, every few minutes, how much to heat, light, ventilate and add CO2. Each choice trades energy against the crop's growth, and the best trade changes with the weather and the prices. Greenhouse simulators, such as GreenLight-Gym, model the climate and the crop well enough to score a controller over a season in minutes. Thermite can put agents on the controller's code and that score in the judge's hands.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md) |
| **The number** | Revenue over cost for the season, or energy a kilogram of produce with `"direction": "min"`, reported by the kit's check. Every metric must be above zero, which profit itself need not be |
| **What must hold** | Temperature, humidity and CO2 within the crop's limits, with no more breaches than the controller you start from |
| **Hidden from the agents** | Weather years and locations that a win must also pass |
| **Where it runs** | A CPU rig |

## How it runs

1. **You write a kit** whose cases are a season, a location and a weather file each, and whose check runs the simulator with the agents' controller and prints profit, energy and breaches.
2. **Agents try changes** to the controller: when to screen, how to set lighting by the price of power, how to keep humidity down at night.
3. **The judge scores each version** and keeps it only if it beats the best version so far, keeps the climate within limits, and holds on the hidden weather.

## What the judge keeps out

A controller tuned on one weather year is tuned to that year, and a controller that saves energy by letting the climate drift harms the crop. The limits are in the check, and the hidden years and locations test the controller on weather it never saw.

## Who it's for

- **[Startups](../for/startups.mdx):** greenhouse control companies, testing a controller over many seasons before a grower runs it.
- **[Enterprises](../for/enterprises.mdx):** grower groups and their research teams.

## What others have shown

In the second Autonomous Greenhouse Challenge, five AI teams each ran a real greenhouse compartment against commercial growers, and all five did better. The winners made a net profit of 6.86 €/m² against the growers' 3.10, using 12.9 MJ of heat a kilogram of tomatoes against 33.0 ([Hemming and others, 2020](https://doi.org/10.3390/s20226430)). Those were real greenhouses; Thermite works only in the simulator.

## Start

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around the simulator, and [test it](../../how-to/campaigns/test-a-kit.md) with your current controller and with one that breaks the limits.
3. A controller that wins in the simulator still needs a trial in a real compartment.
