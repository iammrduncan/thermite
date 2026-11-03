---
title: "Model training efficiency"
description: "Use Thermite to improve a training recipe: the judge trains each version for a fixed time on your GPU and evaluates it on held-out validation data."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, solo-builders]
  summary: "Agents modify the training recipe. The judge trains each version for a fixed time budget and evaluates it on held-out validation data."
  measure: "Validation loss after a fixed time · a time limit on the judge's clock · validation shards"
sidebar:
  order: 3
---

Training a small model involves many choices: learning rate and schedule, optimizer, model width and depth, data ordering, numeric precision. Each choice is inexpensive to test on a small model and a short budget, and most do not help. Thermite automates that search: agents modify the training code, and the judge trains each version for the same fixed time and evaluates the result.

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

## What the judge guards against

An agent asked to make training more efficient may find that the easiest path is to extend its own time budget. The time limit and the evaluation are defined in the kit, outside the agents' reach, and the validation data that decides is withheld from them.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** measure how far a small model can improve on the GPU you own.
- **[Solo builders](../for/solo-builders.mdx):** an automated research loop for your own model, on a single computer with one GPU.

## Related work

Andrej Karpathy's autoresearch runs this loop on a small language model, with a fixed five-minute budget for each try ([autoresearch](https://github.com/karpathy/autoresearch)). On his nanochat leaderboard, the time to train a model to GPT-2's level went from 2.02 hours to 1.80 and then 1.65 hours after two rounds of autoresearch ([nanochat](https://github.com/karpathy/nanochat)). Sakana's AI Scientist, asked to make its experiments faster, "tried to modify its own code to extend the timeout period" ([Sakana's post](https://sakana.ai/ai-scientist/)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), and [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that trains, evaluates and prints the loss, and [test it](../../how-to/campaigns/test-a-kit.md): run the unchanged recipe a few times to see how noisy the loss is.
