---
title: "Staff rostering"
description: "Use a Thermite goal campaign to build rosters for nurses or contact-centre agents that break no hard rule, keep soft penalties below a line and finish within a time limit, checked on public benchmarks and on months of your own data."
type: use-case
useCase:
  mode: goal
  personas: [enterprises, startups]
  summary: "Agents change the rostering model and its search. The judge runs it within the time limit, rebuilds every roster to test each hard rule, and scores its penalty on benchmarks and on your own hidden months."
  measure: "Soft penalty against the best known · every hard rule, each roster rebuilt · months of your own rosters"
sidebar:
  order: 4
---

A ward manager or a rostering team builds a hospital ward's roster weeks ahead in an e-rostering system; a contact centre's workforce management team turns a forecast of contacts into shifts. Hard rules must always hold: cover for each shift and skill, such as a senior nurse on every night; rest between shifts, which the EU's Working Time Directive sets at "a minimum of 11 consecutive hours of rest" in every 24 hours; the most days in a row and the hours each contract allows; and approved leave. Soft rules carry a penalty when broken: requests for shifts or days off, and a fair share of nights and weekends. Teams that build their own engine give a time limit to a solver such as CP-SAT from Google's OR-Tools, Timefold Solver (open source, in Java) or the integer programming solver HiGHS.

The field compares methods on public instances. The Second International Nurse Rostering Competition (INRC-II, 2014–2015) set four hard constraints (one shift a day for each nurse, minimum cover, the legal successions of shift types, and the required skill) and seven weighted soft ones, on datasets of 30 to 120 nurses over 4 or 8 weeks, each solved one week at a time with the history passed on. The Shift Scheduling Benchmark Data Sets add 24 nurse rostering instances of 2 to 52 weeks and 8 to 150 employees, each with its best known solution and lower bound, and 225 instances for staff who move between activities during a shift. The failures in practice are harder to see: a hard rule modelled as a costly soft one, broken when time runs short; a solver tuned to benchmarks that fails on a ward's own contracts; a solver's report of its own penalty, taken on trust. Thermite runs rostering as a goal campaign, with each family of hard rules a goal and the penalty a threshold, checked by a kit the agents can't see.

## Where Thermite fits

The agents change the solver, each in its own copy: its model, its search and its parameters. The judge builds each change and runs it on every instance of a cell within the cell's time limit; the kit's check then reads the roster, rebuilds each person's sequence of shifts, tests every hard rule and computes the penalty with the kit's weights. The agents never see the check or the hospital's months, the one held back for the final checks included. They learn which goal failed and why, never which hidden case.

## Example campaigns

### 1. Ward rosters that break no rule

A hospital group's rostering team builds four-week rosters for its wards. It wants a CP-SAT solver that meets every rule in its contracts and does better on requests and fairness than the rosters its wards publish today.

- **Mode:** a goal campaign. It ends when every required goal passes on two checks of the best version, the hidden month included.
- **The goals:**
  - the solver builds, and returns a roster for INRC-II's smallest test dataset within its limit;
  - INRC-II's four hard constraints hold in every week of its 4-week datasets of 30, 50 and 80 nurses, each week solved within the kit's limit; this goal runs only once the first passes;
  - on instances 1 to 12 of the Shift Scheduling Benchmark, every hard constraint holds and the penalty is at most 3% above the best known solution, the whole 95% interval of five runs below the line;
  - on the hospital's own months: cover for every shift and skill, 11 hours' rest between shifts, no more days in a row and no more hours than each contract allows, and no shift on approved leave. One month is held back for confirmation;
  - on the same months, the penalty for missed requests and an unfair share of nights and weekends, with the weights the wards agreed, is at most 90% of the published rosters', scored the same way.
- **What the agents change:** the solver in `rostering/`: the CP-SAT model, its search parameters and any decomposition around it.
- **What agents would try:** sliding windows, or CP-SAT's `add_automaton`, for days in a row and successions of shifts; hints from the last period's roster with `add_hint`; cover and rest first, then the penalty; a week or a ward at a time, then a large neighbourhood search over a few nurses; more or fewer search workers (`num_workers`).
- **What you get:** the solver, as a commit on the run's branch, and for each goal the judge's evidence. The goal report shows how far each penalty is from its line.

