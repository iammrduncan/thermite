---
title: "Train a better small model in the same time"
description: "Let agents change a training recipe, its architecture, optimizer and data order, while the judge trains each version for a fixed time on your GPU and scores it on data the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, solo-builders]
  summary: "Agents change the recipe. The judge trains each version for the same fixed time on your GPU and scores it on validation data the agents never see."
  measure: "Validation loss after a fixed time · a time limit on the judge's clock · validation shards"
sidebar:
  order: 3
---

Training a small model well is a long list of choices: the learning rate and its schedule, the optimizer, the width and depth, the data order, the precision. Each idea is cheap to try on a small model and a short budget, and most of them don't help. Thermite can run that search: agents change the training code, and the judge trains each version itself, for the same fixed time, and scores what it learned.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md), with `"direction": "min"` for a loss |
| **The number** | Validation loss, or bits per byte, after a fixed training time, reported by the kit's check |
| **What must hold** | The run finishes within its time limit on the judge's clock, and the model loads and answers |
| **Hidden from the agents** | Validation shards, or a task benchmark, that a win must also hold on |
| **Where it runs** | A CUDA rig. A single card is enough for a small model |

## How it runs

1. **You write a kit** that trains the model for a fixed time, then evaluates it and prints the loss. The time limit is the judge's, so an agent can't buy more training by changing a setting.
2. **Agents try changes** to the model and the training loop, each in its own copy.
3. **The judge trains each change** and compares its loss with the best version's. Training is noisy, so a gain must hold a second time, on fresh runs, before it counts.

## What the judge keeps out

An agent that is asked to make training faster can find that the easy path is to give itself more time. The time limit and the evaluation live in the kit, outside the agents' reach, and the validation data that decides is data they never see.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** find out how good a small model can get on the card you own.
- **[Solo builders](../for/solo-builders.mdx):** a research loop for a model of your own, on one computer with one GPU.

## What others have shown

Andrej Karpathy's autoresearch runs this loop on a small language model, with a fixed five-minute budget for each try ([autoresearch](https://github.com/karpathy/autoresearch)). On his nanochat leaderboard, the time to train a model to GPT-2's level went from 2.02 hours to 1.80 and then 1.65 hours after two rounds of autoresearch ([nanochat](https://github.com/karpathy/nanochat)). Sakana's AI Scientist, asked to make its experiments faster, "tried to modify its own code to extend the timeout period" ([Sakana's post](https://sakana.ai/ai-scientist/)).

## Start

1. [Install on one machine](../../tutorials/first-run.md), and [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that trains, evaluates and prints the loss, and [test it](../../how-to/campaigns/test-a-kit.md): run the unchanged recipe a few times to see how noisy the loss is.
