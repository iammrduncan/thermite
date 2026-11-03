---
title: "Code performance optimization"
description: "Use Thermite to optimize performance-critical code: agents propose changes, and a judge benchmarks each one on your hardware and accepts it only if your tests pass and the output is unchanged."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups, enterprises]
  summary: "Agents propose performance changes. The judge benchmarks each on your hardware and accepts it only if your tests pass and the output is unchanged."
  measure: "Time per call · every test passes, same output · real inputs the agents never see"
sidebar:
  order: 1
---

Most projects have performance-critical code: a parser, a renderer, a serializer, a query or a build step. Improving it is a long series of small experiments, most of which fail. Thermite runs those experiments with AI agents working in parallel, while a judge the agents cannot access benchmarks each change on your hardware. A change is accepted only if it is faster and produces exactly the same output.

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

## What the judge guards against

The usual failure of automated optimization is a change that is fast but wrong. In Thermite, the agents never run the official benchmark and never see the check, so they cannot alter a timer, skip work or simplify the reference. Numbers reported by an agent are ignored; only the judge's measurements count, and withheld inputs detect changes tuned only to the visible ones.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx) and open-source maintainers:** run a campaign unattended and review what was tried, what was accepted and why.
- **[Startups](../for/startups.mdx):** a faster hot path is lower cost per request on the same servers.
- **[Enterprises](../for/enterprises.mdx):** run it on your own machines, against your own private code, with a record of every change.

## Related work

In March 2026, an agent loop made Shopify's Liquid template engine, a library about twenty years old, spend 53% less time to parse and render its benchmark (7,469 µs to 3,534 µs), with about 120 automated experiments ([the pull request](https://github.com/Shopify/liquid/pull/2056), still open when this page was written). Codeflash, which builds a tool for this work, reported that 62% of the optimizations GPT-4o proposed were incorrect ([their post](https://hackernoon.com/90percent-failure-rate-why-gpt-4o-cant-optimize-code-and-what-we-built-instead)). Both show why the check matters as much as the speed.

## Get started

1. [Install on one machine](../../tutorials/first-run.md): about twenty minutes.
2. Start a campaign on [your own project](../../tutorials/your-own-project.md) from **New campaign**, and press **Try the kit first** to see the judge measure your project before any agent starts.
3. For a kit of your own, [test it with known changes](../../how-to/campaigns/test-a-kit.md): a real speed-up, a change that is wrong, a change that does nothing.
