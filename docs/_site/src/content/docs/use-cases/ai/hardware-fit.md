---
title: "Fitting a model to your hardware"
description: "Use a Thermite goal campaign to make a 27B to 32B open model serve on one 16 GB GPU, with its memory, speed, quality and API each checked on the card by a kit the agents can't edit."
type: use-case
useCase:
  mode: goal
  personas: [local-ai, solo-builders, startups]
  summary: "Agents choose the weight file, the cache and the server's settings. The judge serves the model on your card, checks its memory, speed, quality and API, and the run ends when every goal passes twice."
  measure: "Peak memory, decode speed and quality on your card · every goal met on two checks · questions and a document the agents never see"
sidebar:
  order: 5
---

Running an open model of 27B to 32B parameters on a 16 GB card, such as an RTX 4060 Ti 16 GB, a T4 or a used Tesla P100, is a memory budget. The weights, the KV cache (the keys and values the model keeps for each token of context) and the engine's working buffers must all fit on the card. Qwen3-32B at Q4_K_M, the llama.cpp weight type that bartowski's quantization page calls the "default size for most use cases", is a 19.76 GB file: too big for the card on its own. The same page's rule of thumb is to "Aim for a quant with a file size 1-2GB smaller than your GPU's total VRAM", and that leaves out the cache. Qwen3-32B has 64 layers with 8 key-value heads of 128 dimensions each, so at 16 bits every token of context takes 256 KiB: 8 GiB for the 32,768 tokens it handles natively.

So each setting is a trade. A lower-bit type such as IQ3_XXS, made with an importance matrix, is a 12.82 GB file. A quantized cache (`--cache-type-k q8_0 --cache-type-v q8_0` in llama.cpp) about halves the cache. A shorter context, or some layers kept on the CPU, buys room at the cost of length or speed, and a draft model for speculative decoding costs memory and can raise speed. Each can change the answers. llama.cpp's `llama-perplexity` measures that as the KL divergence of the quantized model's token distributions from the full-precision model's, whose logits are recorded once on a larger machine; its README warns that the file "will be very large, 11 GiB for LLaMA 2 or 37 GiB for LLaMA 3 when using the Wikitext-2 test set". Engines differ in the cards they take: vLLM asks for "compute capability 7.5 or higher", which leaves out a P100 or a V100, while llama.cpp runs on both.

## Where Thermite fits

The agents change the server's settings, each lane in its own copy: which of the weight files the contract lists to load, the context length, the cache's types, flash attention, batch sizes, which tensors stay on the CPU, and a draft model. The judge starts the server with those settings on its own card, samples the card's memory while it works, times each token as it arrives, scores the answers with a program and replays the kit's API calls. The agents never see the kit, its questions, its long documents or the cases held back for the final checks. When a hidden case fails, they learn which goal failed and how, never which case.

## Example campaigns

### 1. Qwen3-32B on one 16 GB card

A team wants Qwen3-32B answering on a 16 GB card it already owns, with a 32K context, at a speed people will use, and with answers close to the full-precision model's.

- **Mode:** a goal campaign. It ends when every required goal passes on two checks of the best version, hidden cases included, or, as this contract allows, when three different approaches have each been tried and failed.
- **The goals:**
  - the server starts on the card, answers `/health`, and reports in `/props` a context of at least 32,768 tokens;
  - peak memory, sampled while a 30,000-token document is read, is at most 15,360 MiB, which leaves the 1 GiB margin llama.cpp's own `--fit` keeps by default;
  - decode runs at 12 tokens a second or more for one stream, after a prompt of about 600 tokens;
  - mean KL divergence from the full-precision model is at most 0.1 on the kit's text;
  - on the kit's questions, whose answers a program checks, the score is at least 97% of the full-precision model's; part of the questions are held back for confirmation;
  - the server passes the kit's API tests: chat, streaming, a JSON schema in `response_format`, and stop sequences. This goal and the next require the server to start;
  - every fact asked about a 30,000-token document is found, in the kit's document and in a second one held back for confirmation.
- **What the agents change:** `serve/settings.json`. The kit's build accepts only the settings it knows, so nothing the agents write runs as code.
- **What agents would try:** IQ3_XS or IQ3_M with a `q8_0` cache; IQ4_XS with some layers' feed-forward weights on the CPU (`-ot`, or `--n-cpu-ffn` in recent builds), for quality at a cost in speed; a `q4_0` value cache with flash attention on; a smaller micro-batch (`-ub`) to shrink the working buffers; Qwen3-0.6B as a draft model (`-md`).
- **What you get:** the settings that met every goal, as a commit on the run's branch, with the judge's evidence for each goal. If no listed file can meet them all, the evidence for that.

