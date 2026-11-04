---
title: "Model and method landscape"
description: "Use a Thermite research campaign to map the evidence on the models and methods you're choosing between: papers, model cards, benchmark repositories and their issue threads, each claim checked against its archived page."
type: use-case
useCase:
  mode: research
  personas: [local-ai, startups, enterprises]
  summary: "Agents read the papers, model cards, benchmark repositories and issue threads on each model and method you're weighing. Code checks each quote, and a review panel of models decides each question."
  measure: "Verified claims on each model and method · each quote and number found in its archived page · a panel of models, question by question"
sidebar:
  order: 4
---

Before a team commits to a model or a method, such as a long-context model for question answering over long documents, or a small model to fine-tune for extraction, an ML engineer gathers the evidence. It comes from papers on arXiv, model cards on Hugging Face, benchmark repositories on GitHub and the issues filed on them, and leaderboards. The engineer puts the reported scores in a table and writes a recommendation, in the time left over from other work.

The scores rarely measure the same thing. Each comes from its own protocol: the number of examples in the prompt, chain of thought or not, the context length, the decoding settings, the evaluation code and the precision of the weights. A model card reports the developer's own runs. Test sets leak into training data, and figures change between versions of a paper. The GSM1k paper, which tested models on new grade-school maths problems written to mirror the GSM8K benchmark, reported "accuracy drops of up to 13%" in the first version of its abstract on arXiv, in May 2024, and "accuracy drops of up to 8%" in its fourth, in November 2024. Leaderboards have distortions of their own. The Leaderboard Illusion, a 2025 study of Chatbot Arena, identified "27 private LLM variants tested by Meta in the lead-up to the Llama-4 release".

## Where Thermite fits

Each **lane**, a line of search with its own agent, takes one gap the run's plan finds in a question's answer card: a benchmark score with no independent run behind it, a model card that gives no evaluation settings, two papers that disagree at 64K tokens. The agents fetch each paper's HTML version, model card and issue thread through the rig's archiving fetcher, which keeps it as text, and record a **claim** for each result: a score with its model, benchmark and length, quoted from the table that gives it. Code checks every quote word for word against the archived page, and every number in the claim against its quotes, so a score misread from a chart or remembered from another version of a paper stays a draft. A synthesizer keeps an answer card for each question, and a review panel of models decides each by majority, with any dissent kept. No agent closes a question or ends the run.

The run has no time, turn or source limit unless you set one, so it can read everything that bears on the choice. For three candidate models and four long-context benchmarks, that is each benchmark's paper in arXiv's HTML version, its repository and every issue filed there (255 issues in November 2026: RULER 84, HELMET 36, NoLiMa 7, LongBench 128), the three model cards, and every later paper that reports a candidate on one of the benchmarks. The archived pages, every claim (verified or draft), the findings and the answer cards stay in the run's research folder and in the campaign's collection in Thermite's knowledge base, which later runs' agents search, and another campaign's when you grant it.

## Example campaigns

### 1. Long documents: a long-context model, retrieval, or both

A team answers questions over contracts and codebases of 100,000 to 200,000 tokens on its own GPUs. It must choose a model, and decide whether to read the whole document, retrieve passages from it, or both. The candidates are Qwen3.8-27B, Gemma 4 31B and Llama 4 Scout, whose model cards claim contexts of 262,144 tokens, 256K tokens and 10M tokens.

- **The questions:**
  - For each candidate, what context does its model card claim, and what do RULER, HELMET, NoLiMa and LongBench v2 report for it, at which lengths and on which tasks?
  - Which of those results were run by someone other than the model's developer, with which evaluation code, engine, precision, prompt template and decoding settings, on what hardware? Where do two reports of the same model on the same benchmark disagree, and why?
  - Which of these evaluations check their test sets for contamination, how, and what did they find?
  - What do published comparisons report about retrieval against the whole document, and both together, beyond 32K tokens? What do they report about quantized weights or a quantized KV cache at those lengths?
