---
title: "Make your code faster without breaking it"
description: "Point agents at a slow function, a parser, a query or a build, and let them try speed-ups for days while a judge on your machine times each one and runs your tests on inputs they never see."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups, enterprises]
  summary: "Agents try speed-ups for days. The judge times each one on your machine, and a win must pass your tests and match the old output byte for byte."
  measure: "Time per call · every test passes, same output · real inputs the agents never see"
sidebar:
  order: 1
---

Every project has a hot path that everyone means to speed up: a parser, a template renderer, a serializer, a query, a build step. The work is a loop of small experiments, and most of them fail. Thermite hands that loop to AI agents. They try one change after another, side by side, and a judge that they cannot touch times each change on your machine. Only a change that is faster and still gives exactly the same output becomes the new best version.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md): push one number as far as it goes |
| **The number** | Time per call, or calls a second, from the judge's own clock. Lower memory or allocations can be a guard, or the number itself |
| **What must hold** | Your unit tests pass, and the output on every test input is byte for byte the output of the version you started from |
| **Hidden from the agents** | A set of real inputs, such as templates or files from production, that a win must also pass and stay fast on |
| **Where it runs** | A CPU rig: any Linux computer with Podman or Docker. A GPU is not needed |

## How it runs

1. **You write a kit.** It is a small repository that the agents never see: a command that builds your project, a list of test inputs (the kit calls them cells), a command that runs the build on one input, and a check that compares the output with the reference ([Write a kit](../../how-to/campaigns/write-a-kit.md)). For a first try, the **New campaign** page can write a simple kit from your answers ([Your own project](../../tutorials/your-own-project.md)).
2. **You write a contract.** It names the number to push, the folders the agents may change, and the inputs to keep hidden ([Write a contract](../../how-to/campaigns/write-a-contract.md)).
3. **Agents work in lanes.** Each lane is one agent in its own copy of the project. A planner gives each lane a different idea to try: a faster data structure, fewer allocations, a cache, a different algorithm.
4. **The judge decides.** It builds each change itself, runs it beside the best version so far in alternating blocks, checks the output, and works out whether the gain is larger than the machine's noise. A gain must hold a second time, and on the hidden inputs, before the change becomes the new best version.
5. **You take the result.** The best version is a patch against the commit you started from, or a commit on the run's branch in your repository ([Take the result](../../how-to/campaigns/take-the-result.md)). Every attempt, with its code and the judge's reasons, stays in the run's record.

## What the judge keeps out

A fast change that is wrong is the usual failure of automatic optimization. In Thermite, the agents never run the official benchmark and never see the check, so they cannot change a timer, skip work, or make the reference easier to match. A number that an agent prints counts for nothing: only the judge's measurement counts. The hidden inputs catch a change that is tuned to the visible ones.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx) and open-source maintainers:** start a campaign on Friday evening, and read on Saturday what was tried and what won.
- **[Startups](../for/startups.mdx):** a faster hot path is lower cost per request on the same servers.
- **[Enterprises](../for/enterprises.mdx):** run it on your own machines, against your own private code, with a record of every change.

## What others have shown

In March 2026, an agent loop made Shopify's Liquid template engine, a library about twenty years old, spend 53% less time to parse and render its benchmark (7,469 µs to 3,534 µs), with about 120 automated experiments ([the pull request](https://github.com/Shopify/liquid/pull/2056), still open when this page was written). Codeflash, which builds a tool for this work, reported that 62% of the optimizations GPT-4o proposed were incorrect ([their post](https://hackernoon.com/90percent-failure-rate-why-gpt-4o-cant-optimize-code-and-what-we-built-instead)). Both show why the check matters as much as the speed.

## Start

1. [Install on one machine](../../tutorials/first-run.md): about twenty minutes.
2. Start a campaign on [your own project](../../tutorials/your-own-project.md) from **New campaign**, and press **Try the kit first** to see the judge measure your project before any agent starts.
3. For a kit of your own, [test it with known changes](../../how-to/campaigns/test-a-kit.md): a real speed-up, a change that is wrong, a change that does nothing.
