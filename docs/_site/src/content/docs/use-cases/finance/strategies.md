---
title: "Trading strategy research"
description: "Use Thermite to research trading strategies with backtests that charge costs and prevent look-ahead, with recent years withheld and every trial recorded."
type: use-case
useCase:
  mode: climb
  personas: [solo-builders, startups]
  summary: "Agents propose factors and strategies. The judge backtests each with costs and no look-ahead, withholds recent years and records every trial."
  measure: "Growth after costs · no look-ahead, limits kept · the latest years"
sidebar:
  order: 1
---

Testing many strategies on the same history will eventually produce one that performs well by chance. A strategy has value only if it performs on data the search never used, and only if the number of trials behind it is known. Thermite provides both: the most recent years are withheld from the agents, and the run's ledger records every attempt.

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

## What the judge guards against

Look-ahead bias, a cost model the agents could relax, and strategies that only fit historical data. The backtest and its costs are in the kit, which the agents cannot read, and withheld years test every accepted strategy. A withheld period evaluated many times can itself be overfit, so keep a final period outside the campaign for the last test.

## Who it's for

- **[Solo builders](../for/solo-builders.mdx):** independent quantitative researchers with one computer and their own data.
- **[Startups](../for/startups.mdx):** small funds that need a research process they can show to investors.

## Related work

Microsoft's R&D-Agent for quantitative finance reached an annualized return of 14.21% on China's CSI 300 index over 2017 to 2020, a period it was tested on but not tuned on, against 5.70% for a standard set of factors ([the paper](https://arxiv.org/abs/2505.15155)). Bailey, Borwein, López de Prado and Zhu showed that with five years of data, no more than 45 independent configurations should be tried, and that not reporting the number of trials "makes it impossible to assess the risk of overfitting" ([their paper](https://doi.org/10.1090/noti1105)).

## Get started

1. [Install on one machine](../../tutorials/first-run.md).
2. [Write a kit](../../how-to/campaigns/write-a-kit.md) with a backtest and a look-ahead check, and [test it](../../how-to/campaigns/test-a-kit.md) with a strategy that peeks at tomorrow: the check must fail it.
3. Thermite only backtests. It never trades.
