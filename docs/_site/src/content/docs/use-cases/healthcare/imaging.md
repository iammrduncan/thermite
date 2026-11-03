---
title: "Improve a segmentation model on scans it never saw"
description: "Let agents change a medical image segmentation model's architecture and training while the judge trains each version and scores it with Dice on a fold or a site that the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises]
  summary: "Agents change the model and its training. The judge trains each version on the same budget and scores it on a fold, or a hospital's scans, that they never see."
  measure: "Mean Dice · no structure worse, boundary error held · a fold, or a site's scans"
sidebar:
  order: 2
---

A segmentation model outlines organs or tumours in a scan. Most new architectures that claim to beat a strong baseline don't hold up when someone measures them fairly: with the same baseline, the same training budget and a test set the authors didn't tune on. Thermite can run that search fairly by design. The kit fixes the baseline, the budget and the scoring; agents change the model and its training; and the judge scores each version on scans the agents never see.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md) |
| **The number** | Mean Dice over the structures, reported by the kit's check |
| **What must hold** | No structure gets worse; the 95th-percentile boundary distance (HD95) as a guard; the masks are valid |
| **Hidden from the agents** | A fold of the data, or the scans of one site, that a win must also pass |
| **Where it runs** | A CUDA rig. Each try is a training run of hours, so expect a few tries a lane each day |

## How it runs

1. **You write a kit** that trains a model for a fixed budget on your training data, predicts on the cases it measures, and prints the scores. A framework such as nnU-Net can be the starting point.
2. **Agents try changes** to the architecture, the augmentation, the loss and the schedule.
3. **The judge trains and scores each change** on the same budget as the best version. A gain must hold on fresh runs and on the hidden fold or site.

## What the judge keeps out

Weak baselines, unequal budgets and models that learn a shortcut, such as a scanner's marks rather than the anatomy. The kit sets the baseline and the budget, so every version is measured the same way, and a hidden site's scans catch a model that learned one hospital's habits. A shortcut that every site shares can still get through: look at what the model learned.

## Who it's for

- **[Startups](../for/startups.mdx):** imaging AI companies that need gains that hold on a new customer's scans.
- **[Enterprises](../for/enterprises.mdx):** academic radiology departments. Scans hold health information, and here they stay with you, with a local model for the agents if you choose.

## What others have shown

"nnU-Net Revisited" found that "many of these recent claims fail to hold up" when new segmentation methods are compared with strong baselines under the same conditions ([Isensee and others, 2024](https://arxiv.org/abs/2404.09556)). Camyla, an agent system, wrote more than 2,700 model implementations in 28 days on eight GPUs, and beat the strongest of 14 baselines, nnU-Net among them, on 22 of 31 datasets ([the paper](https://arxiv.org/abs/2604.10696)).

## Start

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that trains for a fixed budget and scores Dice, and [test it](../../how-to/campaigns/test-a-kit.md): train the unchanged model twice to see the noise.
3. Dice is not clinical value, and a campaign is not regulatory evidence.
