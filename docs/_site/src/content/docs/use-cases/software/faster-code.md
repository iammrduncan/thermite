---
title: "Code performance optimization"
description: "Use Thermite to make a hot path faster on your own hardware, with each change benchmarked beside the best version so far and its output compared byte for byte with the version you started from."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups, enterprises]
  summary: "Agents rework a hot path: allocations, data structures, algorithms, build settings. The judge benchmarks each change on your machine and compares its output with the starting version's."
  measure: "Renders or calls a second · tests pass, output byte for byte · production inputs the agents never see"
sidebar:
  order: 1
---

Most services spend their time in a few hot paths: a parser or serializer, a template engine, a query planner, an image or compression codec, a request handler. Engineers find them with a profiler, often `perf` and a flame graph on Linux, and measure them with a benchmark harness: Google Benchmark for C++, JMH for Java, Criterion for Rust, pytest-benchmark for Python, or hyperfine for a whole command. A hot path that uses less CPU time per request needs fewer servers for the same traffic.

Making it faster is a long run of small experiments, and most of them fail: an allocation removed in one place moves the cost to another, a cache helps one input and slows the next, a SIMD path pays off only on long inputs. Timings are noisy, so engineers pin CPUs, repeat runs and read the confidence intervals that Criterion and JMH report. Correctness is judged by the unit tests, by golden outputs (the output on a fixed corpus, compared byte for byte) and, for parsers and codecs, by fuzzing. Thermite gives the benchmark and the comparison to a judge the agents can't reach, and lets agents work through the experiments.

## Where Thermite fits

The agents change the source and the build settings, each in its own copy, and can benchmark on development inputs. The judge builds each change itself, runs it on the kit's corpus beside the current best version, times it on its own clock and compares every output with the starting version's. The agents never see the kit's corpus, benchmark or reference outputs, or the production inputs held back for confirmation.

## Example campaigns

### 1. A faster parse and render, the same bytes out

A team's template engine renders every page its product serves, and the profile shows parsing and rendering as most of each request's CPU time.

- **What the agents change:** the engine's source and its build settings, never the tests or the benchmark.
- **What the judge runs:** the kit's benchmark, which parses and renders one set of templates a fixed number of times: short ones such as emails, typical pages, and the largest real ones, as three cells.
- **The number:** templates rendered per second, on the judge's clock. Higher is better.
- **What must hold:** the unit tests pass; every rendered output is byte for byte the starting version's; object allocations per render, counted by the kit's benchmark, no more than 2% worse in one step and 5% in all.
- **Hidden from the agents:** templates exported from production, which a win must also render identically, and no slower beyond a small margin.
- **What agents would try:** scanning bytes in place of regular expressions in the tokenizer; fewer temporary strings and arrays (shared constants, lazy initialization, pre-sized buffers); caching parsed templates or filter lookups; a flatter node layout or a faster hash map; a better algorithm for the hottest loop; link-time or profile-guided optimization (PGO) where the language is compiled.
- **What you get:** the fastest version that kept every output, as a commit on the run's branch, and every attempt with the judge's reasons.

### 2. A smaller binary, no slower

A team ships a command-line tool, and every user downloads it.

- **What the agents change:** the build profile, the dependencies' features and the code.
- **What the judge runs:** the build, then the binary on the benchmark inputs.
- **The number:** the stripped binary's size in bytes, which the check reads from the judge's own build. Lower is better.
- **What must hold:** the tests and golden outputs; run time no more than 2% worse in one step and 5% in all.
- **Hidden from the agents:** inputs from real use, held back as above.
- **What agents would try:** building for size (`opt-level = "z"` in Rust, `-Os` in C and C++), link-time optimization, one codegen unit, aborting on panic, stripping symbols, dropping unused dependency features, replacing a heavy dependency.
- **What you get:** the smallest build that kept speed and output.

### 3. Read what others measured first

