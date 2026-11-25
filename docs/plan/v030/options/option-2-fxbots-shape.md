# Option 2: fxbot's shape

> **Earlier proposal, 2026-11-15.** Not decided. The current planning is [decisions.md](../decisions.md); where this page differs from it, that page holds. [What is current](../README.md).

fxbot's four packages, plus the two that Thermite needs and fxbot does not: a runner, since Thermite has a second program on other machines, and the design system, which exists. All behaviour is in one SDK. Every program is a thin shell around it.

## The tree

```text
examples/             kits/ and campaigns/
runner-images/        one image file for each kind of device
deploy/               the compose files, and the image file of the control plane
docs/                 the plans and the goals
packages/
  sdk/                @thermite/sdk: everything Thermite does
    src/
      index.ts        createThermite(): the control plane in one call
      record/         the store: tables, migrations, a run's tables
      runs/           campaigns, runs, attempts, verdicts, promotion
      scheduler/      the pool, the jobs, the judge's decisions
      agents/         the loops and the roles; harness.ts, fx.ts, claude.ts
      advisors/       the teachers, the auditor, the review panel
      knowledge/      the knowledge base
      bus/            NATS: subjects, streams, users
      wire/           the contracts: events, commands, API shapes; no I/O
      client.ts       @thermite/sdk/client: the typed client
      cli/            the thermite command, on the client
  control/            @thermite/control: HTTP, MCP, and the process's start
  runner/             @thermite/runner: the program on a machine
  ui/                 @thermite/ui: the dashboard's app
  website/            the public site and the documentation
  design-system/      the look
scripts/              what writes made files, and the checks
```

The SDK has three doors, as fxbot's has two:

| Import | For | Holds |
| --- | --- | --- |
| `@thermite/sdk` | A backend that runs Thermite in its own process: `control`, a test, another product | The behaviour |
| `@thermite/sdk/client` | Anything that talks to a running Thermite: `ui`, the command line, fxbot's plugin, a script | `fetch` calls, the stream's parsing, the types |
| `@thermite/sdk/wire` | `runner`, and anything that reads Thermite's events | The contracts, with no runtime imports |

## Choose the owner

fxbot's package guide has this table, and it is what keeps its code where a person looks for it. For Thermite:

| If the change concerns… | Put it in… | Why |
| --- | --- | --- |
| What a campaign, a run or an attempt is; what a command does; what is accepted | `sdk/src/runs`, `scheduler`, `agents` | The same behaviour must work without HTTP, from MCP and from a test |
| A table, a migration, a query | `sdk/src/record` | The SDK owns the record |
| A shape that crosses a process boundary | `sdk/src/wire` | One home for each contract |
| A URL, a status code, a body limit, a header, MCP's framing | `control` | Transport only. It calls the SDK |
| What must happen on the machine with the device | `runner` | It is the only code there |
| A screen | `ui`, from parts of `design-system` | The page imports only the client |

## What goes where

As [option 1's table](option-1-the-tree-as-drawn.md#what-goes-where), with these differences:

- What option 1 puts in `packages/control/{record,scheduler,agents,supervisor}` and in `packages/core` goes into `packages/sdk/src`.
- `packages/control` keeps only `api` and `mcp`: today 5.8k lines, to be made thinner as each action gets its one door (step 8 of the run sheet).
- `src/cli` goes into `packages/sdk/src/cli`, and is the SDK's `bin`. It needs only the client.
- There is no `core` package and no `cli` package.

## Who may import whom

```text
ui ──► sdk/client          control ──► sdk          runner ──► sdk/wire
```

Three arrows. The `exports` of the SDK's `package.json` are the whole rule: what is not exported can't be imported.

## What it costs

- **One very large package.** fxbot's SDK is 8k lines in 30 flat files. Thermite's would hold what is today most of control without its pages (66k lines), the harness's loops and decisions, and the advisors. It needs folders, and a rule for which folder imports which. That rule is today's "order inside a part", moved into the SDK.
- **The planes show less.** A person sees `control` and `runner` as two small packages, and must open the SDK to find the scheduler.
- **A name that may mislead.** In fxbot, "the SDK" is also what another developer builds an app on. Thermite's would be that and the control plane's own engine.
- **Beyond the run sheet:** as option 1.

## What it gives

- **fxbot's rules apply word for word.** "Logic, storage and input checks belong in the SDK; the server only adds HTTP; the page imports only the client." One guide could serve both products.
- **The fewest packages** that Thermite can have with two programs.
- **Embedding is one import.** A product that wants Thermite inside it calls `createThermite()`. A product that wants to steer a running one imports the client. Thermy and fxbot's plugin are the second kind.
- **A thin door by construction.** A route that holds logic has nowhere to put it.

## When to choose it

When one rule book for fxbot and Thermite matters more than seeing the planes in the tree, and when another product running Thermite in its own process is a real wish.
