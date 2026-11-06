---
title: "Robot reward design"
description: "Use Thermite to design reward functions for robot learning in simulation, with each policy trained from scratch by the judge and scored by its own test of task success."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, startups]
  summary: "Agents write and tune reward functions. The judge trains each policy from scratch in simulation and counts task successes with its own test, not with the agents' reward."
  measure: "Task success rate · the judge's own test of success · seeds and dynamics the agents never see"
sidebar:
  order: 1
---

Robot learning teams train control policies in simulation with reinforcement learning, often PPO, in frameworks such as MuJoCo Playground, built on MuJoCo's MJX, and Isaac Lab. Thousands of copies of the robot run at once on one GPU: Playground's settings for its cube-lifting task run 2,048 for 20 million steps. What the policy learns is set by the reward, a sum of terms weighted by hand: Playground's Go1 joystick task, a quadruped following velocity commands, has sixteen, from velocity tracking to penalties on torques, action rate and foot slip. Success is judged apart from the reward, by the task itself: the cube ends at the target, the robot crosses the terrain without falling.

Designing a reward is trial and error: change a term or a weight, train from scratch, watch what the policy learned, try again. Each try costs a full training run, results vary with the seed, and the learner exploits any gap: it maximizes the reward it is given, not the task the designer meant. Eureka showed that a language model can write the reward code in this loop. Thermite runs it with the success test, the training and the seeds kept in a judge the agents can't reach.

## Where Thermite fits

The agents change the reward, and only the reward, each lane in its own copy. The judge trains a policy from scratch with the kit's trainer, settings and step budget on its own GPU, alternating with the best reward so far. The kit's check then runs test episodes in its own copy of the environment and counts successes by its own definition, so the agents' reward plays no part in the score. The agents never see the success test, the seeds or the hidden variations. They learn only the judge's verdict and its reasons.

## Example campaigns

### 1. Lift the cube more often

A team trains an arm to pick up a cube in Playground's PandaPickCube environment, and wants a reward that succeeds more often, on any seed.

- **What the agents change:** the reward module in `rewards/`: its terms, their weights, and how they change over training.
- **What the judge runs:** PPO from scratch for a fixed number of steps on each seed, then a few hundred test episodes.
- **The number:** the share of test episodes in which the cube ends within a set distance of the target, by the kit's own test. Higher is better.
- **What must hold:** mean joint effort within a set fraction of the starting reward's, so that a policy which slams the arm about doesn't win; training within the kit's time limit.
- **Hidden from the agents:** another training seed, and test episodes with a heavier cube and less friction.
- **What agents would try:** a dense term for reaching the cube, then a lift term only once it is grasped; potential-based shaping, which rewards progress without changing which policy is best; penalties for table contact and action rate; ending an episode when the cube leaves the table; scaling terms so that none dominates early.
- **What you get:** the reward that succeeded most often, as a commit on the run's branch, and every reward tried, with the judge's reasons.

### 2. Tune a walking controller

A team has a hand-written walking controller for a quadruped, a gait generator with joint PD gains, and wants it faster on rough ground without falls.

- **What the agents change:** the controller's code and parameters.
- **What the judge runs:** a few hundred episodes in MuJoCo on rough terrain, with pushes. With no training, an attempt is cheap, and a CPU rig can run it.
- **The number:** mean forward speed over the episodes, in metres a second.
- **What must hold:** the share of episodes without a fall, and the energy used per metre, each as a guard.
- **Hidden from the agents:** other terrain, a payload and a lower floor friction.
- **What agents would try:** a higher step frequency with a shorter swing; a higher duty factor on rough ground; stiffer gains in stance than in swing; foot placement that reacts to the body's velocity.
- **What you get:** a faster controller that falls no more often, with every setting tried.

### 3. Read the reward literature first

