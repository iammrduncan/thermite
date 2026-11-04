---
title: "Medical image segmentation"
description: "Use Thermite to improve a CT or MRI segmentation model, with each change trained on the same budget as the best version and scored on scans the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises]
  summary: "Agents change the training recipe, the loss, augmentation and post-processing. The judge trains each version on a fixed budget and scores Dice on scans they never see."
  measure: "Mean Dice on a fixed training budget · each structure's Dice and HD95 held · scans from a site never seen"
sidebar:
  order: 2
---

Imaging AI teams in companies and hospital departments train models that outline organs and lesions in CT and MRI, such as kidney tumours or the organs at risk in a radiotherapy plan. Most start from nnU-Net, which configures a U-Net from the dataset's own properties and won the ten-task Medical Segmentation Decathlon, or build on MONAI, a PyTorch framework for medical imaging. The data is the team's own scans from the hospital's PACS, outlined by clinicians, often beside public sets such as KiTS23: 489 contrast-enhanced CT scans for training, labelled for kidney, tumour and cyst. Training is the cost: nnU-Net's default trains for 1,000 epochs on each of five cross-validation folds, about 9 hours a fold on an A100 GPU by its own documentation.

Improving such a model means testing many small changes to the loss, the augmentation, the patch size or the schedule, each at the cost of a training run, and each with an effect often smaller than the difference between two runs of the same code. Correctness is judged against expert labels on cases that took no part in tuning: the Dice coefficient for each structure, the overlap of prediction and label, and HD95, the 95th percentile of the distances between their surfaces, in millimetres. Challenges such as KiTS23 release only the test images and score the masks that teams send back. Thermite gives that scoring to a judge the agents can't reach, and holds every change to the same training budget.

## Where Thermite fits

The agents change the training code and its settings, each in its own copy: an nnU-Net trainer class, the plans file, the post-processing. The judge builds each version, trains it from scratch on the kit's scans for the budget the kit sets, then predicts and scores the test scans on its own GPU. The agents never see those scans, their labels, the scoring script or the hidden site's scans; public cases in their copy let them test their code. They learn only the judge's verdict and its reasons.

## Example campaigns

### 1. Better tumour outlines on the same budget

A team segments kidneys and renal masses in contrast-enhanced CT with nnU-Net and wants better tumour outlines without a longer training run.

- **What the agents change:** a custom nnU-Net trainer, the plans and the post-processing.
- **What the judge runs:** training from scratch on one fold of the kit's scans, for the 250 epochs the kit sets, then prediction on the fold's validation scans.
- **The number:** mean Dice over kidney, tumour and cyst. Higher is better.
- **What must hold:** each structure's Dice and the mean HD95, within limits you set; training and prediction within three hours, so that no gain comes from more compute; a valid mask for every case.
- **Hidden from the agents:** scans from a second hospital or scanner vendor, labelled by your annotators and never published, so that a change tuned to one site's scanners is caught.
- **What agents would try:** nnU-Net's residual-encoder presets, within the GPU's memory and the time limit; a larger patch with a smaller batch; Dice and cross-entropy weighted differently; more foreground oversampling than nnU-Net's default third; stronger intensity augmentation; another learning-rate schedule; removing tumour predicted outside the kidneys.
- **What you get:** the best training recipe that held every guard, as a commit on the run's branch, with every attempt and the judge's reasons.

### 2. Segment an archive in time

A research group will run its model over tens of thousands of archived CT scans for a study, and each scan must take under a minute on its GPU server.

- **Mode:** a goal campaign, which ends when every required goal passes, twice.
- **The goals:** the time limit, on the judge's clock; each structure's Dice at or above 0.98 against the current model's own masks, and at or above a floor you set against the labels, on the validation scans and the hidden site's.
- **What the agents change:** the inference code, with the trained weights fixed: the sliding window's step size, test-time mirroring, half precision, how patches are batched.
- **What you get:** inference that met every goal, with the judge's measurements for each.

### 3. Read the benchmarks first

