---
title: "Agronomic trial evidence"
description: "Use a Thermite research campaign to gather the evidence on one practice, such as cover crops before corn or nitrogen rates by region, from extension trial reports, on-farm networks, SARE reports and meta-analyses, with each claim checked against its archived page."
type: use-case
useCase:
  mode: research
  personas: [enterprises, solo-builders, startups]
  summary: "Agents read the extension trial reports, on-farm network results, SARE reports and meta-analyses on one practice. Code checks each quote, and a review panel of models decides each question."
  measure: "Verified claims by region, soil and rotation · each quote and number found in its archived page · a panel of models, question by question"
sidebar:
  order: 4
---

Agronomists at seed and input companies, advisory services and cooperatives are asked every winter what the evidence says about one practice, such as cereal rye before corn or the nitrogen rate for corn after soybean, on their growers' soils. It is spread across university extension trial reports and research farm reports; on-farm research networks such as Practical Farmers of Iowa's Cooperators' Program and the Nebraska On-Farm Research Network, which runs 80 to 100 studies a year; USDA's Agricultural Research Service; the SARE program (Sustainable Agriculture Research and Education); and meta-analyses that pool them. For nitrogen, several Corn Belt states use the Maximum Return to Nitrogen (MRTN) approach: the Corn Nitrogen Rate Calculator finds, from rate trials, "the N rate where the economic net return to N application is maximized", by region, rotation and the ratio of nitrogen to corn price.

The figures disagree until their conditions are read. Iowa's Nutrient Reduction Strategy science assessment identified "a corn yield reduction of 6 percent when grown following a rye cover crop". A long-term on-farm trial by Practical Farmers of Iowa and Iowa Learning Farms found that "in 63 of 70 site-years, properly managed cover crops had little to no negative effect on corn and soybean yield". A global review of 106 studies at 372 sites put the main crop's yield about 4% lower after cover crops. Each answers a different question: which crops, which cover, managed how, on which soils. A review written in a few weeks has time for the averages, not the trial reports behind them, and inherits stale numbers, such as an MRTN rate for a state that has changed its method. Iowa State released N-FACT in 2025, built on the Iowa Nitrogen Initiative's on-farm trials, and the calculator's form now lists six states, Iowa not among them.

## Where Thermite fits

Each **lane**, a line of search with its own agent, takes one gap the run's plan finds in a question's evidence: a state with no trial of rye before corn yet, a meta-analysis's data point with no trial report behind it, two networks that disagree on the yield effect. The agents fetch the trial reports, network results and open-access papers through the rig's archiving fetcher, which keeps each as text, and record **claims** with exact quotes: a yield difference, a count of site-years, a termination date. Code verifies each claim: every quote must appear word for word in its archived page, and every number in the claim in its quotes. A synthesizer keeps an answer card for each question, and a review panel of models decides each question and each of the team's hypotheses by majority, with dissent kept. No agent can mark a question answered or end the run.

An agronomist reads the reviews and a few state reports; the run can read the trials behind them, with no limit unless you set one. For rye before corn, that is the 106 studies behind the review above, the 41 articles behind a meta-analysis of nitrate leaching under cover crops and the 23 behind one of hairy vetch before maize, up to 170 papers before overlaps are removed; then each Corn Belt state's research farm reports and network results. The archived pages, claims, findings and answer cards stay in the run's research folder and in the campaign's collection in Thermite's knowledge base, where next season's run searches them.

## Example campaigns

### 1. Cereal rye before corn, by region, soil and rotation

A seed company's agronomists advise growers in Iowa, Illinois and Minnesota who are asked to plant rye before corn.

- **The questions:** the four in the contract below: yield after rye by state, drainage and rotation; the management that limits a loss; nitrate losses; and net cost or return.
- **Starting links and scope:** meta-analyses on PubMed Central, SARE's reports, Practical Farmers of Iowa's research reports, Iowa State's research farm reports and the Nebraska network's results. The agents follow reference lists to the trials, and search through a search server the campaign gives them.
- **The team's hypotheses:** the two in the contract. The review panel gives each a verdict, supported, refuted or undecided, with the claims behind it.
- **What code checks:** every yield, rate, date and count of site-years in a claim must be in its quotes, so a yield difference in the paper traces to the report that gives it.
- **What agents would do:** trace each data point of a meta-analysis to its trial; record each trial's soil, rotation, termination date and nitrogen rate with their quotes; look for trials that contradict an average.
- **What you get:** a research paper with numbered references, an answer card for each question, the review panel's decisions with any dissent, and the corpus.
- **What it feeds:** what only a measurement can settle, such as yield after rye with your growers' termination dates, becomes a next experiment for a goal or hill-climb campaign. A goal campaign whose kit calibrates your crop model to the trials the run listed, with some sites held out, can [start from them](../../how-to/campaigns/use-past-research.md); the calibrated model then serves a hill climb such as [Irrigation and fertiliser planning](crop-management.md).