- **Starting links and scope:** the four benchmarks' papers in arXiv's HTML version and their repositories, and the three model cards. The agents follow links from there, and search the web through a search server the campaign gives them.
- **The team's hypotheses:** "On RULER's tasks, each candidate's effective context is less than half the context its model card claims." "For documents longer than 128K tokens, passages retrieved into a 32K context answer as well as the whole document." The review panel gives each a verdict, supported, refuted or undecided, with the claims behind it.
- **What code checks:** every length, score and version number in a claim must be in its quotes, so a score at 128K tokens in the paper traces to the table row that gives it.
- **What agents would do:** tabulate model, benchmark, length, score, source and settings from each paper and model card; follow each model card's score to the run behind it; search the benchmarks' issues for results that could not be reproduced, or a chat template, a RoPE scaling setting such as YaRN, or a truncation rule that changed a score.
- **What you get:** a research paper with numbered references, an answer card for each question with its certainty, the review panel's decisions with any dissent, and the corpus: every paper, model card and issue thread read, as text.
- **What it feeds:** what only a measurement can settle, such as how each finalist answers on your own documents at 64K and 128K tokens, goes into the paper's future work as next experiments. A goal campaign whose kit runs the finalists on your documents can [start from them](../../how-to/campaigns/use-past-research.md), and the retrieval side fits a hill climb on recall, like the second campaign of [LLM application quality](llm-quality.md).

### 2. A small model to fine-tune for extraction

A product team will fine-tune an open model of 1B to 8B parameters to extract fields from invoices, and has four candidates.

- **The questions:** Which candidates' scores on instruction following and structured output did someone other than the developer reproduce? What does each licence allow, quoted from the licence itself? Which fine-tuning problems, such as chat templates or tokenizer settings, do issue threads report for each? What do published comparisons report about fine-tuned small models against larger prompted ones on extraction?
- **What it feeds:** the invoice campaign of [LLM application quality](llm-quality.md), a hill climb on field F1 whose agents can change the model for each step.

### 3. Quantization for the card you have

