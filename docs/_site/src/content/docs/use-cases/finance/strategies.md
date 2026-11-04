---
title: "Trading strategy research"
description: "Use Thermite to improve an equity strategy in a backtest that charges costs and feeds data one day at a time, with recent years and another market withheld and every attempt recorded."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups]
  summary: "Agents change signals and portfolio construction. The judge backtests each version with costs, one day at a time, and tests wins on years and a market the agents never see."
  measure: "Growth at 10% volatility, after costs · limits and drawdown held · the latest years and another market"
sidebar:
  order: 1
---

Quantitative researchers at hedge funds, asset managers and trading firms look for signals that predict returns, in prices, fundamentals and alternative data. They combine the signals, turn them into positions with a risk model and constraints, and backtest the result: a simulation of past trading that charges commissions, the bid-ask spread and market impact. The data is licensed and point-in-time, with delisted stocks and each date's index members. Microsoft's open-source Qlib provides a backtester with costs and factor sets such as Alpha158; many firms run their own.

Most ideas fail, and a search that tries enough of them will find one that worked by chance. Researchers fit on earlier years and trade on later ones (a walk-forward test), keep a final period aside, and correct the best result for the number of trials behind it, with a deflated Sharpe ratio. Most backtests never report that count. Thermite gives the backtest, its costs and its data to a judge the agents can't reach, keeps the latest years and a second market out of the search, and records every attempt.

## Where Thermite fits

The agents change the strategy's code, each in its own copy: its signals, how it combines them and how it sizes positions. In the kit's backtest, a driver sends the strategy one trading day at a time and records its target positions before it sends the next day. The check fills those positions at the next day's prices, charges costs and applies your limits. The agents never see the data, the cost model or which periods are held out, and learn only the judge's verdict and its reasons. They test their code on a synthetic sample in the project.

## Example campaigns

### 1. Better growth after costs, at the same risk

A small fund runs a long-short US equity strategy built from a dozen signals, and wants a better result after costs without taking more risk.

