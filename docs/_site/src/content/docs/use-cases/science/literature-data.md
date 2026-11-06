---
title: "Data from the literature"
description: "Use a Thermite research campaign to build a dataset of property values reported in thousands of papers, each value kept with the sentence or table row that reports it, its conditions and its units, quoted from an archived page."
type: use-case
useCase:
  mode: research
  personas: [solo-builders, startups, enterprises]
  summary: "Agents read open-access papers and record each reported value as a claim, quoted with its conditions. Code checks that every number is in the quotes, and a review panel of models decides each question."
  measure: "Values with their conditions and units · each number found in its quote from an archived page · a panel of models, by majority"
sidebar:
  order: 4
---

Materials and chemistry groups build datasets of reported values, such as device efficiencies, gas uptakes and catalyst activities, to see trends across a field and to train models. Most are built by hand. For the Perovskite Database Project, researchers went through every paper that the Web of Science found for "perovskite solar" up to February 2020, over 15,000, and extracted data for over 42,400 solar cells, in 5,000 to 10,000 hours of work ([Jacobsson and others, 2022](https://doi.org/10.1038/s41560-021-00941-3)). Text-mining toolkits such as ChemDataExtractor extract values with parsing rules instead: a battery database built with it from 229,061 papers, fetched through Elsevier's and the Royal Society of Chemistry's data-mining APIs, had a precision of 80.0% and a recall of 59.1% ([Huang and Cole, 2020](https://doi.org/10.1038/s41597-020-00602-2)).

A value without its conditions is not data. An efficiency needs the device stack, the active area, the scan direction and whether a test laboratory certified it. A stability result needs the test, its temperature, light and atmosphere, and its duration, which is why the field agreed reporting rules based on the ISOS protocols ([Khenkin and others, 2020](https://doi.org/10.1038/s41560-019-0529-5)). The errors are familiar: a digit typed wrong, the abstract's rounded value where the table has more digits, a unit converted twice, a review's summary table taken for the measurement. The Perovskite Database paper says it plainly: "All data contain errors. That is unavoidable."

## Where Thermite fits

Each **lane**, a line of search with its own agent, takes one gap the run's plan finds in a question's evidence: a composition with no stability figure yet, a value a review cites whose source paper no one has archived, two papers that report different efficiencies for the same cell. The agents fetch each paper through the rig's archiving fetcher, which keeps every page as text, and record each reported value as a **claim** with exact quotes. Code verifies each claim: every quote must appear word for word in its archived page, and every number in the claim in its quotes. An efficiency of 24.26% on a 0.09 cm² cell needs both numbers in what it quotes. A table's value is quoted as its row, which the archived page keeps as text, with the column headings as a second quote. A synthesizer keeps an answer card for each question, and a review panel of models decides each by majority. No agent can mark a question answered or end the run.

Building a dataset by hand takes a group months; the run can read for days, with up to 16 lanes and no time, turn or source limit unless you set one. On 3 November 2026, Europe PMC counted 1,309 open-access articles in PubMed Central from 2020 to 2025 with "perovskite solar" in the title: at the fetcher's default of 6 pages a minute from one site, about 3 hours 40 minutes of fetching to read each once. Nothing it reads is thrown away. The archived pages and every claim, with its quotes and source, stay in the run's research folder (`sources/`, `claims/`), which the run's export carries, and in the campaign's collection in Thermite's knowledge base. A later run of the campaign searches them first, and archives again any page it cites. A short script of your own turns `claims/` into the table, a row for each claim.

## Example campaigns

### 1. Perovskite solar cells since the database's cut-off

A group that models perovskite solar cells wants the device data published after February 2020, which the database leaves to authors to upload.

- **The questions:**
  - For each cell an article reports, what efficiency, open-circuit voltage, short-circuit current density and fill factor does it give, for which stack, active area, scan direction and light source, and is the efficiency certified?
  - For each cell with stability data, what test does the article report (dark storage, light soaking or operation at the maximum power point, say), for how long, and what T80, the time to lose 20% of the starting efficiency?
  - Where does an article give one cell two different values, such as in the abstract and in a table?
- **Starting links and scope:** a Europe PMC search that lists the 1,309 articles as JSON, 1,000 to a page, each with its PMCID, so the agents fetch each article at PubMed Central; the ISOS consensus statement and the Perovskite Database paper, for the field's terms.
- **The team's hypotheses:** "Most cells with stability data were tested in dark storage, not in operation under light." In the database to February 2020, 5,500 of the 7,400 entries with stability data were shelf life in the dark. "Where an article reports both scan directions, the reverse scan gives the higher efficiency for most cells." The review panel gives each a verdict: supported, refuted or undecided.
- **What code checks:** every efficiency, area, temperature and duration in a claim must be in its quotes.
- **What agents would do:** record a claim for each cell and property, in the form the brief sets; trace a value an introduction cites to the article that measured it; list the articles whose values are only in figures or PDFs.
- **What you get:** the claims for your table, an answer card for each question, the review panel's decisions, a research paper with numbered references, and the corpus.
- **What it feeds:** a hill climb on a model that predicts a cell's T80 from its stack and process, trained on the table and scored on the group's own unpublished cells, which the agents can't download. **Start a run** › **From past research** puts the run's next experiments in a new run's queue.

### 2. CO₂ uptake of metal–organic frameworks

A carbon-capture startup screening metal–organic frameworks (MOFs) asks what CO₂ uptake each paper reports for each framework, at what temperature and pressure, excess or total, and after what activation. The uptake, the temperature and the pressure must all be in the quotes. A value converted from mmol g⁻¹ to cm³ g⁻¹ is a number no quote holds, so a claim keeps the paper's unit and the startup's script converts it. The agents also find where groups measured one framework differently. The table feeds a hill climb on the startup's grand canonical Monte Carlo (GCMC) set-up, with the error against the reported uptakes as the number and frameworks the agents never see held out. [Simulation speed and accuracy](simulations.md) shows how a kit checks a simulation against reference values.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "perovskite-cells-2020-2025",
  "version": 1,
  "title": "Perovskite solar cell efficiencies and stabilities in open-access articles, 2020 to 2025",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "Device-level efficiency and stability data for metal-halide perovskite solar cells in open-access articles at PubMed Central from 2020 to 2025, each value with its conditions and units",
  "questions": [
    "For each cell an article reports, what efficiency, open-circuit voltage, short-circuit current density and fill factor does it give, for which stack, active area, scan direction and light source, and is the efficiency certified?",
    "For each cell with stability data, what test does the article report, under what temperature, light and atmosphere, for how long, and what T80 or share of the starting efficiency retained?",
    "Where does an article give one cell two different values, such as one in the abstract and another in a table, or one in its preprint?"
  ],
  "rubrics": [
    "Every article in the list has its cells' values recorded as claims, or is listed as giving no device data in text or tables; say how many give values only in figures or PDFs.",
    "Every stability result is recorded with its test, conditions, duration and T80 or retained share, and the card says which conditions articles most often leave out.",
    "Each pair of different values is given with both quotes and both places, and the card says which one the article's own table gives."
  ],
  "hypotheses": [
    "Most cells with stability data were tested in dark storage, not in operation under light.",
    "Where an article reports both scan directions, the reverse scan gives the higher efficiency for most cells."
  ],
  "additional_information": "## The form of a claim\nOne claim for each cell and property: the stack, the property, the value and unit as printed, the conditions (active area, scan direction, light source, certified or not) and the article's PMCID. Quote the sentence or the table row, and the table's column headings as a second quote.\n\n## Out of scope\nA review's summary table is not a measurement: trace each value in it to the article that measured it.",
  "seeds": [
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=TITLE%3A%22perovskite%20solar%22%20AND%20OPEN_ACCESS%3Ay%20AND%20IN_PMC%3Ay%20AND%20PUB_YEAR%3A%5B2020%20TO%202025%5D&format=json&pageSize=1000&resultType=lite",
    "https://www.nature.com/articles/s41560-019-0529-5",
    "https://www.nature.com/articles/s41560-021-00941-3",
    "https://www.perovskitedatabase.com/"
  ],
  "scope": { "include_domains": ["ebi.ac.uk", "ncbi.nlm.nih.gov", "arxiv.org", "nature.com", "perovskitedatabase.com"] },
  "lanes": { "count": 12 },
  "min_verified_claims": 3000,
  "quality": { "min_independent_sources": 2 },
  "min_duration": "48h",
  "max_duration": "7d",
  "budget": { "llm_usd": 400 }
}
```

The rubrics, what the review panel requires of each answer, ask for coverage: a question is answered when every article has its values recorded or is listed as giving none, and `insufficient`, the best the sources allow, is the right end where values sit only in figures or PDFs. `additional_information`, which every research worker's brief carries, sets the form of a claim, so the claims make one table. `min_verified_claims` holds the first review back until the run has 3,000 verified claims. A cell's values come from one article, so most claims rest on one site; the report lists apart those found on two, such as a preprint and its published version. `max_duration` ends the run at seven days of running time; the model budget pauses it at $400. How many of the 12 lanes read at once is the rig's **Workers at a time** ([Contract](../../reference/contract.md#research), [Campaign modes](../../explanation/campaign-modes.md#research)).

## What to expect

- **Time and scale.** The run reads for at least 48 hours of the agents' time; paused time doesn't count. PubMed Central's rate sets the pace: 360 pages an hour at the default `fetch_policy.per_domain_per_minute` of 6, which you raise only as far as the site's terms allow. After the minimum, the review panel is asked at each hourly digest.
- **Where the agents help most.** Volume and consistency: every table in every article, and the conditions beside each value.
- **Where people stay.** Choosing the scope and the form of a claim, checking a sample of claims against the articles, and the measurements in your own lab.

## What the checks guard against

A wrong digit in a dataset reads like a right one, and a model trained on it learns it. Here a value counts only when its quotes are found word for word in an archived page, and its numbers in those quotes, so a value typed wrong, rounded or converted stays a draft. Each claim names its page, so a value copied from a review carries the review's address until a lane traces it to the original article. The contradiction lanes compare each abstract with its tables. Findings, answer cards and the paper count only when the claims they cite are verified and their numbers come from those claims.

## Limits

- A value on a J–V curve or an isotherm plot can't be quoted: read it off by hand, with a tool such as WebPlotDigitizer, outside the run.
- The fetcher reads web pages, plain text, JSON and XML. A PDF is kept but gives no text to quote, so a value only in a supporting-information PDF can't be a claim. HTML full text is at PubMed Central, on arXiv's HTML pages (not every paper has one) and on publishers' pages for open-access articles, such as Nature's journals.
- The fetcher never signs in, so paywalled articles and publishers' data-mining APIs, which need a key, are out of reach. It respects `robots.txt` by default: arXiv's API server, `export.arxiv.org`, refuses all robots, so the agents read arXiv's listing and HTML pages instead.
- A research run measures nothing, and a verified quote proves what a paper says, not that its measurement is right: that is a question for your lab, or for a goal or hill-climb campaign.
- Without a search server, the agents read only what the starting links lead to. Research workers can't run on a Claude subscription: use another model.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** doctoral students and independent researchers who need a dataset for a thesis or a model, with a source for every value.
- **[Startups](../for/startups.mdx):** materials-informatics teams that need training data they can trace, value by value.
- **[Enterprises](../for/enterprises.mdx):** R&D groups in chemicals, energy and materials, on your own machines with a model you choose.

## Related work

The Perovskite Database Project's [site](https://www.perovskitedatabase.com/) says that for papers after February 2020, "the database relies on authors to upload their own data". ChemDataExtractor's authors measured F-scores from 86.8% to 93.4% on the kinds of data it extracts ([Swain and Cole, 2016](https://doi.org/10.1021/acs.jcim.6b00207)). The NIST/ARPA-E Database of Novel and Emerging Adsorbent Materials held 37,703 isotherms from 4,367 articles on 1 December 2023, from their tables or by "digitization of graphical isotherms" ([NIST](https://www.nist.gov/programs-projects/nist-data-resources-adsorption)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Give the agents a search server](../../how-to/campaigns/give-agents-mcp-tools.md), set **Workers at a time** on **Edit rig**, and see what else a research campaign needs in [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md).
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, with a brief that sets the form of a claim, and start the campaign. When it ends, [start a hill climb or goal campaign from its next experiments](../../how-to/campaigns/use-past-research.md).
