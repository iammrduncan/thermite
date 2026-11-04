---
title: "Literature review"
description: "Use a Thermite research campaign to find out what is known on a question in any field, with every quotation checked word for word against an archived copy of its source."
type: use-case
useCase:
  mode: research
  personas: [solo-builders, enterprises]
  summary: "Agents search, read and record claims with exact quotes. Code checks every quote against its archived source, and a review panel of models decides each question."
  measure: "Verified claims · every quote found in its archived page · by a panel of models, by majority"
sidebar:
  order: 3
---

Most research starts with the literature: a doctoral student mapping a new field, an R&D team checking what was tried before it funds work, a lab writing the background of a grant. Researchers search Google Scholar, PubMed or Scopus, follow references and citing papers, and keep what they read in a reference manager such as Zotero. A systematic review makes this formal: a protocol written in advance, searches of several databases, two people deciding independently whether each study is eligible, as the [Cochrane Handbook](https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-04) requires, and a report that follows the 27-item checklist of the [PRISMA 2020 statement](https://doi.org/10.1136/bmj.n71). It is slow: among 195 completed systematic reviews of medical interventions in one registry, the mean time from registration to publication was 67.3 weeks, with five authors on average.

Most reviews are scoping or narrative reviews instead: what is known about a subject, which methods were tried, where results disagree. The work is a search through many sources, each of which may or may not bear on the question, and a review is judged by whether each statement traces to a source that says it. A language model that drafts from memory fails exactly there: it can invent papers, figures and quotations that read like real ones. A Thermite research campaign does the reading with agents and leaves the tracing to code.

## Where Thermite fits

The agents search the web through a search server the campaign gives them, fetch pages through the rig's archiving fetcher, which keeps a copy of everything it reads, and record claims with exact quotes from those copies. Code checks each claim: every quote must appear word for word in its archived page, and every number in the claim must appear in its quotes. A synthesizer keeps an answer card for each question, and a review panel of models decides by majority whether each question is answered, answered as well as the sources allow, or still open, with the gaps named. No agent can mark a question answered or end the run. A research campaign changes no code, so it has no kit and no judge's clock.

## Example campaigns

### 1. Map a field before a project

An R&D team starts work on solid electrolytes for lithium-metal batteries and needs the state of the field within a week.

- **The questions:** "Which families of solid electrolytes are studied for lithium-metal batteries, and what room-temperature ionic conductivities do papers report for each?" and "Which failure mechanisms at the interface with lithium metal do papers report, and which remedies?"
- **What code checks:** every conductivity in a claim is in its quotes, so each figure in the report traces to a page that states it.
- **What agents would try:** start from recent reviews, trace each figure to the paper that measured it, and look for papers that report other values for the same material.
- **What you get:** an answer card for each question, with its certainty; a paper with numbered references; and every archived source.

### 2. Compare the methods others tried

A computational biology group must choose a method to correct batch effects in single-cell RNA-seq data (differences between samples processed apart that are not biology), and published benchmarks rank the methods differently.

- **The questions:** which methods the benchmarks compared, on which datasets and with which metrics; where they agree and disagree; and which failure modes they report. The contract below has them, each with a rubric: what an answer must cover.
- **What agents would try:** read each benchmark's methods and results, record its datasets and metrics, and look for later papers that contest its ranking.
- **What you get:** a comparison in which each ranking cites the benchmark that reported it, with claims found on one site listed apart from claims found on two.

### 3. Test what the team believes, then measure it

The author's hypotheses, such as "No single method ranks first in every published benchmark", are the run's obligations: the review panel gives each one a verdict, supported, refuted or undecided, with the claims behind it. What only a measurement could settle goes into the paper's future work as next experiments, each for a hill climb or a goal campaign, and a new run can [start from them](../../how-to/campaigns/use-past-research.md).

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "batch-correction-review",
  "version": 1,
  "title": "Batch-effect correction for single-cell RNA-seq: what benchmarks show",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "How published benchmarks compare batch-effect correction methods for single-cell RNA-seq data",
  "questions": [
    "Which batch-correction methods have published benchmarks compared, on which datasets and with which metrics?",
    "Where do the benchmarks agree and disagree on which methods remove batch effects while keeping biological variation?",
    "Which failure modes do the benchmarks report, such as over-correction that merges distinct cell types?"
  ],
  "rubrics": [
    "Name each benchmark, the methods it compared, its datasets and its metrics, from the benchmark itself.",
    "For each method that two or more benchmarks ranked, give each benchmark's finding.",
    "Name each failure mode with the benchmark or paper that reports it."
  ],
  "hypotheses": ["No single method ranks first in every published benchmark."],
  "min_verified_claims": 30,
  "quality": { "min_independent_sources": 2 },
  "min_duration": "4h",
  "max_duration": "12h"
}
```

A research campaign has no kit. The contract holds the topic, the questions, the rubric the review panel judges each answer card against, and the author's hypotheses. `min_verified_claims` holds back the first review until the run has 30 verified claims; `min_duration` is a floor, never a stop; `max_duration` ends the run, answered or not. The check is the harness's own code: a claim whose quotes match shows in the run's History as `lane-1 recorded a verified claim: "…".`, and one that fails stays a draft. Without a search server, the agents read only what the starting links in `seeds` lead to ([Contract](../../reference/contract.md#research)).

## What to expect

- **Time.** The run collects sources for at least `min_duration`. From then on, at each digest (hourly by default), once every question has an answer card, the review panel is asked about each question and hypothesis with no decision that stands. The contract above runs for 4 to 12 hours of the agents' time; time paused, or with the model provider refusing calls, doesn't count.
- **Where the agents help most.** Breadth: reading many sources, tracing each number to the paper that reported it, and finding sources that disagree.
- **Where people stay.** Choosing the questions and rubrics, reading the sources behind the claims that matter, judging the quality of each study, and any review published as systematic.

## What the judge guards against

A fabricated citation looks exactly like a real one. In a research campaign, a claim counts only when every quotation is found word for word on its archived page and every number in the claim appears in its quotations; otherwise it remains a draft, with its problems listed. The rule reaches up the chain: a finding, a reviewer's answer and the paper count only when the claims they cite are verified and their numbers come from those claims (the paper may also give the run's own counts). The report flags every number that appears in no archived source and no verified claim.

## Limits

- It is not a systematic review: there is no protocol registered in advance, no exhaustive search of bibliographic databases, no two people screening each study and no assessment of risk of bias. For clinical questions, see [Clinical evidence review](../healthcare/evidence-reviews.md).
- The fetcher reads text from web pages, plain text, JSON and XML. A PDF is kept but gives no text to quote, so read a paper in an HTML version, such as arXiv's or a journal's full-text page. Pages behind a login or a paywall are out of reach: the fetcher never signs in, and by default it respects `robots.txt`.
- Research workers search the web only through an MCP server the campaign gives them, and they can't run on a Claude subscription: use another model.
- A verified quote proves what a source says, not that the source is right. A retracted paper's words still match. Read the report as a careful first draft.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** independent researchers and students surveying a new field.
- **[Enterprises](../for/enterprises.mdx):** R&D teams that need to show where every statement came from.

## Related work

Walters and Wilder found that 55% of the citations GPT-3.5 gave, and 18% of those GPT-4 gave, were fabricated ([the paper](https://www.nature.com/articles/s41598-023-41032-5)). Kosmos, an AI scientist, had experts rate its statements: 79.4% of 102 were accurate, but only 57.9% of the interpretive ones ([the paper](https://arxiv.org/abs/2511.02824)). Borah and others found that "the mean estimated time to complete the project and publish the review was 67.3 weeks", across 195 registered systematic reviews ([the paper](https://doi.org/10.1136/bmjopen-2016-012545)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Give the agents a search server](../../how-to/campaigns/give-agents-mcp-tools.md), and see what else a research campaign needs in [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md).
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
