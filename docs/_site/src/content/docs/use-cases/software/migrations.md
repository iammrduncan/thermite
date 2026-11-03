---
title: "Codebase migration"
description: "Use a Thermite goal campaign to migrate a codebase to a new framework, language version or API, with each module's tests as a goal and the tests held outside the agents' reach."
type: use-case
useCase:
  mode: goal
  personas: [enterprises, startups]
  summary: "Define each module's migration as a goal. Agents work until every goal passes, against tests held in the kit, outside the agents' reach."
  measure: "Goals met · tests from the kit, not the agents' copy · integration tests"
sidebar:
  order: 2
---

Migrations, such as moving to a new framework, language version or API, are straightforward to define and slow to complete. The existing test suite already defines when the work is done. Thermite runs a migration as a goal campaign: you define the goals, agents work on them in parallel, and the campaign ends when the judge confirms that every required goal passes.

## The campaign

| | |
| --- | --- |
| **Mode** | [Goal](../../explanation/campaign-modes.md): make something work, checked by named sets of tests |
| **The goals** | One for each module or package: it builds on the new framework, and its tests pass. Add goals for lint and type checks |
| **What must hold** | The tests the judge runs come from the kit, so an agent who edits a test in its own copy changes nothing that counts |
| **Hidden from the agents** | Integration tests that run only before a goal counts as met, and again before the run closes |
| **Where it runs** | A CPU rig, or several: one campaign can run on many rigs at once |

## How it runs

1. **You write a kit** with a **verifier** for each goal: a named set of test cases, which passes when every case in it passes. A verifier can require others first, so a module's tests run only once it builds ([Write a kit](../../how-to/campaigns/write-a-kit.md#7-add-verifiers-for-goal-campaigns)).
2. **You write a contract** that lists the goals, which ones are required, and the folders the agents may change ([Write a contract](../../how-to/campaigns/write-a-contract.md)).
3. **Agents work on the open goals, in parallel.** After each promotion the judge checks every goal on the best version, and the planner and the agents read that report, so they know which goals are still open and how far each one is. A change counts as progress when it meets a goal that the best version does not, and loses none that it meets.
4. **The campaign ends itself** when the judge sees every required goal pass, twice, independently. Where your contract allows it, it can also end when the evidence shows the goals can't be met: several different approaches, each tried and failed. You can have that ending wait for your yes. No agent can mark a goal met or close the run.

## What the judge guards against

The easiest way to make a failing test pass is to change the test, and agents do so frequently when unchecked. In Thermite, the tests that count belong to the kit, which the agents never see, and the judge runs them on a build it produced itself. Changes to tests in the agents' own copy have no effect on the result.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** migrations that would take a team months, run on your own machines against private repositories, with the evidence for each goal on record.
- **[Startups](../for/startups.mdx):** complete framework upgrades without pausing feature work.

## Related work

Airbnb moved nearly 3,500 test files from Enzyme to React Testing Library with an LLM pipeline in about six weeks, against an estimate of a year and a half by hand ([InfoQ's report](https://www.infoq.com/news/2025/03/airbnb-llm-test-migration/)). ImpossibleBench, a benchmark built to catch shortcuts, found that GPT-5 cheated on 54% of its conflicting tasks, and that most of the cheating by Claude models was editing the tests ([the paper](https://arxiv.org/abs/2510.20270)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [run a first goal campaign](../../tutorials/first-goal-campaign.md) on the sample project.
2. [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md) says what a goal campaign needs from a kit.
3. Tests define "done". Have a person review what the tests don't cover before you merge the result.
