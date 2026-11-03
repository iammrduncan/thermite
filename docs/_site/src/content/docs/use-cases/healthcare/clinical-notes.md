---
title: "De-identify clinical notes better, inside your own walls"
description: "Raise the recall of a de-identification system on your own annotated notes, with precision held and notes from another department kept hidden, on machines and a model that never send the notes out."
type: use-case
useCase:
  mode: climb
  personas: [enterprises]
  summary: "Agents improve a de-identification system on your annotated notes, with a local model. The judge scores recall on notes from a department they never see."
  measure: "Recall of protected details · precision held, other text unchanged · notes from another department"
sidebar:
  order: 3
---

Before clinical notes can be used for research, the details that identify a patient must come out: names, dates, addresses, record numbers. A system that misses one detail in a hundred notes is a problem; a system that removes half the medical text is useless. Both are measurable on notes that people have annotated. Thermite can improve such a system on your own notes, inside your own network, with agents on a model that you run yourself.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md) |
| **The number** | Recall of the protected details in the annotated notes, reported by the kit's check |
| **What must hold** | Precision, as a guard; the text that is not protected is unchanged |
| **Hidden from the agents** | Notes from a department or of a kind that the agents never saw, which a win must also pass |
| **Where it runs** | A CPU or CUDA rig inside your network, with the agents on a model server inside it too |

## How it runs

1. **You write a kit** that runs the system, such as a set of rules, a small model or both, on the annotated notes and scores what it removed against the annotations.
2. **You point the agents at a local model.** The scoring notes stay in the kit, which only the judge reads, but the agents work with development notes in their copy of the project, so their model must run where the notes may go: a server of your own, such as vLLM or Ollama ([Choose a model](../../how-to/models/choose-a-model.md)).
3. **Agents try changes:** new rules, better patterns for dates and record numbers, a model fine-tuned on your notes.
4. **The judge scores each change.** A change that finds more but removes medical text loses on the guard; a win must also hold on the hidden department's notes.

## What the judge keeps out

A system tuned on one hospital's notes learns that hospital's habits, and fails on the next one's. The hidden department's notes catch this before you rely on the system.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** a hospital system's research data team. Thermite runs on your machines, and its agents can run on your model, so the notes need not leave.

## What others have shown

PhysioNet, which shares clinical datasets for research, says its data-use agreement does not allow sending its data "through APIs or using it on online platforms", and marks locally deployed models "Strongly Recommended" ([PhysioNet's guidance](https://physionet.org/news/post/llm-responsible-use/)). SHIELD, a small de-identification model that runs on a workstation, reported a precision of 0.89 and a recall of 0.88, and that "institution-specific entities transfer poorly" ([the paper](https://arxiv.org/abs/2605.03301)). No published work has yet had agents improve such a system.

## Start

1. [Install on one machine](../../tutorials/first-run.md) inside your network, and [connect your own model server](../../how-to/models/connect-a-provider.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that scores against your annotations, and [test it](../../how-to/campaigns/test-a-kit.md).
3. A better score does not certify de-identification under HIPAA or GDPR. That decision stays with people.
