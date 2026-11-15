# Option 1: the tree as drawn

The owner's tree, [v030_idea.txt](../../v030_idea.txt), filled in: what each folder holds, what of today's code goes into it, and the lines the tree leaves open.

## The tree

```text
examples/
  kits/               smoke-cpu, smoke-cuda, smoke-vulkan
  campaigns/          contracts that run on those kits
runner-images/        one image file for each kind of device:
                      cpu, cuda12, cuda13, vulkan, rocm, metal, esp32
docs/                 the plans and the goals
packages/
  design-system/      the look: theme, parts, its own site      (as today)
  sdk/                what others build on: the contracts and the typed client
  core/               the runtime both planes run
    harness/          how an agent is run: harness.ts (the one interface),
                      fx.ts, claude.ts
    nats/             the bus: subjects, streams, users, the client
  control/            the control plane
    api/              REST and the stream of changes
    mcp/              the MCP server
    record/           the store: tables, migrations, a run's tables     (added)
    scheduler/        the pool, the jobs, the judge's decisions         (added)
    agents/           the loops: workers, planner; each worker's zone   (added)
    supervisor/       the advisors: teachers, auditor, review panel
  runner/             the runner plane: one program on a machine
  ui/                 the dashboard's app
  cli/                the thermite command
  website/            the public site and the documentation
plugins/
  pi/                 Pi as a second agent harness
scripts-ci/
  build/              images, the release bundle
  checks/             the public check, sizes, loose ends; the acceptance checks
```

Three folders are added to `control` that the drawing does not have: the record, the scheduler and the agents. They are goal 258's services. Without them, `api` would hold them, and it would stop being a door.

## What goes where

| Today | Lines | In this tree |
| --- | --- | --- |
| `src/core` (API shapes, events, commands, the knowledge base's contracts) | 18k | `packages/sdk`, with the client that `ui` and `cli` call |
| `src/common/bus`, `src/control/bus`, `src/core/link` | 5.5k | `packages/core/nats` |
| `src/agents` (the programs, the roles' prompts, the tools, compaction, the terminal host) | 18k | `packages/core/harness` for the interface, fx and Claude Code; `plugins/pi` for Pi. Codex and OpenCode: plugins, or gone, as goal 260 decides |
| `src/control/api`, `src/control/mcp` | 5.8k | `packages/control/api`, `mcp` |
| `src/control/store`, `views`, `events`, `live` | 29k | `packages/control/record` |
| `src/control/clusters`, `runpod`, `machines`, `rigs` | 11k | `packages/control/scheduler`, as the pool's sources of machines |
| `src/control/campaigns`, `kits`, `kb`, `providers`, `mcp-servers`, `retention`, `issue`, `system` | 12k | Folders of `packages/control`, each as it is |
| `src/control/ui`, `src/control/dashboard` | 34k | Nowhere: `packages/ui` takes their place at the switch (step 33) |
| `web/` | 2k | `packages/ui` |
| `src/supervisor/advisors`, `advisor-runs` | 9k | `packages/control/supervisor` |
| The rest of `src/supervisor` (the relay for a rig) | 6k | Nowhere: it goes with the rig |
| `src/harness/judge`, and the scheduler in `src/harness/agents` | 6k and part of 13k | The decisions: `packages/control/scheduler`. The measuring: `packages/runner` |
| `src/harness/agents`, `research` | 21k | `packages/control/agents` |
| `src/harness/broker`, `targets`, `runner`, `selftest` | 8k | `packages/runner` |
| `src/harness/ledger`, `service`, `api`, `controller`, `schema` | 15k | Nowhere: the record is the control plane's, and the rig's own service goes |
| `src/cli` | 5k | `packages/cli` |
| `docs/_site` | 151 pages | `packages/website` |
| `containers/` | | `runner-images/`, and one image file for the control plane |
| `kits/`, `examples/` | | `examples/kits`, `examples/campaigns` |
| `scripts/` | 18k | `scripts-ci/` |
| `tests/` | 161k | Beside the code: `packages/<name>/tests` |

## Who may import whom

```text
ui, cli ──► sdk (the client and the contracts only)
control ──► core ──► sdk
runner  ──► core ──► sdk
plugins ──► core (the harness interface), sdk
design-system: nothing of Thermite        website: design-system only
```

- Each arrow is a line in a `package.json`. A package that is not named there can't be imported, so most of today's import check (about 600 lines, with 75 recorded exceptions) is not needed.
- `control` and `runner` never import each other. They meet on the bus, through the contracts in `sdk`.
- `sdk` does no I/O but the client's `fetch`. A browser can load all of it.

## The line between `core` and `sdk`

This is the tree's one hard line. Both are shared, so a new file can go in either.

- **Proposed rule:** `sdk` is what a program outside Thermite needs to talk to Thermite. `core` is what a program that is part of Thermite needs to run.
- **Its test:** fxbot's plugin for Thermite, a script of the owner's and the dashboard need `sdk` and never `core`.
- **The second consumer of `core/harness`:** the control plane's agents, and Thermy. If fxbot itself is to use it (an agent on fx, or on Claude Code for a Claude subscription), it is a package for both products, and then it must import nothing else of Thermite.

## What it costs

- **Beyond the run sheet:** setting up the workspaces, and moving the parts that live on (`web`, the site, the kits, the scripts). The rest moves as its step is built ([the way there](the-way-there.md)).
- **Eight packages** against fxbot's rule of a second consumer: each has one, with the note on `core` above. `cli` is its own package because it is installed on a person's computer without the rest.
- **What it does not make smaller by itself:** the code inside `control`. A tree does not delete lines. The run sheet's steps do, and the rule that each door is thin.

## When to choose it

When the planes should be the first thing a person sees in the repository, and the owner's own words for the parts should be the names of the folders.
