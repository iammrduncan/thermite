---
title: "Choose a model"
description: "Pick a model for the agents: a free model first, then one on your own computer, then an API key or a subscription."
type: how-to
sidebar:
  order: 1
---

Thermite's agents need an AI model to think with. The judge does not: it measures changes with no model at all. This page helps you pick a model and points you to the guide that connects it.

Try the options in this order. Each one costs more, or needs more set-up, than the one before.

| Option | Costs | You need | Runs in |
| --- | --- | --- | --- |
| [OpenCode's free models](#1-opencodes-free-models) | Nothing | Nothing | OpenCode v2 only |
| [A model server on your computer](#2-a-model-server-on-your-own-computer) | Nothing but your hardware | A server such as Ollama, vLLM or LiteLLM | Pi or OpenCode v2; Codex when the server answers `/responses` |
| [An API key](#3-an-api-key-from-a-provider) | The provider's prices | A key from an OpenAI-compatible provider or from Anthropic | Pi or OpenCode v2; Codex when the provider answers `/responses`, as OpenAI's own API does |
| [A subscription](#4-a-claude-or-chatgpt-subscription) | Your plan, nothing more | A Claude Pro or Max plan, or a ChatGPT Plus or Pro plan | Claude: Claude Code only. ChatGPT: Pi, OpenCode v2 or Codex |

You connect every option on one dashboard page, **Settings › Providers**, and then give a [rig](../../reference/glossary.md) one of its models. [Connect a model provider](connect-a-provider.md) shows how.

:::caution[Set a limit before you pay]
Nothing stops research by default: agents keep working until the job is done or you stop them. Before agents use a paid API key:

- Give each campaign a **stop time**: **Stop after (hours)** under **Advanced** on the **New campaign** page, or `budget.wall_hours` in the contract. It works on every rig.
- Set a spending limit at the provider, on the key or the account, if the provider has one.
- Watch the spend, and **Pause** the run if it goes too fast ([Steer a run](../campaigns/steer-a-run.md)).

Thermite's money limits count less than their names suggest. The contract's `budget.llm_usd` counts only on a rig that has token prices (`THERMITE_LLM_USD_PER_MTOK_IN` and `THERMITE_LLM_USD_PER_MTOK_OUT`). The local stack can set them; rigs that control sets up on machines and clusters, or by a join command, can't have them yet. It counts only the workers' trials (their working sessions), not the planner or the advisors. The advisors' daily limit, `max_usd_per_day`, counts only the `openai` runtimes in the advisors file that have prices: an advisor given its model on **Edit rig** counts as $0. See [Set a budget or a stop time](../campaigns/budget-and-stop-time.md) and [goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal).

A subscription never buys more: at its limit, the agents wait.
:::

## What every model must do

The model must support **tool calling**. Workers act only through tools: they read and edit code, run commands and submit their changes with them. A model that only writes text cannot do that work.

The rig's **Model route** check tests exactly this. It sends one short request and passes only when the model answers with a correct tool call. The rig runs it by itself each time control gives it a new model. See [Check a rig](../operate/check-a-rig.md).

## Where the agents run

Each agent runs inside a program that gives the model its tools: the **worker harness**. (The **harness** alone is something else: the rig's container that holds the judge and the agents.) You choose the worker harness in the block **Harness and model for each rig** on **Settings › Providers**, under **Runs in** for each agent on a rig's **Edit rig** page, or under **The agents run in** when you choose the agents' model on the **New campaign** page:

- **Pi**: the agent toolkit by Mario Zechner, which Thermite builds in ([Credits](../../project/credits.md#programs-the-agents-run-in)). It is the default.
- **OpenCode v2**: the OpenCode coding agent, which is always in Thermite's harness image.
- **Claude Code**: Anthropic's own program. It is in the image only when the image is built with it, and it runs only with a Claude subscription.
- **Codex**: the Codex CLI, OpenAI's own coding agent. It is in Thermite's published harness images, and it runs with a ChatGPT subscription or an OpenAI-compatible provider whose server answers OpenAI's Responses API (`/responses`), as OpenAI's own API does. The planner follows the workers into Codex unless it has a model of its own.

Not every model works in every worker harness. Thermite refuses these pairings when you save them:

| You choose | The dashboard says |
| --- | --- |
| Claude Code with any provider other than a Claude subscription | "Claude Code runs only with a Claude subscription here: choose Pi or OpenCode v2 for this provider.", or "… choose Pi, OpenCode v2 or Codex for this provider." for a ChatGPT subscription or an OpenAI-compatible provider |
| OpenCode's own models in Pi | "OpenCode's free models run only in the OpenCode harness: choose OpenCode v2 for this rig." |
| Codex with an Anthropic or OpenCode provider | "Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider." |
| A model given over MCP or REST with a harness that can't run it, for any agent | "A Claude subscription runs only in Claude Code: choose Claude Code for the *agent*, or another model.", or "OpenCode's free models run only in OpenCode: choose OpenCode v2 for the *agent*, or another model." |

A Claude subscription always runs in Claude Code: when you choose one of its models, Thermite picks Claude Code for you. A ChatGPT subscription runs in Pi unless you choose OpenCode v2 or Codex.

The planner and the advisors with a model of their own run in the program their model needs. Over MCP or the REST API, each can take another of the four, as the workers can: see [Where each agent runs](model-per-agent.md#where-each-agent-runs).

:::note[Research campaigns]
Research workers run in Pi or OpenCode v2, never in Claude Code, so a research campaign can't use a Claude subscription. On a rig whose workers run in Codex, research workers run in Pi with the same model. OpenCode's own free models serve a research campaign when the agents run in OpenCode v2. [Write a contract](../campaigns/write-a-contract.md#4-write-a-research-campaign) says what happens otherwise.
:::

## 1. OpenCode's free models

OpenCode runs a service with some free models. They need no key and no account. This is the quickest way to watch agents work.

- On **Settings › Providers**, add a provider of the type **OpenCode (its own models)** and leave **Base URL** and **API key** empty.
- Give the rig one of its models whose name ends in `-free`, with the worker harness **OpenCode v2**. Those are the ones OpenCode serves without a key.

OpenCode decides which of its models are free, and the list can change. Its list also names models it does not serve, and it limits free use: a check that fails with `Rate limit exceeded` may pass a few minutes later. If the model check fails, try again later or try another model ([what the failures mean](connect-a-provider.md#give-a-rig-one-of-its-models)). The tutorial [Hand the work to agents](../../tutorials/agents-with-a-free-model.md) walks through this path from start to end.

## 2. A model server on your own computer

A model server that you run yourself, such as Ollama, vLLM or LiteLLM, costs nothing per request. Add it as an **OpenAI-compatible** provider:

- **Base URL**: the server's address, ending in `/v1`. Thermite runs in containers, and inside a container `localhost` is the container itself. Use `host.docker.internal` instead, for example `http://host.docker.internal:8000/v1`. With Podman, `host.containers.internal` works too.
- **API key**: Thermite asks every new OpenAI-compatible provider for a key. If your server checks none, type any word without spaces.

Control reads the server's model list from where control runs, and each rig calls the model from where the rig runs, so both must reach the address. On the local stack, control and the harness container both reach `host.docker.internal`.

A rig on a cluster reaches a server on a private or Tailscale address only through a network rule of its own. In a namespace that control creates, or that you join, the rig's harness container reaches only DNS and addresses outside the private, shared and link-local ranges, and Tailscale's addresses are in the shared range. Someone who runs the cluster can add a rule that lets the rig's harness reach the server's one address and port ([Reach a model server on a private or Tailscale address](../install/rig-on-a-cluster.md#reach-a-model-server-on-a-private-or-tailscale-address)), or give such a rig a hosted provider instead.

## 3. An API key from a provider

Use a key from a hosted provider:

- **OpenAI-compatible** covers most services and gateways, for example OpenRouter or LiteLLM. Enter the provider's base URL, ending in `/v1`, and your key.
- **Anthropic** is Anthropic's own API. Leave **Base URL** empty and enter your key.

Control seals each key as soon as you save it, never shows it again, and gives it only to the rigs that use one of the provider's models. Set a stop time and a limit at the provider first, as the caution above says.

## 4. A Claude or ChatGPT subscription

If you already pay for a Claude or ChatGPT plan, its agents can work on that plan:

- **Claude subscription (Pro or Max)**: you paste a token from `claude setup-token`. Its models run only in Claude Code, so the harness image must be built with Claude Code. See [Use a Claude subscription](claude-subscription.md).
- **ChatGPT subscription (Plus or Pro)**: you sign in with ChatGPT from the dashboard. Its models run in Pi, OpenCode v2 or Codex. See [Use a ChatGPT subscription](chatgpt-subscription.md).

A subscription is for your own Thermite only. A Thermite that several people use takes API keys. When a plan's usage is full, the agents wait for it; nothing pays for more.

## Mix models

You can give each agent its own model: the workers one, the planner another, and each advisor a third. For example, a free or local model for the workers, and a stronger model for the planner. See [Give each agent its own model](model-per-agent.md).

A rig can also take its model from its own settings, the `THERMITE_MODEL_*` variables, instead of from control. [Connect a model provider](connect-a-provider.md#use-the-rigs-own-settings-instead) explains when that helps.
