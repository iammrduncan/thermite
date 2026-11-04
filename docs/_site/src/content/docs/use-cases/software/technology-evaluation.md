---
title: "Technology evaluation"
description: "Use a Thermite research campaign to build the evidence for choosing a database, a framework or a vendor: every analysis, release note, issue thread and post-mortem the agents read, archived, with each claim checked against its page."
type: use-case
useCase:
  mode: research
  personas: [startups, enterprises]
  summary: "Agents read the analyses, release notes, issue threads and post-mortems on every option you're choosing between. Code checks each quote, and a review panel of models decides each question."
  measure: "Verified claims on every option · each quote and number found in its archived page · a panel of models, question by question"
sidebar:
  order: 3
---

Choosing a database, a message broker or a framework is a decision a team lives with for years. Engineers make it from the documentation, release notes, issue trackers, benchmark reports, licences and the public post-mortems of teams that ran the system in production. For a distributed database they also read Jepsen's analyses, which test whether a system keeps the consistency it claims through network partitions, crashes and clock faults. The result is usually a design document or an architecture decision record, written in a week or two from what one or two engineers had time to read.

Two things go wrong. The reading is shallow: the vendor's documentation and a few blog posts, not three years of release notes and issue threads, which is where the failure modes are. And facts go stale, or were never checked: an anomaly fixed two versions ago, a benchmark on other hardware, a licence that changed. In 2020, Jepsen found that serializable transactions on a single PostgreSQL 12.3 instance "were not, in fact, serializable". In 2024, Cockroach Labs retired CockroachDB Core, its free self-hosted edition. A decision document has to get both right, with the version and the date.

## Where Thermite fits

A research campaign gives the reading to agents and the checking to code. Each **lane**, a line of search with its own agent, gets a task that the run's plan sets from the gaps in each question's evidence: explore, find primary sources, look for contradictions, or consolidate. The agents fetch pages through the rig's archiving fetcher, which keeps every page it reads as text, and record **claims** with exact quotes. Code verifies each claim: every quote must appear word for word in its archived page, and every number in the claim must appear in its quotes. A synthesizer keeps an answer card for each question, and a review panel of models decides each question by majority. No agent can mark a question answered or end the run.

The scale is what sets it apart from a deep research tool. Google describes a typical Gemini Deep Research task as "many model calls over several minutes". A Thermite research campaign has no time, turn or source limit unless you set one. It reads for at least its minimum duration, then until the review panel finds every question answered or research stops adding, with up to 16 lanes. For a choice between four databases, that is every Jepsen analysis of them, every release note since the versions you would run, and the issue threads behind each fix. Nothing it reads is thrown away. The archived pages, every claim (verified or draft), the findings, the hypotheses and the answer cards stay in the run's research folder and in the campaign's collection in Thermite's knowledge base, where later runs' agents search them.

## Example campaigns

### 1. A distributed SQL database for a multi-region ledger

A payments team needs a database for a ledger that takes writes in three regions. It has narrowed the choice to CockroachDB, YugabyteDB and TiDB, with a single-region PostgreSQL primary as the baseline.

- **The questions:**
  - For each candidate, which consistency anomalies have Jepsen, the vendor's documentation or its issue tracker reported, at which isolation level and in which versions, and is each fixed in the version we would run?
  - Which failure modes do public post-mortems and issue threads report for each candidate in production: clock skew, rebalancing, schema changes, upgrades, backup and restore?
  - What do the documentation and published benchmarks say about write latency across regions, and on what topology was each figure measured?
  - Under which licence is each candidate's current release, what has changed since 2023, and what does self-hosting cost a company of our size?
