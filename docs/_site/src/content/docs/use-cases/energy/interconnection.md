---
title: "Interconnection and market rules"
description: "Use a Thermite research campaign to learn how interconnection works after FERC Order No. 2023 in each US grid region where you might build, from the orders, the grid operators' pages, queue data and state rules, with each claim checked against its archived page."
type: use-case
useCase:
  mode: research
  personas: [startups, enterprises]
  summary: "Agents read FERC's orders, each grid operator's interconnection pages, queue data and state rules. Code checks each quote and number against its archived page, and a panel of models decides each question."
  measure: "Verified claims, region by region · each quote and number found in its archived page · a panel of models, question by question"
sidebar:
  order: 2
---

A solar or storage plant can't be built until its grid operator has studied the connection. In the seven US regions run by an independent system operator or regional transmission organization (ISO/RTO), CAISO, ERCOT, ISO-NE, MISO, NYISO, PJM and SPP, a developer files an interconnection request, joins a study cluster, posts deposits, shows it controls the site, and waits for studies that assign the network upgrades it must pay for. Development teams, consultants and regulatory lawyers learn each region's rules from FERC's orders and the ISO's tariff, manuals, filings and queue reports. ERCOT, overseen by the Public Utility Commission of Texas, follows its own Planning Guide, and a plant on a distribution system follows state rules. Berkeley Lab's Queued Up report shows what is at stake: "Only 13% of capacity that submitted interconnection requests from 2000-2020 had reached commercial operations by the end of 2025", and the median time from request to commercial operation "was over 5 years for projects built in 2025".

FERC's Order No. 2023, issued in July 2023 and in effect from 6 November 2023, replaced the first-come, first-served serial studies of its pro forma procedures with a "first-ready, first-served cluster study process". The procedures set study deposits by size, from $35,000 plus $1,000 per MW up to $250,000 for requests of 200 MW or more, 90% site control at the request, a commercial readiness deposit, withdrawal penalties that rise from twice the study costs to 20% of network upgrade costs, and penalties on the transmission provider for late studies. Each ISO/RTO filed its own version, which FERC weighs against an "independent entity variation" standard, so the figures differ by region, and each has changes of its own under way, such as PJM's Transition Cycles 1 and 2 and MISO's queue cap. Mistakes come from the reading: a pro forma figure taken as a region's own, a manual that a later filing changed, a completion rate from an older edition.

## Where Thermite fits

Each **lane**, a line of search with its own agent, takes one gap the run's plan finds in a question's evidence: a deposit with no tariff section behind it, a timeline taken from a slide deck, a grid operator's manual that a later compliance filing may have changed. The agents fetch the orders, tariffs, queue data and commission pages through the rig's archiving fetcher, which keeps each as text, and record **claims** with exact quotes: a deposit, a deadline in days, a withdrawal penalty, each with the section that sets it. Code checks every quote word for word against its archived page and every number in the claim against its quotes, and the quote shows a reviewer whether a figure is the rule in force or a deletion in brackets in a redline. A synthesizer keeps an answer card for each question, a review panel of models decides each by majority, and no agent can end the run.

Start with the two orders: Order No. 2023 fills 336 pages of the Federal Register, and Order No. 2023-A, on rehearing, another 238. Then, for each of seven regions, its interconnection pages, manuals, queue reports and compliance filings, and the rules of each state where the developer holds land. That is days of reading, and the run takes them: up to 16 lanes, no limit unless you set one, and nothing it read thrown away: the archived pages, every claim, the findings and the answer cards stay in the run's research folder and in the campaign's collection in Thermite's knowledge base, where the next cycle's run searches them.

## Example campaigns

### 1. Interconnection rules in seven regions

A developer of solar plants with four-hour batteries is choosing where to file in the next cluster windows, and needs each region's rules and record side by side.

- **The questions:**
  - In each region, which process governs a new request today: its cycle, window, study phases and deadlines? What did its compliance filing change, and what did FERC accept? What does ERCOT require instead?
  - What must a solar or solar-plus-storage request pay and show to enter and stay in each queue, and when?
  - What does a project lose if it withdraws at each stage, and which withdrawals are exempt?
  - How does each region study storage and hybrid plants: charging assumptions, surplus interconnection service, storage added to a queued request?
  - What do Berkeley Lab's data and each region's own reports show about how many requests reach commercial operation, and how long they take?
