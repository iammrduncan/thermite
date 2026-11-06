---
title: "LLM application quality"
description: "Use Thermite to raise an LLM feature's accuracy on your labelled examples, scored by a program, with cost and latency as guards and a test split the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises, local-ai]
  summary: "Agents change prompts, examples, schemas, retrieval and the model for each step. The judge runs the pipeline on your labelled examples, scores it with a program, and guards cost and time."
  measure: "Field F1 or accuracy on your labels · cost and time per example held · a test split the agents never see"
sidebar:
  order: 2
---

Teams build LLM features as pipelines: extract an invoice's fields into JSON, classify and route support tickets, answer questions from documents with retrieval-augmented generation (RAG: find the relevant passages, then answer from them). Each step has choices: the prompt, the few-shot examples, the output schema, the model, and for RAG the chunking, the number of passages and a reranker. Teams judge a change on a labelled set with a metric that fits the task: exact match or field-level F1 for extraction, accuracy or macro-F1 for classification, recall@k for retrieval (the share of questions whose right passage is in the top k).

Each pass over the set costs a model call per example, and the scores move with every change: a prompt that fixes one case can break others, and a hosted model can answer the same request differently twice. A change needs several runs to tell it from noise, and a test set that the people tuning the pipeline don't read. Prompt optimizers such as DSPy's automate part of the search. Thermite gives the scoring to a judge the agents can't reach, and lets agents work through the changes.

## Where Thermite fits

The agents change the pipeline's code, prompts and configuration, each in its own copy, and can run it on a development set in the project. The judge runs each version on the scoring set in the kit, scores the answers against your labels with a program, and counts cost and time. The agents never see the scoring set, its labels, the scoring program or the test split held back for confirmation.

## Example campaigns

### 1. More invoice fields right, at the same cost

A finance-operations product extracts the supplier, invoice number, dates, totals, tax and line items from PDF invoices, and customers correct too many fields by hand.

- **What the agents change:** the prompts, the few-shot examples, the output schema, the clean-up of the PDF's text, and the model for each step.
- **What the judge runs:** the pipeline on the kit's scoring invoices, as two cells split by supplier, then a check that normalizes dates, amounts and names and compares each field with its label.
- **The number:** field-level F1. Higher is better.
- **What must hold:** cost per invoice, from each call's tokens and the kit's price for each model, no more than 5% worse in one step and 10% in all; the batch's run time, no more than 10% and 20% worse; at least 99% of outputs valid against the schema.
- **Hidden from the agents:** invoices from suppliers in neither the development nor the scoring set.
- **What agents would try:** a stricter schema, with enumerations and formats; few-shot examples for the hard layouts; line items in a second, narrower call; amounts normalized in code, not by the model; a DSPy optimizer such as MIPROv2 or GEPA on the development set; a smaller model for the header fields.
- **What you get:** the best pipeline as a commit on the run's branch, with every attempt's scores and the judge's reasons. The same kit serves the opposite campaign: cost as the number, field F1 as the guard.

### 2. Retrieve the right passage first

A support assistant answers from a help centre and internal runbooks, and most wrong answers trace back to a passage that was never retrieved.

- **What the agents change:** the chunking, search and ranking code and its settings.
- **What the judge runs:** a build that indexes the kit's snapshot of the documents, then retrieval for each labelled question.
- **The number:** recall@10. Higher is better.
- **What must hold:** the run's time, as a guard on latency.
- **Hidden from the agents:** questions from recent tickets, labelled by the support team.
- **What agents would try:** other chunk sizes, overlaps or splits on headings; rewriting the query; weighting keyword (BM25) and embedding scores in a hybrid search; more or fewer passages; a reranker; filters by product or version.
- **What you get:** better retrieval. A later campaign can score the answers by program: exact match for short facts, and each citation a retrieved passage that holds the quoted words.

### 3. Read the evidence on prompt optimizers

