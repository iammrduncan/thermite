---
title: "Find irrigation and fertiliser plans in a crop simulator"
description: "Let agents write a policy that decides when to water and fertilise, score it in a crop simulator over many sites and seasons, and keep it only if it saves water and nitrogen at the same yield in years it never saw."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, enterprises]
  summary: "Agents write a policy for water and nitrogen. A crop simulator scores it over sites and seasons, and a win must hold the yield in weather years the agents never see."
  measure: "Water or nitrogen used · yield held, limits kept · weather years the agents never see"
sidebar:
  order: 1
---

How much water and nitrogen a field needs depends on its soil, its crop and the weather. Crop simulators, such as DSSAT, are calibrated to answer that question for a site, day by day. They make a fair judge for a management policy: a small program that reads what a farmer can measure and decides each day how much to irrigate and fertilise. Thermite can put agents on the policy and the simulator in the judge's hands.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md), with `"direction": "min"` on water or nitrogen |
| **The number** | Water (mm) or nitrogen (kg/ha) over the season, from the simulator, reported by the kit's check. Every metric must be above zero, so a return is reported as revenue over cost |
| **What must hold** | Yield, as a guard; each application within the limits you set for an event and a season; the policy reads only what can be measured in the field |
| **Hidden from the agents** | Weather years and a site that a win must also pass. Use weather the agents can't download: your own records, or weather generated from a seed they never see |
| **Where it runs** | A CPU rig. Simulators run in seconds a season, so a campaign can score many sites and years |

## How it runs

1. **You write a kit** whose cases are a site, a soil and a weather year each. Its run command runs the simulator with the agents' policy; its check applies the limits and prints water, nitrogen and yield.
2. **Agents write and improve the policy:** when to irrigate from soil moisture, how to split nitrogen across the season, how to respond to a dry spell.
3. **The judge scores each version** over every visible case, beside the best version so far. A version that saves water but loses yield is a tradeoff, not a win; a win must also hold on the hidden years and site.

## What the judge keeps out

A policy tuned on one season learns that season's weather. A reward that forgets a cost can be won by absurd amounts of fertiliser, and a simulator has flaws that a search will find. The limits are in the check, the hidden years catch a policy that only fits the years it saw, and every attempt stays on record for an agronomist to read.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** an agricultural researcher with a calibrated model and one computer.
- **[Enterprises](../for/enterprises.mdx):** extension services, cooperatives and irrigation equipment makers, testing advice before it reaches a field.

## What others have shown

In a simulated Florida maize season in gym-DSSAT, a policy driven by a language model used 122 kg of nitrogen a hectare instead of 360, and 192 L/m² of water instead of 394, for a yield of 11,402 kg/ha instead of 10,772 ([Wu and others, 2024](https://arxiv.org/abs/2403.19839)). That result comes from one season, with no year held back. In CropGym, the authors found their policies "exploited a flaw in the nitrogen leaching component" of the crop model ([Kallenberg and others, 2023](https://doi.org/10.1017/eds.2023.28)).

## Start

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around your simulator and calibrated sites, and [test it](../../how-to/campaigns/test-a-kit.md) with a known good policy and an absurd one.
3. A simulated result is a hypothesis for a field trial, not a replacement for one.