### 2. A contact centre's weekly shifts

A contact centre schedules 300 agents across calls, chat and email, from a forecast of the agents each activity needs in each 15-minute interval.

- **Mode:** a hill climb: cover improves in many small steps.
- **What the agents change:** the shift builder: the shifts it offers, where it places breaks, and how it assigns agents and activities.
- **The number:** the penalty for intervals over or under the forecast, on each week of past forecasts and on the benchmark's multi-activity instances, plus one, since every value must be above zero. Lower is better.
- **What must hold:** each agent's contracted hours, shift lengths, breaks, skills and rest, or the check fails the week; the spread of late shifts between agents, as a guard; a five-minute limit on the judge's clock.
- **Hidden from the agents:** later weeks of the centre's forecasts.
- **What agents would try:** start times every 15 minutes; breaks placed after the cover is set; a set-covering model of candidate shifts solved with HiGHS.
- **What you get:** the builder that covered the forecast most closely, with its penalty on every week.

### 3. Read the rules first

Before either, a research campaign can collect the rules the kit must enforce: which limits on rest, night work and weekly hours apply to your staff in each country, and what national law and collective agreements add. Each rule is quoted from the official page that states it, and code checks every quote and number against the archived copy. [Supply chain mapping](supply-chain-mapping.md) shows a research campaign of this field in full.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "ward-rosters",
  "version": 1,
  "title": "Four-week ward rosters that break no rule, within the time limit",
  "mode": "goal",
  "project": {
    "repo": "roster-solver",
    "kit": { "repo": "roster-kit", "commit": "5e1a9c3f7b2d4e6a8c0f1b3d5e7a9c2f4b6d8e0a" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["rostering/**"],
  "goals": [
    { "id": "solves", "description": "builds, and returns a roster for INRC-II's test dataset n005w4 within its limit", "verify": { "type": "code", "verifier": "solves" } },
    { "id": "inrc2-hard", "description": "INRC-II's four hard constraints hold in every week of n030w4, n050w4 and n080w4, each week solved within its limit", "verify": { "type": "code", "verifier": "inrc2-hard" } },
    { "id": "benchmark-penalty", "description": "on instances 1 to 12 of the Shift Scheduling Benchmark, every hard constraint holds and the penalty is at most 3% above the best known solution", "verify": { "type": "metric_threshold", "metric": "penalty_ratio", "op": "<=", "value": 1.03, "cells": ["ssb-1-6", "ssb-7-12"] } },
    { "id": "own-rules", "description": "on the hospital's own months: cover for every shift and skill, 11 hours' rest, days in a row and hours within each contract, and no shift on approved leave", "verify": { "type": "code", "verifier": "own-rules" } },
    { "id": "own-penalty", "description": "on the hospital's own months, the penalty for missed requests and unfair nights and weekends is at most 90% of the published rosters'", "verify": { "type": "metric_threshold", "metric": "penalty_vs_published", "op": "<=", "value": 0.9, "cells": ["own-2025", "own-held"] } }
  ],
  "deliverable": "a solver that meets every required goal, as a commit on the run's branch",
  "insufficient": [
    "a hard rule turned into a soft penalty",
    "a stored or downloaded roster returned for a known instance",
    "nurses, shifts or leave left out of an instance before solving"
  ],
  "adversarial_checklist": [
    "the solver reads a published solution from a file or the network",
    "the solver recognizes a benchmark instance and special-cases it",
    "the solver takes its time limit from anywhere but the cell's parameters"
  ],
  "held_out_cells": ["own-held"]
}
```

The kit holds INRC-II's datasets, the benchmark's instances 1 to 12 with their best known solutions, and the hospital's months: demand by shift and skill, each nurse's contract, skills, leave and requests, and the published rosters. Its verifier `solves` has priority 10 and the cell `n005w4`; `inrc2-hard` (cells `n030w4`, `n050w4` and `n080w4`) and `own-rules` (cells `own-2025` and the held-out `own-held`) require it. For INRC-II's cells the run command gives the solver one week at a time, with the history the week before left, as the competition's simulator does. Each cell's parameters give the solver its limit, and its `timeout_s` stops a run that overruns. The check fails a roster that breaks a rule, with a reason such as `cover short: ward 4B, night, 3 March, senior nurse: 1 of 2`, and otherwise prints one line, such as `{"pass": true, "hard_violations": 0, "penalty": 1781, "penalty_ratio": 1.038}` for the benchmark's Instance4, whose best known solution is 1716. `penalty_vs_published` is the penalty plus one over the published rosters' penalty plus one, since every value must be above zero ([Contract](../../reference/contract.md#goal), [Kit manifest](../../reference/kit-manifest.md#verifiers)).

## What to expect

- **Time per check.** Each threshold goal runs every cell five times: at two minutes an instance, the two benchmark cells of six instances take two hours. After each promotion the judge checks every goal, so give the cheap verifiers the lower priority numbers, and set the limits you plan with, no longer.
- **A quiet machine.** On a CPU rig the judge waits for the agents' builds to leave the cores free ([Sharing a device](../../explanation/sharing-a-device.md)). A solver that searches on several threads can return a different roster each run; the five runs and the interval allow for it.
- **Where the agents help most.** Formulations, search settings and decompositions, each change checked against every rule.
- **Where people stay.** Writing the rules into the kit and agreeing the weights with the wards; reading the rosters; and the approval each roster still needs before it is published.

## What the judge guards against

A solver that reports its own penalty can misreport it, and one that treats the 11 hours' rest as a costly soft rule can break it when time runs short and still score well. Here the check rebuilds every roster and tests every hard rule itself, so a roster that breaks one fails whatever its penalty, and the time limit is on the judge's clock. The benchmark instances and many of their best known solutions can be downloaded, and the agents' commands can reach the internet. So the auditor checks every promotion for a solver that reads a published solution or recognizes an instance, and the hidden month of your own data, which can't be downloaded, must pass before the run closes.

## Limits

- A roster meets the rules the kit encodes. Rules people apply by judgement, such as which nurses work well together on a night, stay with the person who approves the roster.
- The judge measures a roster planned ahead. Sickness, swaps and gaps that open during the period are not in it, unless the kit simulates them.
- A rig measures on one machine, with its CPUs. A solver that runs across several machines is not a target.
- Rostering data is personal data. The agents never see the kit, but keep names out of it: an id for each person is enough for every rule.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** hospital groups and contact centres that build their own rosters, on your own machines, with your staff's data kept there.
- **[Startups](../for/startups.mdx):** workforce management and e-rostering software companies, testing their solvers on the kinds of rosters their customers build.

## Related work

The rules of INRC-II said that, to rank the finalists, "New instances, including hidden datasets, will be used." ([Ceschia and others, 2015](https://arxiv.org/abs/1501.04177)); the organizers' report on the competition is in [Annals of Operations Research](https://link.springer.com/article/10.1007/s10479-018-2816-0) (2019). The [Shift Scheduling Benchmark's nurse rostering instances](https://www.schedulingbenchmarks.org/nrp/) list best known solutions and lower bounds, and say that "All solutions are verified before being reported on this website. It is not possible to verify lower bounds." On the largest instance, 52 weeks and 150 employees, the best known solution, 40439, is one above the best known lower bound.

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [run a first goal campaign](../../tutorials/first-goal-campaign.md) on the sample project.
2. [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md) says what a goal campaign needs from a kit, and [Write a kit](../../how-to/campaigns/write-a-kit.md#7-add-verifiers-for-goal-campaigns) shows verifiers that require one another.
3. [Test the kit](../../how-to/campaigns/test-a-kit.md) with a roster that breaks one rule of each kind: each check must fail it.
