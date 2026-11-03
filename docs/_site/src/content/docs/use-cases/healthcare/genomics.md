---
title: "Speed up a genomics pipeline without losing a variant"
description: "Make a variant-calling or analysis pipeline faster on your own machines while the judge holds its accuracy to a public truth set, scored on samples the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, enterprises]
  summary: "Agents speed up the pipeline. The judge times each version on your machines and scores its calls against a truth set, on samples the agents never see."
  measure: "Minutes per sample · F1 against a truth set held · samples the agents never see"
sidebar:
  order: 1
---

A sequencing core runs the same pipeline on every sample: align the reads, call the variants, filter them. Hours of compute a sample add up, and every speed-up has to prove that it calls the same variants. That check already exists: public truth sets, such as the Genome in a Bottle samples from NIST, say which variants are really there, and tools such as `hap.py` score a pipeline's calls against them. Thermite puts agents on the pipeline and that check in the judge's hands.

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

## What the judge keeps out

A pipeline tuned on one public sample can learn that sample. This is why the precisionFDA Truth Challenge kept two samples back. Thermite does the same with hidden cases. Keep the hidden samples private or new, too: the agents' commands can reach the internet, and a public truth set can be downloaded.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** a bioinformatician in a core facility, with one server and a backlog.
- **[Enterprises](../for/enterprises.mdx):** hospital genomics laboratories and pharmaceutical R&D. Genomes can identify a person, and here they stay on your machines, with a local model for the agents if you choose.

## What others have shown

On GPUs, a variant-calling step that took 36.26 hours on CPUs ran in 41.5 minutes on eight V100s ([O'Connell and others, 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10230726/)): engineered by people, but a measure of the room there is. In 2026, an LLM agent made three bioinformatics methods faster "by up to two orders of magnitude over the fastest existing tools", against correctness criteria that people set ([the paper](https://arxiv.org/abs/2609.37849)). The precisionFDA Truth Challenge V2 held back HG003 and HG004 "primarily to minimize gross over-fitting" ([Olson and others, 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9205427/)).

## Start

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on the server where the data is.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around `hap.py` and a truth set, and [test it](../../how-to/campaigns/test-a-kit.md).
3. A faster pipeline is not a validated one. Clinical validation stays a separate step, done by people.
