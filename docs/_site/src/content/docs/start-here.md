---
title: "Start here"
description: "Pick the path that fits you: try Thermite on one computer, run it on your GPUs, give it your own project, or let an agent run it."
type: hub
sidebar:
  order: 1
---

Thermite lets AI agents work on a project for as long as it takes, while a judge they cannot touch decides which of their changes really count. This page helps you find where to begin.

## Three kinds of campaign

A **campaign** is one piece of research. Each one runs in one of three **modes**, which say what the agents make, what decides whether it counts, and when the campaign ends:

| Mode | Use it to | What decides | It ends when | See it in |
| --- | --- | --- | --- | --- |
| **Hill climb** | Make a number better, such as speed, size or accuracy, without breaking anything else | The judge, which times each change against the best version so far | Never on its own: you pause it, or a budget you set does | [Run your first campaign](tutorials/agents-with-a-free-model.md) |
| **Goal** | Work until a list of checks pass: it builds, it loads the model, its answers match | Each goal's own test: the kit's check, a measured threshold, or a review panel of models | Every required goal is met, or the evidence shows that they cannot be | [Your first goal campaign](tutorials/first-goal-campaign.md) |
| **Research** | Find out what is known about a question, with no code changes | Code that finds every quote, word for word, in a page the rig archived; a review panel of models decides each question by a majority | Every question is answered, or answered as well as sources allow; or research stops adding; or its longest time is up. It then writes its final report | [Write a research campaign](how-to/campaigns/write-a-contract.md#4-write-a-research-campaign) |

In every mode, code decides when a campaign is done, never an agent. [Choose a campaign mode](how-to/campaigns/choose-a-mode.md) helps you pick one, and [Campaign modes](explanation/campaign-modes.md) explains how each works.

## What you need

- A computer running Linux or macOS, with a few CPU cores, a few gigabytes of free memory, and several gigabytes of free disk. Thermite's three images take about 2.5 GB.
- Docker or Podman, which run Thermite's containers. You download Thermite's images ready-made, and build nothing.
- git, from the second tutorial on, and for the command line, from the third: Node.js 22.19 or later.
- About twenty minutes for the first run.

A GPU is optional, and so is a paid AI model: you can start with a free one.

Before you give Thermite a model, read [Known limits](reference/known-limits.md). Agents run the code that a model writes on your computer, and under compose that code can reach your local network. [The security model](explanation/security-model.md) says what each part of Thermite can reach and what it trusts.

## Pick your path

### Try it on one computer

You want to see what Thermite does before you commit to anything. Start with the three steps of **Get started**, in this order:

1. [Install on one machine](tutorials/first-run.md): install Thermite from its release, sign in to its dashboard and watch its judge check a rig. Needs only the computer above.
2. [Run your first campaign](tutorials/agents-with-a-free-model.md): connect a free model, start a hill climb on the sample project in Thermite's repository, and watch agents propose changes. Needs step 1 and an internet connection; no account or key.
3. [Add a second machine](tutorials/second-machine.md): let control set a rig up on another machine over SSH, and run the campaign there too. Needs steps 1 and 2, a second Linux machine and a name for the first that it reaches.
4. [Tailscale / WireGuard](how-to/install/private-network.md): keep control and its message bus on a private network that only your machines reach.

An AI agent can do step 1 for you: give it `Set up Thermite on this computer for me: follow https://usethermite.com/llm-setup.txt`.

Then two more tutorials:

- [Your first goal campaign](tutorials/first-goal-campaign.md): set a goal, submit a change yourself, and watch the campaign end when the goal is met. Needs step 1; no model.
- [Your own project](tutorials/your-own-project.md): a hill climb on a small project of yours, started from the **New campaign** page. Needs steps 1 and 2, and a public repository that your computer can push to and Thermite can fetch over `https`.

[What Thermite is](explanation/what-thermite-is.md) gives the ideas behind it, in one minute.

### Run it on your GPUs

You have machines with GPUs and want Thermite to use them.

1. [The one-machine stack](how-to/install/one-machine.md), so it keeps running.
2. [Let rigs on other machines reach control](how-to/install/one-machine.md#let-rigs-on-other-machines-reach-control). This needs an HTTPS address for control, behind a reverse proxy you provide, and Thermite's images in a registry that the rigs can pull from without a login. A release's published images are such images, and its compose file gives them to control.
3. [Add a rig on a machine over SSH](how-to/install/rig-on-a-machine.md) or [on a Kubernetes cluster](how-to/install/rig-on-a-cluster.md), or [run one on a RunPod GPU](how-to/install/runpod-rig.md), paid by the hour.
4. [Give a rig several GPUs](how-to/install/several-gpus.md), and read [Sharing a device](explanation/sharing-a-device.md) to choose how.

:::note
Rigs that control sets up on machines and clusters, and rigs you join yourself, have no [results repository](how-to/operate/results-repository.md) yet. Their exports go to control instead ([Get a rig's results from control](how-to/operate/exports-on-control.md)), but they can't send each other champions. The rigs of the local compose stack have one. See [goal 061](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/061-gaps-found-by-the-docs.goal).
:::

### Give it your own project

You have a project with a number you want to improve or goals you want met, or a question you want researched.

1. First do tutorials 1 and 2 under [Try it on one computer](#try-it-on-one-computer). Then [Your own project](tutorials/your-own-project.md): a first campaign from the **New campaign** page.
2. [Choose a campaign mode](how-to/campaigns/choose-a-mode.md): a hill climb, a goal campaign or a research campaign.
3. [Write a kit for your project](how-to/campaigns/write-a-kit.md): how Thermite builds, runs and checks it. A research campaign needs none.
4. [Write a contract](how-to/campaigns/write-a-contract.md): what the campaign must achieve.
5. [Why agents never judge](explanation/why-agents-never-judge.md): what makes a result count.

### Let an agent run Thermite

You want your own AI assistant to watch and steer campaigns for you.

1. [Let an agent run Thermite over MCP](how-to/automate/agent-over-mcp.md).
2. [Tokens and roles](reference/tokens.md): what an agent may and may not do. Only you approve what matters.
3. Point your agent at [`llms.txt`](https://usethermite.com/llms.txt), which lists every page of this site.

## Words you will meet

| Word | Meaning |
| --- | --- |
| **Rig** | Where the research happens: two containers on a machine, with the device the work is measured on. |
| **Harness** | The rig's container where the judge and the agents work. |
| **Supervisor** | The rig's other container: its link to control, which also does all its git work. |
| **Control** | The one service that shows and steers every rig: a dashboard, a REST API and MCP. |
| **Owner's token** | The secret you sign in to the dashboard with. Only the owner approves what matters. |
| **Campaign** | One piece of research: what to improve or achieve, and how to judge it. |
| **Mode** | The kind of campaign: a **hill climb**, a **goal** campaign or a **research** campaign. See [above](#three-kinds-of-campaign). |
| **Contract** | The file that sets out a campaign: what to improve or which goals to meet, which files agents may change, and its limits. |
| **Run** | A campaign running on one rig. |
| **Kit** | The judge's recipe for a project: how to build it, run it, time it and check it. Agents never see it. |
| **Lane** | One line of search inside a run. Each lane's agent works one **trial** after another. |
| **Attempt** | One change an agent submits. |
| **Judge** | The code that measures each change and gives it a **verdict**. Agents cannot change it. |
| **Champion** | The best confirmed result of a run so far. The starting point is champion #1. |

The [glossary](reference/glossary.md) has every term.

## Ask the community

Stuck, or want to share a result? Thermite's community meets on the [Hackers in the Loop Discord](https://discord.gg/3Qs2uejUf9). [Getting help](project/getting-help.md) says where to report a bug, and what to put in a report.
