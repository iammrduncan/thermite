---
title: "Make your LLM feature score higher on your own tests"
description: "Raise the accuracy of an extraction, classification or retrieval pipeline on a labelled set of your own, with cost and latency held as guards and a test split the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [startups, enterprises, local-ai]
  summary: "Agents change prompts, retrieval and code. A program scores each version on your labelled set, cost and latency can't grow, and the test split stays hidden."
  measure: "Accuracy or F1 on your labels · cost and latency guards · a test split of your examples"
sidebar:
  order: 2
---

An LLM feature, such as pulling fields out of invoices, sorting support tickets or answering from your documents, is a pipeline of prompts, retrieval and code. Each change is a guess until it is scored on real examples. If you have a labelled set, Thermite can put agents on that pipeline: they change the prompts, the retrieval and the code around them, and a check program scores every version on your labels.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md) |
| **The number** | Exact match, F1 or accuracy on your labelled examples, reported by the kit's check |
| **What must hold** | Cost per request and latency, as guards: each may not get worse by more than the share you set |
| **Hidden from the agents** | A test split of your examples, which a win must also pass |
| **Where it runs** | A CPU rig. The check calls the model your feature uses, so each scoring costs what those calls cost |

## How it runs

1. **You write a kit** whose run command runs the pipeline on a batch of examples, and whose check compares the answers with your labels and prints the score, the cost and the time.
2. **You split your examples.** Put a development set in the project, where the agents can run their changes. Put the scoring set in the kit, which only the judge reads, and mark part of it hidden in the contract: the judge runs that part only to confirm a win, and the agents never learn its names or results.
3. **Agents try changes:** a clearer prompt, few-shot examples, a different chunk size, a reranker, a cheaper model for an easy step.
4. **The judge scores each change** beside the best version so far. A change that scores higher but costs more than the guard allows is a tradeoff, not a win.

## What the judge keeps out

A pipeline tuned on a handful of examples learns those examples. The hidden split catches it. Score with a program, not with another model: a score that a model gives puts a model back in the judge's seat, and the agents can learn to please it.

## Who it's for

- **[Startups](../for/startups.mdx):** a better feature at the same cost a request, with the evidence to show a customer.
- **[Enterprises](../for/enterprises.mdx):** your examples, your documents and, if you choose, your own model server, on machines you control.
- **[Local AI enthusiasts](../for/local-ai.mdx):** tune a pipeline that runs on your own model server, so neither the agents nor the scoring cost anything a request.

## What others have shown

GEPA, a method that improves prompts by reflecting on what went wrong, did better than reinforcement learning (GRPO) by 6% on average and by up to 20%, with up to 35 times fewer tries ([the paper](https://arxiv.org/abs/2507.19457)). Thermite gives such a search a judge that it cannot reach.

## Start

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) whose check prints the score: the kit can name each number it reports as a metric.
3. [Connect the model](../../how-to/models/connect-a-provider.md) that the agents use; the check's model is the kit's own business.