A research campaign can first survey published nnU-Net benchmarks: which changes to the default improved Dice under the same training budget, and at what cost in training time. Its report cites only claims whose quotes code found, word for word, in the pages it archived.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "kidney-tumour-dice",
  "version": 1,
  "title": "Better kidney tumour outlines on the same training budget",
  "mode": "hill_climb",
  "project": {
    "repo": "kidney-seg",
    "kit": { "repo": "kidney-seg-kit", "commit": "4c8e2a1f9b7d3e5c6a0b8f2d4e6a1c3b5d7f9e0a" }
  },
  "target": { "type": "cuda-gpu", "class": "nvidia-gpu" },
  "editable_paths": ["trainers/**", "plans/**", "postprocessing/**"],
  "objective": { "primary": { "metric": "mean_dice", "direction": "max", "min_effect": 0.01 } },
  "guards": [
    { "metric": "kidney_dice", "direction": "max", "max_step_regression": 0.005, "max_total_regression": 0.01 },
    { "metric": "tumour_dice", "direction": "max", "max_step_regression": 0.01, "max_total_regression": 0.02 },
    { "metric": "cyst_dice", "direction": "max", "max_step_regression": 0.01, "max_total_regression": 0.02 },
    { "metric": "hd95_mm", "direction": "min", "max_step_regression": 0.05, "max_total_regression": 0.1 }
  ],
  "hard_constraints": [{ "kind": "max", "metric": "run_s", "value": 10800 }],
  "cells": ["fold-0"],
  "held_out_cells": ["site-b"]
}
```

The kit holds the scans, their labels and nnU-Net's preprocessed data, and sets the epochs and the seed. Its run command trains the agents' trainer on one cell's training scans and predicts its test scans. Its check scores each structure against the labels, fails the run when a case has no mask or a mask of the wrong shape, and prints one line, such as `{"pass": true, "mean_dice": 0.861, "kidney_dice": 0.962, "tumour_dice": 0.842, "cyst_dice": 0.779, "hd95_mm": 7.4}`. The kit names `run_s` as the run's time on the judge's clock. A gain counts only when it is at least 1% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** Two trainings of the same code score differently, so the judge trains each change several times, alternating with the best version. With a two-hour schedule, expect a few attempts a day on one judge GPU. Search on a short schedule and one fold; confirm the final recipe with a full five-fold training.
- **Where the agents help most.** The training recipe, the post-processing and the inference code: many small changes, each easy to state.
- **Where people stay.** The labels and their protocol, the choice of structures and metrics, reading what the agents changed, and clinical validation.

## What the judge guards against

Weak baselines, unequal budgets and lucky seeds: the judge trains the change and the best version side by side on the same GPU and budget, and a gain must clear the measured difference between training runs. Shortcut learning: a model can learn a scanner's traits in place of anatomy, and the hidden site's scans catch a model that fits one hospital. A shortcut present at every site can still pass, so look at a winning model's masks, not only its Dice.

## Limits

- Dice suits large structures: the Decathlon's organizers wrote that it "should not be used intensively for very small objects" ([Antonelli and others, 2022](https://doi.org/10.1038/s41467-022-30695-9)). For small lesions, add a per-lesion detection rate to the check and guard it.
- A short schedule can rank changes differently from a full one, and a gain smaller than the disagreement between two annotators may mean nothing.
- A rig measures on one machine, with its NVIDIA GPUs. Training across several machines is not a target.
- Dice is not clinical value, and a campaign is not clinical validation or regulatory evidence.

## Who it's for

- **[Startups](../for/startups.mdx):** imaging AI companies that need gains that hold on a new customer's scans.
- **[Enterprises](../for/enterprises.mdx):** academic radiology departments. Scans hold health information, and here they stay with you, with a local model for the agents if you choose.

## Related work

"nnU-Net Revisited" found that "many of these recent claims fail to hold up" when new segmentation methods face strong baselines under the same conditions ([Isensee and others, 2024](https://arxiv.org/abs/2404.09556)). In nnU-Net's own table, a larger residual-encoder network raised five-fold Dice on KiTS from 86.04 to 88.17, at 35 hours of training against 9 ([nnU-Net's documentation](https://github.com/MIC-DKFZ/nnUNet/blob/master/documentation/resenc_presets.md)). Camyla, an agent system, wrote more than 2,700 model implementations in 28 days on eight GPUs, and beat the strongest of 14 baselines, nnU-Net among them, on 22 and 18 of 31 datasets in its two runs, under the same training budgets ([the paper](https://arxiv.org/abs/2604.10696)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on the GPU server where the scans are.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that trains for a fixed budget and scores Dice, and [test it](../../how-to/campaigns/test-a-kit.md): train the unchanged model twice to see the noise, and try a change you know is worse.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
