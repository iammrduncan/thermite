# Option 4: programs, one core, and plugins

The tree I would suggest. It is [option 1](option-1-the-tree-as-drawn.md) after the rules of options [2](option-2-fxbots-shape.md) and [3](option-3-small-core-and-plugins.md) are applied to it, and after the owner's steer of 2026-11-15: no SDK, since nobody embeds Thermite in another product; core or plugin; and a control plane and a runner that share a common core.

[option-4.html](option-4.html) draws it as a page: the packages and who imports whom, the boundaries, one machine and several machines, how the two planes use NATS, and what of today's code is core, a plugin or going. Open the file in a browser; it loads nothing from the network.

## Three rules give the tree

1. **A package is a program, or what two programs share.** Thermite has five programs (the control plane, the runner, the command line, the dashboard's app, the website) and two shared things (the core, the design system). That is seven packages, and no rule is needed to say whether an eighth is due.
2. **Every boundary between two programs has one folder in the core,** and nothing crosses a boundary that is not written there. The two planes never import each other.
3. **Core or plugin.** What every run needs is in the packages. What an install may leave out is a plugin, and the core never names one.

## The tree

```text
packages/
  core/                 @thermite/core: what two or more programs share
    api/                the actions: each one's name, input, answer and role. One list
    bus/                NATS: the subjects, each message's shape, the streams,
                        who may publish and read what, and the client
    events/             the record's events: each kind and its body
    campaign/           what a person writes: a campaign's contract, a kit's manifest
    plugin/             what a plugin is: its manifest, and the three interfaces
                        (harness.ts, device.ts, compute.ts)
    client.ts           the typed client of the door, made from api/
    log.ts, settings.ts, errors.ts, …      the few tools every program needs
  control/              @thermite/control: the control plane
    main.ts             starts one service, or all of them
    door/               rest.ts, mcp.ts, stream.ts, session.ts: transports only
    record/             the tables, the migrations, events into tables, the queries
    scheduler/          the pool of machines and devices, placing a run, the jobs
    judge/              a verdict from measurements; promotion
    agents/             the loops (workers, planner), each worker's zone, a run's tools
    advisors/           the teachers, the auditor, the review panel
    campaigns/, knowledge/, providers/, …   one folder for each thing the record holds
  runner/               @thermite/runner: the one program on a machine
    main.ts             joins the pool, takes jobs from the bus
    jobs/               build, measure, run a worker's experiment on the device
    wall/               the users and limits that keep a change from the judge's files
  cli/                  @thermite/cli: the thermite command, on core's client
  ui/                   @thermite/ui: the dashboard's app, on core's client
  design-system/        the look, for Thermite and later for fxbot
  website/              the public site and the documentation
plugins/
  harness-fx/           an agent harness: plugin.json, control.ts
  harness-claude/
  harness-pi/
  device-cpu/           a kind of device: plugin.json, runner.ts, its image file
  device-cuda/          (two image files: CUDA 12 and CUDA 13)
  device-vulkan/
  compute-ssh/          a source of machines: plugin.json, control.ts
  compute-kubernetes/
  compute-runpod/
examples/
  kits/                 smoke-cpu, smoke-cuda, smoke-vulkan
  campaigns/
deploy/                 the compose files and the control plane's image file
scripts-ci/
  build/                images, the release bundle
  checks/               the public check, sizes, loose ends; the acceptance checks
docs/                   the plans and the goals
```

Tests are beside their code, in `packages/<name>/tests` and `plugins/<name>/tests`.

## Where the API, MCP and the NATS contracts live

One table answers it. A boundary's contract is in `core`; the code on each side of it is in the program that owns that side.

| Boundary | Its contract, in `core` | The side that serves | The side that calls |
| --- | --- | --- | --- |
| A person, a script or an outside agent, and Thermite | `core/api`: the list of actions | `control/door`: `rest.ts` and `mcp.ts`, both made from the list | `core/client.ts`, which `ui` and `cli` use; any MCP client |
| The control plane and a runner | `core/bus`: subjects, message shapes, streams, permissions | `control/scheduler` gives jobs; `control/record` takes what is reported | `runner` |
| What happened, and everyone who reads it | `core/events` | `control/record` is the one writer | The explorer in `ui`, through the door |
| The owner's files and Thermite | `core/campaign` | `control/campaigns` checks them | `runner` reads a kit to measure; `cli` checks a contract before it is sent |
| A plugin and Thermite | `core/plugin` | `control` loads harnesses and sources of compute; `runner` loads its device | The plugins |

What follows from it:

- **REST and MCP are not two folders of code.** They are two transports over one list. An action is written once, in the folder of the thing it changes (`control/campaigns`, `control/scheduler`), and its entry in `core/api` names its route, its tool, its role and its words. `door/` holds no rule of the product. This is [goal 244](../../goals/244-one-door.goal) as planned; the tree gives it its place.
- **The command line and the client are made from the same list,** so a new action is one entry and one function, and the reference pages are written from the entries ([goal 254](../../goals/254-one-record.goal)).
- **MCP has a second, separate use: a run's tools.** What a worker may call (submit a change, run an experiment, write a note) is not the door. It is in `control/agents`, and a harness plugin hands those tools to its program in the way the program takes them.
- **NATS is the only way between the planes.** `control` and `runner` have no import of each other; their `package.json` files name only `core`. A message that is not in `core/bus` can't be sent.
- **Who may publish and read what is a contract too.** The table of permissions is in `core/bus`. Writing the bus server's users from it is the control plane's work.

## The core

Today's `src/core` (contracts, no I/O, 18k lines) and `src/common` (shared tools, 6k lines) become one package with several entries, as fxbot's SDK has two:

| Import | Who may use it | In a browser |
| --- | --- | --- |
| `@thermite/core/api`, `/events`, `/campaign` | Every program | Yes: schemas only |
| `@thermite/core/client` | `ui`, `cli`, a plugin's page, a script of the owner's | Yes: `fetch` alone |
| `@thermite/core/bus` | `control`, `runner` | No |
| `@thermite/core/plugin` | `control`, `runner`, the plugins | The types, yes |

The core holds no behaviour of the product: no rule about a run, no query, no decision. If a function decides something, it belongs to the program that decides it. That is what keeps a shared package from growing into a second home for everything.

## No SDK, and what takes its place

fxbot has an SDK because a bot can be put inside another product. Thermite is not put inside anything: other things talk to it. So there is no `createThermite()`, and no package that holds the behaviour for someone else's process.

What an SDK's users would have needed is still there, smaller:

- **To talk to a running Thermite:** `@thermite/core/client`, and MCP.
- **To add to Thermite:** a plugin, against `@thermite/core/plugin`.
- **fxbot and Thermy:** fxbot reaches Thermite as any outside agent does, through the door. Thermy is inside the control plane and gets the same actions as its tools, from the same list.

## Core or plugin

**Core:** a campaign and its contract, a run, the record, the pool and the scheduler, measuring, the judge's decisions and promotion, the loops of a run's agents, the advisors, the knowledge base, sign-in and roles, sealed secrets, migrations, backup and restore, the bus, and the plugin API. A machine whose runner joins by itself, with a token, is core too: it is all a one-machine install needs.

**Never open to a plugin:** measurement, verdicts, completion, promotion, the record's writer, the wall, and who may do what.

**Plugins, three kinds to begin with,** each with several real uses today:

| Kind | Runs in | Today's code | What it implements |
| --- | --- | --- | --- |
| `harness-*` | The control plane, in a worker's zone | Pi inside Thermite's own code; Claude Code, Codex and OpenCode as programs (3.5k lines) | `harness.ts`: start a turn with a prompt and tools, take a message inside a turn, stop, give the usage of each model call |
| `device-*` | The runner | The CPU, CUDA and Vulkan target drivers (0.7k lines) and their images | `device.ts`: find the devices, give a job its share of one, measure. Its image file builds the runner for that device |
| `compute-*` | The control plane | Machines over SSH (0.9k), Kubernetes clusters (4.3k), RunPod (3.5k) | `compute.ts`: find, start and stop a machine, and put a runner on it |

Two things in this differ from the owner's tree, on purpose:

- **Every harness is a plugin, fx and Claude Code too.** The core has the interface and names no harness. Which one a new install gets is a line of data. So the tree does not decide [goal 260](../../goals/260-fxbot-and-thermite.goal): today the default is Pi, and it becomes fx on the day fx fits, with a change to the list and to no code of the core.
- **A device's image file is in its plugin,** not in a `runner-images/` folder at the top. The driver and the image are one thing to write, test and version, and ROCm, Metal or ESP32 is then one new folder that touches nothing else.

More kinds wait for a second real use: a provider's sign-in, a retention policy's kind, a reader of a file type for the knowledge base, a screen in the app.

## What goes where

| Today | In this tree |
| --- | --- |
| `src/core/api` | `core/api`, as the list of actions |
| `src/core/link`, `src/common/bus`, and the table of who may publish and read what in `src/control/bus` | `core/bus` |
| `src/core/events` | `core/events` |
| The contract's and the kit's schemas in `src/core` | `core/campaign` |
| `src/control/api`, `src/control/mcp` (5.8k lines) | `control/door`, made thin as each action gets its entry |
| `src/control/store`, `views`, `events` | `control/record` |
| The scheduler in `src/harness/agents`; what is left of `src/control/rigs` once a rig is a machine in the pool | `control/scheduler` |
| The decisions in `src/harness/judge`, and the statistics in `src/core/stats.ts` | `control/judge` |
| The measuring in `src/harness/judge`; `src/harness/broker`, `runner` | `runner` |
| The loops in `src/harness/agents`, `src/harness/research`; the roles and tools in `src/agents` | `control/agents` |
| `src/supervisor/advisors` | `control/advisors` |
| The programs in `src/agents/programs`, Pi's view | `plugins/harness-*` |
| `src/harness/targets`, the device images in `containers/` | `plugins/device-*` |
| `src/control/machines`, `clusters`, `runpod` | `plugins/compute-*` |
| `src/cli` | `cli`. A command that needs the control plane's own files (backup, restore, the copy of the store) is the control plane's, and `thermite` starts it there |
| `web/`, `docs/_site`, `kits/`, `examples/`, `scripts/` | `ui`, `website`, `examples/kits`, `examples/campaigns`, `scripts-ci` |
| The compose files, `containers/Containerfile`, `containers/release` | `deploy/` |

## What gets smaller because of the shape

- **An action in one place.** The route, the tool, the command and the client's call are made from one entry, where today each is written by hand (`src/control/api` and `mcp` are 5.8k lines, and the command line's commands 2.8k).
- **Rules that a boundary replaces.** Which part may import which is a line in a `package.json`. Most of the import check (about 600 lines, with 75 recorded exceptions) is not needed.
- **About 14k lines leave the packages** for plugins, and an install that uses no cluster and no RunPod carries neither.
- **One home for shared things.** `src/core` and `src/common` are two today, with a rule to tell them apart.

