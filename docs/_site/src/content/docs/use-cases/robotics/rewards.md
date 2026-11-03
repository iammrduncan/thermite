---
title: "Teach a robot the task, not a loophole"
description: "Let agents write a robot's reward function or controller while the judge trains a policy from scratch in simulation and measures its success with its own test, on seeds and terrain the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, startups]
  summary: "Agents write the reward. The judge trains a policy from scratch in simulation and measures success with its own test, on seeds and terrain they never see."
  measure: "Task success rate · the judge's own test of success · other seeds and terrain"
sidebar:
  order: 1
---

Training a robot in simulation starts with a reward function: the code that tells the learner how well it is doing. Writing a good one takes experts many tries, and a learner finds every gap in it. Thermite can put agents on the reward code, and a judge on the result. The judge trains a policy itself, from scratch, and measures whether the robot did the task with its own test, which is not the reward the agents wrote.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md) |
| **The number** | The share of test episodes in which the task succeeds, by the kit's own measure of success |
| **What must hold** | The policy is trained from scratch on the judge's seeds, within the kit's time limit |
| **Hidden from the agents** | Other seeds, changed dynamics and new terrain that a win must also pass |
| **Where it runs** | A CUDA rig, with a GPU simulator such as MuJoCo Playground |

## How it runs

1. **You write a kit** whose run command trains a policy with the agents' reward, and whose check runs test episodes and counts successes by its own definition.
2. **Agents write and improve the reward:** what to reward, what to punish, how to shape it over training.
3. **The judge trains and tests each version.** Training is noisy, so a gain must hold on fresh runs before it counts, and on the hidden seeds and terrain.

## What the judge keeps out

A learner rewarded for the wrong thing learns the wrong thing: to flip a block over rather than stack it, or to slide along the ground rather than walk. The judge measures success with a test the agents can't read, so a reward that teaches a loophole loses.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** robot learning on one GPU, with agents on a local model.
- **[Startups](../for/startups.mdx):** robotics companies that design rewards for many tasks and robots.

## What others have shown

Eureka had a language model write reward functions, scored each by a separate measure of the task's success, and "outperforms human experts on 83% of the tasks" across 29 environments ([Ma and others, 2023](https://arxiv.org/abs/2310.12931)). DeepMind's list of specification gaming includes a robot that "flipped over the red block" instead of stacking it ([DeepMind's post](https://deepmind.google/discover/blog/specification-gaming-the-flip-side-of-ai-ingenuity/)).

## Start

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that trains and tests, and [test it](../../how-to/campaigns/test-a-kit.md): train the starting reward a few times to see the noise.
3. Thermite never touches a real robot. Moving a policy from simulation to hardware is its own problem.