- **Starting links and scope:** the texts of both orders on govinfo.gov, each ISO/RTO's interconnection page, MISO's queue as JSON, and the page of ERCOT's Planning Guide. The agents follow links from there, and search the web through a search server the campaign gives them.
- **The team's hypotheses:** "Since Order No. 2023, every ISO/RTO but ERCOT studies new requests in clusters, with withdrawal penalties that rise at each later stage." "Projects in ERCOT reach commercial operation sooner after their request than projects in any other region." The review panel gives each a verdict, supported, refuted or undecided, with the claims behind it.
- **What code checks:** every deposit, percentage, deadline and date in a claim must be in its quotes. A "150 days" in the paper traces to the text that sets it, which in Order No. 2023's pro forma reads "within one hundred fifty (150) Calendar Days of the close of the Customer Engagement Window".
- **What agents would do:** read the pro forma procedures section by section and find each region's version of each; trace each figure in a slide deck or a law firm's alert to the tariff, filing or order behind it; look for later filings that changed a manual.
- **What you get:** a research paper with numbered references, an answer card for each question with its certainty, the review panel's decisions with any dissent, and the corpus.
- **What it feeds:** next experiments, each for a goal or a hill-climb campaign. A hill climb can tune the plant's battery dispatch on a year of the region's prices, within the charging limits its request would state, as the battery campaign on [Building energy control](buildings.md) tunes a neighbourhood's. A goal campaign can check the team's queue-analysis scripts, which must match Berkeley Lab's published completion rates within a tolerance the team sets.

### 2. State rules for community solar

A developer builds community solar plants of a few megawatts in California and New York. It asks which projects interconnect under California's Rule 21 and which under a utility's Wholesale Distribution Access Tariff; the study tracks, timelines and costs under Rule 21 and New York's Standardized Interconnection Requirements, for systems of 5 MW or less; and what the CPUC's rulemaking R.25-08-004, opened on 20 August 2025, has decided. The agents start from the commissions' pages on Rule 21 and on distributed generation, and follow each decision from there.

### 3. Keep the answers current