### 2. Then make it faster

A hill climb can then push decode speed on the same card, starting from the first campaign's champion.

- **What the agents change:** the engine's GPU code, in a fork of llama.cpp (`ggml/src/ggml-cuda/`).
- **The number:** decode tokens a second. Higher is better.
- **What must hold:** peak memory within the first campaign's line, as a hard constraint; KL divergence and the task score as guards.
- **What agents would try:** the kernel work in [LLM inference optimization](inference-speed.md), fitted to this card and this weight type.

### 3. Read the measurements first

Before the first campaign, a research campaign can answer a question such as "Which published measurements of quality loss exist for open models of 27B to 32B parameters at 3 to 4 bits a weight, and how was each measured?" [Model and method landscape](method-landscape.md) shows such a campaign. Its next experiments can go into this campaign's queue.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "qwen3-32b-16gb",
  "version": 1,
  "title": "Qwen3-32B on one 16 GB card",
  "mode": "goal",
  "project": {
    "repo": "qwen32b-serve",
    "kit": { "repo": "qwen32b-serve-kit", "commit": "5b8e2d7a1c4f9e3b6d0a8c2f5e7b1d4a9c3e6f0b" }
  },
  "target": { "type": "cuda-gpu", "class": "nvidia-gpu" },
  "models": [
    { "name": "iq3-xxs", "sha256": "8c092b7d36a5bbefed6ccaf8d89a95ab889b1905acae2db0d860f151155f9b41" },
    { "name": "iq3-xs", "sha256": "24957e8f36bcb926f7d6a50aa598f2e8d069d487b95fda8cd4e50ed8390cde30" },
    { "name": "iq3-m", "sha256": "3d551f95bd02fcfb96fc53c9bdb8d709531f53cfb9170e13c951d72b306617c3" },
    { "name": "iq4-xs", "sha256": "e1e49f04bab5c5aa55d15c7cd383f01672cb0777c2d0153587bfd1a2230ea8ec" },
    { "name": "draft-0.6b", "sha256": "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031" },
    { "name": "full-precision-logits", "sha256": "d41c7e9a3b5f8d2e6a0c4b7f1e9d3a5c8b2f6e0d4a7c1b9e5f3d8a2c6b0e4f7a" }
  ],
  "editable_paths": ["serve/**"],
  "goals": [
    { "id": "starts", "description": "the server starts on the card and reports a context of at least 32,768 tokens", "verify": { "type": "code", "verifier": "starts" } },
    { "id": "memory", "description": "peak memory while a 30,000-token document is read is at most 15,360 MiB", "verify": { "type": "metric_threshold", "metric": "peak_mib", "op": "<=", "value": 15360, "cells": ["long-32k"] } },
    { "id": "decode", "description": "at least 12 tokens a second for one stream", "verify": { "type": "metric_threshold", "metric": "decode_tps", "op": ">=", "value": 12, "cells": ["chat-600"] } },
    { "id": "divergence", "description": "mean KL divergence from the full-precision model at most 0.1", "verify": { "type": "metric_threshold", "metric": "kld", "op": "<=", "value": 0.1, "cells": ["kld"] } },
    { "id": "tasks", "description": "at least 97% of the full-precision model's score on the kit's questions", "verify": { "type": "metric_threshold", "metric": "task_ratio", "op": ">=", "value": 0.97, "cells": ["tasks", "tasks-held"] } },
    { "id": "api", "description": "the server passes the kit's API tests", "verify": { "type": "code", "verifier": "api" } },
    { "id": "long-context", "description": "every fact asked about a 30,000-token document is found", "verify": { "type": "code", "verifier": "long-context" } }
  ],
  "deliverable": "server settings on the run's branch that meet every required goal with one of the listed weight files",
  "insufficient": ["a context shorter than 32,768 tokens", "a weight file the contract does not list"],
  "infeasibility": { "allowed": true, "min_refuted_approaches": 3 },
  "threshold_reps": 3,
  "held_out_cells": ["tasks-held", "long-32k-held"]
}
```

The weight files are bartowski's quantizations of Qwen3-32B and Qwen's own Q8_0 file of Qwen3-0.6B, with the SHA-256 Hugging Face gives each; the full-precision logits are the team's own file, recorded with `llama-perplexity --kl-divergence-base`. The engine is a llama.cpp release in a harness image the team extends, so neither it nor its measuring tools can change. The kit's build checks `serve/settings.json` against the settings it allows and writes the server's command line, with `--fit off`, so the engine never changes a setting on its own to make the model fit. Its run starts the server on one cell, samples the card's memory with `nvidia-smi`, sends the cell's requests, times each token as it arrives, and writes what it saw to `{out}`; the `kld` cell runs `llama-perplexity --kl-divergence` instead. Its verifiers are `starts` (priority 10), then `api` and `long-context` (20 and 30), which require `starts`; `long-context` has the cells `long-32k` and the held-out `long-32k-held`. For `long-32k`, the check prints one line, such as `{"pass": true, "n_ctx": 32768, "peak_mib": 14938, "found": 12, "asked": 12}`, with `pass` false when a fact is missing or the context is shorter. `peak_mib`, `decode_tps`, `kld` and `task_ratio` are numbers read from the check. Memory, divergence and scores vary little between runs on one card and one build, so `threshold_reps` runs each threshold cell three times, not five ([Contract](../../reference/contract.md#goal), [Kit manifest](../../reference/kit-manifest.md#verifiers)).

## What to expect

- **Time per check.** Each run loads a 13 to 18 GB file first, so keep each cell to a few minutes and the question cells to as many questions as the line needs. After each promotion the judge checks every goal, `starts` first.
- **Where the agents help most.** The combined search: files, cache types, context, offload, batch sizes and a draft model, each changing memory, speed and quality at once.
- **Where people stay.** Setting the lines, writing the questions and documents, recording the full-precision reference, and deciding about a goal missed by a measured margin.

## What the judge guards against

A model that fits on paper can fail in use. An engine that fits its settings to the card on its own can start with a shorter context or with layers on the CPU, so the kit turns that off and the check reads the context the server reports. The working buffers peak while a long prompt is read, so memory is sampled during the 30,000-token document, and a file or cache that loses facts deep in a long prompt fails the same case. Quality measured on public text, such as the Wikitext-2 test set llama.cpp's contributors use by convention, can flatter a file calibrated on similar text, so the kit's text and questions are its own. The agents are told where the model files are, so the hidden cases live in the kit.

## Limits

- Each timed run uses one NVIDIA GPU of one machine: no model split across two cards, and no AMD or Apple GPU. A Blackwell card, such as an RTX 5080, needs the CUDA 13 image, which has not yet run on a GPU ([Known limits](../../reference/known-limits.md#the-cuda-13-harness-is-untested)).
- Timed runs are pinned by default to the CPUs near their card, so layers kept on the CPU are timed on those cores. A run's memory limit is 1,024 MiB unless the kit sets `run.rss_mib` higher: give it room for those layers.
- A kit's check has no GPU, and judged runs get no API keys: the run computes the divergence and the answers on the card, and the full-precision reference comes as a model file, recorded on a machine that can run the model.
- The goals hold for one stream on a card with nothing else on it: the judge waits until a card has at most 600 MiB in use before it times. Several users at once, or a desktop on the same card, need cases of their own.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** the largest model your card can hold, with a context you can use and answers you have measured.
- **[Solo builders](../for/solo-builders.mdx):** a model server for your own product on one machine and one card, fitted by agents while you build.
- **[Startups](../for/startups.mdx):** a model on cards you own or rent cheaply, with its memory, speed and quality on record before you serve it.

## Related work

On llama.cpp's scoreboard for Llama 3 8B, Q4_K_M with an importance matrix had a mean KL divergence of 0.028152 from FP16, at 4.58 GiB, and IQ3_XXS 0.183625, at 3.05 GiB ([the perplexity README](https://github.com/ggml-org/llama.cpp/blob/master/tools/perplexity/README.md)). The Qwen3-32B file sizes and the rule of thumb are from bartowski's page of [Qwen3-32B quantizations](https://huggingface.co/bartowski/Qwen_Qwen3-32B-GGUF). In Thermite's own study on a 16 GB Tesla P100, a card that sells used for about $100, two goal campaigns made the engine run Qwen3.8-27B in a new 3-bit format and checked its quality, and a hill climb then took decode from 7.74 to 30.06 tokens a second, with the whole model and a 65,536-token context on the card ([the study](../../studies/qwen3-8-27b-on-a-p100.mdx)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [run a first goal campaign](../../tutorials/first-goal-campaign.md) on the sample project, and [add a rig on your GPU machine](../../how-to/install/rig-on-a-machine.md).
2. [Extend the harness image](../../how-to/install/extend-harness-image.md) with the engine, and [bring the weight files to the rig](../../how-to/campaigns/model-weights.md).
3. [Write a kit](../../how-to/campaigns/write-a-kit.md#7-add-verifiers-for-goal-campaigns) whose verifiers require one another, and [test it](../../how-to/campaigns/test-a-kit.md) with settings you know don't fit. Then [write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
