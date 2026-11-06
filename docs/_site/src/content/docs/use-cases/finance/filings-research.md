---
title: "Research from public filings"
description: "Use a Thermite research campaign to build a corpus of the figures banks report to the SEC and the FDIC, from their published JSON data, with every figure checked against an archived copy and kept for the campaigns that follow."
type: use-case
useCase:
  mode: research
  personas: [solo-builders, startups, enterprises]
  summary: "Agents read the figures banks file with the SEC and the FDIC, as JSON, and record each with exact quotes. Code checks every quote and number against the archived data, and a panel of models decides each question."
  measure: "Verified figures, bank by bank · each quote and number found in its archived data · a panel of models, by majority"
sidebar:
  order: 3
---

Bank analysts at funds, brokers and rating agencies, and banks' own finance teams comparing themselves with peers, work from two sets of public reports. A bank holding company files its 10-K and 10-Q with the SEC; each insured bank files a Call Report, its quarterly report of condition and income, and the FDIC publishes the figures. Both come as data: the SEC's `data.sec.gov` serves the XBRL-tagged figures of each 10-K and 10-Q as JSON, each with its period, form and filing, and the FDIC's BankFind Suite serves Call Report figures as JSON. Item 1406 of Regulation S-K asks a bank holding company for "the amount of uninsured deposits", and the FDIC publishes large banks' estimates from their Call Reports. Most analysts still copy figures into a spreadsheet a few banks at a time, or buy them from a data vendor.

Figures drift from their source. A holding company's deposits cover the whole group and its bank's one bank, the SEC's figures are in dollars and the FDIC's in thousands, and a value from the wrong quarter, or one a later filing changed, reads exactly like the right one. Disclosure in the filings' text is uneven: in December 2024, SEC staff asked one bank holding company to "revise future filings to disclose the total amount of uninsured deposits in accordance with Item 1406(e) of Regulation S-K." Nor did language models alone fix it: in FinanceBench (2023), GPT-4-Turbo with a retrieval system "incorrectly answered or refused to answer 81% of questions" about public companies' filings.

## Where Thermite fits

Each **lane**, a line of search with its own agent, takes one gap the run's plan finds in a question's evidence: a bank whose uninsured deposits are missing for a quarter, a holding company whose tagged deposits don't match its bank's Call Report, a ratio no answer card has a source for yet. The agents fetch the FDIC's and the SEC's JSON files through the rig's archiving fetcher, which keeps each as text, and record each figure as a **claim** that quotes the record it comes from, with its period, form and accession number. Code checks every quote word for word against the archived file, and every number in the claim against its quotes, so a figure rounded, converted from thousands or remembered stays a draft. A synthesizer keeps an answer card for each question, and a review panel of models decides each by majority, with any dissent kept. No agent closes a question or ends the run.

No analyst reads at this scale by hand, and the run has no time, turn or source limit unless you set one. The FDIC-insured banks with assets of $10 billion to $250 billion, 142 at June 30, 2026, over the 12 quarters of 2023 to 2025, is up to 1,704 quarterly Call Reports, beside the figures their holding companies tag in 10-Ks and 10-Qs. The archived data, every claim (verified or draft), the findings and the answer cards stay in the run's research folder and in the campaign's collection in Thermite's knowledge base, which later runs' agents search with `kb_search`.

## Example campaigns

### 1. Deposits and commercial real estate at 142 regional banks

A small fund that trades regional bank stocks wants each bank's deposits, deposit costs and commercial real estate loans, quarter by quarter from 2023 to 2025, as the bank and its holding company reported them.

