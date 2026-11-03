---
title: "Greenhouse climate control"
description: "Use Thermite to develop greenhouse climate control in simulation, with crop limits enforced and performance validated on withheld weather years."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises]
  summary: "Agents develop climate control logic. A greenhouse simulator scores returns and energy use, with crop limits enforced and weather years withheld."
  measure: "Revenue over cost, or energy a kilogram · climate within limits · weather the agents never see"
sidebar:
  order: 2
---

A greenhouse controller adjusts heating, lighting, ventilation and CO2 every few minutes, trading energy cost against crop growth under changing weather and prices. Greenhouse simulators such as GreenLight-Gym model climate and crop response well enough to evaluate a controller over a full season in minutes. Thermite's agents develop the control logic, and the simulator is the judge's evaluation.

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

## What the judge guards against

A controller tuned on one weather year may not generalize, and a controller can reduce energy use by letting the climate drift outside the crop's limits. The check enforces the climate limits, and withheld weather years and locations test every accepted controller.

## Who it's for

- **[Startups](../for/startups.mdx):** greenhouse control companies, testing a controller over many seasons before a grower runs it.
- **[Enterprises](../for/enterprises.mdx):** grower groups and their research teams.

## Related work

In the second Autonomous Greenhouse Challenge, five AI teams each ran a real greenhouse compartment against commercial growers, and all five did better. The winners made a net profit of 6.86 €/m² against the growers' 3.10, using 12.9 MJ of heat a kilogram of tomatoes against 33.0 ([Hemming and others, 2020](https://doi.org/10.3390/s20226430)). Those were real greenhouses; Thermite works only in the simulator.

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around the simulator, and [test it](../../how-to/campaigns/test-a-kit.md) with your current controller and with one that breaks the limits.
3. A controller that wins in the simulator still needs a trial in a real compartment.