Before each cluster window, a new contract version adds "What has changed since the last run?" and starts a new run. Its agents search the earlier claims in the campaign's collection, then fetch again what they cite, so a tariff revision or a new order shows up.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "interconnection-rules",
  "version": 1,
  "title": "Interconnection rules and queue outcomes in seven US grid regions",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "How a solar or solar-plus-storage plant interconnects in CAISO, ERCOT, ISO-NE, MISO, NYISO, PJM and SPP after FERC Order No. 2023",
  "questions": [
    "In each of CAISO, ISO-NE, MISO, NYISO, PJM and SPP, which process governs a new interconnection request today: its cycle, its request window, its study phases and their deadlines? What did its Order No. 2023 compliance filing change, and what did FERC accept? What does ERCOT's Planning Guide require instead?",
    "What must a solar or solar-plus-storage request pay and show to enter and stay in each region's queue: fees, study deposits, site control, readiness deposits or milestones, and when each is due?",
    "In each region, what does a project lose if it withdraws, or is withdrawn, at each stage, and which withdrawals are exempt?",
    "How does each region study storage and hybrid plants: operating assumptions for charging, surplus interconnection service, and storage added to a request already in the queue?",
    "What do Berkeley Lab's Queued Up data and each region's own reports show about the share of requests that reach commercial operation, and how long they take, by region and technology?"
  ],
  "rubrics": [
    "For each region, the process, its current cycle, each window, phase and deadline, and what the compliance filing changed and FERC accepted, each with its tariff section, filing or order.",
    "For each region, each fee, deposit and requirement with its amount, when it is due and its source, the pro forma's figures kept apart from the region's.",
    "For each region, the penalty at each stage and the exemptions, each with its source.",
    "For each region, how charging is studied and whether surplus interconnection service and added storage are allowed, each with its source.",
    "Each completion rate and duration with its source, its edition, its region and technology, and the years of request it covers."
  ],
  "hypotheses": [
    "Since Order No. 2023, every ISO/RTO but ERCOT studies new requests in clusters, with withdrawal penalties that rise at each later stage.",
    "Projects in ERCOT reach commercial operation sooner after their interconnection request than projects in any other region."
  ],
  "seeds": [
    "https://www.govinfo.gov/content/pkg/FR-2023-09-06/html/2023-16628.htm",
    "https://www.govinfo.gov/content/pkg/FR-2024-04-16/html/2024-06563.htm",
    "https://www.caiso.com/generation-transmission/generation/generator-interconnection",
    "https://www.iso-ne.com/system-planning/interconnection-service",
    "https://www.misoenergy.org/planning/resource-utilization/GI_Queue/",
    "https://www.misoenergy.org/api/giqueue/getprojects",
    "https://www.nyiso.com/interconnections",
    "https://www.pjm.com/planning/service-requests",
    "https://www.spp.org/engineering/generator-interconnection/",
    "https://www.ercot.com/mktrules/guides/planning/current"
  ],
  "lanes": { "count": 12 },
  "min_verified_claims": 500,
  "quality": { "min_independent_sources": 2 },
  "fetch_policy": { "max_bytes": 8000000 },
  "min_duration": "48h",
  "max_duration": "120h",
  "budget": { "llm_usd": 250 }
}
```

The questions name the regions, so the plan gives each its tasks, and the rubrics ask for each region's own source. The starting links are pages the fetcher can read, MISO's whole queue among them as one JSON file of about 2.4 MB. `fetch_policy.max_bytes` is raised because the Federal Register's own copy of Order No. 2023 is just over the default of 5,000,000 bytes. `min_verified_claims` holds the first review back until 500 claims are verified. `min_duration` is a floor, never a stop; `max_duration` ends the run after 120 hours of running time, and the model budget pauses it at $250 ([Contract](../../reference/contract.md#research), [Campaign modes](../../explanation/campaign-modes.md#research)).

## What to expect

- **Time and scale.** The run reads for at least 48 hours of the agents' time. The fetcher takes at most 6 pages a minute from one site by default, so lanes spread across seven grid operators read faster than lanes on one. After the minimum, the review panel is asked at each hourly digest. How many of the 12 lanes read at once is the rig's **Workers at a time**.
- **Where the agents help most.** Volume and tracing: each region's version of each pro forma section, and each figure in a summary followed to the order or tariff that sets it.
- **Where people stay.** Choosing the regions and the questions; reading the claims a filing decision rests on; legal advice; meetings with the grid operator; and studies of your own sites.

## What the checks guard against

A deposit, a deadline or a penalty reads the same whether it is the region's or the pro forma's. Here a claim counts only when its quotes are found word for word in a page the rig archived, and its numbers in those quotes, so each figure traces to the page that says it, and the rubric asks whether that page is the region's own. A claim quoted from two sites, such as the grid operator's page and govinfo.gov, counts as independently sourced; the report lists claims resting on one site, such as a law firm's alert, apart. Answer cards and the paper count only when the claims they cite are verified, and the report flags every number found in no archived source, such as a completion rate remembered from an older edition.

## Limits

- Much of the record is in PDF, Word or Excel files, kept with no text to quote: PJM's study statistics and the CPUC's decisions are PDFs, CAISO's queue reports are Excel workbooks, and ERCOT's Planning Guide is in Word files. FERC's eLibrary, which holds the compliance filings, is a JavaScript application that a plain fetch gets without content. Start from HTML, text or JSON: FERC's rules on govinfo.gov, the grid operators' pages, MISO's queue.
- The Federal Register's document pages answer automated clients with a page saying "programmatic access to these sites is limited to access to our extensive developer APIs", which no claim about an order can quote: use govinfo.gov or the Federal Register's API.
- ferc.gov and Berkeley Lab's sites refuse plain HTTP clients with a 403, and an error page is never archived, so Berkeley Lab's figures reach the run only through pages that quote them. Try your starting links in a short run first.
- In the orders' redlined pro forma, "Deletions are in brackets and additions are in italics", and plain text keeps no italics: the old $10,000 study deposit sits in brackets beside the new amounts, and a quote of it is still word for word.
- The fetcher never signs in, so paid queue databases are out of reach, and it respects `robots.txt` by default. A research run measures nothing: studies of your own sites are next experiments.
- Without a search server, the agents read only what the starting links lead to, and MISO's JSON has no links to follow. Research workers can't run on a Claude subscription: use another model.

## Who it's for

- **[Startups](../for/startups.mdx):** a development team of a few people choosing regions from more filings, manuals and queue data than it could read in a cycle.
- **[Enterprises](../for/enterprises.mdx):** independent power producers, utilities' development arms and consultancies that track every region each cycle, on their own machines with a model they choose.

## Related work

Berkeley Lab's [Queued Up: 2026 Edition](https://eta-publications.lbl.gov/publications/queued-2026-edition-characteristics), by Rand and others, found that "Only 13% of capacity that submitted interconnection requests from 2000-2020 had reached commercial operations by the end of 2025", and that "For the regions with available data, the median duration from IR to COD was over 5 years for projects built in 2025." FERC's [Order No. 2023](https://www.federalregister.gov/documents/2023/09/06/2023-16628/improvements-to-generator-interconnection-procedures-and-agreements) (88 FR 61014) and, on rehearing, [Order No. 2023-A](https://www.federalregister.gov/documents/2024/04/16/2024-06563/improvements-to-generator-interconnection-procedures-and-agreements) (89 FR 27006) set the pro forma procedures from which each region's compliance filing starts.

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Give the agents a search server](../../how-to/campaigns/give-agents-mcp-tools.md), set **Workers at a time** on **Edit rig**, and see what else a research campaign needs in [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md).
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign. When it ends, [start a goal or hill-climb campaign from its next experiments](../../how-to/campaigns/use-past-research.md).
