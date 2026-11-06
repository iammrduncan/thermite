---
title: "Greenhouse climate control"
description: "Use Thermite to improve a greenhouse climate strategy in the GreenLight model, scored on return over whole seasons with the crop's climate limits held and checked on weather the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises]
  summary: "Agents rewrite the rules for heating, vents, screens, lamps and CO2. The judge runs each season in GL-Gym and scores revenue over energy cost, with climate limits held."
  measure: "Revenue over energy and CO2 cost · climate within limits, yield held · weather the agents never see"
sidebar:
  order: 2
---

A glasshouse growing tomatoes, cucumbers or peppers is run by a climate computer that sets the heating pipes, roof vents, energy and blackout screens, supplementary lamps and CO2 dosing every few minutes. The grower, often with a crop adviser, sets its strategy: day and night temperatures, a rise in temperature with light, a limit on humidity deficit (how much more water the air could hold, in g/m³), when the screens close by outside temperature and radiation, and a daily light integral (the light the crop gets in a day, in mol/m²). Heat and electricity are large costs, and a grower who lights a crop through winter buys power at prices that change every hour.

The settings interact. Closing a screen saves heat and raises humidity; venting the humidity loses heat and CO2; switching the lamps off at a price peak costs light the crop must make up later. Each effect depends on the weather and the prices, so improving a strategy is a search through many uncertain changes. A grower tests a change in one compartment for a season; the Autonomous Greenhouse Challenge ran algorithms against growers in real compartments for six months. A model lets a strategy face many seasons first. GreenLight, an open-source model of a lit tomato greenhouse from Wageningen University, predicted the heat that trial compartments needed under high-pressure sodium (HPS) and LED lamps within 1–12% of the measured values. GL-Gym, built on GreenLight, makes it an environment with six controls: heating, CO2 dosing, thermal screen, roof vents, lamps and blackout screen.

## Where Thermite fits

The agents change the strategy: the code that turns each time step's readings into settings for the six controls. The judge runs it through a season in GL-Gym on each case, with the kit's weather and prices, and reads revenue, costs, yield and climate from the model. The agents never see the weather and price files, the cost model or the hidden seasons.

## Example campaigns

### 1. More return from a lit winter crop

A tomato grower lights the crop through winter with dimmable LEDs and buys electricity on the day-ahead market.

- **What the agents change:** the strategy in `controller/`: setpoints and rules for each control, and how each responds to light, humidity and price.
- **What the judge runs:** the strategy in GL-Gym over a 60-day winter season, GL-Gym's default length, for each of four winters of weather with an hourly price series.
- **The number:** revenue from fruit divided by the cost of heat, electricity and CO2. Higher is better. A ratio stays above zero, as every Thermite metric must; a profit need not.
- **What must hold:** yield within 2% of the starting strategy's; at least 98% of hours with temperature, humidity and CO2 inside the crop's limits; no lamps outside the hours the grower allows.
- **Hidden from the agents:** two winters they can't download: one generated from a seed they never see, and one from the grower's own climate records and energy bills.
- **What agents would try:** lamps off in the dearest hours and on in cheap night hours, with the day's light integral kept; dimming instead of switching; temperature integration, where a cooler night is made up by a warmer day; a day temperature that rises with light; CO2 dosed only while the vents are nearly closed; the energy screen closed earlier on cold, clear nights, with a gap opened for humidity before the vents.
- **What you get:** the strategy with the best return over every case, as a commit on the run's branch, and each attempt's revenue, costs, yield and climate.

### 2. Retune the climate for LED lamps

A grower is replacing HPS lamps with LEDs. LEDs give off little radiant heat and can turn more of their power into light, so the heating often has to make up the difference, and a strategy tuned for HPS no longer fits.

