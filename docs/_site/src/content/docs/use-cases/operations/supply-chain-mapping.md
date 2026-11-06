---
title: "Supply chain mapping"
description: "Use a Thermite research campaign to trace where your suppliers' inputs come from, below tier one, with every statement about a company quoted from an archived public page and checked by code, and the conclusions left to your team."
type: use-case
useCase:
  mode: research
  personas: [enterprises, startups]
  summary: "Agents trace suppliers below tier one through official lists, notices and the companies' own disclosures. Code checks every quote, a panel of models decides each question, and your team judges each company."
  measure: "Quoted evidence for each supplier link · each quote and date found in its archived page · a panel of models, then your team"
sidebar:
  order: 3
---

Since 21 June 2022, US Customs and Border Protection (CBP) has presumed that goods made wholly or in part in Xinjiang, or by an entity on the UFLPA Entity List, are made with forced labour and may not enter the United States. CBP's FAQ says that "Goods containing any input from the XUAR or a company on the UFLPA Entity List are prohibited from entering U.S. commerce unless the importer can satisfy the exacting requirements of Section 3(b) of the UFLPA". So an importer's trade compliance team must know its suppliers' suppliers: the spinner behind the mill behind the garment factory. It works from supplier questionnaires and audits, the Entity List that DHS publishes for the Forced Labor Enforcement Task Force, Federal Register notices, CBP's guidance and suppliers' own statements, such as those in the UK's modern slavery statement registry. For tin, tantalum, tungsten and gold it adds the Responsible Minerals Initiative's Conflict Minerals Reporting Template (CMRT) and companies' Form SD filings with the SEC. The EU's Forced Labour Regulation applies from 14 December 2027, and its due diligence directive, as amended, from 26 July 2029.

The work is done by hand, supplier by supplier, and starts again whenever a list changes. The Entity List's update of 29 October 2026 "adds three new entities", and its entries carry aliases, former names and, for some, "subordinate and affiliated entities"; every name in a supplier's disclosures must be checked against all of them. A supplier's statement is its own account: the UK registry says of each summary that "The organisation is responsible for all the information it provided." To overcome the presumption, an importer must show "by clear and convincing evidence" that its goods were not made with forced labour. Shallow checks fail here: a name matched loosely, a list read months ago, a summary taken for the notice, a link no source states.

## Where Thermite fits

The reading goes to agents, the checking to code and the conclusions to you. Each **lane**, a line of search with its own agent, takes one gap the run's plan finds in a question's evidence: a tier-two supplier with no named source for its inputs, an entity on the list whose affiliates no one has looked for, a supplier's statement that no other site confirms. The agents fetch the entity lists, Federal Register notices, customs guidance and suppliers' own statements through the rig's archiving fetcher, which keeps each as text, and record **claims** with exact quotes. Code checks every quote word for word against its archived page and every number in the claim, dates included, against its quotes, so the date an entity joined a list is the date its notice gives. A synthesizer keeps an answer card for each question, and a review panel of models decides each by majority. No agent can close a question or end the run, and what a supplier has done is for your team to decide.

A compliance team samples; the run can read everything, on up to 16 lanes with no limit unless you set one. For the 120 garment suppliers in the first example below, three years of published statements come to at most 360 documents, before the mills and spinners they name and every notice that changed the Entity List. The archived pages, claims, findings and answer cards stay in the run's research folder and in the campaign's collection in Thermite's knowledge base, where later runs' agents search them.

## Example campaigns

### 1. Cotton in an apparel importer's garments

An apparel importer buys from 120 garment factories, and must know where the yarn, the fabric and the cotton in each product line come from.

