---
title: "Clinical note de-identification"
description: "Use Thermite to improve a clinical note de-identification system on your own annotated notes, inside your network, with agents on a model you host."
type: use-case
useCase:
  mode: climb
  personas: [enterprises]
  summary: "Agents improve a de-identification system using a model you host. The judge measures recall on annotated notes from a held-out department."
  measure: "Recall of protected details · precision held, other text unchanged · notes from another department"
sidebar:
  order: 3
---

Before clinical notes can be used for research, identifying details must be removed: names, dates, addresses, record numbers. A system that misses identifiers is a compliance risk; a system that removes clinical content is not useful. Both properties can be measured against annotated notes. Thermite improves such a system on your own notes, inside your network, with agents running on a model you host.

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

## What the judge guards against

A system tuned on one hospital's notes fits that hospital's conventions and degrades on another's. Notes from a withheld department detect this before the system is relied on.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** a hospital system's research data team. Thermite runs on your machines, and its agents can run on your model, so the notes need not leave.

## Related work

PhysioNet, which shares clinical datasets for research, says its data-use agreement does not allow sending its data "through APIs or using it on online platforms", and marks locally deployed models "Strongly Recommended" ([PhysioNet's guidance](https://physionet.org/news/post/llm-responsible-use/)). SHIELD, a small de-identification model that runs on a workstation, reported a precision of 0.89 and a recall of 0.88, and that "institution-specific entities transfer poorly" ([the paper](https://arxiv.org/abs/2605.03301)). No published work has yet had agents improve such a system.

## Get started

1. [Install on one machine](../../tutorials/first-run.md) inside your network, and [connect your own model server](../../how-to/models/connect-a-provider.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that scores against your annotations, and [test it](../../how-to/campaigns/test-a-kit.md).
3. A better score does not certify de-identification under HIPAA or GDPR. That decision stays with people.
