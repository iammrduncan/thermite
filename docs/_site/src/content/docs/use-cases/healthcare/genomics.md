---
title: "Genomics pipeline acceleration"
description: "Use Thermite to accelerate a genomics pipeline on your own infrastructure, with variant calls validated against a public truth set on held-out samples."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, enterprises]
  summary: "Agents optimize the pipeline. The judge measures run time on your infrastructure and validates the calls against a truth set on held-out samples."
  measure: "Minutes per sample · F1 against a truth set held · samples the agents never see"
sidebar:
  order: 1
---

Sequencing facilities run the same pipeline on every sample: alignment, variant calling and filtering. Compute time per sample accumulates, and every optimization must demonstrate that it calls the same variants. Public truth sets, such as NIST's Genome in a Bottle samples, and tools such as `hap.py` already provide that check. Thermite puts agents on the pipeline and gives that check to the judge.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md) on run time, with `"direction": "min"` |
| **The number** | Minutes from aligned reads to variant calls, from the judge's clock, over slices of the genome |
| **What must hold** | SNV and indel F1 against the truth set, as guards, including in the difficult regions; the output files are valid |
| **Hidden from the agents** | Other truth-set samples, such as HG003 and HG004 when the agents work on HG002 |
| **Where it runs** | A CPU rig, or a CUDA rig for GPU-accelerated callers, on the machines where the data already is |

## How it runs

1. **You write a kit** whose cases are slices of a sample, so that each run takes minutes rather than hours, and whose check runs `hap.py` against the truth set and prints the scores.
2. **Agents try changes:** threads and memory, the order of steps, a faster tool for one stage, a GPU build of another.
3. **The judge times each change** and scores its calls. A change that is faster but loses accuracy is a tradeoff, not a win; a win must also hold on the hidden samples.
4. **A goal campaign can port the pipeline**, for example to a GPU or to a new release of a tool, with goals that its calls match the old pipeline's on each sample.

## What the judge guards against

A pipeline tuned on one public sample can overfit to it, which is why the precisionFDA Truth Challenge withheld two samples. Thermite applies the same principle with hidden cases. Keep those samples private or unpublished: the agents' commands can reach the internet, and public truth sets can be downloaded.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** bioinformaticians in core facilities with a single server and a large sample backlog.
- **[Enterprises](../for/enterprises.mdx):** hospital genomics laboratories and pharmaceutical R&D. Genomes can identify a person, and here they stay on your machines, with a local model for the agents if you choose.

## Related work

On GPUs, a variant-calling step that took 36.26 hours on CPUs ran in 41.5 minutes on eight V100s ([O'Connell and others, 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10230726/)): engineered by people, but a measure of the room there is. In 2026, an LLM agent made three bioinformatics methods faster "by up to two orders of magnitude over the fastest existing tools", against correctness criteria that people set ([the paper](https://arxiv.org/abs/2609.37849)). The precisionFDA Truth Challenge V2 held back HG003 and HG004 "primarily to minimize gross over-fitting" ([Olson and others, 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9205427/)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on the server where the data is.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around `hap.py` and a truth set, and [test it](../../how-to/campaigns/test-a-kit.md).
3. A faster pipeline is not a validated one. Clinical validation stays a separate step, done by people.