The shape does not shrink the control plane's own logic. The run sheet's steps do that, and the rule that the door is thin.

## What I am least sure of

1. **One `core`, or two.** `core` mixes what a browser may load with what only Node runs (the bus's client). The entries keep them apart, and a check holds it, as one does today for the app. Two packages (`wire` and `core`) would make the line physical, at the cost of an eighth package and of the question the owner's tree raised: which shared thing goes in which.
2. **Thermy.** By the rule it is a plugin: no run needs it. But it needs a place in the page, and that is a fourth kind of hook, which nothing else needs yet. I would build it in `control/agents` at step 32, behind the same tools as any outside agent, and move it when a second plugin wants a place in the page.
3. **The control plane as one package.** It will be the large one. Its services are entries of one package, not packages: they share the record's types and most of their folders, and a one-machine install starts them as one process. If a service ever needs its own image or its own release, it becomes a package then.

## What changes from the tree as drawn

| In the owner's tree | Here | Why |
| --- | --- | --- |
| `packages/sdk` | Gone. Its contracts and its client are in `core` | Nobody embeds Thermite |
| `packages/core/harness/{harness,fx,claude}.ts` | `core/plugin/harness.ts`, and `plugins/harness-fx`, `harness-claude` | The core names no plugin |
| `packages/core/nats` | `core/bus` | It holds the contract of the boundary, not only the client |
| `packages/control/api`, `mcp` | `control/door`, over `core/api` | Two transports of one list |
| `packages/control/supervisor` | `control/advisors` | Today "the supervisor" is the rig's relay, which goes |
| (not drawn) | `control/record`, `scheduler`, `judge`, `agents` | Goal 258's services need a home |
| `runner-images/` | `plugins/device-*`, each with its image file | A device is one thing |
| `plugins/pi` | `plugins/harness-pi`, with the kind in its name | Three kinds of plugin |
| (not drawn) | `deploy/` | The compose files and the control plane's image |