- **What the agents change:** the signals, how they are combined, portfolio construction and rebalancing.
- **What the judge runs:** walk-forward backtests of the 1,000 largest US stocks on daily bars, over three four-year periods from 2010 to 2021.
- **The number:** what one unit grows to after costs, with daily returns scaled to 10% annual volatility, so that no version wins by taking more risk. Over four years, a 2% gain is roughly 0.05 of Sharpe ratio.
- **What must hold:** your limits on weight per stock, gross exposure and share of daily volume, or the check fails the run; maximum drawdown at most 20%, and no more than 5% worse in a step; turnover no more than 10% higher in a step.
- **Hidden from the agents:** 2022 to 2025 in the same universe, and large European stocks from 2014 to 2025.
- **What agents would try:** z-scores within each industry; twelve-month momentum that skips the latest month; clipped outliers; signals weighted by their recent information coefficient (their correlation with the next period's returns); no-trade bands; a shrunk covariance matrix in the optimizer; gradient-boosted trees on Alpha158.
- **What you get:** the best strategy that held your limits, as a commit on the run's branch, and every attempt with its numbers and the judge's reasons: the trials behind the result.

### 2. Faster backtests, the same P&L

A team's backtester loops over days and stocks in Python, which limits how many ideas a researcher can test in a day.

- **Mode:** a goal campaign, which ends when every required goal passes, twice.
- **The goals:** the same daily P&L as the current backtester, to your tolerance, for three reference strategies on every visible period and on a hidden one; and a ten-year run within the time you set, on the judge's clock.
- **What you get:** a faster backtester whose numbers match the old one, with the judge's measurements for each goal.

### 3. Read the literature first

A research campaign can first answer a question such as "Which published equity anomalies keep a positive return after realistic trading costs, and how much of it remained after publication?" The agents read open-access papers, a claim counts only when code finds its quotes word for word in the archived page, and a review panel of models decides each question.

## The contract for the first campaign

```json title="contract.json"
{
  "schema_version": 1,
  "campaign": "equity-ls-growth",
  "version": 1,
  "title": "Better growth after costs, at fixed volatility",
  "mode": "hill_climb",
  "project": {
    "repo": "equity-strategy",
    "kit": { "repo": "equity-backtest-kit", "commit": "3e7a91c0b4d25f86e1a0c9b7d3f4e2a1b5c6d708" }
  },
  "target": { "type": "cpu", "class": "generic-cpu" },
  "editable_paths": ["signals/**", "portfolio/**", "config/**"],
  "forbidden_patterns": ["\\bopen\\(", "\\bread_(csv|parquet|feather|pickle|bytes|text)\\(", "\\bos\\.(walk|listdir|scandir)\\("],
  "objective": { "primary": { "metric": "growth_at_10vol", "direction": "max", "min_effect": 0.02 } },
  "guards": [
    { "metric": "max_drawdown", "direction": "min", "max_step_regression": 0.05, "max_total_regression": 0.15 },
    { "metric": "turnover", "direction": "min", "max_step_regression": 0.1, "max_total_regression": 0.25 }
  ],
  "hard_constraints": [{ "kind": "max", "metric": "max_drawdown", "value": 0.2 }],
  "cells": ["us-2010-2013", "us-2014-2017", "us-2018-2021"],
  "held_out_cells": ["us-2022-2025", "europe-2014-2025"]
}
```

The kit holds the point-in-time data, the driver, the cost model and the check. The driver sends the strategy its fitting years, then one day at a time, and writes its positions. The check fills them with the kit's costs, enforces the limits, scales the returns to 10% volatility and prints one line, such as `{"pass": true, "growth_at_10vol": 1.284, "max_drawdown": 0.093, "turnover": 4.1}`. All three are read from the check, and each must be above zero: hence growth, not a return. The forbidden patterns refuse a change that adds the plain ways to read a file. A gain counts only when it is at least 2% ([Contract](../../reference/contract.md), [Kit manifest](../../reference/kit-manifest.md)).

## What to expect

- **Time per attempt.** The judge runs each change on every period, alternating with the best version so far, then fresh runs and the hidden periods for a win, so an attempt costs several backtests. A deterministic backtest gives the same number on every run, so the verdict usually comes after three blocks. Keep each backtest to minutes: daily bars, not ticks.
- **Where the agents help most.** Many small variations of signals, turnover and portfolio construction. They can't buy data, or tell whether a signal has an economic reason to last.
- **Where people stay.** The universe, costs and limits; why a signal should work; the last out-of-sample test; every decision to trade.

## What the judge guards against

Look-ahead, a cost model the agents could relax, and strategies that fit only the years they were tuned on. The data arrives one day at a time, the kit charges the costs, a win must hold on years and a market the search never used, and an auditor model can review a gain far above the run's earlier ones. A held-out period checked many times can itself be overfit, and market prices are public to agents whose commands reach the internet. Keep the final test for data that did not exist when the campaign ran.

## Limits

- Thermite only backtests: it never connects to a broker, an exchange or a live feed, and never trades. A backtest can't show a strategy's capacity or crowding.
- The strategy's process can read the driver's data files. Daily delivery prevents accidental look-ahead and the forbidden patterns refuse plain file reads; read the champion's code before you trust it.
- Attempts in a hill climb build on one another. Estimate the effective number of independent trials before you correct for them.
- Market data licences often restrict redistribution and some uses. The data stays on your machine, away from the agents' model provider; check that your licence covers this use.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** independent quantitative researchers with one computer and their own data.
- **[Startups](../for/startups.mdx):** small funds that need a research process they can show to investors.

## Related work

Microsoft's R&D-Agent(Q) reached an annualized return of 14.21% on CSI 300 stocks from 2017 to mid-2020, a period it was tested on but not tuned on, against 5.70% for Alpha158 ([the paper](https://arxiv.org/abs/2505.15155)). Bailey, Borwein, López de Prado and Zhu showed that with five years of data, no more than 45 independent configurations should be tried, and that not reporting the number of trials "makes it impossible to assess the risk of overfitting" ([their paper](https://doi.org/10.1090/noti1105)). The deflated Sharpe ratio ([Bailey and López de Prado, 2014](https://papers.ssrn.com/abstract=2460551)) and the probability of backtest overfitting ([Bailey and others, 2017](https://doi.org/10.21314/JCF.2016.322)) both need every trial, not only the best.

## Get started

1. [Install on one machine](../../tutorials/first-run.md), then [add a rig](../../how-to/install/rig-on-a-machine.md) on the machine where the data is.
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with a driver, a cost model and point-in-time data, and [test it](../../how-to/campaigns/test-a-kit.md) with a strategy you know is worse and one that breaks a position limit: the first must lose, and the check must fail the second.
3. [Write a contract](../../how-to/campaigns/write-a-contract.md) like the one above, and start the campaign.
