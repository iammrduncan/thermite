---
title: "Test strategies on years they never saw"
description: "Let agents propose factors and trading strategies while the judge backtests each one with costs and no look-ahead, keeps the latest years hidden, and records every attempt so you know how many were tried."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups]
  summary: "Agents propose factors and strategies. The judge backtests each with costs and no look-ahead, keeps the latest years hidden, and records how many were tried."
  measure: "Growth after costs · no look-ahead, limits kept · the latest years"
sidebar:
  order: 1
---

Search enough strategies on the same history and one of them will look good by chance. A strategy is worth something only if it holds on data that the search never touched, and only if you know how many strategies the search tried to find it. Thermite gives you both: the latest years stay hidden from the agents, and the run's ledger records every attempt, so the number of tries is a fact, not a guess.

## The campaign

| | |
| --- | --- |
| **Mode** | [Hill climb](../../explanation/campaign-modes.md) |
| **The number** | What one unit grows to over the backtest, after costs, reported by the kit's check. Every metric must be above zero, so a return is reported as growth, not as a percentage that can be negative |
| **What must hold** | No look-ahead: each decision uses only data from before it; positions within your limits; drawdown as a guard |
| **Hidden from the agents** | The latest years, which a win must also pass. Keep one more period aside, outside Thermite, for a final test |
| **Where it runs** | A CPU rig, on market data you are licensed to use |

## How it runs

1. **You write a kit** whose cases are periods of history, with a backtest that charges costs and a check that refuses look-ahead and prints the growth.
2. **Agents propose and improve** factors, signals and position sizing, each in its own copy.
3. **The judge backtests each version** on the visible periods, and on the hidden years before a win counts.
4. **You read the record.** Every attempt is in the ledger, with its verdict, so you can correct the result for the number of tries, with a deflated Sharpe ratio or a test of the probability of backtest overfitting.

## What the judge keeps out

Look-ahead, a cost model that the agents could loosen, and a strategy that only fits the past. The backtest and its costs are in the kit, which the agents can't read. Hidden years test the strategy on data the search never touched, but a hidden period that is checked thousands of times wears out too, so keep a last one outside the campaign.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** independent quantitative researchers with one computer and their own data.
- **[Startups](../for/startups.mdx):** small funds that need a research process they can show to investors.

## What others have shown

Microsoft's R&D-Agent for quantitative finance reached an annualized return of 14.21% on China's CSI 300 index over 2017 to 2020, a period it was tested on but not tuned on, against 5.70% for a standard set of factors ([the paper](https://arxiv.org/abs/2505.15155)). Bailey, Borwein, López de Prado and Zhu showed that with five years of data, no more than 45 independent configurations should be tried, and that not reporting the number of trials "makes it impossible to assess the risk of overfitting" ([their paper](https://doi.org/10.1090/noti1105)).

## Start

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with a backtest and a look-ahead check, and [test it](../../how-to/campaigns/test-a-kit.md) with a strategy that peeks at tomorrow: the check must fail it.
3. Thermite only backtests. It never trades.