A research campaign can answer a question such as "What do published comparisons show about automatic prompt optimizers, such as DSPy's MIPROv2 and GEPA, against hand-written prompts, and on how many examples?" The agents read papers and documentation, and record claims whose quotes code finds, word for word, in the pages it archived. [Model and method landscape](method-landscape.md) shows a larger research campaign, on choosing the model itself.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "invoice-extraction",
  "version": 1,
  "title": "More invoice fields right, at the same cost",
  "mode": "hill_climb",
  "project": {
    "repo": "invoice-pipeline",
    "kit": { "repo": "invoice-kit", "commit": "7d1e4b8a2f6c9e3d5a0b7c1f4e8d2a6b9c3f5e7d" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["pipeline/**", "prompts/**", "config/**"],
  "objective": { "primary": { "metric": "field_f1", "direction": "max", "min_effect": 0.01 } },
  "guards": [
    { "metric": "cost_per_doc", "direction": "min", "max_step_regression": 0.05, "max_total_regression": 0.1 },
    { "metric": "batch_s", "direction": "min", "max_step_regression": 0.1, "max_total_regression": 0.2 }
  ],
  "hard_constraints": [{ "kind": "min", "metric": "valid_rate", "value": 0.99 }],
  "cells": ["suppliers-a", "suppliers-b"],
  "held_out_cells": ["new-suppliers"]
}
```

The kit holds the scoring invoices with their labels, a price per token for each model, and a runner. Its run feeds one cell's invoices through the pipeline, a fixed number at a time, and writes each answer with each call's tokens. Its check scores each field and prints one line, such as `{"pass": true, "field_f1": 0.912, "cost_per_doc": 0.0041, "valid_rate": 0.995}`. The kit names `batch_s` as the run's time on the judge's clock, and the rest as numbers read from the check. Every value must be above zero, so give a local model a price of your own. A gain counts only when it is at least 1% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Cost per attempt.** The judge runs each change several times, alternating with the best version, and each run calls the model for every invoice in a cell. With the default settings, a change rejected at the first look costs three runs of each version on each cell, and a promoted one at least eight, plus the held-out cell. A hosted model's answers vary from run to run, and the judge decides against that noise.
- **Where the agents help most.** Prompts, examples, schemas and retrieval settings: many small changes, each cheap to try.
- **Where people stay.** Labelling, and fixing labels the agents' failures show are wrong; choosing the metric; reviewing what the labels don't cover, such as tone.

## What the judge guards against

A pipeline tuned on a small set overfits to it. The agents see the development set and can copy its cases into few-shot examples, so the scoring set lives in the kit and a test split is held back for confirmation. Split by supplier, customer or month, not at random, or near-duplicates on both sides hide the overfitting. Scoring is done by a program, not by another model: a model used as a judge has known biases, and agents searching against it can learn to please it instead of matching your labels. Leave a quality with no program check, such as tone, to people.

## Limits

- The judge's runs get no secrets: a kit holds no keys, and a run's environment has only a path, a locale, a user and its folders. Serve the pipeline's model from a server the rig reaches without a key, such as vLLM or Ollama on your network, or a gateway there that holds the provider's key.
- The agents' commands reach the same server and the internet: keep the labelled data private.
- Guards are compared with the starting point over the whole run, so a provider that changes or slows a model reads as a change's doing. Pin a dated model version where you can.
- The number measures only what the labels hold.

## Who it's for

- **[Startups](../for/startups.mdx):** higher accuracy at the same cost per request, with evidence you can show customers.
- **[Enterprises](../for/enterprises.mdx):** your examples, your documents and, if you choose, your own model server, on machines you control.
- **[Local AI enthusiasts](../for/local-ai.mdx):** tune a pipeline that runs on your own model server, with no per-request cost for the agents or the scoring.

## Related work

GEPA, a method that improves prompts by reflecting on what went wrong, did better than reinforcement learning (GRPO) by 6% on average and by up to 20% across six tasks, with up to 35 times fewer rollouts, and beat MIPROv2 by over 10% ([the paper](https://arxiv.org/abs/2507.19457)). Thermite gives such a search a judge it can't reach. In one study, GPT-4 as a judge agreed with people's preferences over 80% of the time, and models as judges showed position, verbosity and self-enhancement biases ([Zheng and others, 2023](https://arxiv.org/abs/2306.05685)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) whose check prints the score: the kit can name each number it reports as a metric. [Test it](../../how-to/campaigns/test-a-kit.md) with a prompt you know is worse.
3. [Connect the model](../../how-to/models/connect-a-provider.md) that the agents use; the pipeline's own model is the one its server serves.
