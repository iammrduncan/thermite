---
title: "Building simulation validation"
description: "Use a Thermite goal campaign to bring a building energy simulation engine, or the model behind a predictive controller, within the acceptance ranges of ASHRAE Standard 140, one test group at a time, checked by a kit that holds your licensed copy of the cases."
type: use-case
useCase:
  mode: goal
  personas: [startups, enterprises, solo-builders]
  summary: "Agents change the engine's physics code. The judge runs each Standard 140 test group from your licensed cases, counts the results inside the acceptance ranges, and the run ends when every group passes twice."
  measure: "Standard 140 test groups passed · each group's count of results within its ranges · the same cases written in ways the agents never see"
sidebar:
  order: 3
---

Developers of building energy simulation programs test their engines with ASHRAE Standard 140, *Method of Test for Evaluating Building Performance Simulation Software*. Its cases, known as BESTEST (Building Energy Simulation Test), specify simple buildings and systems exactly, so that a program's results can be compared with analytical solutions and with other programs: weather data, a test building's envelope and fabric in low-mass and high-mass forms, a ground-coupled slab, and cooling, heating and air-side HVAC equipment. Addendum b, approved in April 2026, adds the first empirical tests, against data measured in a test facility in France. Appendix G of ASHRAE 90.1, the performance rating method, requires the program to be tested to Standard 140, with its results posted publicly for each tested version. EnergyPlus posts its results with the releases of BESTEST-GSR, the National Laboratory of the Rockies' tool that builds the case models through OpenStudio.

Until the 2023 edition there was no pass or fail. Its Normative Annex A3 sets acceptance ranges for five test groups: the low-mass and high-mass thermal fabric cases, cooling equipment, heating equipment and air-side equipment. The ranges come from nine reference programs, EnergyPlus among them. Each range case, one case's result or the difference between two cases, gets the wider of a statistical band around the programs' median and a band of 5% of the base case's median. Addendum a, approved in 2025, adds hourly loads on two days to the thermal fabric groups, judged by their correlation with, and error from, a representative curve. A group passes when at least 90% of its range cases, rounded down, are in range: with Addendum a, 30 of the low-mass group's 34. Addendum at to Standard 90.1-2022, approved in 2025, requires those counts for every group. Reaching them takes many rounds: a result outside its range can be an input error, a bug or a real difference in modelling, one fix moves other cases, and the whole set runs again for each release. Thermite runs the work as a goal campaign, with one goal for each test group.

## Where Thermite fits

The agents change the engine's source, each in its own copy. The judge builds each change, runs each test group's cases, counts the range cases inside their ranges with the standard's tolerances, and compares the count with the group's minimum. ASHRAE sells the standard, so the kit holds the team's licensed copy of what the judge needs: the input files the team wrote from the specifications, the weather data and Annex A3's ranges. The agents never see the kit or the cases held back for confirmation. They learn each group's count, and which range cases fall outside, from the judge's reasons.

## Example campaigns

### 1. A release that passes every acceptance group

A team ships a building simulation engine that its customers use for code compliance, and its next release must pass Standard 140-2023's acceptance criteria.

- **Mode:** a goal campaign. It ends when every required goal passes on two checks of the best version, hidden cases included, or, as this contract allows, when three different approaches have each been tried and failed.
- **The goals:**
  - the engine builds, its unit tests pass, and it runs the kit's smoke case;
  - thermal fabric, low mass: at least 30 of 34 range cases in range; high mass: at least 25 of 28. These goals, and the three below, require the build, so they run only once it passes;
  - cooling equipment: at least 12 of 14; heating equipment: at least 5 of 6; air-side equipment: at least 48 of 54;
  - the low-mass group still runs in at most 90 seconds, an example limit the team sets from its current engine;
  - for a review panel of models: the modeler report gives a physical reason for each result outside its range, as the standard's report block for anomalous results asks.
- **What the agents change:** the engine's `src/`, and the draft modeler report in `modeler-report/`.
- **What agents would try:** trace each sensitivity outside its range, the difference between two cases, to the model that the one changed input exercises; tell an error in the shape of the hourly loads (a low correlation) from one in their scale (a high RMSE); check the solar distribution, window and convection models against the public reports on the updated cases; for the equipment groups, the part-load and fan-heat calculations.
- **What you get:** an engine branch on which every group passes, the judge's count for each group on every check, and a modeler report draft to review before publishing.

