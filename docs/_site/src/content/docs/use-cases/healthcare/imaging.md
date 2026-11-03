---
title: "Medical image segmentation"
description: "Use Thermite to improve a medical image segmentation model, trained on a fixed budget and evaluated on a fold or site withheld from the agents."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises]
  summary: "Agents modify the architecture and training. The judge trains each version on a fixed budget and evaluates it on a held-out fold or site."
  measure: "Mean Dice · no structure worse, boundary error held · a fold, or a site's scans"
sidebar:
  order: 2
---

Segmentation models delineate organs and lesions in medical images. Many new architectures that report gains over strong baselines do not hold up under a fair comparison: the same baseline, the same training budget, and a test set that was not used for tuning. Thermite enforces that comparison by design. The kit fixes the baseline, the budget and the scoring; agents change the model and its training; the judge evaluates each version on scans the agents never see.

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

## What the judge guards against

Weak baselines, unequal training budgets, and models that learn shortcuts such as scanner artefacts instead of anatomy. The kit fixes the baseline and the budget, so every version is measured the same way, and a withheld site's scans detect a model that fits one hospital's data. A shortcut present at every site can still pass, so review what the model has learned.

## Who it's for

- **[Startups](../for/startups.mdx):** imaging AI companies that need gains that hold on a new customer's scans.
- **[Enterprises](../for/enterprises.mdx):** academic radiology departments. Scans hold health information, and here they stay with you, with a local model for the agents if you choose.

## Related work

"nnU-Net Revisited" found that "many of these recent claims fail to hold up" when new segmentation methods are compared with strong baselines under the same conditions ([Isensee and others, 2024](https://arxiv.org/abs/2404.09556)). Camyla, an agent system, wrote more than 2,700 model implementations in 28 days on eight GPUs, and beat the strongest of 14 baselines, nnU-Net among them, on 22 of 31 datasets ([the paper](https://arxiv.org/abs/2604.10696)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that trains for a fixed budget and scores Dice, and [test it](../../how-to/campaigns/test-a-kit.md): train the unchanged model twice to see the noise.
3. Dice is not clinical value, and a campaign is not regulatory evidence.
