# v0.3.0: architecture and technology decisions

**Status:** the current planning for v0.3.0's structure, and the open questions under discussion. It is the repository's copy of the maintainers' working document, last brought in step on 2026-11-25. Nothing here is decided until a row of [the open decisions](#open-decisions) says so, and nothing is built from it until the owner starts a step of [the run sheet](../v030_release_plan.md).

It takes the place of the questions at the end of [the options' README](options/README.md). The [options](options/) are the earlier proposals of 2026-11-15, kept as the background to this page. Where they differ from this page, this page holds.

## Where the plan stands

Nothing about the code's structure is decided. The latest plan is the set of four options written on 2026-11-15, with option 4 recommended. Their eight questions for the owner are rows 1 to 8 of [the open decisions](#open-decisions) below, and more have come up since.

v0.3.0 carries three pieces of work:

| Work | Agreed | State on 2026-11-25 |
| --- | --- | --- |
| The dashboard as a web app, built from the design system | 2026-11-10 | The base and the design system are done. No screen is built yet |
| A run owns its agents and its share of compute. A control plane does most of the work, and a machine runs one light runner ([goal 258's design](../goal-258-design.md)) | 2026-11-12 | 2 of its 10 steps are built: the store behind an interface, and PostgreSQL beside SQLite |
| The code's structure: one repository of small packages, on fxbot's conventions, core or plugin | Asked on 2026-11-15, not decided | Four options on paper, and this page. Nothing built |

[The run sheet](../v030_release_plan.md) has 35 steps, and its column **State** says where each stands. On 2026-11-25, step 3 (the brand and the design system) is done; steps 1, 2 and 4 (the cheap guards, the store behind an interface, PostgreSQL beside SQLite) are built and wait for the owner's look; step 5, the knowledge base's search on PostgreSQL, is next; the other 31 are not started.

The structure question sits across all of it. The recommendation adds one step before step 5, to set up the packages, and keeps the order of the other 35.

## Today and after

Everything the core of a rig does today runs in the control plane after v0.3.0: the run's record, the scheduler, the judge's decisions, the agents' loops and the advisors. A machine keeps one runner, and NATS is the only link to it. This is the design agreed on 2026-11-12, and every structure option keeps it. [option-4.html](options/option-4.html) draws it, for one machine and for several.

## What is settled

These hold in every option, so none of them is open unless the owner reopens it.

| Decision | Date | What it means for the structure |
| --- | --- | --- |
| Agents never judge. Measurement, verdicts and promotion are code the agents cannot write | Since v0.1.0 | A run's agents never write or load what judges them. Whether a plugin that the owner adds may judge is [decision 16](#open-decisions) |
| TypeScript on Node.js LTS. Compose or Kubernetes | Since v0.1.0 | One language across every package |
| The dashboard is a web app on fxbot's stack (React, shadcn/ui, Tailwind CSS, Geist), a client of the API alone | 2026-11-10 | The app is a program of its own and imports contracts only |
| One entry for each action, with its REST route and its MCP tool | 2026-11-10 | The list needs one home that every program can import |
| A run owns its agents and its share of compute. Machines are a pool. The rig goes | 2026-11-12 | What is keyed by rig today is keyed by run or by machine |
| The control plane has four services: the door, the record, the agents, the scheduler | 2026-11-12 | These are the folders of the control plane, whatever the tree |
| The agents' loops and the writing of code run in the control plane, each worker in a zone of its own | 2026-11-12 | The control plane needs sandboxes. A model's sign-in never reaches a machine |
| A machine runs one runner, in one image. The container is the wall in v0.3.0 | 2026-11-12 | A runner with no container engine is a v0.4.0 goal ([277](../goals/277-runner-without-a-container-engine.goal)), with microsandbox to study |
| PostgreSQL holds the record. PGlite runs the fast tests, a real server runs CI | 2026-11-12, 2026-11-14 | SQLite stays only as the way back at the move |
| Every component and every look is made in the design system | 2026-11-14 | `packages/design-system` stays as it is, and fxbot uses it later |

The owner's steer of 2026-11-15 is a direction, not yet a chosen tree: one repository of small packages, fxbot's conventions, core or plugin, a control plane and a runner over a common core, and no SDK.

## The structure options

[Option 4](options/option-4-programs-one-core-and-plugins.md) is the one recommended: seven packages from one rule, plugins of three kinds, and no SDK. It is the owner's tree ([option 1](options/option-1-the-tree-as-drawn.md)) after the rules of options [2](options/option-2-fxbots-shape.md) and [3](options/option-3-small-core-and-plugins.md) and the owner's steer are applied to it.

| Option | Packages | Where behaviour lives | Plugins | Its risk |
| --- | --- | --- | --- | --- |
| 1. The tree as drawn | 8: `design-system`, `cli`, `ui`, `control`, `runner`, `sdk`, `core`, `website` | In `control` and `runner`. Shared runtime in `core`. Contracts and the client in `sdk` | One, for a second agent harness | Two shared packages whose line must be kept |
| 2. fxbot's shape | 6: `sdk`, `control`, `runner`, `ui`, `website`, `design-system` | In `sdk`. `control` and `runner` are thin programs around it | None at first | One very large package |
| 3. A small core and plugins | Option 2's 6, with a plugin API in `sdk` | In `sdk`, and in plugins for all that an install may leave out | Agent harnesses, kinds of device, sources of compute, and more | Hooks made before their second use |
| **4. Programs, one core, and plugins** | 7: `core`, `control`, `runner`, `cli`, `ui`, `design-system`, `website` | In `control` and `runner`. `core` holds only what crosses a boundary | Three kinds: every agent harness, every kind of device, every source of compute | One `core` that a browser and Node both load from. A large `control` |

How to get there is a second choice, and it is the same for every option ([the way there](options/the-way-there.md)). Path B is recommended.

| Path | What happens | Cost |
| --- | --- | --- |
| A. Move the folders now | Each folder of `src/` moves into its package in one mechanical change | About a week, by my estimate. It moves 52k lines that later steps delete |
| **B. Fill the packages step by step** | The workspaces are set up once. Each step of the run sheet writes or moves its code into its package, and `src/` shrinks until it is empty | A few days for the first step, by my estimate. Two trees until the rig goes at step 34 |
| C. A clean tree beside the old | A new layout with only what the new model needs | Not estimated. A long time with nothing that runs a campaign |

The run sheet deletes at least 52k of today's 220k lines of code whatever the tree is: the old dashboard's pages, and what exists only for the rig.

## Option 4 in short

The control plane and the runner share no code but the core, and they talk over NATS alone. The app and the command line reach the control plane only through the core's client.

Three rules give the tree:

1. **A package is a program, or what two programs share.** Five programs and two shared things make seven packages. An eighth needs a second real consumer.
2. **Every boundary between two programs has one folder in the core.** Nothing crosses a boundary that is not written there.
3. **Core or plugin.** What every run needs is in the packages. What an install may leave out is a plugin, and the core never names one.

Each boundary's contract is in `core`, and the code on each side is in the program that owns that side:

| Boundary | Its contract | Who serves | Who calls |
| --- | --- | --- | --- |
| A person, a script or an outside agent, and Thermite | `core/api`: the list of actions | `control/door`: REST and MCP, both made from the list | `core/client`, which `ui` and `cli` use. Any MCP client |
| The control plane and a runner | `core/bus`: subjects, message shapes, streams, permissions | `control/scheduler` gives jobs. `control/record` takes reports | `runner` |
| What happened, and everyone who reads it | `core/events` | `control/record`, the one writer | The explorer in `ui`, through the door |
| A user's files and Thermite | `core/campaign`: a contract, a kit's manifest | `control` checks them | `runner` reads a kit. `cli` checks a contract |
| A plugin and Thermite | `core/plugin`: the manifest and three interfaces | `control` and `runner` load plugins | The plugins |

The three kinds of plugin each have several real uses today:

| Kind | Runs in | Today's code | What it implements |
| --- | --- | --- | --- |
| `harness-*` | The control plane, in a worker's zone | Pi inside Thermite's own code. Claude Code, Codex and OpenCode as programs (3.5k lines) | Start a turn with a prompt and tools, take a message inside a turn, stop, give the usage of each model call |
| `device-*` | The runner | The CPU, CUDA and Vulkan drivers (0.7k lines) and their images | Find the devices, give a job its share of one, measure. Its image file builds the runner for that device |
| `compute-*` | The control plane | Machines over SSH (0.9k), Kubernetes clusters (4.3k), RunPod (3.5k) | Find, start and stop a machine, and put a runner on it |

**What is closed to a plugin is open.** The option pages of 2026-11-15 close seven things to every plugin: measurement, verdicts, completion, promotion, the record's writer, the wall, and who may do what. That list was my proposal, not a settled decision, and it closes too much: with it, nobody could add a judge, a campaign mode, a promotion rule, an advisor or a wall of their own. The settled decision is narrower: a run's agents never judge. [Decision 16](#open-decisions) proposes the rule that takes the list's place.

The conventions are fxbot's, taken as they are: small files on one job, few dependencies, plain TypeScript with no classes, no abstraction before its second real use, delete before adding. Thermite goes its own way in three places: no SDK, a second program with a bus, and tests for what a verdict rests on.

## Technology choices

Most of the stack is already the same as fxbot's. Four differences need a decision: the build step, the tests, the default agent loop, and how a turn survives a restart.

| Layer | Thermite at `31f12d21` | fxbot 0.11.0 | Where the plan stands |
| --- | --- | --- | --- |
| Language and runtime | TypeScript 7.0 on Node.js 22.19 or later | TypeScript 7.0 on Node.js 22.18 or later | The same |
| Packages | One package. The app and the design system are installed apart | 4 npm workspaces | npm workspaces and one lock file, in every option |
| Build | `tsc` builds `dist/` for the images. Tests and scripts run the source | Node runs the source. Only the page is built | Open: run the source, as fxbot does |
| HTTP | Hono 4 | Node's own `http`, and `ws` | Not in the option pages (decision 15) |
| Checks of input | zod 4 for the contracts. TypeBox for the agents' tools | Its own checks, with no schema library | Not in the option pages. The app's contracts may import zod alone today |
| The record | PostgreSQL 18 through `pg`. PGlite in the fast tests. Node's SQLite until the move | PostgreSQL through `postgres`, with pgvector | PostgreSQL is settled. The two products use two drivers (decision 14) |
| Between the planes | NATS 2.15 with JetStream | None: one server | Stays. `core/bus` holds its contract |
| Live changes on a screen | Server-sent events | Streams of NDJSON lines | Stays, in `control/door` |
| MCP | The MCP SDK 1.32, as a server | The MCP client 2.4 | The list of actions makes the tools |
| The agent loop | Pi as a library. Claude Code, Codex and OpenCode as programs | libfx 0.0.16 | Each becomes a `harness-*` plugin. Pi is the default until fx fits |
| A turn that survives a restart | None: a conversation is in a process's memory | libfx's durable sessions, in PostgreSQL | The agents' service needs it. No design yet (decision 13) |
| The wall | A container, with users and groups the image makes | A computer of each bot's own | The container stays in v0.3.0. microsandbox is studied for v0.4.0 |
| The app | React 19, Vite 8, Tailwind CSS 4, Radix, Geist | The same, with shadcn/ui and a PWA | The same stack. One design system for both, later |
| The docs site | Astro 7 with Starlight | Astro 7 with Starlight | The same |
| Lint and format | Biome 2.6 | None | Not asked |
| Tests | Node's test runner, 161k lines. 24 acceptance scripts. Playwright for the browser | None, by choice | Open: keep what a verdict rests on (decision 6) |

On the agent loop: the study of fx ([goal 260](../goals/260-fxbot-and-thermite.goal), read at libfx 0.0.16, which fxbot still uses) found six things that do not fit a run's agent yet. The first three are that Claude by key loses prompt caching and thinking, that a provider by key has no Responses API, and that a turn has no limits and no control of compaction. In one real hill climb, 87% of the input tokens came from the cache.

## Open decisions

Seventeen decisions are open. Ten come from the option pages, three from the agreed design of the control plane, and four came up in the discussion since. The last column changes only when the owner decides.

| # | The decision | What I recommend | From | The owner's call |
| --- | --- | --- | --- | --- |
| 1 | The tree | Option 4 | The option pages | Open |
| 2 | The way there, and the run sheet | Path B. One new step before step 5 sets up the packages, and the 35 steps keep their order | The option pages | Open |
| 3 | Every agent harness is a plugin, fx and Claude Code too | Yes. The default is a line of data, so the tree does not decide when fx takes over from Pi | The option pages | Open |
| 4 | A device's image file lives in its plugin | Yes, with no `runner-images/` folder at the top | The option pages | Open |
| 5 | Where Thermy lives | In `control/agents` first. A plugin when a second plugin needs a place in the page | The option pages | Open |
| 6 | Tests | Keep the tests of what a verdict rests on, beside their code. The pages' tests go with the pages. One test of an action covers REST, MCP and the command line | The option pages | Open |
| 7 | A build step | Run the TypeScript source, as fxbot does. Build only what a browser loads | The option pages | Open |
| 8 | One plugin manifest for fxbot and Thermite | One `plugin.json` with a key for each product. It is the cheapest way to line the two up | The option pages | Open |
| 9 | One `core`, or two | One. Its entries keep what a browser loads apart from what only Node runs, and a check holds the line | The option pages | Open |
| 10 | The control plane as one package | One. A service becomes a package when it needs its own image or its own release | The option pages | Open |
| 11 | A run's tables as views, filled from events first | Yes, as the design proposes. The explorer gets its tables while rigs still run underneath | The control plane's design | Open |
| 12 | Which of a worker's commands run in its zone, and which go to a runner | No proposal yet. The design leaves it to the step that moves the agents: the kit says, or the kind of command does | The control plane's design | Open |
| 13 | A turn that survives a restart | Keep each conversation in the record, written through the harness interface, so every harness plugin gets it. A first thought, with no design behind it | The control plane's design | Open |
| 14 | The PostgreSQL driver | Keep `pg`. The store on it was built and checked on 2026-11-14, and the two products share no store code | Raised 2026-11-24 | Open |
| 15 | The HTTP layer of the door | Decide it when the door is rebuilt from the list of actions, at step 8 of the run sheet. Keep Hono until then | Raised 2026-11-24 | Open |
| 16 | What is closed to a plugin | Close less. Three rules take the place of the list of seven. Only the owner adds a plugin, never a run or its agents. Every verdict names the plugin and the version that judged it. The core keeps the proof and a plugin supplies the mechanism: a wall must pass the isolation self-test, and a judge must pass an A/A run, before its work counts. A judge, a campaign mode, a promotion rule, an advisor or a wall then becomes a kind of plugin on the day a real one needs it. A proposal, with no design behind it yet | The owner's question, 2026-11-24 | Open |
| 17 | Where a plugin's code runs | No proposal yet. The plan loads a harness or a compute plugin into the control plane's own process, so it is trusted as far as the owner's choice to add it. A plugin that judges raises the question: the same trust, or a process of its own | Raised 2026-11-24 | Open |

A decision made here goes into the plan it changes in the same commit: the goal it affects, the run sheet, and [decisions.md](../decisions.md) if it shapes the whole product. A step starts only when the owner runs its command.

## Sources

- [The four options, at a glance](options/README.md), [option 4 in full](options/option-4-programs-one-core-and-plugins.md) and [drawn as a page](options/option-4.html)
- [The way there: the three paths](options/the-way-there.md)
- [The design of the control plane and the runner](../goal-258-design.md)
- [The release plan for v0.3.0](../release-v0.3.0.md), and [the run sheet](../v030_release_plan.md)
- [The study of fx as the agent loop](../goals/260-fxbot-and-thermite.goal)
- [fxbot](https://github.com/iammrduncan/fxbot), read at 0.11.0: its conventions, its package guide and its dependencies
- The dependency lists and the compose files of Thermite at `31f12d21`