### 2. A control model that passes the thermal fabric groups

A startup's model predictive controller plans each building's setpoints from a fast thermal model, and a customer's engineers ask how far its physics can be trusted. A goal campaign runs the model at an hourly time step, which the standard's detailed (Class I) tests allow, on the low-mass and high-mass groups, with a metric threshold beside them: 100 planning solves in at most 60 seconds, so the controller still plans in time. The agents change the model's structure, such as its thermal nodes and how solar gains split between the air and the mass, and the code that sets its parameters from a building's description.

### 3. Faster, still passing

Once every group passes, a hill climb can make the engine faster. The number is the time to simulate a year of the team's own reference buildings. The test groups are cells too, and their check fails any run below its group's minimum, so no gain in speed can cost a pass.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "std140-acceptance",
  "version": 1,
  "title": "Pass the acceptance criteria of ASHRAE Standard 140-2023",
  "mode": "goal",
  "project": {
    "repo": "sim-engine",
    "kit": { "repo": "std140-kit", "commit": "9b2e4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c5e7b" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["src/**", "modeler-report/**"],
  "goals": [
    { "id": "builds", "description": "the engine builds, its unit tests pass and it runs the kit's smoke case", "verify": { "type": "code", "verifier": "builds" } },
    { "id": "tf-low-mass", "description": "thermal fabric, low mass (Section 7): at least 30 of 34 range cases in range", "verify": { "type": "code", "verifier": "tf-low-mass" } },
    { "id": "tf-high-mass", "description": "thermal fabric, high mass (Section 7): at least 25 of 28 range cases in range", "verify": { "type": "code", "verifier": "tf-high-mass" } },
    { "id": "cooling", "description": "space-cooling equipment (Sections 9.2.3 and 9.2.4): at least 12 of 14 range cases in range", "verify": { "type": "code", "verifier": "cooling" } },
    { "id": "heating", "description": "space-heating equipment (Section 10): at least 5 of 6 range cases in range", "verify": { "type": "code", "verifier": "heating" } },
    { "id": "air-side", "description": "air-side HVAC equipment (Section 11): at least 48 of 54 range cases in range", "verify": { "type": "code", "verifier": "air-side" } },
    { "id": "speed", "description": "the low-mass group runs in at most 90 seconds", "verify": { "type": "metric_threshold", "metric": "suite_s", "op": "<=", "value": 90, "cells": ["tf-low-mass"] } },
    { "id": "modeler-report", "description": "the modeler report explains each result outside its range", "verify": { "type": "review", "criteria": ["every result outside its range is named, with the input that drives it", "each reason is physical, not a note on tuning"] } }
  ],
  "deliverable": "an engine commit that passes every acceptance test group, with its draft modeler report",
  "insufficient": ["code that recognizes a Standard 140 case from its inputs", "a constant changed only to move a result into its range", "a default that applies only to the kit's input files", "results changed after the simulation rather than computed by it"],
  "adversarial_checklist": ["branches on the test building's dimensions, surface names, file names or weather file", "outputs rewritten after the simulation", "a model switched off for some cases"],
  "infeasibility": { "allowed": true, "min_refuted_approaches": 3 },
  "held_out_cells": ["tf-low-mass-alt", "tf-high-mass-alt"]
}
```

The kit holds the team's input files for each case, written from its licensed copy of Standard 140-2023 with Addenda a and b, the weather files, and Annex A3's ranges and curves. The five group verifiers require `builds`, which has the lowest `priority` number and runs first. Each has one cell that runs every case of its group, since most range cases are differences between two cases. The thermal fabric verifiers also have a held-out cell, `tf-low-mass-alt` or `tf-high-mass-alt`: the same buildings with other surface names and order and the coordinates moved to another origin, so the physics and the ranges are unchanged. A group's check reads the outputs its range cases need, such as the thermal fabric groups' annual and hourly loads, computes each range case, applies the standard's tolerances (1% relative, 0.0001 absolute) and prints one line, such as `{"pass": true, "in_range": 31, "range_cases": 34, "required": 30}`; below the minimum, `pass` is false and `reasons` names the range cases outside. The kit names `suite_s` as a time metric: the run's time on the judge's clock ([Contract](../../reference/contract.md#goal), [Kit manifest](../../reference/kit-manifest.md#verifiers)).

## What to expect

- **Time per check.** The low-mass group's cell is one annual simulation for each of its 11 cases, and the speed goal runs it five times. After each promotion, the judge checks every goal. Time each group once before you set the speed limit.
- **Where the agents help most.** The loop of diagnosis: a range case outside, the input that drives it, the model behind it, a fix, and the fix's effect on the other range cases, across five groups.
- **Where people stay.** Writing and checking the input files from the licensed standard; deciding whether a result outside its range is a bug or a real difference in modelling, which the 90% rule allows for; the modeler report and the results published for each version; and the release.

## What the judge guards against

The test buildings are few, small and well known, and Addendum a, a free download from ASHRAE, prints the low-mass and high-mass ranges. An engine could learn to recognize a case and return a number inside its range. Here the input files belong to the kit, outside `editable_paths`, so the agents can't make a case easier. The held-out cells run the same buildings written another way: physics passes there, and code that recognizes a case by its names, order or coordinates does not. Recognizing it by its dimensions is on the checklist of the auditor, who audits every promotion. Addendum at lets a test use "hidden inputs that are not normally accessible to the user"; this contract's `insufficient` list counts a default that applies only to the kit's files as not done. Because the 90% rule passes a group with some results outside, the review goal asks for a physical reason for each.

## Limits

- Annex A3's ranges cover five test groups. The weather data, ground-coupled slab and analytical cooling equipment tests, the simplified (Class II) tests and the empirical tests have none, so a kit checks them against the standard's analytical or example results with tolerances the team sets.
- The ranges change with the reference programs. Addendum c, in public review in August and September 2026, recalculates them and adds the Modelica Buildings Library to the reference set. A kit pins one set of ranges; a new addendum is a new kit commit and contract version.
- A pass shows the engine agrees with the reference programs, not that it predicts a real building. Calibrating a model of a building is separate work, as on [Building energy control](buildings.md).
- ASHRAE sells the standard and its electronic files, and its copyright limits copies. The agents never see the team's licensed copy: they learn from the judge's reasons and from public material such as the addenda.
- Annex A3 says the testing of one program "cannot be used as a proxy for documenting compliance of another software that uses the same calculation engine but a different user interface". A product built on another team's engine runs the cases through its own interface.
- A rig builds and measures on one machine, with its CPUs, which is all these simulations need.

## Who it's for

- **[Startups](../for/startups.mdx):** new simulation engines and control models whose customers ask for their Standard 140 results.
- **[Enterprises](../for/enterprises.mdx):** vendors of compliance software that publish results for each version, and laboratories that maintain engines.
- **[Solo builders](../for/solo-builders.mdx):** an open-source engine kept by one or two people, with the judge doing every release's runs.

## Related work

[Addendum at to Standard 90.1-2022](https://www.ashrae.org/file%20library/technical%20resources/standards%20and%20guidelines/standards%20addenda/90_1_2022_at_20250311.pdf) says that "Prior to the 2023 edition, Standard 140 had test cases with example results to evaluate building performance software, but it did not include any information on when a software's results would be considered acceptable for the test cases." [Addendum b to Standard 140-2023](https://www.ashrae.org/file%20library/technical%20resources/standards%20and%20guidelines/standards%20addenda/140_2023_b_20260424.pdf) adds what it calls "Standard 140's first empirical validation tests, where simulation results are compared to measured data within the uncertainty of the measurements." EnergyPlus's [testing page](https://energyplus.net/testing) says that "the validation primarily follows ASHRAE Standard 140 and is conducted as part of the OpenStudio validation using the same standard", with the results posted with each release of [BESTEST-GSR](https://github.com/NatLabRockies/BESTEST-GSR/releases).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [run a first goal campaign](../../tutorials/first-goal-campaign.md) on the sample project.
2. [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md) says what a goal campaign needs from a kit, and [Write a kit](../../how-to/campaigns/write-a-kit.md#7-add-verifiers-for-goal-campaigns) shows verifiers that require one another.
3. Test the kit with your current engine and with a build that recognizes each case by its surface names and returns a number inside its range: the held-out cells must fail it.
