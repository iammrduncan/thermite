---
title: "Clinical note de-identification"
description: "Use Thermite to raise the recall of a clinical note de-identification system on your own annotated notes, inside your network, with agents on a model you host."
type: use-case
useCase:
  mode: climb
  personas: [enterprises]
  summary: "Agents tune the patterns, word lists and model of a de-identification system. The judge scores recall of identifiers on annotated notes they never see, with precision held."
  measure: "Recall of identifiers · precision, name recall and speed held · notes from another department"
sidebar:
  order: 3
---

Hospitals de-identify clinical notes before they share them for research: discharge summaries, progress notes, radiology reports, often millions at a time. Under HIPAA's Safe Harbor method, 18 types of identifier must go, among them names, every element of a date but the year, medical record numbers, phone numbers and email addresses; the other route, Expert Determination, needs an expert's finding that the risk of identification is very small. Research data teams use tools such as Philter, an open-source system from UCSF that runs an ordered list of regular expressions and word lists; Presidio, an open-source toolkit for finding personal data; and transformer models that tag identifiers. The common benchmark is the 2014 i2b2/UTHealth corpus: 1,304 records of 296 patients, with categories broader than HIPAA's and every identifier replaced by a realistic surrogate.

Raising recall is a long list of small, uncertain changes: a pattern for this hospital's record numbers, a date written as "9/12" that could also be a lab value, a name in a signature line, a safe list of eponyms such as Parkinson that must stay, a threshold on a model's scores. A change that finds more can also remove clinical words, and a system tuned to one hospital's templates misses identifiers in another's. Teams judge a system against notes they annotated themselves: recall first, because a missed name is a disclosure, and precision second, because each word removed in error is lost to research. Thermite gives that scoring to a judge the agents can't reach.

## Where Thermite fits

The agents change the system's configuration and code, each in its own copy: patterns, word lists, the order of filters, a model's settings and how its output joins the rules'. The judge runs the system on annotated notes the kit holds, compares what it removed with the annotations token by token, and times the run on its own clock. The agents never see those notes, their annotations, the scoring script or the hidden department's notes. They work from development notes in their copy, which data agreements usually keep inside your network, so their model must run there too: a model server of your own, such as vLLM or Ollama ([Choose a model](../../how-to/models/choose-a-model.md)).

## Example campaigns

### 1. More identifiers caught, clinical text kept

A research data team runs Philter over discharge summaries and progress notes, and its manual review keeps finding missed record numbers and names.

- **What the agents change:** Philter's filter configuration and its pattern and word-list files; for a system with a model, also its threshold and the rules around it.
- **What the judge runs:** the system over a few thousand annotated notes of one note type, then a token-by-token comparison with the annotations.
- **The number:** recall, the share of annotated identifier tokens the system removed. Higher is better.
- **What must hold:** precision within 1% of the starting system's; recall of names no lower than the starting system's; at least 50 notes a second on the server's CPUs; output that is the input with only the removed spans replaced.
- **Hidden from the agents:** annotated notes from a department whose notes they never saw, such as psychiatry, written in other templates.
- **What agents would try:** patterns for the hospital's own record and accession number formats; dates written as "3/4" or "the 14th"; names in signature lines and in capitals; ages over 89, which Safe Harbor counts as identifiers; safe lists for eponyms such as Hodgkin and for drug names that look like surnames; a named-entity model run beside the rules, keeping what either found.
- **What you get:** the configuration with the best recall that held precision and speed, as a commit on the run's branch, with every attempt and the judge's reasons.

### 2. A new hospital's notes, to the same standard

A health system adds a hospital whose notes come from another electronic health record, and the system must reach the same recall there before those notes go to researchers.

