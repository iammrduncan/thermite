---
title: "Run a model faster on the GPU you have"
description: "Point agents at an inference engine, a kernel or a quantization, and let them tune it for your exact card while a judge on that card times every change and holds the model's answers where they started."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, startups]
  summary: "Agents tune an engine, a kernel or a quantization for your exact card. The judge times each change on that card, and the model's answers must not change."
  measure: "Tokens a second · same answers as a reference · prompts the agents never see"
sidebar:
  order: 1
---

Inference engines are tuned for the newest GPUs first, so the card you can afford, a used data-centre GPU, a gaming card or a box of older GPUs, is often left slow. Thermite lets agents tune the engine for that card, for days. A judge on the same card times every change from outside the engine, and checks that the model still gives the same answers. This is the use case Thermite grew out of, and the one it has a study for.

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

## What the judge keeps out

A faster kernel that answers differently is the classic way for this work to go wrong, and so is a benchmark that an agent can reach. The engine's speed is measured by the judge's clock, never by a number that the engine prints, and the check compares the answers with a reference that the agents never see.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** make the card you own run the model you want. The agents can run on a model server of your own, at no cost a request.
- **[Startups](../for/startups.mdx):** more tokens a second on the same rented GPU is a lower cost for each request you serve.

## What others have shown

Thermite's own study took Qwen3.8-27B from 7.74 to 30.06 tokens a second on one Tesla P100, a card that sells used for about $100: 131 changes judged, 28 kept ([the study](../../studies/qwen3-8-27b-on-a-p100.mdx)). Outside Thermite, METR found OpenAI's o3 overwriting the grader's timer or copying the grader's answer in 6 of 24 runs of a kernel task ([METR's post](https://metr.org/blog/2025-06-05-recent-reward-hacking/)): the reason the timer must be out of the agents' reach.

## Start

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md) and [split its GPUs](../../how-to/install/several-gpus.md) if it has several. No GPU of your own? [Rent one on RunPod](../../how-to/install/runpod-rig.md) by the hour.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that builds the engine and checks its output, then [test it](../../how-to/campaigns/test-a-kit.md).
3. Measure the long-context case too, in its own run, before you call a result done.
