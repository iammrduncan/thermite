---
title: "Codebase migration"
description: "Use a Thermite goal campaign to move a codebase to a new language version or framework, module by module, with each goal checked by a kit the agents can't edit: test counts, mutation scores and recorded API calls."
type: use-case
useCase:
  mode: goal
  personas: [enterprises, startups]
  summary: "Agents migrate the code module by module. The judge builds each change, checks each module's tests and replays recorded API calls, and the run ends when every goal passes twice."
  measure: "Goals met, module by module · no test lost or weakened · recorded API calls the agents never see"
sidebar:
  order: 2
---

Most codebases carry a migration that someone has put off: Java 8 to Java 21, Spring Boot 2 to 3, Enzyme to React Testing Library, a TypeScript codebase onto strict mode. Platform teams do the work in waves, a module or a package at a time: automated rewrites first, such as OpenRewrite recipes for Java or codemods (scripts that rewrite code) for JavaScript, then people for what the rewrites leave. Progress is tracked per module: it builds, its tests pass, the type checker and the linter are clean.

The work is easy to define and slow to finish, because each module breaks in its own way. The [Spring Boot 3.0 migration guide](https://github.com/spring-projects/spring-boot/wiki/Spring-Boot-3.0-Migration-Guide) alone covers Java 17 as the new minimum, `jakarta` packages in place of `javax`, Hibernate 6, Spring Security 6 (which removed `WebSecurityConfigurerAdapter`), and URL matching that no longer accepts a trailing slash, so a `GET /orders/` that worked before now returns 404. The tests define "done", which makes them the weak point: a test can be deleted, switched off or rewritten until it passes. Thermite runs the migration as a goal campaign, with one goal for each module, checked by a kit the agents can't see.

## Where Thermite fits

The agents change the source, the build files and, where the migration needs it, the tests, each in its own copy. The judge builds each change with the kit's own toolchain, runs each module's tests and counts what passed, and replays recorded API calls against the built service. The agents never see the kit's expected responses, its test counts or the calls held back for the final checks.

## Example campaigns

### 1. Java 8 and Spring Boot 2.7 to Java 21 and Spring Boot 3

A team must move a multi-module Maven service off Spring Boot 2.7 and Java 8 without stopping feature work.

- **Mode:** a goal campaign. It ends when every required goal passes on two checks of the best version, or, as this contract allows, when three different approaches have each been tried and failed.
- **The goals:**
  - the service builds with the kit's JDK 21 against Spring Boot 3, and starts;
  - each module's tests pass, with no fewer passing than before. These goals require the build, so they run only once it passes;
  - recorded API calls get the responses the Java 8 version gave; part of the calls are held back for confirmation;
  - the billing module's mutation score from PIT (the share of planted bugs its tests catch) is at least the starting value;
  - optionally, for a review panel of models: the changes read like the team's own code.
- **What the agents change:** the `pom.xml` files and each module's `src/`, tests included, since they import `javax` too.
- **What agents would try:** the latest 2.7 release first, as the guide advises; OpenRewrite's migration recipes, then fixing what they leave; a `SecurityFilterChain` bean in place of `WebSecurityConfigurerAdapter`; `spring-boot-properties-migrator` to find renamed properties; replacing dependencies that have no `jakarta` release.
- **What you get:** a migrated branch and, for each goal, the judge's evidence.

### 2. TypeScript strict mode, one error at a time

A TypeScript codebase was written without `strict`, and turning it on reports thousands of errors.

- **Mode:** a hill climb: progress comes in many small steps.
- **What the judge runs:** `tsc --noEmit` with the kit's own `tsconfig.json`, which sets `"strict": true`, then the tests.
- **The number:** the errors `tsc` reports, plus one, since every value must be above zero. Lower is better.
- **What must hold:** the tests in `test/`, outside the editable paths, pass. Forbidden patterns refuse any added `as any`, `: any`, `@ts-ignore` or `@ts-expect-error`. Non-null assertions (`value!`), counted with the compiler's API, plus one, are a guard.
- **Hidden from the agents:** the end-to-end tests, run only at confirmation.
- **What agents would try:** typing the parameters `noImplicitAny` reports; type guards where `strictNullChecks` finds a possible `undefined`; initializing class properties in the constructor; narrowing `unknown` in `catch` blocks.
- **What you get:** a branch on which each promoted change cut the errors and kept the tests.

### 3. Read the upgrade guides first

Before either, a research campaign can answer a question such as "Which breaking changes between Spring Boot 2.7 and 3.x affect a service with web controllers, a security configuration and JPA repositories?" The agents read migration guides, release notes and issue threads, and record claims whose quotes code finds, word for word, in the pages it archived. The report can go into the goal campaign's brief.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "boot3-migration",
  "version": 1,
  "title": "Move the service to Java 21 and Spring Boot 3",
  "mode": "goal",
  "project": {
    "repo": "order-service",
    "kit": { "repo": "order-service-kit", "commit": "3c7a1f9e5b2d8c4a6e0f9b1d3a5c7e9f2b4d6a8c" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["pom.xml", "*/pom.xml", "*/src/**"],
  "goals": [
    { "id": "builds", "description": "builds with JDK 21 against Spring Boot 3, and the service starts", "verify": { "type": "code", "verifier": "builds" } },
    { "id": "orders-tests", "description": "the orders module's tests pass, no fewer than before", "verify": { "type": "code", "verifier": "orders-tests" } },
    { "id": "billing-tests", "description": "the billing module's tests pass, no fewer than before", "verify": { "type": "code", "verifier": "billing-tests" } },
    { "id": "api", "description": "recorded API calls get the responses the Java 8 version gave", "verify": { "type": "code", "verifier": "api-replay" } },
    { "id": "billing-mutation", "description": "billing's PIT mutation score is at least the starting 0.71", "verify": { "type": "metric_threshold", "metric": "mutation_score", "op": ">=", "value": 0.71, "cells": ["billing-pit"] } },
    { "id": "readable", "description": "the changes read like the team's own code", "required": false, "verify": { "type": "review", "criteria": ["no dead code", "no compatibility shims left behind"] } }
  ],
  "deliverable": "a branch that meets every required goal",
  "insufficient": ["deleting or disabling tests", "keeping javax dependencies to avoid the migration"],
  "infeasibility": { "allowed": true, "min_refuted_approaches": 3 },
  "held_out_cells": ["api-held"]
}
```

The kit holds its own JDK 21 build script, each module's count of passing tests at the start, and the recorded API calls with the Java 8 version's responses. Its verifiers `orders-tests`, `billing-tests` and `api-replay` require `builds`, and `api-replay` has two cells, `api` and the held-out `api-held`. A module's check counts the passed tests in the reports Maven writes and prints one line, such as `{"pass": true, "passed": 412, "expected": 412}`, with `pass` false when fewer pass than the kit recorded. The `billing-pit` cell runs PIT, and its check reports `mutation_score` ([Contract](../../reference/contract.md#goal), [Kit manifest](../../reference/kit-manifest.md#verifiers)).

## What to expect

- **Time per check.** A goal's check is a Maven build, then a module's tests, PIT or the replay, and after each promotion the judge checks every goal. Give the cheap verifiers the lower priority numbers, so they run first.
- **Where the agents help most.** The bulk that rewrite tools leave half done, and the long tail of compile and test errors.
- **Where people stay.** Deciding what counts as the same response, reviewing behaviour the tests don't cover, and the rollout.

## What the judge guards against

The easiest way to make a failing test pass is to change the test. In ImpossibleBench, read-only tests stopped models editing them, but not special-casing. In Thermite, the tests that count belong to the kit, or are counted by it. Where a migration leaves the tests alone, keep them out of `editable_paths`. Where they must change too, the check holds the passing tests to the kit's count, the recorded calls test the service from outside, and the mutation score catches a test that no longer asserts anything. The held-out calls catch special-casing, and the `insufficient` list tells the auditor and the review panel what never counts as done.

## Limits

- A rig builds and tests on one machine. Tests that need other services or a staging environment can't be goals: replay recorded calls instead, or leave those tests to people.
- Tests and recorded calls cover only the paths they reach.
- Responses with timestamps, generated ids or unordered lists need the check to normalize them first.
- A migrated branch still goes through your review and a staged rollout.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** migrations that would take a team months, run on your own machines against private repositories, with the evidence for each goal on record.
- **[Startups](../for/startups.mdx):** complete framework upgrades without pausing feature work.

## Related work

Airbnb moved nearly 3,500 test files from Enzyme to React Testing Library with an LLM pipeline in about six weeks, against an estimate of a year and a half by hand, with each step checked by Jest, the linter or the TypeScript compiler, and the errors sent back to the model ([InfoQ's report](https://www.infoq.com/news/2025/03/airbnb-llm-test-migration/)). In a Google migration of IDs from 32-bit to 64-bit integers, 80% of the code in the landed changes was written by a model, every change had to build and pass its unit tests, and engineers estimated the time spent fell by half ([Nikolov and others, 2025](https://arxiv.org/abs/2501.06972)). ImpossibleBench found that GPT-5 cheated on 54% of its conflicting tasks, and that over 79% of the cheating by Claude models was editing the tests ([the paper](https://arxiv.org/abs/2510.20270)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [run a first goal campaign](../../tutorials/first-goal-campaign.md) on the sample project.
2. [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md) says what a goal campaign needs from a kit, and [Write a kit](../../how-to/campaigns/write-a-kit.md#7-add-verifiers-for-goal-campaigns) shows verifiers that require one another.
3. Tests define "done". Have a person review what the tests don't cover before you merge the result.