Before a large rewrite, a research campaign can answer a question such as "Which techniques do published JSON and CSV parsers credit for their speed, on which input sizes and CPUs?" The agents read papers and benchmark reports, and record claims whose quotes code finds, word for word, in the pages it archived. [Technology evaluation](technology-evaluation.md) shows a larger research campaign, which reads for a day or more.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "render-speed",
  "version": 1,
  "title": "Faster parse and render, the same output",
  "mode": "hill_climb",
  "project": {
    "repo": "template-engine",
    "kit": { "repo": "template-engine-kit", "commit": "5e8a2c7f1b9d4e6a3c0f8b2d7e1a9c4f6b3d5e8a" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["lib/**", "ext/**"],
  "objective": { "primary": { "metric": "renders_per_s", "direction": "max", "min_effect": 0.03 } },
  "guards": [
    { "metric": "allocs_per_render", "direction": "min", "max_step_regression": 0.02, "max_total_regression": 0.05 }
  ],
  "cells": ["short", "typical", "large"],
  "held_out_cells": ["production"]
}
```

The kit holds the template corpus and the benchmark. Its build compiles the candidate and runs the unit tests, which sit outside `editable_paths`. Its run renders one cell's templates and writes every output. On the judge's first job, which measures the starting point, the check keeps a hash of each output in its baseline folder; every later check compares each output with its hash and prints one line, such as `{"pass": true, "allocs_per_render": 412}`. `renders_per_s` is a rate: the cell's `renders` parameter divided by the run's time on the judge's clock. A gain counts only when it is at least 3% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge runs each change several times, alternating with the best version so far, so an attempt costs a build and several benchmark runs. Keep a run to seconds or tens of seconds, long enough that start-up time doesn't dominate.
- **Where the agents help most.** Local changes with a clear profile: allocations, data layout, a slow library call, a missing fast path, build settings.
- **Where people stay.** Choosing the corpus, reading each accepted change (a faster version can be harder to maintain), and any change to the public API.

## What the judge guards against

The usual failure of automated optimization is a change that is fast but wrong. The agents never run the official benchmark or see the check, so they can't alter the timer, skip work for known inputs or relax the comparison, and numbers an agent reports are ignored. The production inputs held back catch a change tuned to the visible corpus, such as a cache sized for it. The contract can also refuse any added line that matches a pattern, such as a call to the clock.

## Limits

- A rig measures on one machine. A gain from `-march=native` or a cache size tuned to its CPU can shrink on another: measure on a machine like production, or refuse such flags with a forbidden pattern.
- A benchmark misses caches shared with other work, I/O and garbage-collection pauses under load. Confirm a win under load before you ship it.
- A byte-for-byte comparison refuses changes that are correct but different, such as another order of floating-point additions. Where those are acceptable, compare with a tolerance or a normalized form.
- The judge reports no memory metric of its own: a count of allocations or bytes comes from the kit's benchmark.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx) and open-source maintainers:** run a campaign unattended and review what was tried, what was accepted and why.
- **[Startups](../for/startups.mdx):** a faster hot path is lower cost per request on the same servers.
- **[Enterprises](../for/enterprises.mdx):** run it on your own machines, against your own private code, with a record of every change.

## Related work

In March 2026, an agent loop cut the parse-and-render time of Shopify's Liquid, a template engine about twenty years old, by 53% on its benchmark (7,469 µs to 3,534 µs), with 61% fewer object allocations, over about 120 automated experiments ([the pull request](https://github.com/Shopify/liquid/pull/2056), still open when this page was written). Codeflash, which builds a tool for this work, found that 62% of GPT-4o's attempts to optimize code introduced bugs, and that 28% more were correct but not faster ([their post](https://hackernoon.com/90percent-failure-rate-why-gpt-4o-cant-optimize-code-and-what-we-built-instead)). Both show why the check matters as much as the speed.

## Get started

1. [Install on one machine](../../tutorials/first-run.md): about twenty minutes.
2. Start a campaign on [your own project](../../tutorials/your-own-project.md) from **New campaign**, and press **Try the kit first** to see the judge measure your project before any agent starts.
3. For a kit of your own, [write one](../../how-to/campaigns/write-a-kit.md) around your benchmark, and [test it with known changes](../../how-to/campaigns/test-a-kit.md): a real speed-up, a change that is wrong, a change that does nothing.