- **Mode:** a goal campaign, which ends when every required goal passes, twice.
- **The goals:** recall at or above 0.99 on the new hospital's annotated notes (an example: you set it); precision there at or above your floor; recall on the original hospital's notes no lower than today's; throughput above your floor.
- **What the agents change:** the same configuration and code.
- **What you get:** a system that met every goal, with the judge's measurements as engineering evidence for the people who approve each release of notes.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "deid-recall",
  "version": 1,
  "title": "Higher identifier recall, precision held",
  "mode": "hill_climb",
  "project": {
    "repo": "deid",
    "kit": { "repo": "deid-kit", "commit": "e3a91c7f2b5d8e0a4c6f1b3d5e7a9c2b4d6f8e1a" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["configs/**", "filters/**", "deid/**"],
  "objective": { "primary": { "metric": "phi_recall", "direction": "max", "min_effect": 0.002 } },
  "guards": [
    { "metric": "phi_precision", "direction": "max", "max_step_regression": 0.005, "max_total_regression": 0.01 },
    { "metric": "name_recall", "direction": "max", "max_step_regression": 0, "max_total_regression": 0 }
  ],
  "hard_constraints": [{ "kind": "min", "metric": "notes_per_s", "value": 50 }],
  "cells": ["discharge", "progress"],
  "held_out_cells": ["psychiatry"]
}
```

The kit holds the annotated notes, a few thousand for each cell, and their annotations, on your servers. Its run command runs the system over one cell's notes. Its check compares the output with the annotations token by token, fails the run when any text outside a removed span has changed, and prints one line, such as `{"pass": true, "phi_recall": 0.9874, "phi_precision": 0.912, "name_recall": 0.9931}`. The kit names `notes_per_s` as a rate on the judge's clock: the cell's `notes` parameter over the run's time. Near full recall the steps are small, so a gain counts from 0.2% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** A run over a few thousand notes takes minutes on CPUs. The judge runs each change several times, alternating with the best version, so an attempt takes a few times that.
- **Where the agents help most.** Patterns, word lists and the rules around a model: work that today means reading misses one at a time. Fine-tuning a model works on a CUDA rig, but each attempt is then a training run.
- **Where people stay.** The annotation guideline and the annotations, the thresholds, reading every change, and the decision to release notes.

## What the judge guards against

A system tuned on one hospital's notes fits that hospital's conventions and degrades on another's. Notes from a withheld department detect this before the system is relied on. A change that removes more text raises recall and loses precision, and the guard stops it; the check that text outside removed spans is unchanged stops a change that rewrites notes.

## Limits

- A score is only as good as the annotations. In the 2014 corpus, annotated twice and arbitrated, the annotators matched the final gold standard with an average token-level F1 of 0.927 ([Stubbs and Uzuner, 2015](https://doi.org/10.1016/j.jbi.2015.07.020)). Annotate the kit's notes twice too.
- Rare types are measured on few examples: that corpus's test set has two fax numbers and one email address ([Yang and Garibaldi, 2015](https://doi.org/10.1016/j.jbi.2015.06.015)). Report recall for each type, with its count.
- Token recall does not measure the risk of re-identification from what remains, such as a rare diagnosis or an unusual event.
- The harness, and code the agents write, can reach the internet ([the security model](../../explanation/security-model.md)). Give the agents notes whose identifiers are already replaced by surrogates, and run the rig where your policies allow the kit's notes.
- A better score does not certify de-identification under HIPAA or GDPR. That decision stays with people.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** a hospital system's research data team. Thermite runs on your machines, and its agents can run on your model, so the notes need not leave.

## Related work

PhysioNet, which shares clinical datasets for research, says its data-use agreement does not allow sending its data "through APIs or using it on online platforms", and lists locally deployed models as "Strongly Recommended" ([PhysioNet's guidance](https://physionet.org/news/post/llm-responsible-use/)). SHIELD, a small de-identification model that runs on a workstation, reported a precision of 0.89 and a recall of 0.88, and found that "institution-specific entities remain hard to transfer in both directions" ([the paper](https://arxiv.org/abs/2605.03301)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md) inside your network, and [connect your own model server](../../how-to/models/connect-a-provider.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that scores against your annotations, and [test it](../../how-to/campaigns/test-a-kit.md) with a change you know misses names and one that removes every word.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
