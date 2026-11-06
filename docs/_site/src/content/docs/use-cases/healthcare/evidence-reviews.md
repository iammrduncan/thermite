---
title: "Clinical evidence review"
description: "Use a Thermite research campaign to build a corpus of every trial record and publication on one clinical question, from ClinicalTrials.gov and other registries to PubMed and PMC full text, each quote checked against an archived copy and kept current as new trials report."
type: use-case
useCase:
  mode: research
  personas: [enterprises, solo-builders]
  summary: "Agents read every registry record and publication on one PICO question and record claims with exact quotes. Code checks each quote and number, and a review panel of models decides each question."
  measure: "Verified claims, trial by trial · each quote and number found in its archived record or paper · a panel of models, by majority"
sidebar:
  order: 4
---

A clinical evidence question is framed as PICO: the population, the intervention, the comparator and the outcomes. Review teams, guideline groups, health technology assessment agencies and medical affairs teams answer it from two kinds of source. Trial registries, such as ClinicalTrials.gov, the ISRCTN registry and the others that the WHO's International Clinical Trials Registry Platform (ICTRP) brings together, hold each trial's planned outcomes, its status and often its results. The literature, searched in MEDLINE through PubMed, in Embase and in CENTRAL, holds the publications, with full texts in PubMed Central (PMC) and Europe PMC. A systematic review reads both to a protocol, with two people screening each record, as the Cochrane Handbook asks; across 195 registered reviews, the mean time from registration to publication was 67.3 weeks, and about 3% of the records found were included.

The registries and the papers often disagree, and the gaps between them are where an evidence summary goes wrong. Results go missing: of 4,209 trials due to post results on ClinicalTrials.gov under US law, 1,722 (40.9%) did so within the one-year deadline. Outcomes change between registration and publication: COMPare checked every trial that five major medical journals published over six weeks, and 58 of 67 had discrepancies that needed a correction letter. A language model asked for the references makes some up: in one study, 28.6% of the references GPT-4 gave for systematic reviews were hallucinated.

## Where Thermite fits

Each **lane**, a line of search with its own agent, takes one gap the run's plan finds in a question's answer card: a completed trial with no publication found yet, a hazard ratio known only from a press release, an outcome registered one way and published another. The agents fetch each registry record and paper through the rig's archiving fetcher, which keeps every page as text, and record **claims** with exact quotes. Code checks each quote word for word against its archived page, and each number in the claim, such as a hazard ratio and its confidence interval, against its quotes. A synthesizer keeps an answer card for each question, and a review panel of models decides each question by majority, with any dissent kept. No agent can mark a question answered or end the run.

A review team screens titles and abstracts for weeks; the run reads every record and paper in scope, registries as well as literature, on up to 16 lanes with no limit unless you set one. On 3 November 2026, ClinicalTrials.gov's API returned 285 records for heart failure with an SGLT2 inhibitor among the interventions, 44 with results posted, and PubMed listed 509 randomized controlled trials of the same drugs in heart failure, 257 with full text in PMC: about 1,050 pages, under an hour and a half from each site at the default six pages a minute. Nothing it reads is thrown away: the archived pages, every claim, the answer cards and the paper stay in the run's research folder and in the campaign's collection in Thermite's knowledge base. Next month's run searches them, fetches what is new, and archives again each page it cites, so newly posted results show up.

What you get is not a systematic review: no protocol registered in advance, no exhaustive search of subscription databases, no two people screening each record, no risk-of-bias assessment with RoB 2, no meta-analysis and no GRADE rating. It is a corpus of what the registries and the open literature hold on one PICO question, each trial's records and publications linked by registration number, quoted and kept current: for scoping a review, watching for new results and checking publications against registrations.

## Example campaigns

### 1. SGLT2 inhibitors in heart failure with an ejection fraction above 40%

A guideline group keeps a recommendation on SGLT2 inhibitors, a drug class first used for type 2 diabetes, in heart failure with an ejection fraction above 40%. Before its next update it wants every trial in the registries and the literature, linked and quoted.

- **The questions:** four, in the contract below: the trials and their registry records; each completed trial's registered and published primary outcome, with its effect estimate and 95% confidence interval; the completed trials with no results and no publication; and the subgroups, where they differ.
- **Starting links and scope:** ClinicalTrials.gov's and ISRCTN's APIs for the registry records, a PubMed search limited to randomized controlled trials, and a Europe PMC search. `scope.include_domains` keeps the fetcher to the registries, NCBI and Europe PMC, away from news and marketing pages.
- **The team's hypotheses:** "For each completed trial, the primary outcome in its main publication is the one its registry record gives." "Every completed trial in this population with results on ClinicalTrials.gov also has a journal publication." The review panel gives each a verdict, supported, refuted or undecided, with the claims behind it.
- **What code checks:** every hazard ratio, interval, number randomized and date in a claim must be in its quotes.
- **What agents would do:** follow each registration number to PubMed and PMC; set each registered primary outcome beside the published one; look for a trial registered in two registries; check each paper's PubMed record for a retraction or an erratum.
- **What you get:** a research paper with numbered references, an answer card for each question, the review panel's decisions, and the corpus: every record and paper as text.
- **What it feeds:** the claims, checked by people, are labelled data for a hill climb on the team's screening model, with recall of the records people included as the number and precision held, as on [Clinical note de-identification](clinical-notes.md), scored on records screened after the run. What only a new trial could settle stays `insufficient` on its card: the best the evidence allows.

