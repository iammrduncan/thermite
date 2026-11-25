# Option 3: a small core and plugins

> **Earlier proposal, 2026-11-15.** Not decided. The current planning is [decisions.md](../decisions.md); where this page differs from it, that page holds. [What is current](../README.md).

fxbot's first rule, applied to Thermite: a small core that every install runs, and plugins for everything an install may leave out. The packages are [option 2's](option-2-fxbots-shape.md) (or [option 1's](option-1-the-tree-as-drawn.md): the plugin line does not depend on which). What changes is how much is in them.

## Core or plugin

fxbot asks of each feature: is this core, or a plugin? Its default answer is plugin. For Thermite:

**Core is only:**

- **What every run needs:** a campaign and its contract, a run, the record, the scheduler, measuring and the judge's decisions, promotion, the knowledge base, and one way to run an agent.
- **What plugins plug into:** the plugin API, and adding, checking and updating a plugin.
- **What Thermite needs to run:** sign-in and roles, sealed secrets, migrations, backup and restore, the bus.

**Proposed as never a plugin (2026-11-15):** measurement, verdicts, completion and promotion; the record's writer; the wall between a worker and the judge; who may do what. This list went further than the settled decision, which is only that a run's agents never judge, and it would stop anyone from adding a judge, a campaign mode, a promotion rule, an advisor or a wall of their own. It is reopened as [decision 16](../decisions.md#open-decisions), with a narrower rule proposed there.

**Plugins, from what is built in today:**

| Kind of plugin | Built in today | Lines today | What a plugin of this kind carries |
| --- | --- | --- | --- |
| An agent harness | Pi (in Thermite's own code), Claude Code, Codex, OpenCode | The three programs 3.5k, Pi's view 1.1k | How to start, feed, stop and read one agent program, behind `harness.ts` |
| A kind of device | CPU, CUDA, Vulkan | The target drivers 0.7k, and each image | A target driver for the runner and its image file. `runner-images/` becomes these plugins' images |
| A source of compute | Machines over SSH, Kubernetes clusters, RunPod | 0.9k, 4.3k, 3.5k | How to find, start and stop a machine, and put the runner on it |
| A tool server for agents | MCP servers | 1.2k | Already data the owner adds. No code moves |
| A retention policy's kind | Seven kinds | 0.6k, and their tables | What it may remove, and when |

fxbot's own list suggests more kinds that Thermite has no code for yet: a provider's sign-in, a screen in the app, a tool for Thermy.

## The tree

```text
packages/             as option 2 (or option 1)
plugins/
  harness-pi/         plugin.json, server.ts
  harness-codex/
  harness-opencode/
  device-cpu/         plugin.json, runner.ts, Containerfile
  device-cuda/
  device-vulkan/
  device-rocm/        named in the owner's tree; not built
  device-metal/
  device-esp32/
  compute-ssh/
  compute-kubernetes/
  compute-runpod/
```

fx and Claude Code stay in the core: one is the default harness, and the other is the only way to use a Claude subscription.

## The rules, from fxbot's

- The core never imports or names a plugin. Its lists name the plugins it suggests, as data.
- A plugin that is not added costs nothing: no process, no table, no request, no code in the page.
- A plugin's data is in tables of its own, which it makes and removes. Never in a core migration.
- Thermite's own plugins use the same API as anyone's. If one needs a way into the core, the API lacks a hook.
- When a plugin can't do what it needs, the API gets the smallest hook that it needs. The feature is not built in the core.
- A change that breaks the plugin API is listed, with the release that made it, so that a plugin that can't run shows as unsupported.

## One manifest for both products

An fxbot plugin is a folder with a `plugin.json`. What fxbot reads is under one key of it, `extensions["sh.fxbot"]`. So one folder can carry a second key for Thermite:

```json
{
  "name": "thermite",
  "version": "0.1.0",
  "extensions": {
    "sh.fxbot": { "minFxbot": "0.10.0", "server": "./fxbot/server.ts" },
    "com.usethermite": { "minThermite": "0.3.0", "server": "./thermite/server.ts" }
  }
}
```

That is the cheapest alignment of the two products: one way to write, find, add and update a plugin, and one registry. A bot of fxbot's that steers Thermite, and a tool that Thermy gets, could then be one plugin.

## What it costs

- **A plugin API is new work, and a promise.** fxbot's is about a sixth of its SDK (1.3k of 8.0k lines) and has its own list of breaks. Thermite's needs at least three kinds of hook from the start (a harness, a device, a source of compute), and each is a contract that outside plugins then rely on.
- **Where a plugin's code runs.** A harness plugin and a compute plugin run in the control plane's process, with its rights. A device plugin's code runs on a machine. Each is installed by the owner, and is trusted as the owner's own code is. That must be said plainly, since Thermite's walls are a reason people trust its results.
- **fxbot's own warning:** no abstraction before a second real use. Agent harnesses, devices and sources of compute each have three or four uses today, so they pass. Retention kinds and the rest do not need an API yet.
- **Tests and acceptance checks** are written per plugin. About half of today's 24 acceptance checks are about what would become plugins: Claude Code, Codex, the terminals, clusters, machines, RunPod.
- **It is the longest way.** Nothing in the run sheet needs it before step 29 (one way to run an agent program), which is the natural place for the first hook.

## What it gives

- **The smallest core.** About 14k lines of today's code are sources of compute, agent programs and devices: they leave the core, and an install that uses none of them carries none of them.
- **A new device or a new cloud without a change to Thermite.** ROCm, Metal and ESP32, which the owner's tree names, are each one folder that anyone can write.
- **The same shape as fxbot and Pi,** which the owner already works in.

## When to choose it

When others are to add devices, clouds and agent programs without the maintainers, and when the core being small matters more than v0.3.0 being soon. It can also be chosen later: options 1 and 2 both leave `plugins/` open, and the first hook can come at step 29.