### 2. Nitrogen rates for corn by region

A cooperative sets nitrogen recommendations for members in several states.

- **The questions:** Which guideline does each state's university publish for corn after soybean and after corn, by which method (MRTN, a yield goal or a model such as N-FACT), and from which trials, sites and years? What do trials report about the late-spring soil nitrate test and side-dressing, and how far do they move the rate?
- **What code checks:** a claim that gives an MRTN rate and its price ratio must quote a page that gives both. The calculator gives its rates in answer to a form, so they enter the corpus through pages that publish them, such as a state's guidelines.
- **What it feeds:** the split-nitrogen hill climb on [Irrigation and fertiliser planning](crop-management.md), started from a state's published rate, with the trials as calibration sites.

### 3. Products sold to supply nitrogen

Agronomists want to know what independent trials report for microbial products sold to supply corn with nitrogen. On-farm networks run such trials, and Nebraska's publishes a protocol for them. A claim whose quotes all come from one site, such as a maker's product page, is listed apart from claims with independent sources.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "rye-before-corn",
  "version": 1,
  "title": "Cereal rye before corn in the Corn Belt: yield, nitrogen and management",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "Published trial evidence on corn after a cereal rye cover crop in the US Corn Belt, by state, soil, drainage and rotation: yield, the management that limits a yield loss, nitrate losses and economics",
  "questions": [
    "In published Corn Belt trials, how does corn yield after a cereal rye cover crop compare with corn after no cover crop, by state, soil drainage and rotation, and on how many site-years does each figure rest?",
    "Which management do trials report as limiting a yield loss after rye: termination date relative to planting, nitrogen at planting, planter settings, or a legume or a mixture in place of rye, and under which conditions?",
    "What do trials and meta-analyses report about nitrate leaching or nitrate in tile drainage under a rye cover crop, by soil and drainage?",
    "What do published economic analyses report as the net cost or return of rye before corn, with which costs, payments and prices?"
  ],
  "rubrics": [
    "Give each yield comparison with its source, state, years, number of site-years, soil or drainage, rotation and whether it is a small-plot trial, a strip trial or a survey, and keep meta-analyses' averages apart from single trials.",
    "Name each practice with the trials that tested it, its effect on yield, and the conditions under which the effect was and was not seen.",
    "Give each leaching or drainage figure with its source, the measurement method, the soil and drainage, and the years.",
    "Give each net cost or return with its source, the year of its prices, and the costs and payments it includes."
  ],
  "hypotheses": [
    "Corn after cereal rye yields less than corn after no cover crop when the rye is terminated within a week of planting, and the difference shrinks with earlier termination.",
    "Extra nitrogen at planting does not fully offset a yield loss after rye."
  ],
  "seeds": [
    "https://pmc.ncbi.nlm.nih.gov/articles/PMC6851768/",
    "https://pmc.ncbi.nlm.nih.gov/articles/PMC9328130/",
    "https://www.sare.org/resources/cover-crop-economics/",
    "https://projects.sare.org/project-reports/onc15-002/",
    "https://practicalfarmers.org/resources/research-reports/winter-cereal-rye-cover-crop-effect-on-cash-crop-yield-4/",
    "https://iastatedigitalpress.com/farmreports/",
    "https://on-farm-research.unl.edu/research-results/"
  ],
  "lanes": { "count": 8 },
  "min_verified_claims": 300,
  "quality": { "min_independent_sources": 2 },
  "min_duration": "48h",
  "budget": { "llm_usd": 200 }
}
```

The rubrics are where the field's conditions go: an answer that gives a yield difference without its site-years, soil, rotation and kind of trial doesn't meet them. `min_verified_claims` holds the first review back until the run has 300 verified claims. `min_duration` is a floor, never a stop. With no `max_duration`, the run ends when the review panel finds every question answered or research stops adding; the model budget pauses it at $200, counted when the rig knows the model's prices. The run plans work for eight lanes; how many read at once is the rig's **Workers at a time** ([Contract](../../reference/contract.md#research), [Campaign modes](../../explanation/campaign-modes.md#research)).

## What to expect

- **Time and scale.** At least 48 hours of the agents' time; paused time doesn't count. The fetcher takes at most 6 pages a minute from one site by default (`fetch_policy.per_domain_per_minute`), so lanes spread across universities, networks and journals read faster than lanes on one site. After the minimum, the review panel is asked at each hourly digest.
- **Where the agents help most.** Volume and tracing: every report for each state and year, and each average followed to its trials.
- **Where people stay.** Choosing the practice, the region and the questions; judging which trials resemble your growers' fields; the recommendation itself, and next season's trials.

## What the checks guard against

The usual error is a number without its conditions: a yield difference quoted without the termination date, the nitrogen rate or the soil, or a press release's figure in place of the trial report's. A claim counts only when its quotes are found word for word in a page the rig archived, and its numbers in those quotes. What kind of evidence a figure is stays the rubrics' work, judged by the review panel: SARE's Cover Crop Economics is "Based primarily on yield and economic data gathered through five years of national cover crop surveys", not on replicated trials. A claim quoting at least two sites counts as independently sourced; claims resting on one site are listed apart. Findings, answer cards and the paper count only when the claims they cite are verified, so a trial no archived page reports can't be cited.

## Limits

- Many trial reports are PDFs: Iowa State's research farm reports, behind an abstract page, and the Nebraska network's results book and studies. The fetcher reads web pages, plain text, JSON and XML; a PDF is kept but gives no text to quote. PubMed Central's open-access articles, SARE's project reports and bulletins, Practical Farmers of Iowa's research reports and many extension articles are web pages.
- Unpublished trials, a company's or a grower's, are not on the web. Paywalled journals and pages behind a login are out of reach: the fetcher never signs in, and by default it respects `robots.txt`.
- A research run measures nothing. Yield on your growers' fields, or a crop model calibrated to the trials, is a next experiment for a goal or hill-climb campaign.
- Without a search server, the agents read only what the starting links lead to. Research workers can't run on a Claude subscription: use another model.
- A verified quote proves what a report says, not that its trial was well designed.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** seed and input companies, advisory services and cooperatives that need a source for every statement in a recommendation.
- **[Solo builders](../for/solo-builders.mdx):** independent crop consultants and researchers.
- **[Startups](../for/startups.mdx):** agtech teams whose advice or models rest on published trials.

## Related work

Abdalla and others' [review of cover crops](https://pmc.ncbi.nlm.nih.gov/articles/PMC6851768/) (2019) drew on "106 studies carried out at 372 sites"; [Nouri and others](https://pmc.ncbi.nlm.nih.gov/articles/PMC9328130/) (2022) pooled 41 articles on nitrate leaching, and [Rodriguez and others](https://pmc.ncbi.nlm.nih.gov/articles/PMC10709520/) (2023) 23 on hairy vetch before maize. The other quotes come from Practical Farmers of Iowa's [long-term rye trial](https://practicalfarmers.org/resources/research-reports/winter-cereal-rye-cover-crop-effect-on-cash-crop-yield-4/), an [Iowa State research farm report](https://iastatedigitalpress.com/farmreports/article/id/790) (Lundvall, Patel and Sawyer, 2017), the [Corn Nitrogen Rate Calculator](https://www.cornnratecalc.org/about) and SARE's [Cover Crop Economics](https://www.sare.org/resources/cover-crop-economics/). The [Nebraska On-Farm Research Network](https://cropwatch.unl.edu/on-farm-research/) "conducts 80 to 100 on-farm studies each year"; Iowa State's [N-FACT](https://stories.cals.iastate.edu/2025/05/new-tool-helps-find-goldilocks-nitrogen-level) draws on "hundreds of on-farm trials".

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Give the agents a search server](../../how-to/campaigns/give-agents-mcp-tools.md), set **Workers at a time** on **Edit rig**, and see what else a research campaign needs in [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md).
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign. When it ends, [start a goal or hill-climb campaign from its next experiments](../../how-to/campaigns/use-past-research.md).
