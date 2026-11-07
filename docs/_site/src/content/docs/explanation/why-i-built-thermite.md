---
title: "Why I built Thermite"
description: "What I wanted from cheap GPUs, where my autoresearch setup stopped fitting that work, and what Thermite became."
type: explanation
sidebar:
  order: 1
---

I built Thermite because I wanted AI agents to run research for days at a time on cheap GPUs, and I wanted to be able to believe the results when I came back. The tools I started with could not give me that. I'm [iammrduncan](https://github.com/iammrduncan), I started Thermite in October 2026, and this is what led to it.

## The work that started it

I want local AI that doesn't need thousands of dollars of GPUs. A Tesla P100 sells used for about $100 and holds a 27-billion-parameter model in its 16 GB, but most engines run it slowly. I want to know how far custom kernels, weight formats and engines can take cards like that, and whether smaller models can beat larger ones.

That is a lot of combinations: kernels, quantizations and engines, for many models, on many cards. Nobody can try them all by hand. So in September 2026 I handed the search to agents, with [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch). It is an extension for the [Pi](https://github.com/earendil-works/pi) coding agent, and it runs the loop from [Andrej Karpathy's autoresearch](https://github.com/karpathy/autoresearch): change something, measure it, keep it if it is better, undo it if it isn't.

It worked. In two weeks and about 400 logged runs, the agents took decode on one P100 from about 9 to about 24 tokens a second. I want that said first, because the rest of this page is about what went wrong.

## What I noticed

The campaigns grew to days, and one measurement could take over an hour. On 5 October I wrote down what I had noticed. Tidied up a little, my list said:

- The pi-autoresearch dashboard is brittle.
- The pod setup is brittle, and doesn't work well with herdr on tmux or with attaching agent context.
- Discard is used for anything that doesn't move the hill climb, even if it's valuable work.
- There's a primary metric, but it's hard to lock secondary metrics or climb two. I want to raise prefill tokens a second and never drop decode tokens a second.
- The dashboard is limited, and the longer it gets, the more chunky and buggy it gets.
- It has weird configs for total turns and total discards.
- There's no built-in supervisor, so I have to run a separate cron job, with its own objectives.

Eight P100s in one machine were coming, and I wanted several research projects running side by side. I needed better command and control.

Not all of that was pi-autoresearch's fault. The pod setup was my own stack, I had patched the extension by hand, and I was running it far from what it was built for. [Thermite vs pi-autoresearch](../compare/pi-autoresearch.md) says where it is the better tool.

## What the logs showed

When I went back through the logs, the list turned into numbers.

- **Good work was logged as failure.** In the first campaign, 62 of 128 logged runs have a score of zero, and 57 of those are discards. One is what the agent called "the largest mechanism win of the campaign". It had no headline number, so it went down as a discard. A discard also reverts the change, so the agent had to move its work out of reach first.
- **The best score was not a result.** In that campaign's longest stretch, all 24 keeps changed no kernel code. The best number on the dashboard was one of them: a control run of unchanged code.
- **Rules lived in prose.** "Raise prefill, never drop decode" was a list of conditions in a prompt. Another rule kept at least 512 MiB of GPU memory free, and the records said about 700 MiB. A separate sampler then caught 114 MiB for about 19 seconds, in a phase the records never measured.
- **The loop stopped itself.** On 27 September a run reached the limit of 200 automatic turns. For about 14 hours, each message from my supervisor bought one turn, and the agent sat idle for 45 to 55 minutes of every hour.
- **Oversight was bolted on.** My supervisor ran from cron and steered by typing into a terminal. About nine in ten of its 146 check-ins sent a correction or a steer, so it was doing real work. It also cost $555 in ten days, and anything wrong with the loop itself still had to wait for me.

By then the loop tool was the smallest part of the system. Around it sat a 76 KB prompt, a journal, a system of receipts, an hourly supervisor and two patches of my own. Everything that made a result trustworthy lived outside the tool: pinned binaries, repeat measurements, guards and a second model checking the first. Most of it was prose, and it held only while someone kept checking.

## Why I didn't just fix it

I wrote up seven ways forward and compared them. These are the three that mattered most:

| Option | Why I didn't take it |
| --- | --- |
| Patch or fork pi-autoresearch | The agent would still own its benchmark. Take away the benchmark and the verdict, and little of the extension is left, in a fork that has to keep up with Pi |
| Adopt another multi-agent harness | [CORAL](https://github.com/Human-Agent-Society/CORAL) was the best one I read, and Thermite takes ideas from it. But I would have written the same judge inside someone else's frame |
| Give the agents stricter rules | My own campaigns had already answered that: written reminders did not stop it, and only a checker would |

Across every system I read, the results I could trust came from something that measured and judged outside the agent's reach, not from smarter search. So Thermite starts there: agents propose, and code they can't touch measures, judges and promotes. [Why agents never judge](why-agents-never-judge.md) explains how.

The other rules came straight from the logs. Every attempt is kept, with the reason it lost. Nothing ends research unless you set a limit. The rig holds the memory, so a crashed agent loses nothing. The supervisor is built in, and every instruction is on the record. [Where Thermite came from](where-thermite-came-from.md) pairs each lesson with the part that answers it.

That has a price. pi-autoresearch is one install and a slash command. Thermite is containers, a kit for each project (the judge's recipe for building, running, timing and checking it) and time on your hardware for every judgement. I took that trade because I needed to leave research running and trust what I found when I came back.

## What it became

I wrote that list on 5 October. The first public release came on 26 October, and v0.1.3 on 6 November. It is young, and it has already grown well past P100s:

- **Three kinds of research:** push a number up, work through a list of goals, or answer a question with quotes that code has checked. [Campaign modes](campaign-modes.md) explains each.
- **More than kernels:** anything you can measure and check. The [use cases](/use-cases/) cover nine fields, from software and science to farming and finance.
- **The machines you have:** one computer, machines over SSH, a Kubernetes cluster or RunPod, and a rig can spread over several machines.
- **The models you have:** a free model, a server of your own, an API key or a subscription, in Pi, OpenCode, Codex or Claude Code.
- **Research that adds up:** what one campaign learns goes into a [knowledge base](journals-and-knowledge.md) that later campaigns can read.
- **One place to steer it all:** a dashboard, a REST API and MCP, for every campaign on every machine.

It also did what I started it for. With [tensorless](https://tensorless.dev), four campaigns took Qwen3.8-27B on one P100 from 7.7 to 30 tokens a second with its quality held. [The first study](../studies/qwen3-8-27b-on-a-p100.mdx) has every number, and the misses too.

## Why it's open

I build things that solve my own problems and my community's. I want a place where people can learn and build this together, and that place is [Hackers in the Loop](https://discord.gg/3Qs2uejUf9). That's why Thermite is open source, under the Apache License 2.0.

## Where to go next

- [Thermite vs pi-autoresearch](../compare/pi-autoresearch.md) sets the two side by side.
- [What Thermite is](what-thermite-is.md) gives the ideas in one minute.
- [Install on one machine](../tutorials/first-run.md) shows the judge at work in about twenty minutes.
