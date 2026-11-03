---
title: "Find out what is known, with every quote checked"
description: "Ask a research campaign a question about the literature, and get a report whose every claim rests on a quote that code found, word for word, in an archived copy of the page it came from."
type: use-case
useCase:
  mode: research
  personas: [solo-builders, enterprises]
  summary: "Ask questions. Agents read sources and record claims; code finds every quote, word for word, in an archived copy of its page, and a panel of models decides each answer."
  measure: "Verified claims · every quote found in its archived page · by a panel of models, by majority"
sidebar:
  order: 3
---

Before an experiment comes the question of what is already known. A literature review takes days, and a language model that does it for you can invent a paper, a number or a quote. A Thermite **research campaign** answers the questions you ask from sources it archives as it reads them, and code checks every quote in its report against those archived pages, word for word.

## The campaign

| | |
| --- | --- |
| **Mode** | [Research](../../explanation/campaign-modes.md#research): answer questions from sources |
| **What you give it** | The questions, any hypotheses you want tested, and how long it must run at least, and at most |
| **What is checked** | Every claim rests on quotes, and code finds each quote, word for word, in the copy of the page that the rig archived. Every number in a claim must be in its quotes, and each finding must rest on verified claims |
| **Who decides** | A review panel of models decides each question by a majority. No agent can mark a question answered or close the run |
| **What you get** | A report and, at the end, a paper; the archived sources, the claims and the notes, in the run's research folder |

## How it runs

1. **You write the brief:** the questions, the hypotheses, and the length of the run. No kit is needed: a research campaign changes no code.
2. **Agents read and record.** They fetch pages through the rig's archiving fetcher, which respects `robots.txt`, and record each claim with its exact quotes.
3. **Code checks every quote** against the archived page, and the run's page shows each question's state: answered, the best available, or open, with the gaps in the evidence that the next tasks look for.
4. **The run ends** when the review panel's decisions give every question an end, when the research stops adding, or when its maximum time is over.

## What the judge keeps out

An invented citation reads exactly like a real one. In a research campaign, a claim counts only when every quote is found word for word on its archived page and every number in the claim is in its quotes; otherwise it stays a draft, with its problems listed. The report flags every number that appears in no archived source and no verified claim.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** an independent researcher's or a student's first pass over a field.
- **[Enterprises](../for/enterprises.mdx):** R&D teams that need to show where every statement came from.

## What others have shown

Walters and Wilder found that 55% of the citations GPT-3.5 gave, and 18% of those GPT-4 gave, were fabricated ([the paper](https://www.nature.com/articles/s41598-023-41032-5)). Kosmos, an AI scientist, had experts rate its statements: 79.4% of 102 were accurate, but only 57.9% of the interpretive ones ([the paper](https://arxiv.org/abs/2511.02824)).

## Start

1. [Install on one machine](../../tutorials/first-run.md).
2. [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md) shows what a research campaign needs.
3. A verified quote proves what a source says, not that the source is right. Paywalled papers are out of reach. Read the report as a careful first draft.
