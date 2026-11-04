---
title: "Model training efficiency"
description: "Use Thermite to improve a small model's training recipe: the judge trains each version for the same fixed time on your GPU and scores it on validation text the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, solo-builders]
  summary: "Agents change the model, the optimizer and the schedule. The judge trains each version for the same fixed time on your GPU and scores it on validation text the agents never see."
  measure: "Validation bits per byte after a fixed time · the time limit on the judge's clock · validation text the agents never see"
sidebar:
  order: 3
---

Researchers try training ideas on small models and short budgets, because a large run costs too much to experiment on. Keller Jordan's modded-nanogpt speedrun trains a language model on eight H100s to 3.28 cross-entropy loss on the FineWeb validation set, the loss of Andrej Karpathy's GPT-2 small reproduction; its record has fallen from 45 minutes in May 2024 to under 40 seconds. Karpathy's nanochat keeps a leaderboard of the time to train a model to GPT-2-grade capability. Recipes are compared by validation loss after a fixed wall-clock budget, by the time to reach a target loss, or in bits per byte, which doesn't depend on the tokenizer.

The work is a long list of small, uncertain changes to the optimizer, the schedule, the architecture and the numeric precision. Most don't help, and many that seem to are within the noise between seeds, which is why the speedrun asks each new record for enough runs to show statistical significance. Karpathy's autoresearch showed that an agent can work through such a list; Thermite keeps the loop and moves the decision to a judge the agents can't reach.

## Where Thermite fits

The agents change the training code, each lane in its own copy, and may train short runs of their own. The judge trains each change from scratch on its own GPU for the kit's budget, alternating with the best version so far, and the kit's check scores the checkpoint on validation tokens only the check can read. The agents never see those tokens, the scoring code or the hidden seed. They learn only the judge's verdict and its reasons.

## Example campaigns

### 1. Lower loss from five minutes on one GPU

You have a small GPT and one GPU, and want the best model five minutes of training can make.

- **What the agents change:** `train.py` and `model.py`: the architecture, the optimizer, the schedule and the batch shape. The token stream and the tokenizer stay fixed.
- **What the judge runs:** training from scratch on each seed, then the check's scoring.
- **The number:** validation bits per byte. Lower is better.
- **What must hold:** the whole run, start-up and compilation included, ends within the budget on the judge's clock, so a change can spend the time as it likes but not extend it; changing a later token leaves the earlier predictions unchanged.
- **Hidden from the agents:** a third seed, scored on private text.
- **What agents would try:** Muon for the hidden layers' weight matrices, AdamW for the rest; a warm-up and a linear cool-down in place of a cosine schedule; fewer, wider layers; rotary embeddings, QK-norm and ReLU²; a larger batch with a higher learning rate; bf16 activations.
- **What you get:** the best recipe, as a commit on the run's branch, and every attempt with its loss and the judge's reasons, failed ideas included.

### 2. Reach a target loss sooner

You care about the time to a fixed quality, as the speedruns do.

- **What the agents change:** the same files, and the number of training steps.
- **What the judge runs:** the training as the change sets it, then the check.
- **The number:** the run's time on the judge's clock. Lower is better.
- **What must hold:** validation loss at or below your target on every run; a run above it fails the check.
- **Hidden from the agents:** a third seed, as above.
- **What agents would try:** fewer steps at a higher learning rate; shorter sequences early in training; fused kernels and lower-precision matrix multiplies on cards that support them.
- **What you get:** a faster recipe that still reaches the target. Leave a margin below the target, as the speedrun does.

### 3. Read the optimizer results first

