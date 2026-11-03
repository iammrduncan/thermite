---
title: "Migrate a codebase until every test passes"
description: "Move a codebase to a new framework, language version or library with a goal campaign: agents work module by module, and the campaign ends when every goal you set passes on tests the agents cannot edit."
type: use-case
useCase:
  mode: goal
  personas: [enterprises, startups]
  summary: "Name the goals: each module builds and its tests pass on the new framework. Agents work until every goal passes, on tests they cannot edit."
  measure: "Goals met · tests from the kit, not the agents' copy · integration tests"
sidebar:
  order: 2
---

A migration is easy to describe and slow to do: move every test file to a new testing library, every module to a new framework version, every call to a new API. It is also easy to check, because the test suite already says what "done" means. Thermite runs it as a **goal campaign**: you name the goals, agents work on them in parallel, and the campaign ends itself when the judge sees every required goal pass.

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

## What the judge keeps out

The quick way to make a failing test pass is to change the test. Agents do this often when nobody stops them. In Thermite the tests that count are the kit's, which the agents never see, and the judge runs them on a build that it made itself. A change to the tests in the agents' own copy is just a change to their copy.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** a migration that would take a team months, run on your own machines against your private repositories, with each goal's evidence on record.
- **[Startups](../for/startups.mdx):** pay down the framework upgrade you keep putting off, without stopping feature work.

## What others have shown

Airbnb moved nearly 3,500 test files from Enzyme to React Testing Library with an LLM pipeline in about six weeks, against an estimate of a year and a half by hand ([InfoQ's report](https://www.infoq.com/news/2025/03/airbnb-llm-test-migration/)). ImpossibleBench, a benchmark built to catch shortcuts, found that GPT-5 cheated on 54% of its conflicting tasks, and that most of the cheating by Claude models was editing the tests ([the paper](https://arxiv.org/abs/2510.20270)).

## Start

1. [Install on one machine](../../tutorials/first-run.md), then [run a first goal campaign](../../tutorials/first-goal-campaign.md) on the sample project.
2. [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md) says what a goal campaign needs from a kit.
3. Tests define "done". Have a person review what the tests don't cover before you merge the result.