### 2. Registered against published, for one sponsor's trials

A pharmaceutical company's transparency team checks every trial it sponsors.

- **The questions:** For each trial with a primary completion date before 2025, when were results posted on ClinicalTrials.gov, and how long after completion? Which publication reports it? Do its published primary outcomes match the registered ones?
- **Starting links:** the registry's API, filtered by the sponsor, and a PubMed search for the trials' registration numbers.
- **What code checks:** every date in a claim is in its quotes from the registry record.
- **What it feeds:** a goal campaign for the team's own script that links registry records to publications, held to the run's verified pairs, checked by people, on trials the agents never see.

### 3. Keep it current

Copy the campaign, add the question "What has been registered, posted or published since the last run?", and start a new run each month. A medical information team can let its own campaign read the collection, so its sourced answers to clinicians start from the same corpus ([Use past research](../../how-to/campaigns/use-past-research.md#let-a-campaign-read-anothers-collection)).

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "sglt2-hf-above-40",
  "version": 1,
  "title": "SGLT2 inhibitors in heart failure with an ejection fraction above 40%: every trial record and publication",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "Randomized trials of SGLT2 inhibitors against placebo in adults with heart failure and a left ventricular ejection fraction above 40%: their registry records, results and publications",
  "questions": [
    "Which randomized trials in the registries compare an SGLT2 inhibitor with placebo in adults with heart failure and an ejection fraction above 40%, with their registration numbers, status, numbers randomized and dates?",
    "For each completed trial, what primary outcome does its registry record give, what does its main publication report, and with what effect estimate and 95% confidence interval?",
    "Which completed trials have no results posted and no publication found, and how long ago was their primary completion?",
    "Which prespecified subgroups, such as ejection fraction, diabetes and age, did the trials report, and where do their results differ?"
  ],
  "rubrics": [
    "Each trial named with its registration numbers, drug and dose, population, status, number randomized and primary completion date, from its registry record.",
    "For each completed trial, the registered primary outcome and the published one, both quoted, and the published hazard ratio or other estimate with its 95% confidence interval.",
    "Each completed trial without posted results or a publication, with its primary completion date, or a statement that every completed trial has both.",
    "The subgroups each trial reported, with each result that differs between trials and the sources of both."
  ],
  "hypotheses": [
    "For each completed trial, the primary outcome in its main publication is the one its registry record gives.",
    "Every completed trial in this population with results on ClinicalTrials.gov also has a journal publication."
  ],
  "seeds": [
    "https://clinicaltrials.gov/api/v2/studies?query.cond=heart+failure&query.intr=SGLT2+OR+dapagliflozin+OR+empagliflozin+OR+sotagliflozin+OR+canagliflozin+OR+ertugliflozin&fields=NCTId,BriefTitle,OverallStatus,Phase,StudyType,EnrollmentCount,PrimaryCompletionDate,HasResults,PrimaryOutcomeMeasure&pageSize=1000",
    "https://www.isrctn.com/api/query/format/default?q=heart%20failure%20AND%20(dapagliflozin%20OR%20empagliflozin%20OR%20sotagliflozin%20OR%20canagliflozin%20OR%20ertugliflozin)&limit=100",
    "https://pubmed.ncbi.nlm.nih.gov/?term=%28SGLT2+inhibitor+OR+dapagliflozin+OR+empagliflozin+OR+sotagliflozin+OR+canagliflozin+OR+ertugliflozin%29+AND+heart+failure&filter=pubt.randomizedcontrolledtrial",
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=%28dapagliflozin+OR+empagliflozin+OR+sotagliflozin+OR+canagliflozin+OR+ertugliflozin%29+AND+%22heart+failure%22+AND+PUB_TYPE%3A%22Randomized+Controlled+Trial%22&resultType=core&format=json&pageSize=100"
  ],
  "scope": { "include_domains": ["clinicaltrials.gov", "isrctn.com", "nih.gov", "ebi.ac.uk", "europepmc.org"] },
  "fetch_policy": { "respect_robots": false },
  "lanes": { "count": 6 },
  "min_verified_claims": 250,
  "quality": { "min_independent_sources": 2 },
  "min_duration": "12h",
  "max_duration": "72h"
}
```

ClinicalTrials.gov's API gives all 285 records in one JSON page, ISRCTN's API gives XML and Europe PMC's gives abstracts as JSON. ClinicalTrials.gov's study pages are drawn in the browser and hold almost no text for the fetcher, and its `robots.txt` keeps robots off `/api/`, although the API's own description says it "is made available to provide users meta data, statistics, and the most recent version of the clinical trials available on ClinicalTrials.gov". So this contract sets `fetch_policy.respect_robots` to false, and `scope.include_domains` keeps the fetcher to five sites, at the default six pages a minute each. Read each site's terms before you do the same. The rubrics, what the review panel requires of each answer, ask for each trial by its registration numbers. `min_verified_claims` holds the first review back until 250 claims are verified, and `max_duration` ends the run after 72 hours of running time, answered or not ([Contract](../../reference/contract.md#research), [Campaign modes](../../explanation/campaign-modes.md#research)).

## What to expect

- **Time and scale.** The run reads for at least 12 hours of the agents' time, paused time aside; after that, the review panel is asked at each hourly digest, once every question has an answer card.
- **Where the agents help most.** Volume and linking: every registry record, each registration number followed to its publications, each registered outcome set beside the published one.
- **Where people stay.** The question and its eligibility criteria, screening the candidates, whether a trial falls under the US reporting law, risk of bias, any meta-analysis and certainty rating, and the recommendation itself.

## What the checks guard against

A hazard ratio copied from a press release, a conference abstract or the wrong analysis reads like the right one. Here a number counts only when it is in a quote from an archived page, so each figure traces to the registry record or the paper that gives it. A claim quoting both a trial's registry record and its publication counts as independently sourced, since clinicaltrials.gov and nih.gov are two sites; PubMed and PMC are one site, nih.gov, so an abstract and its own full text never count twice. Two sources on one trial are still one trial, so the rubrics ask for each trial's registration numbers. Findings, answer cards, the review panel's answers and the paper count only when the claims they cite are verified, and their numbers come from those claims.

## Limits

- The WHO's ICTRP search portal keeps robots off its whole site, so records that only the portal brings together stay out of reach.
- The fetcher reads web pages, plain text, JSON and XML. A PDF is kept but gives no text to quote, so subgroup tables found only in a supplementary appendix in PDF can't support a claim. HTML full text is at PMC, Europe PMC and publishers' pages for open-access articles.
- The fetcher never signs in, so a paywalled paper's claims rest on its abstract, and Embase and CENTRAL are out of reach. The search can't be repeated the way a documented database search can.
- A verified quote proves what a record or a paper says, not that the trial is sound, and a retracted paper's words still match. The certainty on an answer card says how well the verified claims answer the question: it is not GRADE's certainty of the evidence, and the report is not clinical guidance.
- A research run measures nothing. Without a search server, the agents read only what the starting links lead to. Research workers can't run on a Claude subscription: use another model.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** medical affairs, health economics and transparency teams, who must show the source of every statement. The questions themselves can reveal a pipeline; here they stay on your machines.
- **[Solo builders](../for/solo-builders.mdx):** clinician-researchers scoping a review or keeping a question's evidence current.

## Related work

DeVito, Bacon and Goldacre found that "1722 (40·9%; 95% CI 39·4-42·2)" of 4,209 trials due to report on ClinicalTrials.gov did so within the one-year deadline ([The Lancet, 2020](https://doi.org/10.1016/S0140-6736(19)33220-9)). COMPare found that "Fifty-eight trials had discrepancies requiring a correction letter", of 67 assessed ([Trials, 2019](https://doi.org/10.1186/s13063-019-3173-2)). Chelli and others found that 28.6% of the references GPT-4 gave for systematic reviews, and 39.6% of those GPT-3.5 gave, were hallucinated ([JMIR, 2024](https://doi.org/10.2196/53164)). otto-SR, a language-model system for systematic reviews, updated 12 Cochrane reviews and found 114 eligible studies where their authors had found 64 ([its preprint](https://doi.org/10.1101/2025.06.13.25329541)). Borah and others put "the mean estimated time to complete the project and publish the review" at 67.3 weeks ([BMJ Open, 2017](https://doi.org/10.1136/bmjopen-2016-012545)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md). A research campaign needs a model other than a Claude subscription ([Choose a model](../../how-to/models/choose-a-model.md)).
2. [Give the agents a search server](../../how-to/campaigns/give-agents-mcp-tools.md), set **Workers at a time** on **Edit rig**, and see what else a research campaign needs in [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md).
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, with your PICO question and a rubric for each question, and start the campaign. Copy it each month to keep the corpus current.