A research campaign can survey a question first, such as "In published work on quadruped locomotion learned in simulation, which reward terms and randomization ranges do authors report as needed for transfer to hardware?" A claim counts only when code finds its quotes, word for word, in the pages it archived; a review panel of models decides each question, and the report lists every source.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "pick-cube-reward",
  "version": 1,
  "title": "A reward that lifts the cube more often",
  "mode": "hill_climb",
  "project": {
    "repo": "panda-pick",
    "kit": { "repo": "panda-pick-kit", "commit": "5d2b8e1f4a7c0936e8b2d5f1a4c7e0b3d6f9a2c5" }
  },
  "target": { "type": "cuda-gpu", "class": "nvidia-gpu" },
  "editable_paths": ["rewards/**"],
  "objective": { "primary": { "metric": "success_rate", "direction": "max", "min_effect": 0.05 } },
  "guards": [
    { "metric": "effort", "direction": "min", "max_step_regression": 0.05, "max_total_regression": 0.15 }
  ],
  "cells": ["seed-1", "seed-2"],
  "held_out_cells": ["seed-3-heavy-cube"],
  "acceptance": { "equivalence_band": 0.02 }
}
```

The kit holds the trainer's settings, the seeds, its own copy of the environment and the success test. Its run trains a policy with the change's reward on one cell's seed and writes the policy's parameters. Its check loads them into the kit's environment, runs the test episodes on the CPUs (a kit's check has no GPU), and prints one line, such as `{"pass": true, "success_rate": 0.83, "effort": 41.6}`. Both are numbers read from the check. Every metric must be above zero, so start from a reward that already succeeds sometimes. Success rates vary between seeds, so the contract counts a gain of 5% and widens the band in which the judge calls two rewards equivalent ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge runs each change several times, alternating with the best version so far. Here each block trains four policies, both rewards on both seeds, and screening runs at least three blocks: twelve trainings for a change rejected early, more than thirty for a confirmed win. At ten minutes a training, that is two to six hours of the judge's GPU.
- **Where the agents help most.** Writing and rebalancing reward terms. On a rig with two GPUs, give the agents one: their trial trainings are long too.
- **Where people stay.** Writing the success test, choosing the seeds and the hidden variations, watching what the best policy does, and every step towards hardware.

## What the judge guards against

Specification gaming is the known failure here: DeepMind's list includes an arm that flipped a block over instead of stacking it, and a simulated robot that hooked its legs together and slid along the ground. The judge counts success with its own test, in its own copy of the environment, so a reward that teaches the wrong behaviour, or changes the simulation it trains in, gains nothing. Write the test as strictly as the task: the cube must stay at the target until the episode ends, not pass through it.

## Limits

- Thermite never touches a real robot. A policy that succeeds in simulation still has to cross the gap to hardware: domain randomization, system identification and tests on the robot are work for people.
- Each timed run uses one GPU of one machine, and every attempt costs full trainings: keep the task and the step budget as small as the question allows.
- The harness image carries no simulator: [extend it](../../how-to/install/extend-harness-image.md) with MuJoCo Playground or Isaac Lab and what they need.
- The success test is only as good as its definition: a loose one can be gamed too.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** robot learning on a single GPU, with agents on a local model.
- **[Startups](../for/startups.mdx):** robotics companies that design rewards for many tasks and robots.

## Related work

Eureka had a language model write reward functions, scored each by a separate measure of the task's success, and "outperforms human experts on 83% of the tasks" across 29 environments ([Ma and others, 2023](https://arxiv.org/abs/2310.12931)). DeepMind's list of specification gaming includes a robot arm that "flipped over the red block" instead of stacking it ([DeepMind's post](https://deepmind.google/discover/blog/specification-gaming-the-flip-side-of-ai-ingenuity/)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md), and [extend the harness image](../../how-to/install/extend-harness-image.md) with your simulator.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) that trains and tests, and [test it](../../how-to/campaigns/test-a-kit.md): train the starting reward a few times to see the noise, and try a reward you know games the task, which the check must fail.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