- **Starting links and scope:** Jepsen's analyses and each vendor's release notes. The agents follow links from there, and search the web through a search server the campaign gives them. `scope.include_domains` can keep them to the vendors', Jepsen's and GitHub's sites.
- **The team's hypotheses:** "Each candidate's strongest isolation level has had an anomaly, reported by Jepsen or the vendor, that a later release fixed." "Write latency across regions is set by the round trip between them, whichever candidate we choose." The review panel gives each a verdict, supported, refuted or undecided, with the claims behind it.
- **What code checks:** every version number, latency and price in a claim must be in its quotes, so "fixed in 23.1" in the paper traces to the release note that says so.
- **What agents would do:** trace each anomaly from Jepsen's analysis to the issue that fixed it and the release that shipped the fix; read each release note since; search the issue trackers for the failure modes the post-mortems name; look for benchmarks that contradict the vendor's own.
- **What you get:** a research paper with numbered references, an answer card for each question with its certainty, the review panel's decisions with any dissent, and the corpus: every page read, as text.
- **What it feeds:** what only a measurement can settle, such as the latency of your own transactions between your regions, goes into the paper's future work as next experiments, each for a goal or a hill-climb campaign. A goal campaign whose kit runs your workload and a consistency check against the two finalists can [start from them](../../how-to/campaigns/use-past-research.md).

### 2. What made other teams' retries fail

An SRE team is setting the retry, timeout and back-off rules for a service mesh, and wants to know how retries have made outages worse elsewhere.

