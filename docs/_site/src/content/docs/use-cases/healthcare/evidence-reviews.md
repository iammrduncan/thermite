---
title: "Review the evidence on a clinical question, every quote checked"
description: "Run a research campaign on a question such as what trials compare two treatments, and get a report in which every quote was found word for word in an archived copy of its source."
type: use-case
useCase:
  mode: research
  personas: [enterprises, solo-builders]
  summary: "Ask what the trials say. Agents read open-access papers and record claims; code finds every quote, word for word, in the archived page, and invented references can't count."
  measure: "Verified claims · every quote found in its archived source · by a panel of models, by majority"
sidebar:
  order: 4
---

A question such as "which randomised trials compare treatment X with treatment Y for outcome Z, and what did they find?" starts every systematic review, every guideline update and every medical-affairs brief. It takes days to answer well, and a language model can answer it in seconds with references that don't exist. A Thermite **research campaign** answers it from the open-access literature, archives every page it reads, and counts a claim only when code finds its quotes in that archive, word for word.

## The campaign

| | |
| --- | --- |
| **Mode** | [Research](../../explanation/campaign-modes.md#research) |
| **What you give it** | The questions, the hypotheses to test, and how long it must run at least, and at most |
| **What is checked** | Each quote is found word for word in its archived source, and every number in a claim is in its quotes. A report section that states a number from nowhere is flagged |
| **Who decides** | A review panel of models decides each question, by a majority, as answered, the best available, or open |
| **What you get** | A report and a paper, with the archived sources, the verified claims and the open gaps in the evidence |

## How it runs

1. **You write the brief.** No kit is needed: a research campaign changes no code.
2. **Agents search and read** open-access journals and repositories through the rig's archiving fetcher, and record claims with their quotes.
3. **Code verifies each claim**, and the review panel decides each question. The run's page shows where every question stands, and the gaps that the next tasks will look for.

## What the judge keeps out

Invented references, and numbers that no source states. A claim whose quote isn't on its archived page stays a draft, and the report can only cite verified claims as findings.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** pharmaceutical medical affairs and health-economics teams, who must show the source of every statement. The questions themselves can reveal a pipeline; here they stay on your machines.
- **[Solo builders](../for/solo-builders.mdx):** a clinician-researcher starting a review.

## What others have shown

In a study of systematic reviews, Chelli and others found that 28.6% of the references GPT-4 gave and 39.6% of those GPT-3.5 gave were hallucinated ([JMIR, 2024](https://doi.org/10.2196/53164)). otto-SR, an AI system for systematic reviews, reproduced 12 Cochrane reviews in about two days ([its preprint](https://doi.org/10.1101/2025.06.13.25329541), not yet peer reviewed).

## Start

1. [Install on one machine](../../tutorials/first-run.md).
2. [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md) shows what a research campaign needs.
3. A checked quote proves what a paper says, not that the study is sound. Grading the risk of bias, and any meta-analysis, stays with people, and the report is not clinical guidance.
