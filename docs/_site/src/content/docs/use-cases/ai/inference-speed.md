---
title: "LLM inference optimization"
description: "Use Thermite to make an inference engine faster on your own GPU, with every change timed on that card and the model's outputs held to a reference the agents never see."
type: use-case
useCase:
  mode: climb
  personas: [local-ai, startups]
  summary: "Agents tune an engine's kernels and launch settings for your GPU. The judge times decode on that card and holds the model's outputs to a reference."
  measure: "Decode tokens a second · outputs held to a reference · prompts the agents never see"
sidebar:
  order: 1
---

Running a language model on your own GPU means choosing an engine and a weight format: llama.cpp with a GGUF file in a k-quant such as Q4_K_M, vLLM with AWQ or GPTQ weights, ExLlamaV3 with EXL3. Three numbers matter: decode speed; prompt speed, which sets the time to first token; and the memory left for the context. llama.cpp's `llama-bench` reports the first two in tokens a second, as `tg128` and `pp512`. For one stream, each new token reads every weight once, so decode is bound by memory bandwidth and, at low bit widths, by unpacking. The fastest kernels assume recent cards: the 2016 Tesla P100 lacks the integer dot-product instruction that today's low-bit kernels rely on.

Making one card fast is a long list of kernel changes, from how work is split across warps to what is fused. Each depends on the card, the format and the model, and most don't help: in Thermite's P100 study, 48 of 131 judged changes were slower and 39 made no real difference. Any of them can also change the answers. To catch that, llama.cpp's `test-backend-ops` compares each GPU operation with the CPU's result, and `llama-perplexity` reports perplexity and the KL divergence of a quantized model's token distributions from the full-precision model's. Thermite runs such checks in a judge the agents can't reach, on the card you want to be fast.

## Where Thermite fits

The agents change the engine's source, each lane in its own copy. The judge builds each change, loads the model file the rig downloaded and checked, times prompt and decode from outside the engine on its own card, and compares the outputs with references it holds. The agents never see the kit, the references, the timing code or the hidden prompts. They learn only the judge's verdict and its reasons.

## Example campaigns

### 1. Faster decode on the card you have

You run a quantized model on one GPU and want more tokens a second from each stream.

- **What the agents change:** the engine's GPU code: in llama.cpp, the CUDA backend in `ggml/src/ggml-cuda/`, such as `mmvq.cu` for quantized matrix-vector products, and its launch parameters.
- **What the judge runs:** a cold prompt of about 600 tokens, then 256 greedy tokens, once with code and once with prose.
- **The number:** decode tokens a second. Higher is better.
- **What must hold:** KL divergence from the reference within your limit (few kernel changes keep the output bit-identical); perplexity within a fraction of a per cent; bit-identical text from a second weight file that shares the engine's code; the whole context still fitting on the card.
- **Hidden from the agents:** a prompt they never see, run at confirmation.
- **What agents would try:** activations staged in shared memory and reused across rows; wider loads; fewer instructions to unpack a block; rows per block fitted to the card's multiprocessor count; normalizations fused into neighbouring kernels.
- **What you get:** the fastest engine that held the outputs, as a commit on the run's branch, and every attempt with the judge's reasons.

### 2. Run a new weight format or model

A new quantization type, or a model with a new kind of layer, must run correctly before anyone makes it fast.

- **Mode:** a goal campaign, which ends when every required goal passes, twice.
- **The goals:** the format's test blocks decode bit for bit on CPU and GPU; matrix multiplies match an exact sum within a tolerance at every shape the model uses; the model loads with its whole context; its outputs match a full-precision reference on inputs the agents never see; other formats' outputs don't change.
- **What you get:** an engine that runs the format correctly, the judge's evidence for each goal, and a champion to start the decode climb from.

### 3. Faster prompts, decode held

Long prompts make the time to first token the delay users notice.