A research campaign can survey a question first, such as "What do published comparisons report about Muon against AdamW for language models under a billion parameters?" A claim counts only when code finds its quotes, word for word, in the pages it archived; a review panel of models decides each question, and the report lists every source.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "gpt-five-minutes",
  "version": 1,
  "title": "Lower validation loss from five minutes of training",
  "mode": "hill_climb",
  "project": {
    "repo": "small-gpt",
    "kit": { "repo": "small-gpt-kit", "commit": "3e8a1f0c7b2d4e6f9a1b3c5d7e9f0a2b4c6d8e0f" }
  },
  "target": { "type": "cuda-gpu", "class": "nvidia-gpu" },
  "models": [
    { "name": "train-tokens", "sha256": "4c9e2a7f1b5d8e3a6c0f9b2d5e8a1c4f7b0e3d6a9c2f5b8e1d4a7c0f3b6e9d2a" }
  ],
  "editable_paths": ["train.py", "model.py"],
  "objective": { "primary": { "metric": "val_bpb", "direction": "min", "min_effect": 0.002 } },
  "hard_constraints": [{ "kind": "max", "metric": "wall_s", "value": 330 }],
  "cells": ["seed-1", "seed-2"],
  "held_out_cells": ["seed-3-private"],
  "acceptance": { "equivalence_band": 0.001 }
}
```

The kit holds the validation tokens and its scoring code; the training tokens reach the rig as a [file the contract names](../../how-to/campaigns/model-weights.md) with its SHA-256. Its run starts `train.py` with the cell's seed and writes a checkpoint. Its check loads the checkpoint with the change's model code, tests causality, scores the validation tokens with its own loop and prints one line, such as `{"pass": true, "val_bpb": 0.9971}`. The kit names `wall_s` as the run's time on the judge's clock, which the contract holds to 330 seconds with start-up included, and `val_bpb` as a number read from the check. Gains here are small, so the contract counts one of 0.2% and narrows the band in which the judge calls two versions equivalent: run the unchanged recipe a few times first to see whether the noise allows that ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge runs each change several times, alternating with the best version so far. Here each block trains both versions on both seeds, and screening runs at least three blocks: twelve trainings, about an hour of the judge's GPU, for a change it rejects early, and more than thirty for a confirmed win. That is slower than autoresearch's one run per idea, and it is what tells a gain from seed noise.
- **Where the agents help most.** Recipe changes with a clear effect at small scale. On a rig with two GPUs, give the agents one, so their trial runs don't wait for the judge.
- **Where people stay.** Choosing the budget and the validation text, and reading what changed.

## What the judge guards against

The easiest way to lower the loss in a fixed time is to take more time; here the budget is the judge's clock. Another is a model that sees the answer: a broken causal mask lets each position read the next token, and the loss falls far below anything real. The check tests causality on every run, and a confirmed gain above 15% goes to an audit first. To score a changed architecture, the check must run the change's model code; for a stricter line, leave `model.py` out of `editable_paths` and let the agents change only the recipe.

## Limits

- Each timed run uses one GPU of one machine. The speedruns' eight-GPU runs can't be timed as one run: scale the model and the target to one card.
- A gain at small scale and a short budget may not hold for a larger model. Test the best recipes at the size you care about.
- A kit's check has no GPU: it scores on the machine's CPUs, so keep the validation set and the model small.
- The agents' commands can reach the internet, and a public validation set can be downloaded and trained on. Score the hidden seed on text that can't be.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** measure how far a small model can improve on the GPU you own.
- **[Solo builders](../for/solo-builders.mdx):** an automated research loop for your own model, on a single computer with one GPU.

## Related work

In Karpathy's autoresearch, an agent edits `train.py`, trains for five minutes, and keeps the change if validation bits per byte went down ([autoresearch](https://github.com/karpathy/autoresearch)). On his nanochat leaderboard, the time to train a model to GPT-2's level went from 2.02 hours to 1.80 and then 1.65 hours after two rounds of autoresearch ([nanochat](https://github.com/karpathy/nanochat)). The modded-nanogpt speedrun asks each record for "enough run logs to attain a statistical significance level of p<0.01", and keeps its record "roughly 0.001-0.002 loss below 3.28 to make validation simpler" ([modded-nanogpt](https://github.com/KellerJordan/modded-nanogpt)). Sakana's AI Scientist, whose experiments hit a timeout, "tried to modify its own code to extend the timeout period" ([Sakana's post](https://sakana.ai/ai-scientist/)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md), and [extend the harness image](../../how-to/install/extend-harness-image.md) with your training framework.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that trains, scores the checkpoint and prints the loss, and [test it](../../how-to/campaigns/test-a-kit.md): run the unchanged recipe a few times to see the noise, and try a change that breaks the causal mask, which the check must fail.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
