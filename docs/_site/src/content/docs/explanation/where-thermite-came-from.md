---
title: "Where Thermite came from"
description: "The lessons from long research campaigns that shaped Thermite, and the part of Thermite that answers each one."
type: explanation
sidebar:
  order: 15
---

Thermite grew out of long-running hill-climbing campaigns on inference kernels: AI agents trying, change after change, to make the GPU code behind a model's answers run faster. Those campaigns taught a handful of lessons. Thermite is the system built around them, informed by published work on agent research systems and on evolutionary code search. [Credits](../project/credits.md#research-behind-the-design) names that work, with what Thermite takes from each.

Each lesson below is paired with the part of Thermite that answers it. The [glossary](../reference/glossary.md) explains the Thermite words used here.

## Loops that stopped after a fixed number of failures

A search for speed has long dry spells. A loop that stops after a fixed number of failures ends the search at the first long one, whether or not the next change would have worked.

**In Thermite:** nothing ends research by default. There is no limit on turns, attempts, failures or time unless you set one. A lane whose trials end without a usable change waits a little longer before its next trial, up to ten minutes. A provider's error is answered by its kind: a rate limit or an outage waits and goes on, and no credits, a refused key, or an outage or refused requests that last 30 minutes stop the agents until the model works again. → [Why Thermite runs until the job is done](runs-until-done.md)

## Useful experiments discarded because they didn't move one number

A change that loses on the headline number can still hold an idea worth reading later, or worth trying again in another form. Throw it away and the idea is gone.

**In Thermite:** every attempt's change is saved as a git ref before the judge even builds it, and the ledger keeps its verdict and the judge's reasons. Every attempt also goes into the rig's exports. Losses feed the next round of work too: the planner sees recent results from every lane, and each worker sees its own lane's recent attempts with the judge's findings. Each run's experiment queue keeps every experiment tried, with its result, and the ideas that workers propose while they work, so an idea outlives the trial that had it. The agents also keep field notes of what they observe and learn, and every campaign's records go into its collection in Thermite's knowledge base, where later runs can read them. → [Why agents never judge](why-agents-never-judge.md), [Agents, lanes and the planner](agents-lanes-planner.md) and [Journals and the knowledge base](journals-and-knowledge.md)

## Dashboards that vanished on restart

When the record of a campaign lives in the process that shows it, a restart loses the history of what was tried.

**In Thermite:** each rig keeps a ledger, a database that survives restarts and is the authority on what happened. Control keeps its own store of everything the rigs report. A rig keeps researching while control is down, and its reports catch up when control is back. → [How the parts fit together](how-it-fits-together.md)

## Supervisors bolted on through a terminal

Oversight added afterwards, by typing into a terminal, leaves no record of who asked for what, or why, and nothing stops it from overruling the measurements.

**In Thermite:** every rig has a supervisor container built in. Its advisors, when the rig has them, steer the planner with directives that carry their reasons and citations, add experiments to the run's queue with why, and an auditor can stop a result the judge confirmed, or clear it as the last step. Every instruction a person gives goes through control as a signed, recorded command, from the dashboard, the REST API or MCP. None of them can set a verdict. → [Supervision](supervision.md) and [Steer a run](../how-to/campaigns/steer-a-run.md)

## "The agent says it's faster" is not "it is faster"

An agent's report of its own result is a claim, not a measurement. A change can even make the measurement itself wrong, for example by moving the timer.

**In Thermite:** an agent never grades its own work. A judge that the agents can neither read nor change builds each change, times it against the champion on the same device, checks its output and confirms a win on fresh runs before it counts. → [Why agents never judge](why-agents-never-judge.md)