- **What the agents change:** the matrix-matrix kernels (`mmq.cu` in llama.cpp), micro-batch sizes and the attention kernel's prompt path.
- **What the judge runs:** a cold prompt of about 4,000 tokens, then a short decode.
- **The number:** prompt tokens a second.
- **What must hold:** decode within 1% of the starting point, as a guard, and every output check above.
- **Hidden from the agents:** a prompt of another kind and length.
- **What agents would try:** tile sizes fitted to the card's shared memory; weights converted to FP16 for cuBLAS against quantized blocks multiplied directly; tensor-core paths where the card has them.
- **What you get:** a shorter time to first token, with decode unchanged.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "decode-speed",
  "version": 1,
  "title": "Faster decode on one GPU, outputs held",
  "mode": "hill_climb",
  "project": {
    "repo": "inference-engine",
    "kit": { "repo": "decode-kit", "commit": "7c41e9a2b8d05f3e6a1c9b4d2e8f07a3c5b19d6e" }
  },
  "target": { "type": "cuda-gpu", "class": "nvidia-gpu" },
  "models": [
    { "name": "model-q4", "sha256": "2a6f1c8e4b9d07a3f5e2c1b8d6a4f9e0c3b7d2a1e8f5c4b9a6d3e0f7c2b1a8d5" },
    { "name": "second-file", "sha256": "8d3e0b5a2f7c4e1d9b6a3f0c8e5d2b7a4f1c9e6d3b0a7f4c1e8d5b2a9f6c3e0d" }
  ],
  "editable_paths": ["ggml/src/ggml-cuda/**"],
  "objective": { "primary": { "metric": "decode_tps", "direction": "max", "min_effect": 0.01 } },
  "guards": [
    { "metric": "prompt_tps", "direction": "max", "max_step_regression": 0.02, "max_total_regression": 0.05 },
    { "metric": "ppl", "direction": "min", "max_step_regression": 0.001, "max_total_regression": 0.0025 }
  ],
  "cells": ["code-600", "prose-600"],
  "held_out_cells": ["prose-hidden"]
}
```

The kit builds the engine from the change, and its own measuring tools from a fixed commit. Its run starts the engine on one cell, and the kit's [driver](../../reference/kit-manifest.md#a-kits-driver), a program beside the engine that the change can't reach, sends the prompt and records when each token arrives. Its check works out both speeds from those times, computes perplexity and KL divergence against reference logits, compares the second file's text, and prints one line, such as `{"pass": true, "decode_tps": 31.2, "prompt_tps": 402.7, "ppl": 6.084}`. All three are numbers read from the check, and a gain counts at 1% or more ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge runs each change several times, alternating with the best version so far, on every case. Keep the cases short: minutes a block, not the hour a cold 32K-token prompt costs. In the study, two judge P100s weighed 131 changes in five days.
- **Where the agents help most.** Kernel work for one card, one format and one model's shapes: a wide search with cheap checks.
- **Where people stay.** Setting the quality bar and the reference, deciding about a goal missed by a measured margin, and releasing the engine.

## What the judge guards against

The common failure is a faster kernel that changes the answers slightly: a dropped scale, a sum in lower precision, a race that shows on some prompts only. Another is a benchmark the agents can edit. The judge times from outside the engine with tools built from a fixed commit, holds the outputs to references the agents never see, and keeps the second file's text bit-identical, which catches a broken shared code path. A confirmed gain above 15% goes to an audit first.

## Limits

- Each timed run uses one NVIDIA GPU, or the CPUs, of one machine. AMD and Apple GPUs are not targets, and a model split across cards can't be timed as one run. Blackwell cards need the CUDA 13 image, which has not yet run on a GPU ([Known limits](../../reference/known-limits.md#the-cuda-13-harness-is-untested)).
- A gain on a short prompt may not hold at 32K tokens of context or under many concurrent requests: time those in runs of their own.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** get the most from the GPUs you own, with agents on your own model server at no per-request cost.
- **[Startups](../for/startups.mdx):** higher throughput on the same rented GPU lowers the cost of every request you serve.

## Related work

Thermite's own study took Qwen3.8-27B-PN3 from 7.74 to 30.06 tokens a second on one Tesla P100, a card that sells used for about $100: 131 changes judged, 28 confirmed wins ([the study](../../studies/qwen3-8-27b-on-a-p100.mdx)). Outside Thermite, METR found OpenAI's o3 overwriting the grader's timer or copying the grader's answer in 6 of 24 runs of a kernel task ([METR's post](https://metr.org/blog/2025-06-05-recent-reward-hacking/)): the reason the timer must be out of the agents' reach.

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md) and [split its GPUs](../../how-to/install/several-gpus.md) if it has several. No GPU of your own? [Rent one on RunPod](../../how-to/install/runpod-rig.md) by the hour.
2. [Bring the model's weights](../../how-to/campaigns/model-weights.md) to the rig, and [write a kit](../../how-to/campaigns/write-a-kit.md) that builds the engine and checks its output. [Test it](../../how-to/campaigns/test-a-kit.md) with a change you know is slower and one you know changes the output.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