- **Mode:** a goal campaign, which ends when every required goal passes, twice.
- **The goals:** with the LED lamps in the model, at least 98% of hours inside the climate limits on every case; yield at or above the HPS season's; heat and electricity a kilogram at or below a value the grower sets; the same on the hidden winters.
- **What the agents change:** the heating, screen and humidity rules and the lamp schedule.
- **What you get:** a strategy for the new lamps before they are installed, with the judge's measurements for each goal.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "tomato-winter-return",
  "version": 1,
  "title": "Higher return from a lit winter tomato crop",
  "mode": "hill_climb",
  "project": {
    "repo": "climate-strategy",
    "kit": { "repo": "gl-gym-kit", "commit": "e7a19c4d2b8f6031a5c9e4d7b2f8a1c6e3d905b4" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["controller/**"],
  "objective": { "primary": { "metric": "return_ratio", "direction": "max", "min_effect": 0.02 } },
  "guards": [
    { "metric": "yield_kg_m2", "direction": "max", "max_step_regression": 0.01, "max_total_regression": 0.02 }
  ],
  "hard_constraints": [{ "kind": "min", "metric": "in_limits", "value": 0.98 }],
  "cells": ["winter-2009", "winter-2010", "winter-2011", "winter-2012"],
  "held_out_cells": ["winter-generated", "winter-own-records"]
}
```

The kit holds GL-Gym, the weather and price files, the cost model (the prices of fruit, gas, electricity and CO2) and the crop's limits. Its run command runs one case's season, calling the strategy at each time step with what a climate computer reads: indoor temperature, humidity and CO2, outside weather and radiation, the light sum so far and the day's prices. The check fails the run when the season stops early or the lamps run outside the allowed hours, and prints one line, such as `{"pass": true, "return_ratio": 1.27, "yield_kg_m2": 3.6, "in_limits": 0.991}`. `in_limits` is the share of hours inside the limits, not a count of hours outside them, which can be zero. A gain counts only when it is at least 2% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge runs each change several times, alternating with the best strategy so far, so an attempt costs several passes over every case. Keep each case to a season of weeks, as GL-Gym does, and add cases for more weather rather than longer seasons.
- **Where the agents help most.** Rules that weigh price, light and humidity together, tried over many winters.
- **Where people stay.** The crop's limits, the price assumptions, what the model leaves out, such as plant balance and fruit quality, and the trial in a compartment.

## What the judge guards against

A strategy can cut energy by letting the climate drift outside the crop's limits or by giving up yield, and one tuned to a few winters fits their weather. The hard constraint catches the first, the yield guard the second, and the hidden winters the third. Humidity limits stand in for disease, such as grey mould, which the model does not simulate. Keep the hidden weather private: historical weather for most places can be downloaded.

## Limits

- GreenLight was evaluated against compartments at one Dutch research station, with a temperature error (RMSE) of 1.74–2.04 °C. Treat a small gain as a hypothesis.
- The model's crop is tomato. Cucumber, pepper or flowers need their own crop model in the kit.
- Thermite works offline, on one machine. It does not drive a climate computer or read live sensors: the result is a strategy to enter in the climate computer, or a controller to trial.

## Who it's for

- **[Startups](../for/startups.mdx):** greenhouse control companies, testing a controller over many seasons before a grower runs it.
- **[Enterprises](../for/enterprises.mdx):** grower groups and their research teams.

## Related work

In the second Autonomous Greenhouse Challenge, five AI teams each ran a cherry tomato compartment for six months beside a team of experienced growers, and all five made more net profit. The winners made 6.86 €/m² against the growers' 3.10, using 12.9 MJ of heat a kilogram against 33.0 ([Hemming and others, 2020](https://doi.org/10.3390/s20226430)). Those were real greenhouses; Thermite works only in the model. GreenLight's authors give its errors against measured compartments with HPS and LED lamps, and describe how the two lamps change the heat a greenhouse needs ([Katzin and others, 2020](https://doi.org/10.1016/j.biosystemseng.2020.03.010)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md). A CPU rig is enough.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around GL-Gym, and [test it](../../how-to/campaigns/test-a-kit.md) with your current strategy and with one that keeps the lamps on all night: the check must fail the second.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