- **The questions:** which spinners, mills and traders public sources name as each supplier's suppliers; whether a company at any tier, by any of its names, is on the Entity List or in a CBP Withhold Release Order or Finding; which reports name these companies in connection with cotton or labour from Xinjiang, and the companies' published responses; and what CBP and the EU require an importer to show.
- **Starting links:** the official pages in the contract below, and each supplier's own site. With a search server the agents also search the web.
- **The team's hypotheses:** "No garment supplier, under its own name or a listed alias, is on the UFLPA Entity List." "Most garment suppliers name no spinner or mill in public, so the tiers below rest on documents the team must request." The review panel gives each a verdict.
- **What code checks:** every quote is in its archived page, and every date and number in a claim is in its quotes, so an entry's effective date traces to the list itself.
- **What agents would do:** read each supplier's site and statements for the companies they name; check each name and alias against the Entity List; follow each match to the notice that added it; look for published responses, and for sources that contradict a supplier.
- **What you get:** for each supplier, the upstream companies public sources name, each link with its quotes and dates; each matching entry, in the list's words; the open gaps, such as a mill whose spinners no source names; a research paper; and the corpus. The team decides what each link means.
- **What it feeds:** next experiments for goal or hill-climb campaigns, such as how many of the run's matches the team's name-screening tool flags. A goal campaign whose kit runs that tool on name pairs the team checked by hand, some held back, can [start from them](../../how-to/campaigns/use-past-research.md).

### 2. The smelters behind an electronics maker's parts

An electronics maker's suppliers send CMRTs that list the smelters and refiners in their parts; the templates stay in the team's files. A research campaign asks what is public about each smelter: what the Responsible Minerals Initiative says of its assessment under the Responsible Minerals Assurance Process (RMAP), which other companies' Conflict Minerals Reports name it, and what the EU's Conflict Minerals Regulation, which has applied since 1 January 2021, requires of an importer. The Commission recognized RMAP's equivalence under the regulation on 16 October 2025.

### 3. Keep the map current

