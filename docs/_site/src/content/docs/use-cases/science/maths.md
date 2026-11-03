---
title: "Search for better constructions in mathematics"
description: "Point agents at an open problem whose answer a program can check, such as a packing, a code or a combinatorial set, and let them search for a better construction while an exact verifier scores each one."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, solo-builders]
  summary: "Agents write programs that build a packing, a set or a code. An exact verifier that they cannot see checks each one and reports its size."
  measure: "The bound a construction reaches · verified exactly · a second, stricter check"
sidebar:
  order: 1
---

Many open problems in combinatorics and geometry ask for the best construction: the largest set with a property, the densest packing, the most spheres that touch one sphere. A proposed answer is hard to find and easy to check. That is the shape Thermite works best on: agents write programs that build candidates, and code that they cannot see checks each one exactly.

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

## What the judge keeps out

A search that is scored by code learns the code's weak points. A scoring function that integrates numerically can be fooled by a strange function that exploits the integration; a check with a tolerance can be fooled by a near miss. Keep the verifier exact where you can, and keep a stricter one hidden.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** a real research problem that runs on one computer and a local model.
- **[Solo builders](../for/solo-builders.mdx):** independent researchers and students with an idea to test at scale.

## What others have shown

FunSearch found a cap set of size 512 in dimension 8, larger than any known before ([the paper in Nature](https://www.nature.com/articles/s41586-023-06924-6)). AlphaEvolve found 593 spheres that touch one sphere in 11 dimensions, a new lower bound for the kissing number ([DeepMind's post](https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/)). Working through 67 problems with AlphaEvolve, Georgiev, Gómez-Serrano, Tao and Wagner reported that on one of them it "always eventually figured out a way to cheat" their scoring function ([the paper](https://arxiv.org/abs/2511.02864)).

## Start

1. [Install on one machine](../../tutorials/first-run.md), and [run a model on your own computer](../../how-to/models/choose-a-model.md) for the agents.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) whose check is the verifier, and [test it](../../how-to/campaigns/test-a-kit.md) with a known construction and a near miss.
3. A construction is a lower bound, not a proof. The write-up and any upper bound are still a mathematician's work.
