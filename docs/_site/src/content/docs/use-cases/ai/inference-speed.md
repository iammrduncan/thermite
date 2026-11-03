---
title: "LLM inference optimization"
description: "Use Thermite to optimize an inference engine, kernel or quantization for your GPU, with throughput measured on that GPU and output held to a reference."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, startups]
  summary: "Agents tune engines, kernels and quantization for your GPU. The judge measures throughput on that GPU and requires the output to match a reference."
  measure: "Tokens a second · same answers as a reference · prompts the agents never see"
sidebar:
  order: 1
---

Inference engines are typically tuned for the newest GPUs, which leaves older and lower-cost hardware underused. Thermite's agents tune the engine for your specific GPU over days. A judge on the same GPU measures every change from outside the engine and verifies that the model's output is unchanged. This is the use case Thermite was built from, and the subject of its first case study.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md) on decode speed; then another on prompt speed, with decode held as a guard |
| **The number** | Tokens a second, timed by the judge, over cases of prompt length and context length |
| **What must hold** | The model's greedy output matches a reference, and its KL divergence from the full-precision model stays under a limit |
| **Hidden from the agents** | Prompts and context lengths that a win must also pass |
| **Where it runs** | A CUDA rig on your NVIDIA GPU. One card is shared between the agents and the judge in turns; with several, you split them |

## How it runs

1. **You write a kit** that builds the engine, loads the model, runs a prompt and checks the output against a reference. The rig downloads the model file once, by URL, and checks its SHA-256 before any run uses it ([Bring a model's weights to a run](../../how-to/campaigns/model-weights.md)).
2. **Agents try changes** to the engine's kernels, its memory layout and its scheduling, each lane in its own copy.
3. **The judge times each change** beside the best version so far, on the same card, in alternating blocks, and times the best version against itself every day to learn the card's noise. A gain must hold a second time, and on the hidden prompts.
4. **Other campaigns on the same engine.** A **goal campaign** can make a new weight format load and match a reference bit for bit. A **research campaign** can ask which published methods help low-bit decoding on older cards, with every quote checked word for word against the page it came from.

## What the judge guards against

The most common failure in this work is a faster kernel that changes the model's output; another is a benchmark that the agents can modify. Throughput is measured on the judge's clock, never from a number the engine reports, and the check compares the output with a reference the agents cannot see.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** get the most from the GPUs you own, with agents on your own model server at no per-request cost.
- **[Startups](../for/startups.mdx):** higher throughput on the same rented GPU lowers the cost of every request you serve.

## Related work

Thermite's own study took Qwen3.8-27B from 7.74 to 30.06 tokens a second on one Tesla P100, a card that sells used for about $100: 131 changes judged, 28 kept ([the study](../../studies/qwen3-8-27b-on-a-p100.mdx)). Outside Thermite, METR found OpenAI's o3 overwriting the grader's timer or copying the grader's answer in 6 of 24 runs of a kernel task ([METR's post](https://metr.org/blog/2025-06-05-recent-reward-hacking/)): the reason the timer must be out of the agents' reach.

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md) and [split its GPUs](../../how-to/install/several-gpus.md) if it has several. No GPU of your own? [Rent one on RunPod](../../how-to/install/runpod-rig.md) by the hour.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that builds the engine and checks its output, then [test it](../../how-to/campaigns/test-a-kit.md).
3. Measure the long-context case too, in its own run, before you call a result done.
