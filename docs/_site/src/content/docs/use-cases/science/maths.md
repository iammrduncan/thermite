---
title: "Mathematical discovery"
description: "Use Thermite to search for better constructions in combinatorics and geometry, with every candidate checked by an exact verifier the agents cannot access."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, solo-builders]
  summary: "Agents write programs that generate candidate constructions. An exact verifier, hidden from the agents, checks each one and reports its bound."
  measure: "The bound a construction reaches · verified exactly · a second, stricter check"
sidebar:
  order: 1
---

Many open problems in combinatorics and geometry ask for an optimal construction: the largest set with a given property, the densest packing, the highest kissing number. Candidates are difficult to find and straightforward to verify. Agents write programs that generate candidates, and a verifier the agents cannot access checks each one exactly.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md) on the construction's size or score |
| **The number** | The bound the construction reaches, such as the size of a set or the radius of a packing, reported by the kit's check |
| **What must hold** | The check verifies the construction exactly, in integer or rational arithmetic where it can, so a rounding error can't pass for a record |
| **Hidden from the agents** | A second, stricter check, such as a tighter tolerance or an independent verifier, that a win must also pass |
| **Where it runs** | A CPU rig. The search and the checks are cheap, so the agents can run on a local model at no cost a request |

## How it runs

1. **You write a kit** whose run command runs the agents' program and writes out the construction, and whose check verifies it and prints its size.
2. **Agents write and improve the program**: a smarter search, a symmetry to exploit, a known construction to start from. Workers can also read papers through the rig's archiving fetcher and record what they found, with quotes that code checks word for word.
3. **The judge keeps the best construction**, checked exactly. A record is a record only when the verifier says so.

## What the judge guards against

A search scored by code will find that code's weaknesses: a numerically integrated score can be exploited by an irregular function, and a check with a tolerance can accept a near miss. Use an exact verifier wherever possible, and keep a stricter one hidden from the agents.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** open research problems that run on a single computer with a local model.
- **[Solo builders](../for/solo-builders.mdx):** independent researchers and students who want to test an approach at scale.

## Related work

FunSearch found a cap set of size 512 in dimension 8, larger than any known before ([the paper in Nature](https://www.nature.com/articles/s41586-023-06924-6)). AlphaEvolve found 593 spheres that touch one sphere in 11 dimensions, a new lower bound for the kissing number ([DeepMind's post](https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)). Working through 67 problems with AlphaEvolve, Georgiev, Gómez-Serrano, Tao and Wagner reported that on one of them it "always eventually figured out a way to cheat" their scoring function ([the paper](https://arxiv.org/abs/2511.02864)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), and [run a model on your own computer](../../how-to/models/choose-a-model.md) for the agents.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) whose check is the verifier, and [test it](../../how-to/campaigns/test-a-kit.md) with a known construction and a near miss.
3. A construction is a lower bound, not a proof. The write-up and any upper bound are still a mathematician's work.
