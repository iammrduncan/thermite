---
title: "Clinical evidence review"
description: "Use a Thermite research campaign to map the published evidence on a clinical question, with every quotation and number checked against an archived copy of its source."
type: use-case
useCase:
  mode: research
  personas: [enterprises, solo-builders]
  summary: "Agents search the open-access literature and record claims with exact quotes. Code checks each quote and number against its archived source, and a panel of models decides each question."
  measure: "Verified claims · every quote and number found in its archived source · a panel of models, by majority"
sidebar:
  order: 4
---

A systematic review answers a clinical question framed as PICO: the population, the intervention, the comparator and the outcomes. The review team writes a protocol, searches the databases MEDLINE, CENTRAL and, where it has access, Embase, as well as trial registers, and screens thousands of titles and abstracts in a tool such as Covidence or EPPI-Reviewer. Two people working independently decide whether each study is eligible, as the Cochrane Handbook asks. Then come data extraction, an assessment of each trial's risk of bias with RoB 2, a meta-analysis, and a rating of the certainty of the evidence with GRADE, reported to the PRISMA 2020 guideline. It is slow: across 195 registered reviews, the mean time from registration to publication was 67.3 weeks, and about 3% of the records found were included in the end.

Much of that time goes to finding and reading: which trials exist, what each one reported, what has appeared since the last search. That is also where language models are least safe: in one study, 28.6% of the references GPT-4 gave for systematic reviews were hallucinated. A Thermite research campaign does the finding and the reading in the open-access literature. It archives every page it reads, accepts a claim only when code finds the claim's quotes word for word in the archive and its numbers in those quotes, and leaves the judgements of a review to people.

## Where Thermite fits

The agents search with a tool the campaign gives them, or follow links from starting pages such as a PubMed search, and fetch each page through the rig's archiving fetcher: abstracts on PubMed, full texts on PubMed Central and Europe PMC. They record each claim with its exact quotes. Code checks every quote against the archived page and every number in the claim against its quotes; a claim that fails stays a draft. A review panel of models decides each question as answered, or as the best the sources allow. No agent can mark a question answered or end the run.

A run does not replace the review. It makes no exhaustive search of subscription databases, keeps no screening record for a PRISMA flow diagram, has no second independent reviewer, assesses no risk of bias, pools no results and grades no certainty. It belongs before and around a review: scoping a question, watching for new trials, and answering questions where every statement needs a source.

## Example campaigns

### 1. Scope a review before the protocol

A review team plans a systematic review of SGLT2 inhibitors, a class of drugs first used for type 2 diabetes, in heart failure with an ejection fraction above 40%, and wants to know which trials exist before it writes the protocol.

- **Mode:** research.
- **The questions:** which randomized controlled trials compared an SGLT2 inhibitor with placebo in that population; what each reported for its primary outcome, with the effect estimate and confidence interval in the trial's own words; which subgroups and secondary outcomes each reported.
- **What code checks:** every quote is in its archived page, and every hazard ratio and interval in a claim is in its quotes.
- **What you get:** a report and a paper that list each trial with its quoted results and its sources, and the gaps the run could not close, to inform the protocol and its search strategy.

### 2. Watch for new trials since the last search

A guideline group's review searched the literature up to a date, and the group must decide whether new evidence justifies an update.

- **Mode:** research. Copy the campaign to run it again later.
- **The questions:** which randomized trials in the review's population and interventions were published after its search date; whether any of them reports a primary result in the opposite direction to the review's conclusion, with the quote.
- **What you get:** a list of candidate studies, each with quotes from its archived abstract or full text, for the group to screen. The decision to update stays with the group.

### 3. A sourced answer for medical information

A pharmaceutical company's medical information team answers a clinician's question about the published evidence for one of its products in a subgroup of patients, and every statement in the reply must cite a publication.

