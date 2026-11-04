---
title: "Literature review"
description: "Use a Thermite research campaign to map what a whole field knows, from its reviews, papers and benchmarks on arXiv, PubMed Central and open-access journals, with every quote checked against an archived copy and the corpus kept for later campaigns."
type: use-case
useCase:
  mode: research
  personas: [solo-builders, enterprises]
  summary: "Agents read a field's reviews, papers and benchmarks and record claims with exact quotes. Code checks every quote and number against its archived page, and a review panel of models decides each question."
  measure: "Verified claims across a field · every quote and number found in its archived page · a panel of models, by majority"
sidebar:
  order: 3
---

Most research starts by finding out what a field already knows: a doctoral student mapping a new area, an R&D team checking what was tried before it funds a programme. Researchers search Google Scholar, Scopus, PubMed or OpenAlex, an open catalogue of scholarly works, follow references and citing papers, read preprints on arXiv, and keep what they read in a reference manager such as Zotero. The result is a narrative or scoping review, a thesis chapter or an internal report: which methods were tried, what each found and under which conditions, where results disagree, and what is still open. A systematic review makes the process formal, with a protocol, two people deciding independently whether each study is eligible, as the [Cochrane Handbook](https://www.cochrane.org/authors/handbooks-and-manuals/handbook/current/chapter-04) requires, and the 27-item checklist of the [PRISMA 2020 statement](https://doi.org/10.1136/bmj.n71); across 195 registered reviews of medical interventions, the mean time from registration to publication was 67.3 weeks, with five authors on average.

A field is larger than anyone's reading. On 3 November 2026, an OpenAlex search for "solid electrolyte" and "lithium metal" returned 23,712 works since 2015, 1,026 of them reviews. So maps are drawn from what one person had time to read, and figures are copied from reviews instead of the papers that measured them. Even benchmarks disagree: a 2020 benchmark of batch-effect correction for single-cell RNA-seq recommended Harmony, LIGER and Seurat 3, while a 2022 benchmark of atlas-level integration found that scANVI, Scanorama, scVI and scGen performed well. And a language model that drafts from memory invents sources: in one study, 55% of the citations GPT-3.5 gave, and 18% of those GPT-4 gave, were fabricated.

## Where Thermite fits

Each **lane**, a line of search with its own agent, takes one gap the run's plan finds in a question's answer card: a mechanism that only one review describes, a result no one has traced to the paper that first reported it, a remedy that later papers may contradict. The agents fetch each paper through the rig's archiving fetcher, which keeps every page as text, and record **claims** with exact quotes. Code checks each quote word for word against its archived page, and each number in the claim, such as a current density or a cycle count, against its quotes. A synthesizer keeps an answer card for each question, and a review panel of models decides each question and each of the team's hypotheses by majority, with any dissent kept. No agent can mark a question answered or end the run.

A doctoral student spends months on a field's literature; the run reads it on up to 16 lanes, with no limit unless you set one. For solid electrolytes, OpenAlex lists the 1,026 reviews in six pages of 200; the papers they cite for each mechanism and remedy are the next reading, then the papers that cite those. Nothing it reads is thrown away: the archived pages, every claim, finding and note, the answer cards and the paper stay in the run's research folder and in the campaign's collection in Thermite's knowledge base. Later runs' agents search that collection before they read again, and you can let another campaign read it, such as the hill climb that tests what the map found.

What you get is a map of the field: its methods, results, disagreements and open problems, each statement traced to the page that makes it, and a corpus later campaigns build on. It is not a systematic review, and it is not a table of reported values, which [Data from the literature](literature-data.md) builds.

## Example campaigns

### 1. Map a field before a programme starts

An R&D team is about to fund work on solid electrolytes for lithium-metal batteries, which replace the flammable liquid electrolyte with a solid, and needs the state of the field.

- **The questions:** four, in the contract below: the families of electrolytes studied with lithium metal; the failure mechanisms at the interface, such as lithium filaments growing through the electrolyte, and the evidence for each; the remedies tested, such as interlayers, coatings and stack pressure, and under what conditions; and which results a second research group reproduced or contradicted.
- **Starting links and scope:** OpenAlex's list of the 1,026 reviews, most cited first, and Europe PMC's open-access search, which returned 2,853 articles. The agents follow each review to the papers it cites, on publishers' open-access pages, arXiv's HTML pages and PubMed Central.
- **The team's hypotheses:** "Critical current densities reported for garnet electrolytes against lithium metal depend more on the interface treatment than on the electrolyte's bulk conductivity." The critical current density is the current density above which lithium filaments grow through the electrolyte and short the cell. "No remedy has been shown by two independent groups to last 1,000 cycles." The review panel gives each a verdict, supported, refuted or undecided, with the claims behind it.
- **What code checks:** every current density, capacity and cycle count in a claim must be in its quotes, so a figure traces to the paper that ran the cell, not to the review that repeated it.
- **What agents would do:** trace each mechanism and remedy from the reviews to the paper that first reported it; look for later papers that report the opposite under the same conditions; record the group behind each result.
- **What you get:** a research paper with numbered references, an answer card for each question, the review panel's decisions, and the corpus.
- **What it feeds:** what only a measurement can settle becomes the paper's next experiments, each for a hill climb or a goal campaign: a hill climb on the team's molecular dynamics simulations of lithium at a candidate interface, as in [Simulation speed and accuracy](simulations.md), or a goal campaign that reruns a paper's simulation from its released code, as in [Reproducing published results](reproduction.md). **Start a run** › **From past research** puts them in a new run's queue.

### 2. Compare what the benchmarks found

A computational biology group must choose a method to correct batch effects in single-cell RNA-seq data, the differences between samples processed apart that are not biology, and the published benchmarks rank the methods differently.

- **The questions:** Which methods did each benchmark compare, on which datasets, with which metrics and which versions? Where do the benchmarks agree and disagree? Which failure modes do they report, such as over-correction that merges distinct cell types? Which later papers contest a ranking?
- **Starting links:** the two benchmarks' full texts at PubMed Central, and an OpenAlex search for the benchmarks that followed.
- **The team's hypotheses:** "No single method ranks first in every published benchmark."
- **What it feeds:** a hill climb on the group's own integration pipeline, scored with the metrics of scib, the 2022 benchmark's Python module, on a batch of the group's data the agents never see.

### 3. Keep the map current

A year on, a new version of the contract adds the question "What has been published since the last run?" and starts a new run. Its agents search the earlier run's claims in the campaign's collection, then fetch and archive again what they cite, so a result reproduced, contradicted or retracted since shows up.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "solid-electrolyte-map",
  "version": 1,
  "title": "Solid electrolytes for lithium-metal batteries: what the field knows",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "Solid electrolytes paired with lithium-metal anodes since 2015: the families studied, the failure mechanisms at the interface and the evidence for each, the remedies tested and under what conditions, and which results other groups reproduced",
  "questions": [
    "Which families of solid electrolytes have papers paired with lithium-metal anodes since 2015, and what do the papers give as each family's main strengths and problems?",
    "Which failure mechanisms at the interface with lithium metal do papers report, and with what evidence: imaging, electrochemistry or simulation?",
    "Which remedies have papers tested, and at what current density, capacity and number of cycles?",
    "Which of these results has a second research group reproduced or contradicted, and which rest on one group's papers?"
  ],
  "rubrics": [
    "Name each family with representative compositions and the strengths and problems its papers report, each from a paper, not only from a review.",
    "Name each mechanism with the papers that report it and the kind of evidence each gives.",
    "Give each remedy with its test conditions as the paper states them: current density, areal capacity, cycles and temperature.",
    "For each result in the other answers, name the group that reported it and every other group's paper that reproduced or contradicted it, or say that none did."
  ],
  "hypotheses": [
    "Critical current densities reported for garnet electrolytes against lithium metal depend more on the interface treatment than on the electrolyte's bulk conductivity.",
    "No remedy has been shown by two independent groups to last 1,000 cycles."
  ],
  "seeds": [
    "https://api.openalex.org/works?search=%22solid+electrolyte%22+%22lithium+metal%22&filter=type:review,publication_year:2015-2026&sort=cited_by_count:desc&select=id,doi,display_name,publication_year,cited_by_count,is_retracted,best_oa_location&per-page=200",
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=%22solid+electrolyte%22+AND+%22lithium+metal%22+AND+OPEN_ACCESS%3Ay&resultType=core&format=json&pageSize=100"
  ],
  "lanes": { "count": 10 },
  "min_verified_claims": 400,
  "quality": { "min_independent_sources": 2 },
  "fetch_policy": { "per_domain_per_minute": 4 },
  "min_duration": "24h",
  "budget": { "llm_usd": 200 }
}
```

OpenAlex's seed asks for only the fields the agents need, so the page stays under the fetcher's limit of 5,000,000 bytes; Europe PMC's gives abstracts as JSON. There is no `scope.include_domains`, because a field's papers sit on many publishers' sites. `fetch_policy.per_domain_per_minute` is 4, because arXiv's `robots.txt` sets a crawl delay of 15 seconds. `min_verified_claims` holds the first review back until the run has 400 verified claims, and `min_duration` is a floor, never a stop. With no `max_duration`, the run ends when the review panel finds every question at an end or research stops adding; the model budget pauses it at $200, counted when the rig knows the model's prices. How many of the ten lanes read at once is the rig's **Workers at a time** ([Contract](../../reference/contract.md#research), [Campaign modes](../../explanation/campaign-modes.md#research)).

## What to expect

- **Time and scale.** The run reads for at least 24 hours of the agents' time, paused time aside. Papers come from many sites, so the limit for one site rarely sets the pace. After the minimum, the review panel is asked at each hourly digest, and the progress rule ends the run when every open question has stopped adding claims from new sites and nothing has improved for a quarter of its running time.
- **Where the agents help most.** Breadth and tracing: every review, each result followed to the paper that reported it, and the papers that disagree.
- **Where people stay.** Choosing the questions and the rubrics, judging each study's quality, reading the papers behind the claims a programme rests on, and the decision to fund it.

## What the checks guard against

A figure copied from a review reads like one from the paper that measured it, and a fabricated citation looks like a real one. Here a claim counts only when every quote is found word for word in an archived page and every number in its quotes. Each claim names its page, so a figure taken from a review keeps the review's address until a lane traces it. Code counts sites, not research groups: two papers by one group in two journals count as two sites, so the fourth question asks for each result's group, and the review panel judges it against the rubric. A retracted paper's words still match; OpenAlex marks retracted works (`is_retracted`), and Crossref's API carries the Retraction Watch database, so a rubric can require the check. Findings, answer cards, the review panel's answers and the paper count only when the claims they cite are verified and their numbers come from those claims.

## Limits

- Much of a field's literature is behind subscriptions, and the fetcher never signs in. It respects `robots.txt` by default, and Elsevier's ScienceDirect keeps robots off its whole site.
- OpenAlex gives an abstract as an index of its words, not as running text, so a claim can't quote it: the agents quote the paper's own page, Europe PMC's record or arXiv's abstract page instead.
- arXiv's API server and its search refuse robots, so the agents find arXiv papers through OpenAlex and read arXiv's abstract and HTML pages. Not every paper has an HTML version.
- The fetcher reads web pages, plain text, JSON and XML. A PDF is kept but gives no text to quote.
- OpenAlex counts each request against a daily budget, which a free key raises. The fetcher sends no key, so paging through thousands of results can use up a day's allowance.
- A verified quote proves what a paper says, not that it is right. A research run measures nothing: a result to check on your own system is a next experiment for a hill climb or a goal campaign.
- Without a search server, the agents read only what the starting links lead to. Research workers can't run on a Claude subscription: use another model.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** doctoral students and independent researchers mapping a new field, with a source for every statement.
- **[Enterprises](../for/enterprises.mdx):** R&D teams that must show where every statement came from before they fund a programme, on your own machines with a model you choose.

## Related work

Walters and Wilder found that 55% of the citations GPT-3.5 gave, and 18% of those GPT-4 gave, were fabricated ([the paper](https://doi.org/10.1038/s41598-023-41032-5)). Kosmos, an AI scientist, reads "1,500 papers per run"; experts rated 79.4% of 102 statements from its reports accurate, and 57.9% of its synthesis statements ([the paper](https://arxiv.org/abs/2511.02824)). Tran and others concluded that "Harmony, LIGER, and Seurat 3 are the recommended methods for batch integration" ([Genome Biology, 2020](https://doi.org/10.1186/s13059-019-1850-9)); Luecken and others, across 68 method and preprocessing combinations, that "scANVI, Scanorama, scVI and scGen perform well, particularly on complex integration tasks" ([Nature Methods, 2022](https://doi.org/10.1038/s41592-021-01336-8)). Crossref "acquired the Retraction Watch database from the Center of Scientific Integrity" in September 2023 and made it public ([Crossref](https://www.crossref.org/documentation/retrieve-metadata/retraction-watch/)). Borah and others found that "the mean estimated time to complete the project and publish the review was 67.3 weeks" ([BMJ Open, 2017](https://doi.org/10.1136/bmjopen-2016-012545)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Give the agents a search server](../../how-to/campaigns/give-agents-mcp-tools.md), set **Workers at a time** on **Edit rig**, and see what else a research campaign needs in [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md).
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign. When it ends, [start a hill climb or goal campaign from its next experiments](../../how-to/campaigns/use-past-research.md).
