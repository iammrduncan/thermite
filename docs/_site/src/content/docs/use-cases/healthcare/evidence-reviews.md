---
title: "Clinical evidence review"
description: "Use a Thermite research campaign to review the clinical evidence on a question, with every quotation verified against an archived copy of its source."
type: use-case
useCase:
  mode: research
  personas: [enterprises, solo-builders]
  summary: "Agents search the open-access literature and record claims. Every quote is verified against its archived source; unsupported references do not count."
  measure: "Verified claims · every quote found in its archived source · by a panel of models, by majority"
sidebar:
  order: 4
---

Questions such as which randomised trials compare two treatments, and what they found, underpin systematic reviews, guideline updates and medical-affairs briefings. Answering them well takes days, and language models frequently cite references that do not exist. A Thermite research campaign answers from the open-access literature, archives every page it reads, and accepts a claim only when its quotations are found word for word in that archive.

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

## What the judge guards against

Fabricated references and numbers that no source states. A claim whose quotation is not found on its archived page remains a draft, and findings can cite only verified claims.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** pharmaceutical medical affairs and health-economics teams, who must show the source of every statement. The questions themselves can reveal a pipeline; here they stay on your machines.
- **[Solo builders](../for/solo-builders.mdx):** clinician-researchers starting a systematic review.

## Related work

In a study of systematic reviews, Chelli and others found that 28.6% of the references GPT-4 gave and 39.6% of those GPT-3.5 gave were hallucinated ([JMIR, 2024](https://doi.org/10.2196/53164)). otto-SR, an AI system for systematic reviews, reproduced 12 Cochrane reviews in about two days ([its preprint](https://doi.org/10.1101/2025.06.13.25329541), not yet peer reviewed).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md) shows what a research campaign needs.
3. A checked quote proves what a paper says, not that the study is sound. Grading the risk of bias, and any meta-analysis, stays with people, and the report is not clinical guidance.
