---
title: "Irrigation and fertiliser planning"
description: "Use Thermite to develop irrigation and fertiliser policies in a crop simulator, with yield held and performance validated on withheld weather years."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, enterprises]
  summary: "Agents develop irrigation and fertiliser policies. A crop simulator scores each across sites and seasons, with yield held and weather years withheld."
  measure: "Water or nitrogen used · yield held, limits kept · weather years the agents never see"
sidebar:
  order: 1
---

Water and nitrogen requirements depend on soil, crop and weather. Calibrated crop simulators such as DSSAT estimate them for a given site, day by day, which makes them a sound evaluator for management policies: programs that decide daily irrigation and fertiliser applications from inputs that can be measured in the field. Thermite's agents develop the policy, and the simulator is the judge's evaluation.

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

## What the judge guards against

Policies tuned on a single season fit that season's weather, rewards that omit a cost can be maximized with unrealistic application rates, and searches find and exploit simulator flaws. The check enforces per-event and seasonal application limits, withheld weather years test every accepted policy, and every attempt remains on record for review by an agronomist.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** agricultural researchers with a calibrated crop model and a single computer.
- **[Enterprises](../for/enterprises.mdx):** extension services, cooperatives and irrigation equipment makers, testing advice before it reaches a field.

## Related work

In a simulated Florida maize season in gym-DSSAT, a policy driven by a language model used 122 kg of nitrogen a hectare instead of 360, and 192 L/m² of water instead of 394, for a yield of 11,402 kg/ha instead of 10,772 ([Wu and others, 2024](https://arxiv.org/abs/2403.19839)). That result comes from one season, with no year held back. In CropGym, the authors found their policies "exploited a flaw in the nitrogen leaching component" of the crop model ([Kallenberg and others, 2023](https://doi.org/10.1017/eds.2023.28)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around your simulator and calibrated sites, and [test it](../../how-to/campaigns/test-a-kit.md) with a known good policy and an absurd one.
3. A simulated result is a hypothesis for a field trial, not a replacement for one.