- **The questions:** Which public post-mortems describe an outage that retries, timeouts or reconnects amplified? What set each one off, and what did the team change afterwards? Which of those changes did later post-mortems show held?
- **Starting links:** collected lists of public post-mortems, such as [Dan Luu's](https://github.com/danluu/post-mortems), and the engineering blogs they link to.
- **What agents would do:** read each post-mortem in the list, follow its links to the provider's own write-up, record the trigger and the fix with their quotes, and look for later incidents at the same company.
- **What you get:** a corpus of incidents, each cause and fix quoted from the team that wrote it up, grouped into findings that cite them.
- **What it feeds:** a hill climb on the team's own load test, with error rate as the number and the retry rules as what the agents change.

### 3. Keep the decision current

A year on, a new version of the contract adds one question, "What has changed since the last run?", and starts a new run. Its agents search the earlier run's claims in the campaign's collection, then fetch and archive again what they cite, so a fix or a licence change made since shows up.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "ledger-database",
  "version": 1,
  "title": "Choosing a distributed SQL database for a multi-region ledger",
  "mode": "research",
  "project": { "repo": "research" },
  "topic": "Consistency, failure modes, latency across regions and licensing of CockroachDB, YugabyteDB and TiDB, against a single-region PostgreSQL primary",
  "questions": [
    "For each candidate, which consistency anomalies have Jepsen, the vendor's documentation or its issue tracker reported, at which isolation level and in which versions, and is each fixed in the current release?",
    "Which failure modes do public post-mortems and issue threads report for each candidate in production: clock skew, rebalancing, schema changes, upgrades, backup and restore?",
    "What do the documentation and published benchmarks say about write latency across regions, and on what topology was each figure measured?",
    "Under which licence is each candidate's current release, what has changed since 2023, and what does self-hosting cost?"
  ],
  "rubrics": [
    "For each candidate, list each reported anomaly with its source, the isolation level, the versions affected and the release that fixed it, or say that no fix is reported.",
    "Name each failure mode with the post-mortem or issue that reports it, and the candidate and version.",
    "Give each latency figure with its source, its topology and its workload, and keep the vendors' figures apart from third parties'.",
    "Give each candidate's licence with its date and source, each change since 2023, and its price terms where published."
  ],
  "hypotheses": [
    "Each candidate's strongest isolation level has had an anomaly, reported by Jepsen or the vendor, that a later release fixed.",
    "Write latency across regions is set by the round trip between them, whichever candidate is chosen."
  ],
  "seeds": [
    "https://jepsen.io/analyses",
    "https://www.cockroachlabs.com/docs/releases/",
    "https://docs.yugabyte.com/preview/releases/ybdb-releases/",
    "https://docs.pingcap.com/releases/tidb-self-managed/"
  ],
  "lanes": { "count": 8 },
  "min_verified_claims": 300,
  "quality": { "min_independent_sources": 2 },
  "min_duration": "24h",
  "budget": { "llm_usd": 150 }
}
```

A research campaign has no kit and no judge's clock. The contract holds the topic, the questions, a rubric for each (what the review panel requires of its answer), the team's hypotheses and the starting links. `min_verified_claims` holds the first review back until the run has 300 verified claims. `min_duration` is a floor, never a stop. There is no `max_duration`, so the run ends when the review panel finds every question answered or research stops adding; the model budget pauses it if it reaches $150 first, counted when the rig knows the model's prices. The run plans work for eight lanes; how many read at the same time is the rig's **Workers at a time** ([Contract](../../reference/contract.md#research), [Campaign modes](../../explanation/campaign-modes.md#research)).

## What to expect

- **Time and scale.** The run reads for at least 24 hours of the agents' time; time paused, or with the model provider refusing calls, doesn't count. The fetcher takes at most 6 pages a minute from one site by default (`fetch_policy.per_domain_per_minute`), so lanes spread across many sites read faster than lanes on one. After the minimum, the review panel is asked at each hourly digest, once every question has an answer card. The progress rule ends the run when every open question has stopped adding claims from new sites and nothing has improved for a quarter of its running time.
- **Where the agents help most.** Volume and tracing: every release note and issue thread, each figure followed to the page that first reported it, and the pages that contradict a vendor.
- **Where people stay.** Choosing the candidates, the questions and the rubrics; reading the claims the decision rests on; the decision itself, and a trial on your own workload.

## What the checks guard against

A wrong version number or an invented benchmark reads exactly like a real one. Here a claim counts only when its quotes are found word for word in a page the rig archived, and its numbers in those quotes. A claim whose quotes come from at least two different sites counts as independently sourced, and the report lists claims resting on one site, such as a vendor's own benchmark, apart. Findings, answer cards, the review panel's answers and the paper count only when the claims they cite are verified, and their numbers come from those claims. The report flags every number in a section that appears in no archived source and no verified claim.

## Limits

- The fetcher reads web pages, plain text, JSON and XML. A PDF is kept but gives no text to quote, so a vendor's white paper in PDF can't support a claim. Pages behind a login or a paywall, such as analysts' reports, are out of reach: the fetcher never signs in, and by default it respects `robots.txt`.
- A research run measures nothing. The latency of your own workload, or a consistency test on your own cluster, is a next experiment for a goal or hill-climb campaign.
- Without a search server, the agents read only what the starting links lead to. Research workers can't run on a Claude subscription: use another model.
- A verified quote proves what a page says, not that it is right. A vendor's benchmark is still the vendor's.

## Who it's for

- **[Startups](../for/startups.mdx):** a stack chosen once, early, from more reading than a small team can do.
- **[Enterprises](../for/enterprises.mdx):** architecture reviews that need a source for every statement, run on your own machines with a model you choose.

## Related work

Jepsen's [analysis of PostgreSQL 12.3](https://jepsen.io/analyses/postgresql-12.3) (2020) found that "transactions executed with serializable isolation on a single PostgreSQL instance were not, in fact, serializable", with a patch "scheduled for the next minor release". Cockroach Labs [announced](https://www.cockroachlabs.com/blog/enterprise-license-announcement/) in August 2024 that it was "retiring our Core offering", with CockroachDB Enterprise free for "businesses under $10M in annual revenues". Google's page on [Gemini Deep Research](https://gemini.google/overview/deep-research/) says that "A typical Deep Research task involves many model calls over several minutes."

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Give the agents a search server](../../how-to/campaigns/give-agents-mcp-tools.md), set **Workers at a time** on **Edit rig**, and see what else a research campaign needs in [Choose a campaign mode](../../how-to/campaigns/choose-a-mode.md).
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign. When it ends, [start a goal campaign from its next experiments](../../how-to/campaigns/use-past-research.md).