- **The questions:** for each bank and quarter, its estimated uninsured and total deposits; its deposit interest expense and the FDIC's cost of funding earning assets; its loans secured by nonfarm nonresidential properties that are not owner-occupied (where office loans sit with retail, hotel and industrial ones), and the part no longer earning interest; and how its holding company's tagged deposits compare.
- **Starting links and scope:** the FDIC's list of the banks, each with its holding company; one bank's Call Report figures; three of the SEC's frames, each one figure for every filer at one period, with each filer's CIK (the SEC's number for it); one company-concept file, every value a company tagged for one figure, with the filing each came from; and Item 1406 as XML from govinfo. The agents build the other addresses from the same patterns. `scope.include_domains` keeps them to `sec.gov`, `fdic.gov` and `govinfo.gov`.
- **The team's hypotheses:** that a one-bank holding company's tagged deposits are within 5% of its bank's Call Report deposits each quarter, and that every bank's deposit interest expense rose in each quarter of 2023. The review panel gives each a verdict: supported, refuted or undecided.
- **What code checks:** every number in a claim must be in its quotes, so a claim gives each figure as the data write it. "M&T's 10-K for 2025 tags total deposits (us-gaap `Deposits`) of 166909000000 US dollars at 2025-12-31" verifies against the quote `{"end":"2025-12-31","val":166909000000,"accn":"0000036270-26-000010","fy":2025,"fp":"FY","form":"10-K","filed":"2026-02-18"}` from M&T's company-concept file. "$166.9 billion" would not, since 166.9 is in no quote. For the same reason, a share or a change worked out from two figures can't be a verified claim. A ratio the FDIC publishes, such as its cost of funding earning assets, can.
- **What agents would do:** match each bank to its holding company and CIK; build each bank's quarterly series; record each holding company's figure beside its bank's, with both quotes; find values a later filing changed, since a company-concept file keeps each filing's value for the same period.
- **What you get:** a research paper, an answer card for each question, the review panel's decisions with any dissent, and the corpus: every file read, as text, and every figure with its quote.
- **What it feeds:** the measurements a research run can't make. A hill climb such as [Trading strategy research](../finance/strategies.md) can test a signal built from the verified figures, such as uninsured deposits as a share of deposits, worked out by its kit, in walk-forward backtests. Date each SEC figure by its `filed` date and each Call Report figure by when it was published, or the backtest looks ahead. A goal campaign can check a program that pulls the same figures each quarter against the run's verified ones.

### 2. Every filer at once

A bank's finance team wants to see where it stands among every filer that tags a figure, not only its chosen peers. One frames file gives one figure for every filer at one period: time deposits at or above the FDIC insurance limit, for example, from 216 filers at the end of 2025. Three figures over 12 quarters is 36 files, whose values the agents record, each with its quote and filing.

### 3. Keep the corpus current

Each quarter, a new version of the contract adds the latest quarter and one question, "What changed since the last run?" Its agents search the earlier runs' claims in the campaign's collection, then archive the new data themselves: a claim quotes only pages its own run archived.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "regional-bank-figures",
  "version": 1,
  "title": "Deposits and commercial real estate at 142 regional banks, 2023 to 2025",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "Uninsured deposits, deposit costs and commercial real estate loans at the FDIC-insured banks with assets of $10 billion to $250 billion, and their holding companies' tagged figures, for the 12 quarters of 2023 to 2025, from the FDIC's Call Report data and the SEC's XBRL data",
  "questions": [
    "For each bank and quarter, what estimated uninsured deposits and total deposits does its Call Report give?",
    "For each bank and quarter, what deposit interest expense and cost of funding earning assets does the FDIC give, and what deposit interest expense does its holding company tag?",
    "For each bank and quarter, what loans secured by nonfarm nonresidential properties that are not owner-occupied does its Call Report give, and how much of them is nonaccrual?",
    "For each holding company and quarter, how do the deposits it tags in its 10-K or 10-Q compare with its bank's Call Report deposits?"
  ],
  "rubrics": [
    "Give each figure with its bank, its report date, its field and its unit, quoted from the FDIC's data.",
    "Give each figure with its bank or holding company, its period, its source and its unit, and keep the FDIC's figures apart from the SEC's.",
    "Give each figure with its bank, its report date, its field and its unit, and say where a bank reports none.",
    "Give both figures with their periods, units and sources, and the filing each SEC figure came from; leave out any number the sources do not give."
  ],
  "hypotheses": [
    "For a holding company with one bank, the deposits it tags in each 10-K or 10-Q are within 5% of its bank's Call Report deposits for the same quarter.",
    "Every bank in scope had a higher deposit interest expense in each quarter of 2023 than in the quarter before."
  ],
  "seeds": [
    "https://api.fdic.gov/banks/institutions?filters=ACTIVE%3A1%20AND%20ASSET%3A%5B10000000%20TO%20250000000%5D&fields=NAME%2CCERT%2CNAMEHCR%2CASSET%2CREPDTE&sort_by=ASSET&sort_order=DESC&limit=200",
    "https://api.fdic.gov/banks/financials?filters=CERT%3A17534%20AND%20REPDTE%3A%5B20230331%20TO%2020251231%5D&fields=CERT%2CNAME%2CREPDTE%2CDEP%2CDEPUNINS%2CEDEPDOMQ%2CINTEXPYQ%2CLNRENROT%2CNARENROT&sort_by=REPDTE&sort_order=ASC&limit=12",
    "https://data.sec.gov/api/xbrl/frames/us-gaap/Deposits/USD/CY2025Q4I.json",
    "https://data.sec.gov/api/xbrl/frames/us-gaap/InterestExpenseDeposits/USD/CY2025.json",
    "https://data.sec.gov/api/xbrl/frames/us-gaap/TimeDepositsAtOrAboveFDICInsuranceLimit/USD/CY2025Q4I.json",
    "https://data.sec.gov/api/xbrl/companyconcept/CIK0000036270/us-gaap/Deposits.json",
    "https://www.govinfo.gov/content/pkg/CFR-2025-title17-vol3/xml/CFR-2025-title17-vol3-sec229-1406.xml"
  ],
  "lanes": { "count": 8 },
  "min_verified_claims": 2000,
  "quality": { "min_independent_sources": 2 },
  "scope": { "include_domains": ["sec.gov", "fdic.gov", "govinfo.gov"] },
  "fetch_policy": { "per_domain_per_minute": 60, "max_bytes": 10000000 },
  "min_duration": "24h",
  "budget": { "llm_usd": 300 }
}
```

KeyBank's Call Report figures and M&T's company-concept file stand for every bank's and holding company's. The SEC's stated maximum for automated access is 10 requests a second, so `fetch_policy.per_domain_per_minute` is 60, far below it, for every site; further fetches wait, they are never refused. A company-facts file, every figure a large bank has tagged, can pass the default `max_bytes` of 5,000,000 (M&T's is about 6.1 MB), so the contract sets 10,000,000. `quality.min_independent_sources` is 2: a claim that quotes a holding company's tagged figure and its bank's Call Report comes from two sites, `sec.gov` and `fdic.gov`, and counts as independently sourced; a claim from one of them is listed apart. `min_verified_claims` holds the first review back until 2,000 claims are verified, and `min_duration` is a floor, never a stop. With no `max_duration`, the model budget pauses the run at $300, counted when the rig knows the model's prices ([Contract](../../reference/contract.md#research), [Campaign modes](../../explanation/campaign-modes.md#research)).

## What to expect

- **Time and scale.** The data come as a few hundred small files, one for each bank and one for each holding company and figure, so fetching takes minutes; the time goes to matching and recording. After 24 hours of the agents' time, the review panel is asked at each hourly digest, once every question has an answer card and 2,000 claims are verified. How many lanes read at once is the rig's **Workers at a time** on **Edit rig**.
- **Where the agents help most.** Matching banks to holding companies and CIKs, the same figures for every bank and quarter, each with its quote, and the values later filings changed.
- **Where people stay.** Choosing the banks, the questions and the rubrics; deciding what a difference between a holding company and its bank means; reading the claims a position rests on; every decision to trade.

## What the checks guard against

A figure from the wrong quarter, copied from a news story, or since changed by a later filing reads exactly like the right one. Here a claim counts only when its quotes are found word for word in data the rig archived, and every number in it is in those quotes, as the data write it, so a rounded or rescaled figure does not verify. Code checks the words, not their meaning: a claim that reads the FDIC's thousands as dollars still verifies, so the rubrics ask for each figure's unit, and the review panel judges each answer card against them. The report flags every number in a section that appears in no archived source and no verified claim.

## Limits

- EDGAR's filing pages (`www.sec.gov/Archives`) refuse Thermite's fetcher today. The SEC asks automated tools to declare a contact address in their User-Agent, and the fetcher sends a fixed one. So the text of 10-Ks and 10-Qs, such as how a bank describes its office loans, is out of reach; the structured data on `data.sec.gov` is not.
- The SEC's XBRL data hold only figures in standard taxonomies that apply to the whole filer: a figure broken out by loan class, or tagged with a filer's own element, is not in them. The Call Report has no separate line for office loans, and a holding company's figures cover more than its bank's, so a difference is not by itself an error. The frames place each filer's figures in the nearest calendar quarter, whatever its own quarter's end.
- The fetcher reads web pages, plain text, JSON and XML, never signs in, and respects `robots.txt` by default: vendors' data behind a subscription is out of reach.
- A research run measures nothing: a ratio, or a signal's returns, is a next experiment. Without a search server, the agents read only what the starting links lead to. Research workers can't run on a Claude subscription: use another model.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** independent analysts who want every figure traced to its source.
- **[Startups](../for/startups.mdx):** small funds whose research must show its sources to investors.
- **[Enterprises](../for/enterprises.mdx):** banks' finance and strategy teams comparing themselves with peers, and credit research teams, on their own machines with a model they choose.

## Related work

The SEC's [EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) "do not require any authentication or API keys to access", and its XBRL APIs hold facts that "Apply to the entire filing entity". Its page on [accessing EDGAR data](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data) gives the "Current max request rate: 10 requests/second". The [FDIC's API documentation](https://api.fdic.gov/banks/docs/) writes deposits of 50,000,000 dollars as "50000 thousands of dollars". [Item 1406(e)](https://www.ecfr.gov/current/title-17/chapter-II/part-229/subpart-229.1400/section-229.1406) is the rule SEC staff cited to [Stock Yards Bancorp](https://www.sec.gov/Archives/edgar/data/835324/000000000024013437/filename2.txt) on December 5, 2024. [FinanceBench](https://arxiv.org/abs/2311.11944) (Islam and others, 2023) tested 16 model configurations on questions drawn from 361 public filings.

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. Set **Workers at a time** on **Edit rig**, and see what else a research campaign needs in [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md). A [search server](../../how-to/campaigns/give-agents-mcp-tools.md) helps the agents find sources beyond the starting links.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign. When it ends, [start a hill climb or a goal campaign from its next experiments](../../how-to/campaigns/use-past-research.md).