The notice of 29 October 2026 says that future revisions "may include additions, removals, or technical corrections". A new version of the contract each quarter adds one question, "What has changed since the last run?", and starts a new run. Its agents search the earlier run's claims in the campaign's collection, then fetch and archive again what they cite, so an added entry, a removal or a supplier's new statement shows up.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "cotton-tracing",
  "version": 1,
  "title": "Where our garment suppliers' yarn, fabric and cotton come from",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "The upstream suppliers of 120 garment factories, below tier one, and the public evidence on each against the UFLPA Entity List, CBP's guidance and the EU's Forced Labour Regulation",
  "questions": [
    "For each garment supplier, which spinners, fabric mills and cotton traders do public sources name as its suppliers, in which years, and in whose words?",
    "For each company named at any tier, does its name, a former name or an alias appear on the UFLPA Entity List or in a CBP Withhold Release Order or Finding, and what does the entry say?",
    "Which reports by governments, researchers or journalists name any of these companies in connection with cotton or labour from Xinjiang, what does each say, and has the company published a response?",
    "What do CBP's FAQs and guidance say an importer of cotton goods should be able to show, and what does the EU's Forced Labour Regulation require from 14 December 2027?"
  ],
  "rubrics": [
    "For each supplier, list each named upstream company with the quote that names it, its source, the source's date and whose words they are, and say where no public source names one.",
    "Quote each matching list entry with its effective date and the name or alias that matches; keep exact matches apart from similar names, and draw no conclusion beyond the entry.",
    "Give each report's own words with its author, date and source, and the company's published response where there is one; report what sources say, never a finding about a company.",
    "Quote each requirement with its source and date, the US and the EU apart, and name each source the run could read only as a summary of a PDF."
  ],
  "hypotheses": [
    "No garment supplier, under its own name or a listed alias, is on the UFLPA Entity List.",
    "Most garment suppliers name no spinner or mill in public, so the tiers below rest on documents the team must request."
  ],
  "seeds": [
    "https://www.dhs.gov/uflpa-entity-list",
    "https://www.cbp.gov/trade/forced-labor/UFLPA",
    "https://www.cbp.gov/trade/forced-labor/faqs-uflpa-enforcement",
    "https://www.federalregister.gov/api/v1/documents.json?conditions%5Bterm%5D=%22UFLPA+Entity+List%22&fields%5B%5D=title&fields%5B%5D=publication_date&fields%5B%5D=raw_text_url&order=newest",
    "https://single-market-economy.ec.europa.eu/single-market/goods/forced-labour-regulation/what-forced-labour-regulation-and-how-does-it-work_en",
    "https://modern-slavery-statement-registry.service.gov.uk/search"
  ],
  "lanes": { "count": 10 },
  "min_verified_claims": 400,
  "quality": { "min_independent_sources": 2 },
  "min_duration": "48h",
  "max_duration": "10d",
  "budget": { "llm_usd": 400 }
}
```

Add each supplier's own site to `seeds`. The rubrics carry the team's rule for wording: what each source says, with its author and date, and no conclusion about a company beyond the quotes. `min_verified_claims` holds the first review back until the run has 400 verified claims. With `quality.min_independent_sources` at 2, a claim whose quotes come from one site is listed apart, so a supplier's word about itself never counts as independent. `min_duration` is a floor, never a stop; `max_duration` closes the run after ten days of running time; the model budget pauses it at $400, counted when the rig knows the model's prices. How many of the ten lanes read at the same time is the rig's **Workers at a time** ([Contract](../../reference/contract.md#research), [Campaign modes](../../explanation/campaign-modes.md#research)).

## What to expect

- **Time and scale.** The run reads for at least 48 hours of the agents' time, and closes at ten days. The fetcher takes at most 6 pages a minute from one site by default, so lanes spread across suppliers' sites read faster than lanes on one government site. After the minimum, the review panel is asked at each hourly digest.
- **Where the agents help most.** Volume and tracing: every supplier's statements, every alias held against every entry, each entry followed to its notice, and the sources that contradict a supplier.
- **Where people stay.** Choosing the suppliers, the questions and the rubrics; confirming that a name is the same company, by its address or registration number; asking suppliers for documents; every conclusion about a company, and anything sent to CBP.

## What the checks guard against

Here a wrong statement about a company does more harm than a gap. A claim counts only when its quotes are found word for word in a page the rig archived, and its numbers in those quotes. So a link that no source states can't become a claim, and neither can a near match of names: the claim must quote the entry with the name that matches. A claim whose quotes all come from one site, such as the supplier's own, is listed apart. Findings, answer cards and the paper count only when the claims they cite are verified.

## Limits

- Much of the evidence is in PDFs: CBP's guidance for importers, the Task Force's UFLPA strategy and its updates, and many full statements in the UK registry. The fetcher reads web pages, plain text, JSON and XML; a PDF is archived with no text to quote.
- Some official sites turn automated readers away. The Federal Register's document pages do, though its API and plain-text copies answer. CBP shows its Withhold Release Orders and Findings as charts with no text. EUR-Lex answers with an empty page; the Commission's pages answer. EDGAR refuses tools that don't declare a company name and a contact address, which the rig's fetcher doesn't, so Form SD filings are out of reach.
- Questionnaires, audits, purchase records and commercial databases stay with the team: the fetcher never signs in or pays, and by default respects `robots.txt`.
- A quote must match its page word for word, so a claim from a page in Chinese quotes the Chinese; the claim's own text can translate it.
- A research run measures nothing: a laboratory test of a garment's fibre belongs to people, a test of your screening tool to a next experiment.
- Without a search server, the agents read only what the starting links lead to. Research workers can't run on a Claude subscription: use another model.
- A verified quote proves what a page says, not that it is true, and the same name is not always the same company.

## Who it's for

- **[Enterprises](../for/enterprises.mdx):** importers' trade compliance and responsible sourcing teams that need a source for every statement about a supplier, run on your own machines.
- **[Startups](../for/startups.mdx):** makers of due diligence and supply chain mapping products, for a corpus of public evidence with a source for every statement.

## Related work

DHS's [notice of 29 October 2026](https://www.federalregister.gov/documents/full_text/text/2026/10/29/2026-22094.txt) calls the Entity List "a consolidated register of the four lists required to be developed and maintained pursuant to the UFLPA". CBP's [FAQ on UFLPA enforcement](https://www.cbp.gov/trade/forced-labor/faqs-uflpa-enforcement) says that "CBP will consider laboratory test results as part of the total package of information submitted by an importer to document a supply chain."

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Give the agents a search server](../../how-to/campaigns/give-agents-mcp-tools.md), set **Workers at a time** on **Edit rig**, and see what else a research campaign needs in [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md).
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign. When it ends, [start a goal campaign from its next experiments](../../how-to/campaigns/use-past-research.md).
