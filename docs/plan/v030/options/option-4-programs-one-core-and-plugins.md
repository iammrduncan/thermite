# Option 4: programs, one core, and plugins

> **Earlier proposal, 2026-11-15.** Not decided. The current planning is [decisions.md](../decisions.md); where this page differs from it, that page holds. [What is current](../README.md).

The tree I would suggest. It is [option 1](option-1-the-tree-as-drawn.md) after the rules of options [2](option-2-fxbots-shape.md) and [3](option-3-small-core-and-plugins.md) are applied to it, and after the owner's steer of 2026-11-15: no SDK, since nobody embeds Thermite in another product; core or plugin; and a control plane and a runner that share a common core.

[option-4.html](option-4.html) draws it as a page: the conventions, the packages and who imports whom, a sketch of each package's files, where a change goes, the boundaries, one machine and several machines, how the two planes use NATS, and what of today's code is core, a plugin or going. Open the file in a browser; it loads nothing from the network.

## Three rules give the tree

1. **A package is a program, or what two programs share.** Thermite has five programs (the control plane, the runner, the command line, the dashboard's app, the website) and two shared things (the core, the design system). That is seven packages, and no rule is needed to say whether an eighth is due.
2. **Every boundary between two programs has one folder in the core,** and nothing crosses a boundary that is not written there. The two planes never import each other.
3. **Core or plugin.** What every run needs is in the packages. What an install may leave out is a plugin, and the core never names one.

## The conventions

They are fxbot's, taken as they are, so that both products read the same way. fxbot's conventions open with four choices, and with one more line: a smaller solution that does the job beats a rule kept from an older design.

| The choice | What it does in this tree |
| --- | --- |
| Simplicity over complexity | Three rules place every file. A boundary is a line in a `package.json`. An action is written once |
| Small over huge | Seven packages. A file does one job and reads in one sitting. An eighth package needs a second real consumer |
| Light over heavy | Few dependencies, each with a reason. A plugin that is not added costs nothing: no process, no table, no code in the page |
| Performance over other things | What a person waits on stays fast: a screen's first view, an action's answer, a job's start. A change says what it adds to those |

One thing is above all four: agents propose, and code they cannot write measures and judges. No convention trades that away.

For the code:

| The rule | What it does in this tree |
| --- | --- |
| Small files, each on one job. Split one that is hard to read in one sitting | A package's `src/` is flat: a file for each thing, and a folder only when a thing needs several files |
| Few dependencies. Node and the browser first | A `package.json` stays short enough to read. A new line in one is a decision, with its reason and its credit |
| No abstraction before its second real use. A few repeated lines are fine | Three kinds of plugin, each with several real uses. A fourth kind, a new hook or an eighth package waits for its second use |
| Plain TypeScript: functions and data. No classes, frameworks or wrappers unless a library needs one | An action is an entry in a list and a function. A plugin is a `plugin.json` and a file of functions |
| Delete before adding. No hook, option or layer for a use that is not real yet | `door/` holds no rule, so nothing collects there. What a step replaces is deleted in that step |
| Name a thing for what it is | One word for each thing, the same in a folder, the API, a screen and the docs: door, record, scheduler, judge, runner |
| Check outside input once, at the edge that receives it | The door checks an action's input against its entry in `core/api`, and the function behind it does not check again. The runner checks a message against `core/bus` |
| Keep what a person waits on fast | A change says what it adds to a screen's first view, an action's answer or a job's start: in requests, in work, in page weight |
| Test behaviour that can break, on data that can be thrown away | Tests are beside their code, in each package's `tests/`. One test of an action covers REST, MCP and the command line |
| The source runs as it is | Node runs each package's TypeScript. Only what a browser loads is built: `ui`, the design system's site, `website` |
| Records in PostgreSQL, one statement or one transaction for each change | `control/record` is the one writer. A change to a table is a new numbered file in `migrations/`, never an edit of one that shipped |
| A secret is sealed before it is stored, and never reaches the page | Keys stay in the control plane, sealed. `core/client` and `ui` never hold one |
| The smallest change that does the task | A step builds what it needs, in the package that owns it, and no more |

For core or plugin, the default is plugin: before a feature is built, its goal says which it is, and why. Core is only what every run needs, what plugins plug into, and what Thermite needs to run.

- **What a plugin may count on.** The core never imports or names it, and which plugins a new install gets is a list, as data. Thermite's own plugins use the same API as anyone's. When a plugin cannot do what it needs, the API gets the smallest hook for it, on the day a real plugin needs one. A release that breaks the API says so in one list, and a plugin names the oldest Thermite it runs on.
- **What the core may count on.** A plugin that is not added costs nothing. A plugin's data is its own, in tables or files that it makes and removes, never in a migration of the core. Removing a plugin leaves the core working. What is closed to a plugin is open: [decision 16](../decisions.md#open-decisions).

Thermite goes its own way in three places, each for what it is:

- **No SDK.** fxbot is put inside other products. Nothing embeds Thermite: other things talk to it, through the door.
- **Two programs, and a bus.** fxbot is one server. Thermite has a second program, on other machines, so it has one more boundary, and NATS for it.
- **Tests.** fxbot checks each feature by hand. A wrong rank in a statistics routine is not found by hand, so what a verdict rests on has tests.

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
    campaigns.ts, runs.ts, knowledge.ts, …  one file for each thing the record holds,
                        a folder once one file is not enough
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

### A sketch of the files

The folders above follow from the three rules. The files below show the grain, as fxbot's packages have it: each is named when its step is built. In this page `core/api` is short for `packages/core/src/api`.

```text
packages/core/            @thermite/core · what two or more programs share
  package.json            its doors: ./api, ./events, ./campaign, ./client, ./bus, ./plugin
  src/
    api/                  the list of actions
      action.ts           what an action is: its name, input, answer, role, route, tool, command and words
      campaigns.ts        the actions on a campaign
      runs.ts             the actions on a run: start, pause, stop, steer
      machines.ts         the actions on the pool
      knowledge.ts        the actions on the knowledge base
      index.ts            the whole list
    bus/                  NATS
      subjects.ts         every subject, made by a function
      messages.ts         each message's shape: a command, a job, a result, a live line, an ask
      streams.ts          each stream, and how it keeps its messages
      permissions.ts      who may publish and read what
      client.ts           connect, publish, take. Node only
    events/               the record's events
      run.ts              a run's events
      attempt.ts          an attempt's: built, measured, judged
      machine.ts          a machine's: joined, lost
      index.ts            every kind, by name
    campaign/             what a person writes
      contract.ts         a campaign's contract
      kit.ts              a kit's manifest
    plugin/               what a plugin is
      manifest.ts         plugin.json
      harness.ts          an agent program: start a turn, send a message, stop, give the usage
      device.ts           a kind of device: find them, give a job its share, measure
      compute.ts          a source of machines: find, start and stop one, put a runner on it
      breaks.json         what each release broke for plugins
    client.ts             the typed client of the door, made from api/. fetch alone
    settings.ts           every setting: its name, its kind, its words
    errors.ts             an error's code and its words
  tests/

packages/control/         @thermite/control · the control plane
  package.json            imports core, and nothing else of Thermite
  src/
    main.ts               starts one service, or all four
    door/                 transports only
      rest.ts             a route for each action
      mcp.ts              a tool for each action
      stream.ts           changes, sent to the open screens
      session.ts          sign-in and roles
    record/               the one writer
      schema.ts           the tables
      migrations/         one numbered file for each change
      apply.ts            events from the bus into the tables, each once, in order
      queries.ts          what the actions and the screens read
      backup.ts           backup and restore
    scheduler/            who works where
      pool.ts             the machines and their devices
      place.ts            which device a run's next job gets
      jobs.ts             a job's life: given, taken, done, lost
    judge/                what wins
      verdict.ts          a verdict from measurements
      stats.ts            the statistics
      promote.ts          a new champion
    agents/               a run's agents
      worker.ts           a worker's loop
      planner.ts          the planner's
      zone.ts             each worker's sandbox
      tools.ts            a run's tools: submit a change, run an experiment, write a note
      context.ts          what an agent is told, built from the record
    advisors/             who watches a run
      teachers.ts
      auditor.ts
      review-panel.ts
    campaigns.ts          campaigns, their contracts, their kits
    runs.ts               a run: its state, its budget, what ends it
    knowledge.ts          the knowledge base
    providers.ts          model providers and their keys
    plugins.ts            finds, checks, adds and loads plugins
    secrets.ts            sealing
  tests/

packages/runner/          @thermite/runner · the one program on a machine
  package.json            imports core, and nothing else of Thermite
  src/
    main.ts               joins the pool, takes jobs from the bus
    jobs/                 what a machine is asked to do
      build.ts            builds a change for the device
      measure.ts          the judge's measurement
      experiment.ts       a worker's own experiment
    wall/                 keeps a change from the judge's files
      users.ts            a user for the judge, a user for each worker
      limits.ts           what a job may use
      check.ts            proves the wall holds, before the first job
    device.ts             loads the device plugin of its image
    report.ts             what happened, onto the bus
  tests/

packages/cli/             @thermite/cli · the thermite command
  package.json            imports core
  src/
    main.ts               a command for each action, made from core/api
    local.ts              sets Thermite up on this machine
    doctor.ts             checks the machine
  tests/

packages/ui/              @thermite/ui · the dashboard's app
  package.json            imports core and design-system
  index.html
  vite.config.ts
  src/
    main.tsx              the entry
    app.tsx               the routes and the shell
    client.ts             the page's one client, from core/client
    screens/              one file for each screen, made of the design system's parts

packages/design-system/   the look, for Thermite and later for fxbot
  package.json            imports nothing of Thermite
  src/
    theme.css             every colour by its use, in light and in dark
    ui/                   the stock components
    parts/                the brand's parts
    index.ts              its door
  site/                   every part, with its states and its code

packages/website/         the public site and the documentation
  package.json            imports design-system
  src/
    content/docs/         the documentation's pages
    pages/                the public site

plugins/                  what an install may leave out
  harness-fx/             an agent harness
    plugin.json           its kind, its name, the oldest Thermite it runs on
    control.ts            implements core/plugin/harness.ts
    README.md
    tests/
  harness-claude/
  harness-pi/             the same shape
  device-cuda/            a kind of device
    plugin.json
    runner.ts             implements core/plugin/device.ts
    Containerfile.cuda12  builds the runner for this device
    Containerfile.cuda13
    tests/
  device-cpu/
  device-vulkan/          the same shape, one image file each
  compute-runpod/         a source of machines
    plugin.json
    control.ts            implements core/plugin/compute.ts
    tests/
  compute-ssh/
  compute-kubernetes/     the same shape

beside the packages       the top of the repository
  AGENTS.md               what Thermite is, the rules for agents, the checks
  CONVENTIONS.md          one page: the conventions above
  package.json            the workspaces
  packages/AGENTS.md      the package guide: this tree, and where a change goes
  examples/
    kits/                 smoke-cpu, smoke-cuda, smoke-vulkan
    campaigns/            a contract of each mode, ready to start
  deploy/
    compose.yaml          one machine: control, PostgreSQL, NATS, a runner
    compose.runner.yaml   a runner alone, for another machine
    Containerfile         the control plane's image
  scripts-ci/
    build/                the images, the release
    checks/               the public check, sizes, loose ends, the acceptance checks
  docs/
    plan/                 the roadmap, the goals, the decisions
```

### Where a change goes

| If the change is about… | It goes in… | Why |
| --- | --- | --- |
| What an action is called, what it takes and answers, who may call it | `core/api` | REST, MCP, the command line and the client are made from it |
| What an action does, and when it is refused | The file of the thing it changes: `control/runs.ts`, `control/scheduler` | The rule has one place, whatever the transport |
| A URL, a status code, a header, MCP's framing, a session | `control/door` | Transport only |
| A table, a migration, a query | `control/record` | The record has one writer |
| A message between the planes, a stream, who may read a subject | `core/bus` | Neither plane can send what is not written there |
| A kind of event, or what one holds | `core/events` | Everyone who reads the record reads one shape |
| Which device a job gets, and a job's life | `control/scheduler` | The pool is the control plane's |
| When a change wins | `control/judge` | Never an agent's. Whether a plugin the owner adds may judge is [decision 16](../decisions.md#open-decisions) |
| What happens beside the device: a build, a measurement, the wall | `runner` | It is the only code on the machine |
| How a run's agents work: a loop, a tool, what an agent is told | `control/agents`, `control/advisors` | A run owns its agents |
| How one agent program is started and read | `plugins/harness-*` | The core names no program |
| A new kind of device, or a new place to get machines | A new folder: `plugins/device-*`, `plugins/compute-*` | It touches nothing else |
| A screen | `ui/src/screens` | The page holds no rule of the product |
| A component, or a look | `design-system` | Every screen gets it |

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

**Proposed as never open to a plugin (2026-11-15):** measurement, verdicts, completion, promotion, the record's writer, the wall, and who may do what. This list went further than the settled decision, which is only that a run's agents never judge, and it would stop anyone from adding a judge, a campaign mode, a promotion rule, an advisor or a wall of their own. It is reopened as [decision 16](../decisions.md#open-decisions), with a narrower rule proposed there.

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