Before fitting a model to a 16 GB card, a short campaign can answer "Which published measurements of quality loss exist for open models of 27B to 32B parameters at 3 to 4 bits a weight, in GGUF, EXL3 and AWQ, and how was each measured?" Its next experiments go to a goal campaign such as [Fitting a model to your hardware](hardware-fit.md).

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "long-docs-landscape",
  "version": 1,
  "title": "Long documents: a long-context model, retrieval, or both",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "Claimed and measured long-context performance of Qwen3.8-27B, Gemma 4 31B and Llama 4 Scout on RULER, HELMET, NoLiMa and LongBench v2: which results were reproduced and under which settings, which evaluations check for contamination, and retrieval against the whole document",
  "questions": [
    "For each candidate, what context does its model card claim, and what do RULER, HELMET, NoLiMa and LongBench v2 report for it, at which lengths and on which tasks?",
    "Which of those results were run by someone other than the model's developer, with which evaluation code, engine, precision, prompt template and decoding settings, on what hardware? Where do two reports of the same model on the same benchmark disagree, and why?",
    "Which of these evaluations check their test sets for contamination, how, and what did they find?",
    "What do published comparisons report about retrieval against the whole document, and both together, beyond 32K tokens, and about quantized weights or a quantized KV cache at those lengths?"
  ],
  "rubrics": [
    "For each candidate, give the claimed context with its source, then each benchmark result with its length, task, score and source, or say that none is published.",
    "For each result, say who ran it, with which code, engine, precision and settings, and on what hardware. Keep the developer's own runs apart from others', and give each disagreement with both sources.",
    "Name each evaluation's contamination check, quoted from its paper or repository, and what it found, or say that it reports none.",
    "Give each comparison with its source, models, lengths, retrieval method and result, and keep results on quantized models apart."
  ],
  "hypotheses": [
    "On RULER's tasks, each candidate's effective context is less than half the context its model card claims.",
    "For documents longer than 128K tokens, passages retrieved into a 32K context answer as well as the whole document."
  ],
  "seeds": [
    "https://arxiv.org/html/2404.06654",
    "https://arxiv.org/html/2410.02694",
    "https://arxiv.org/html/2502.05167",
    "https://arxiv.org/html/2412.15204",
    "https://github.com/NVIDIA/RULER",
    "https://github.com/princeton-nlp/HELMET",
    "https://github.com/adobe-research/NoLiMa",
    "https://github.com/THUDM/LongBench",
    "https://huggingface.co/Qwen/Qwen3.8-27B",
    "https://huggingface.co/google/gemma-4-31B-it",
    "https://huggingface.co/meta-llama/Llama-4-Scout-17B-16E-Instruct"
  ],
  "lanes": { "count": 8 },
  "min_verified_claims": 400,
  "quality": { "min_independent_sources": 2 },
  "scope": { "include_domains": ["arxiv.org", "huggingface.co", "github.com", "github.io"] },
  "fetch_policy": { "per_domain_per_minute": 4 },
  "min_duration": "24h",
  "budget": { "llm_usd": 200 }
}
```

`scope.include_domains` keeps the agents to arXiv, Hugging Face, GitHub and project sites on `github.io`, so a claimed context must come from the model card, not a blog post. arXiv's `robots.txt` asks for 15 seconds between requests, so `fetch_policy.per_domain_per_minute` is 4; further fetches wait, they are never refused. `min_verified_claims` holds the first review back until 400 claims are verified, and `min_duration` is a floor, never a stop. With no `max_duration`, the run ends when the review panel gives every question and hypothesis an end, or when research stops adding; the model budget pauses it at $200 first, counted when the rig knows the model's prices ([Contract](../../reference/contract.md#research), [Campaign modes](../../explanation/campaign-modes.md#research)).

## What to expect

- **Time and scale.** The run reads for at least 24 hours of the agents' time; time paused, or with the model provider refusing calls, doesn't count. At 4 fetches a minute, one site gives at most 240 pages an hour, so lanes spread across arXiv, Hugging Face and GitHub read faster than lanes on one. After the minimum, the review panel is asked at each hourly digest, once every question has an answer card and 400 claims are verified.
- **Where the agents help most.** Volume and tracing: every table of every benchmark paper, each model card's score followed to its run, and the issue threads where someone could not reproduce a result.
- **Where people stay.** Choosing the candidates, the benchmarks and the questions; deciding what counts as a reproduction; reading the claims the choice rests on; and the measurement on your own documents.

## What the checks guard against

A score copied from a model card into a decision document reads like an independent result. Here every claim quotes its page, and the rubric for the second question asks who ran each result, so the developer's own runs stay apart from others'. A figure from an earlier version of a paper fails against the version the run archived, or the claim cites the earlier version it quotes. Every number in a finding, an answer card or the paper must be in the verified claims it cites, and the report flags a number that appears in no archived source and no verified claim.

Two sites are not always two teams. A benchmark's paper on arXiv and its repository on GitHub are two registrable domains, so code lists a claim quoting both as independently sourced, though one group wrote both. Code checks domains only; whether someone else reproduced a result is for the rubric and the review panel.

## Limits

- The fetcher reads web pages, plain text, JSON and XML. A PDF is kept but gives no text to quote, so a paper with no HTML version on arXiv can't support a claim, and neither can a score shown only in a chart. A leaderboard that fills its table with scripts in the browser can arrive without its scores; fetch its data files in JSON instead, where it publishes them.
- Pages behind a login or a paywall are out of reach: the fetcher never signs in, and by default it respects `robots.txt`.
- A research run measures nothing. How a candidate answers on your documents, or how fast it runs on your GPU, is a next experiment for a goal or hill-climb campaign.
- Without a search server, the agents read only what the starting links lead to. Research workers can't run on a Claude subscription: use another model.
- A verified quote proves what a page says, not that the result is right.

## Who it's for

- **[Local AI enthusiasts](../for/local-ai.mdx):** know which open models hold up at the lengths you need before you download and fit one.
- **[Startups](../for/startups.mdx):** a model choice made from more reading than a small team has time for, with a source for each score.
- **[Enterprises](../for/enterprises.mdx):** model evaluations that need a source for every statement, run on your own machines with a model you choose.

## Related work

RULER evaluated 17 long-context models: "While these models all claim context sizes of 32K tokens or greater, only half of them can maintain satisfactory performance at the length of 32K" ([the paper](https://arxiv.org/abs/2404.06654)). In NoLiMa, whose questions share few words with the passages that answer them, "At 32K, for instance, 11 models drop below 50% of their strong short-length baselines" ([the paper](https://arxiv.org/abs/2502.05167)). HELMET's study of 59 models found that "synthetic tasks like NIAH do not reliably predict downstream performance" ([the paper](https://arxiv.org/abs/2410.02694)). GSM1k's two figures are from the [first](https://arxiv.org/abs/2405.00332v1) and [fourth](https://arxiv.org/abs/2405.00332v4) versions of its abstract on arXiv, and the count of Meta's private variants from [The Leaderboard Illusion](https://arxiv.org/abs/2504.20879).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Give the agents a search server](../../how-to/campaigns/give-agents-mcp-tools.md), set **Workers at a time** on **Edit rig**, and see what else a research campaign needs in [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md).
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign. When it ends, [start a goal campaign from its next experiments](../../how-to/campaigns/use-past-research.md).