- **Mode:** research, with a rubric for what each answer must cover.
- **What you get:** a report in which every number traces to a quote on an archived page, for the team's medical reviewers to check and edit before anything is sent.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "sglt2-hf-scoping",
  "version": 1,
  "title": "SGLT2 inhibitors in heart failure with an ejection fraction above 40%: the randomized evidence",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "Randomized controlled trials of SGLT2 inhibitors against placebo in adults with heart failure and a left ventricular ejection fraction above 40%",
  "questions": [
    "Which randomized controlled trials have compared an SGLT2 inhibitor with placebo in adults with heart failure and an ejection fraction above 40%, and what were their populations, numbers randomized and follow-up?",
    "What did each trial report for its primary outcome, with the effect estimate and its 95% confidence interval as the trial's own publication states them?",
    "Which prespecified subgroups and secondary outcomes did the trials report, and where do their results differ?"
  ],
  "rubrics": [
    "Each trial named with its registration number, drug and dose, population, number randomized and median follow-up",
    "For each trial, the primary outcome's definition and its hazard ratio with the 95% confidence interval, quoted from the trial's publication",
    "The subgroups by ejection fraction, diabetes and age where reported, and each result that differs between trials"
  ],
  "seeds": [
    "https://pubmed.ncbi.nlm.nih.gov/?term=SGLT2+inhibitor+heart+failure+preserved+ejection+fraction&filter=pubt.randomizedcontrolledtrial"
  ],
  "scope": { "include_domains": ["nih.gov", "europepmc.org"] },
  "min_duration": "2h",
  "max_duration": "8h"
}
```

A research campaign has no kit and changes no code. The contract holds the topic, the questions, and a rubric for each question that says what its answer must cover; the review panel judges each answer card against it. The starting link is a PubMed search limited to randomized controlled trials. The scope keeps the fetcher to PubMed, PubMed Central and Europe PMC, away from news and marketing pages; add a journal's domain to read its open-access articles there. The run reads for at least two hours, and ends when the review panel finds every question at an end, when the research stops adding, or after eight hours ([Contract](../../reference/contract.md#research)). The run's **History** tab records each claim as code decides it, such as `lane-1 recorded a verified claim: "…".` or `lane-1's claim stays a draft: "…". Why: …`.

## What to expect

- **Time.** A run takes hours, not weeks. The fetcher takes at most six pages a minute from each site by default, so hundreds of full texts take hours.
- **Where the agents help most.** Finding the trials, reading abstracts and full texts, and copying each result in its exact words and numbers, which code then checks.
- **Where people stay.** The question and its eligibility criteria, screening the candidates, judging each trial's risk of bias, any meta-analysis, and the conclusions.

## What the judge guards against

Fabricated references and numbers that no source states. A claim whose quotation is not found on its archived page remains a draft, and findings can cite only verified claims. A hazard ratio or a confidence interval in a claim must appear in its quotes, so a number copied wrongly is caught, and the report flags every number that appears in no archived source and no verified claim.

## Limits

- Open access only. Where a trial's full text is behind a paywall, claims rest on its abstract, and subscription databases such as Embase are out of reach.
- The search is not a systematic search: it depends on the search tool and the links the agents follow, and it can't be repeated the way a documented database search can.
- A verified quote proves what a paper says, not that the study is sound. Risk of bias, meta-analysis and GRADE stay with people.
- The certainty on an answer card says how well the verified claims answer the question. It is not GRADE's certainty of the evidence.
- The report is not clinical guidance.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** pharmaceutical medical affairs and health-economics teams, who must show the source of every statement. The questions themselves can reveal a pipeline; here they stay on your machines.
- **[Solo builders](../for/solo-builders.mdx):** clinician-researchers starting a systematic review.

## Related work

Chelli and others found that 28.6% of the references GPT-4 gave for systematic reviews, and 39.6% of those GPT-3.5 gave, were hallucinated ([JMIR, 2024](https://doi.org/10.2196/53164)). otto-SR, a language-model system for systematic reviews, reproduced and updated 12 Cochrane reviews and found 114 eligible studies where the original authors had found 64, with every discrepancy checked by two people ([its preprint](https://doi.org/10.1101/2025.06.13.25329541)). Across 195 registered reviews, Borah and others measured a mean of 67.3 weeks from registration to publication ([BMJ Open, 2017](https://doi.org/10.1136/bmjopen-2016-012545)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md). A research campaign needs a model other than a Claude subscription ([Choose a model](../../how-to/models/choose-a-model.md)).
2. [Give the agents a search tool](../../how-to/campaigns/give-agents-mcp-tools.md), or start them from a PubMed search, as above.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, with your questions and a rubric for each, and start the campaign.
