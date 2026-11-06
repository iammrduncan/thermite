---
title: "Genomics pipeline acceleration"
description: "Use Thermite to make a germline variant-calling pipeline faster on your own servers, with every change scored against a Genome in a Bottle truth set and checked on a sample the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, enterprises]
  summary: "Agents tune the pipeline's tools, threads and scattering. The judge times it on your servers and scores its calls with hap.py against a truth set."
  measure: "Minutes from reads to calls · SNV and indel F1 held · a sample the agents never see"
sidebar:
  order: 1
---

A sequencing lab turns each sample's reads into a list of variants with a pipeline: align the reads to the reference genome with BWA-MEM2, sort them and mark duplicates with samtools, call variants with GATK HaplotypeCaller or DeepVariant, then filter. The pipeline is usually a workflow in Nextflow, such as nf-core/sarek, running on the lab's own servers. A 30x whole genome costs many core-hours on CPUs: one published benchmark measured 36 hours for HaplotypeCaller alone. Every sample pays it again.

Making the pipeline faster is a long list of small, uncertain changes: thread counts, how finely each step is split across the genome, a faster tool for one step, a GPU build of another, a step that may not be needed. Each one has to show that it still calls the same variants. Labs already have that check: the Genome in a Bottle (GIAB) truth sets from NIST, and `hap.py`, the benchmarking tool that reports precision, recall and F1 for SNVs and indels against them. Thermite gives that check to a judge the agents can't reach, and lets agents work through the list.

## Where Thermite fits

The agents change the workflow and its configuration, each in its own copy. The judge runs the pipeline on reads it holds, scores the calls with `hap.py` against the truth set, and times the whole run on its own clock. The agents never see the reads the judge uses, the truth VCFs, the scoring script or the hidden sample. They learn only the judge's verdict and its reasons.

## Example campaigns

### 1. Fewer hours per genome, the same calls

A core facility runs a germline pipeline on 30x genomes and wants more samples a day from the same servers.

- **What the agents change:** the workflow files and their configuration: process resources and thread counts, how many intervals HaplotypeCaller is scattered over, tool versions and flags.
- **What the judge runs:** the pipeline from reads to VCF on chromosome 20 of HG002 at 30x, so that one run takes minutes rather than a day, then `hap.py` against the GIAB benchmark for that region.
- **The number:** wall time from reads to VCF, on the judge's clock. Lower is better.
- **What must hold:** SNV F1 and indel F1, each within 0.1% of the starting pipeline's; a valid VCF.
- **Hidden from the agents:** chromosome 20 of a second sample with a validated call set, ideally one of the lab's own, so that a change tuned to HG002 is caught.
- **What agents would try:** BWA-MEM2 in place of BWA-MEM; sorting and duplicate marking with more threads; scattering over more, smaller intervals; skipping base quality score recalibration where it doesn't change the calls (the F1 guards decide); a GPU build of one step on a CUDA rig.
- **What you get:** the fastest pipeline that held accuracy, as a commit on the run's branch, and every attempt with its time, its F1 and the judge's reasons.

### 2. Change callers, with the evidence to show for it

A lab wants to move from HaplotypeCaller to DeepVariant, or to a new major version of GATK, and needs evidence before it changes production.

- **Mode:** a goal campaign, which ends when every required goal passes, twice.
- **The goals:** the new pipeline builds and runs end to end in the lab's container; SNV and indel F1 on HG002 chromosome 20 at or above the thresholds the lab sets; the same on the hidden sample; and run time no worse than the current pipeline's.
- **What the agents change:** the workflow, its container definition and the caller's settings.
- **What you get:** a migrated pipeline and, for each goal, the judge's measurements. It is engineering evidence, not clinical validation.

### 3. Read the benchmarks first

Before either campaign, a research campaign can answer a question such as "In published GIAB-based benchmarks, how do DeepVariant and GATK HaplotypeCaller compare on indels in difficult regions at 30x short-read coverage?" The agents read open-access papers and benchmark reports, and record claims whose quotes code finds, word for word, in the pages it archived. The report lists every source.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "germline-speed",
  "version": 1,
  "title": "Faster germline calling, accuracy held",
  "mode": "hill_climb",
  "project": {
    "repo": "germline-pipeline",
    "kit": { "repo": "germline-kit", "commit": "9b2f6c1e4a7d8b3c5e0f1a2b3c4d5e6f7a8b9c0d" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["workflows/**", "conf/**"],
  "objective": { "primary": { "metric": "wall_s", "direction": "min", "min_effect": 0.03 } },
  "guards": [
    { "metric": "snv_f1", "direction": "max", "max_step_regression": 0.0005, "max_total_regression": 0.001 },
    { "metric": "indel_f1", "direction": "max", "max_step_regression": 0.0005, "max_total_regression": 0.001 }
  ],
  "cells": ["hg002-chr20"],
  "held_out_cells": ["lab-sample-chr20"]
}
```

The kit holds the reads and the truth sets. Its run command starts the workflow on one cell's sample; its check runs `hap.py` on the VCF and prints one line, such as `{"pass": true, "snv_f1": 0.9987, "indel_f1": 0.9962}`. The kit names `wall_s` as the run's time on the judge's clock, and `snv_f1` and `indel_f1` as numbers read from the check. A gain counts only when it is at least 3% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge runs each change several times, alternating with the best version so far, so an attempt takes several times one pipeline run. Keep the cells small: one chromosome at 30x, or a downsampled genome.
- **Where the agents help most.** Configuration and orchestration: threads, memory, scattering, tool choices. Rewriting an aligner or a caller is a larger project, and a goal campaign suits it better.
- **Where people stay.** Choosing the truth sets and thresholds, reading what the agents changed, and validating the pipeline for clinical use.

## What the judge guards against

A pipeline tuned on one public sample can overfit to it, which is why the precisionFDA Truth Challenge withheld two samples. Thermite applies the same principle with hidden cases. Keep the hidden sample private or unpublished: the agents' commands can reach the internet, and public truth sets can be downloaded.

## Limits

- GIAB benchmarks cover the high-confidence parts of the genome; report difficult regions separately, with GIAB's stratifications.
- A rig measures on one machine, with its CPUs or NVIDIA GPUs. A cluster scheduler such as Slurm is not a target: measure the pipeline on one node.
- A faster pipeline is not a validated one. Clinical validation under CLIA or CAP stays a separate step, done by people.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** bioinformaticians in core facilities with a single server and a large sample backlog.
- **[Enterprises](../for/enterprises.mdx):** hospital genomics laboratories and pharmaceutical R&D. Genomes can identify a person, and here they stay on your machines, with a local model for the agents if you choose.

## Related work

On GPUs, a variant-calling step that took 36.26 hours on CPUs ran in 41.5 minutes on eight V100s ([O'Connell and others, 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10230726/)): engineered by people, but a measure of the room there is. In 2026, an LLM agent made three bioinformatics methods faster "by up to two orders of magnitude over the fastest existing tools", against correctness criteria that people set ([the paper](https://arxiv.org/abs/2609.37849)). The precisionFDA Truth Challenge V2 held back HG003 and HG004 "primarily to minimize gross over-fitting" ([Olson and others, 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC9205427/)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on the server where the data is.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) around `hap.py` and a truth set, and [test it](../../how-to/campaigns/test-a-kit.md) with a change you know is slower and one you know breaks the calls.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
