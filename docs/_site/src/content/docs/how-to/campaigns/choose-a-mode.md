---
title: "Choose a campaign mode"
description: "Pick a hill climb, a goal campaign or a research campaign: what each one is for, what it needs and what ends it."
type: how-to
sidebar:
  order: 0
---

Every campaign runs in one of three **modes**: **hill climb**, **goal** or **research**. The mode decides what the agents make, what code checks before anything counts, and when the campaign ends. Choose it first: the rest of the campaign follows from it.

| | Hill climb | Goal | Research |
| --- | --- | --- | --- |
| Choose it when | You have a number to make better, such as speed, size or accuracy | You can say what the result must do, as checks: it builds, it loads the model, its answers match | You have a question, and hours or days to spend on it |
| The agents make | Changes to your code | Changes to your code | Claims, with quotes from the pages they read, and findings. No code changes |
| What decides | The judge, which times each change against the champion | Each goal's own test: the kit's check, a measured threshold, or the review panel | Code, which finds every quote word for word in a page the rig archived; the review panel decides each question, by a majority |
| What you get | The champion: the best confirmed version | The champion: the version that meets the most goals | A report whose findings rest on verified claims |
| It ends when | Never on its own: you pause it or close it | Every required goal is met, or the evidence shows that they cannot be, where the contract allows it | After its shortest time, the review panel finds every question answered, or its open questions stop adding (the progress rule); or its longest time is up |
| What you need | Your project, and a kit that measures the number | Your project, and a kit that checks the goals | A model for the agents, and a review panel on the rig. No project and no kit |

[Campaign modes](../../explanation/campaign-modes.md) explains how each mode works.

## 1. Find your mode

Answer these in order, and stop at the first yes:

1. **Is the work reading, not changing code?** You want to know what is known, what the sources say, or which approach to take: a **research** campaign.
2. **Can you write down what done means?** Each thing the result must do is a check that passes or fails, or a number that must cross a line: a **goal** campaign. A goal that needs judgement, such as clear documentation, goes to the rig's review panel.
3. **Is there a number to push up or down?** Operations per second, run time, a score: a **hill climb**. Other numbers that must not get worse become its guards, and pass-or-fail limits its hard constraints.

Some work fits two modes:

- **A number with a line to reach:** a goal campaign whose goal is a measured threshold, such as a number of items per second, ends once the judge confirms that the line is crossed. A hill climb keeps going past it.
- **Read first, then change the code:** run a research campaign, then let a hill climb or a goal campaign read its collection in Thermite's knowledge base. That campaign's agents can then search what the research found. See [Use past research in a new run](use-past-research.md).

## 2. Set the mode

On the dashboard, open **Campaigns**, press **New campaign**, and choose the mode's card on the first step, **1 Aim**:

| Card | Mode |
| --- | --- |
| **Hill climb** | hill climb |
| **Reach a list of goals** | goal |
| **Research a question** | research |

A research campaign skips **3 Project**, and its step 4 is **Time and tools**. [Start a campaign from the dashboard](start-from-dashboard.md) goes through every step.

In a contract, set `mode` to `hill_climb`, `goal` or `research`. [Write a contract](write-a-contract.md) gives an example of each, and [Start a campaign from the command line](start-from-command-line.md) sends it to a rig.

## 3. Get what the mode needs

- **Hill climb:** a [kit](write-a-kit.md) whose check reports the number, and the contract's `target`, the kind of device. **Try the kit first** on the **New campaign** page runs the kit with no agents and no model, so you see it work before an agent spends anything ([Test a kit with known candidates](test-a-kit.md)).
- **Goal:** a kit whose checks test the goals, as verifiers or measured metrics. For goals that need judgement, a review panel on the rig: see [Configure advisors](../operate/advisors.md). **Try the kit first** works here too.
- **Research:** a model for the agents, since research is all agent work. Research workers run in Pi or OpenCode v2, so a Claude subscription can't serve them. The contract needs a topic, its questions and the shortest time to work, `min_duration`: the time the run has to collect sources and claims. After it, the run ends when the rig's review panel finds every question answered, or when its open questions stop adding, so the rig needs a review panel ([Configure advisors](../operate/advisors.md)). Its longest time, `max_duration`, ends it at the latest, answered or not; without either of those ends and without one, it runs until you close it. The **New campaign** page sets the shortest time, and, if you want one, a floor of verified claims before the first check (`min_verified_claims`), but no longest time. [When a research run ends](../../explanation/campaign-modes.md#when-a-research-run-ends) gives every step. For web search, give the agents an MCP server that searches ([Give agents MCP tools](give-agents-mcp-tools.md)).

In every mode, nothing ends a campaign by default. Before agents use a paid model, set a stop time or a budget: see [Set a budget or a stop time](budget-and-stop-time.md).

## How to tell it worked

On **Campaigns**, the campaign's name is followed by its mode: `hill climb`, `goal` or `research`. Its run's page says the same after the rig's name, such as `on local-1 · hill climb · Running`.

To see each mode at work first:

- A hill climb: [Hand the work to agents](../../tutorials/agents-with-a-free-model.md), on the sample project, and [Your own project](../../tutorials/your-own-project.md), on a project of yours.
- A goal campaign: [Your first goal campaign](../../tutorials/first-goal-campaign.md), with no model.
- A research campaign: [Write a research campaign](write-a-contract.md#4-write-a-research-campaign), then start it from the dashboard or the command line.
