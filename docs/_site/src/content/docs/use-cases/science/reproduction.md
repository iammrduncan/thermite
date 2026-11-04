---
title: "Reproducing published results"
description: "Use a Thermite goal campaign to reproduce a paper's tables and figures from its released code and data, with each reported number checked within your tolerance by a kit the agents can't see, and seeds held back for the final checks."
type: use-case
useCase:
  mode: goal
  personas: [solo-builders, enterprises]
  summary: "Agents make the released code install and run. The judge rebuilds it, reruns each table and figure and checks every number within your tolerance, and the run ends when every goal passes twice."
  measure: "Tables and figures reproduced · each number within your tolerance, with the paper's settings · seeds the agents never see"
sidebar:
  order: 5
---

Reproducing a paper from its released code and data is routine work. Artifact evaluation committees at ACM conferences run authors' code and award badges such as Artifacts Evaluated – Functional and Results Reproduced. The American Economic Association's data editor checks the replication packages of its journals' papers. Participants in the Machine Learning Reproducibility Challenge, which has run since 2018, reproduce papers from leading venues, and labs reproduce a baseline before they build on it. The code comes from GitHub, Zenodo or a Code Ocean capsule. Nobody expects identical numbers: in [ACM's policy](https://www.acm.org/publications/policies/artifact-review-and-badging-current), "the results must be in agreement to within a tolerance deemed acceptable for experiments of the given type".

It often fails. Trisovic and others ran over 9,000 R files from replication datasets on the Harvard Dataverse: 74% failed to complete without error, and 56% still failed after automatic code cleaning ([Scientific Data, 2022](https://doi.org/10.1038/s41597-022-01143-6)). Of 28 papers with code and data in the 2022 reproducibility challenge, 18 were completely reproducible ([CORE-Bench](https://arxiv.org/abs/2409.11363)). The causes are familiar: a pinned version that no longer installs, an API that was removed (NumPy 1.24 removed `np.float`), a hard-coded path, a preprocessing step the README leaves out. And whether a number is reproduced is often judged by eye, by the person who fixed the code and may have changed a setting to reach it. Thermite runs the reproduction as a goal campaign, with a goal for each table and figure, checked by a kit the agents can't see.

## Where Thermite fits

The agents change what stands between the released code and a clean run, each in its own copy: environment files, scripts, paths, calls to removed APIs. The judge builds each change with the kit's build, which installs the pinned packages on the rig's image, runs the pipeline for each table and figure, and compares each number with the paper's within the tolerance you set. The paper's settings, its reported values, the tolerances and the seeds held back for the final checks belong to the kit. The agents can read the paper, but they never see the check, and they can't change what a result is compared with.

## Example campaigns

### 1. Table 2 and Figure 3 of a machine-learning paper

A group wants to build on a paper's method, and first wants its Table 2 and Figure 3 from the authors' released code.

- **Mode:** a goal campaign on a CUDA rig whose harness image has the PyTorch release the paper used ([Extend the harness image](../../how-to/install/extend-harness-image.md)). It ends when every required goal passes on two checks of the best version, hidden seeds included, or, as this contract allows, as "not possible" once three approaches have failed: a failure to reproduce, with its evidence.
- **The goals:**
  - the environment installs from the repository's pinned files, and the code imports;
  - `reproduce.sh` runs end to end on a small configuration the kit sets. It requires the environment, and the goals below require it;
  - each test accuracy in Table 2, on three datasets, within 0.5 points of the paper's mean over its five seeds, with the paper's settings; part of the runs, with seeds the agents never see, are held back for confirmation;
  - Figure 3, drawn by the authors' plotting script from this run's outputs, with each curve within the team's tolerance of values read off the published figure;
  - optionally, for a review panel of models: `REPRODUCE.md` says how to rebuild each table and figure, and lists every change to the authors' code.
- **What the agents change:** the environment files, `src/`, `scripts/`, `reproduce.sh` and `REPRODUCE.md`. The paper's settings, in `configs/`, are outside `editable_paths`.
- **What agents would try:** the newest release of each pinned package that still installs and keeps its API; removed aliases such as `np.float` replaced; absolute paths made relative; a preprocessing step rebuilt from the paper's appendix; PyTorch's deterministic algorithms, to tell a real gap from noise.
- **What you get:** a branch on which `reproduce.sh` rebuilds Table 2 and Figure 3, with the judge's evidence for each goal, or the approaches that failed.

### 2. An R replication package for a social-science paper

A team that will extend a published study needs its replication package to run from the raw data to the tables.

- **Mode:** a goal campaign on a CPU rig whose harness image has R added.
- **The goals:** `renv::restore()` installs the packages that `renv.lock` names; the master script runs from the raw data to the tables; each coefficient and standard error in Tables 1 to 3 matches the paper to the digits it prints; Figure 2 is drawn from the run's own estimates. The appendix's robustness tables are held out.
- **What the agents change:** `renv.lock` where a pinned version no longer builds, and the scripts' paths, calls and order.
- **What you get:** a package that runs from start to end on a clean machine, with the judge's evidence for each table.

### 3. Collect what the paper reports first

Before either, a research campaign can collect each number the paper reports, quoted from its HTML page on arXiv with the table it sits in, and what the repository's issue threads and other groups' reports say about each. The kit's expected values then rest on quotes that code found, word for word, in pages it archived. [Data from the literature](literature-data.md) shows a research campaign that builds such a table.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "reproduce-table-2",
  "version": 1,
  "title": "Reproduce the paper's Table 2 and Figure 3 from its released code and data",
  "mode": "goal",
  "project": {
    "repo": "paper-code",
    "kit": { "repo": "paper-repro-kit", "commit": "5d2b8e1f4a7c0e3b6d9f2a5c8e1b4d7f0a3c6e9b" }
  },
  "target": { "type": "cuda-gpu", "class": "nvidia-gpu" },
  "models": [
    { "name": "released-data", "sha256": "8f3a1c6e9b2d5f8a1c4e7b0d3f6a9c2e5b8d1f4a7c0e3b6d9f2a5c8e1b4d7f0a" }
  ],
  "editable_paths": ["requirements.txt", "pyproject.toml", "src/**", "scripts/**", "reproduce.sh", "REPRODUCE.md"],
  "goals": [
    { "id": "environment", "description": "the environment installs from the repository's pinned files, and the code imports", "verify": { "type": "code", "verifier": "environment" } },
    { "id": "pipeline", "description": "reproduce.sh runs end to end on the kit's small configuration", "verify": { "type": "code", "verifier": "pipeline" } },
    { "id": "table-2", "description": "each test accuracy in Table 2 within 0.5 points of the paper's mean, with the paper's settings", "verify": { "type": "code", "verifier": "table-2" } },
    { "id": "figure-3", "description": "Figure 3 drawn from this run's outputs, each curve within tolerance of the published one", "verify": { "type": "code", "verifier": "figure-3" } },
    { "id": "documented", "description": "REPRODUCE.md says how to rebuild each table and figure", "required": false, "verify": { "type": "review", "criteria": ["names the command, the hardware and the time for each table and figure", "lists every change to the authors' code, with its reason"] } }
  ],
  "deliverable": "a branch on which reproduce.sh rebuilds Table 2 and Figure 3 from the released code and data",
  "insufficient": ["numbers written into the outputs instead of computed", "settings changed from the paper's to reach its numbers", "a seed chosen because it matches the paper"],
  "adversarial_checklist": ["the paper's reported values appear in the code or in what writes the outputs", "the training or test split differs from the paper's"],
  "infeasibility": { "allowed": true, "min_refuted_approaches": 3 },
  "held_out_cells": ["table-2-hidden-seeds"]
}
```

The kit holds the paper's settings, its reported values, the tolerances, the test labels and the hidden seeds. Its verifier `environment` has priority 10 and the cell `imports`. `pipeline`, priority 20, requires it and runs `smoke`. `table-2`, priority 50, requires `pipeline` and has four cells: `table-2-a`, `table-2-b`, `table-2-c` and the held-out `table-2-hidden-seeds`, each training with its own seeds and with its own time limit. `figure-3`, priority 60, requires `pipeline` too, and its check compares the curves the plotting script draws with values the team read off the published figure. A Table 2 run writes its test predictions and the settings it used; the check scores the predictions with the kit's labels, compares the settings with the paper's, and prints one line, such as `{"pass": true, "accuracy": 83.1, "reported": 83.5, "tolerance": 0.5}`, with `pass` false when the accuracy is further from the paper's than the tolerance or a setting differs. The authors' data reach the rig as a [file the contract names](../../how-to/campaigns/model-weights.md) with its SHA-256 ([Contract](../../reference/contract.md#goal), [Kit manifest](../../reference/kit-manifest.md#verifiers)).

## What to expect

- **Time per check.** The environment goal is an install, the pipeline a few minutes, a Table 2 cell a full training. When the run starts and after each promotion, the judge checks every goal on the best version, so give the cheap verifiers the lower priority numbers and keep each cell as short as the paper's protocol allows. A cell's run has at most a day.
- **Where the agents help most.** The long tail between `git clone` and a full run: versions, removed APIs and paths, with several lanes trying at once. On a rig with two GPUs, give the agents one.
- **Where people stay.** Choosing each tolerance, reading values off figures, deciding whether a change to the authors' code changes the method, and asking the authors about a gap.

## What the judge guards against

The easiest way to reproduce a number is to write it down. The next is to change a setting until the number comes out, or to try seeds until one matches. Here the check computes each accuracy itself, from the run's predictions and the kit's labels; it compares the settings the run used with the paper's, which sit outside `editable_paths`; and seeds the agents never see catch a seed chosen to match. The `insufficient` list tells the auditor and the review panel what never counts, and the adversarial checklist sends every promotion to an audit first. Set each tolerance from the paper's own spread across seeds, not from the gap you see: ACM's test is that differences "should not change the main claims made in the paper".

## Limits

- A rig measures on one machine. A paper trained on many GPUs or nodes can't be rerun as one: reproduce its smaller experiments, or a reduced configuration the authors give.
- The judge builds and runs in the rig's harness image, so a repository's Dockerfile doesn't set the environment: put what it installs in a harness image of your own, or in the kit's build. A build's outputs may hold no links and at most 20,000 entries, so a framework as large as PyTorch belongs in the image. Commercial software, such as MATLAB or Stata, needs your own image and its licence.
- Judged runs get no API keys, only `PATH` and `LANG`: a pipeline that calls a hosted model while it runs can't be judged. A kit's check has no GPU, so it reads the run's outputs on the CPUs.
- The agents' commands can reach the internet. Data held out must be data they can't download; the hidden seeds stay in the kit.
- Running the authors' code again runs their bugs again. An independent implementation, which ACM calls Results Replicated, is separate work.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** students and researchers who reproduce a baseline before they build on it, or a paper for the reproducibility challenge.
- **[Enterprises](../for/enterprises.mdx):** R&D teams that check a published method before they adopt it, on your own machines, with the evidence for each number on record.

## Related work

ACM's [Artifact Review and Badging](https://www.acm.org/publications/policies/artifact-review-and-badging-current) (version 1.1, 2020) says that "exact replication or reproduction of results is not required, or even expected". In CORE-Bench, 270 tasks from 90 papers' Code Ocean capsules, the best agent of 2024 solved 21% of the hardest tasks ([the paper](https://arxiv.org/abs/2409.11363)); Princeton's Holistic Agent Leaderboard later "declared CORE-Bench solved", after Claude Opus 4.5 in Claude Code scored 77.78% on its hard set, and 95.5% with manual validation ([HAL](https://hal.cs.princeton.edu/corebench_hard)). PaperBench asks agents to replicate 20 ICML 2024 papers from scratch, without the authors' code, and grades them with a language model against rubrics: the best agent scored 21.0%, and ML PhDs 41.4% after 48 hours on three papers ([Starace and others, 2025](https://arxiv.org/abs/2504.01848)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [run a first goal campaign](../../tutorials/first-goal-campaign.md) on the sample project.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md#7-add-verifiers-for-goal-campaigns) whose verifiers require one another, with the paper's values and your tolerances in the kit.
3. [Test it](../../how-to/campaigns/test-a-kit.md) with a version that prints the paper's numbers without computing them, to see that the check fails it, then [write a contract](../../how-to/campaigns/write-a-contract.md) like the one above and start the campaign.
