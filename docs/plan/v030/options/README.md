# v0.3.0's structure: the options

**Status:** earlier proposals, written on 2026-11-15 at the owner's request. None is chosen, and nothing of them is built. The discussion goes on in [decisions.md](../decisions.md), which is the current planning: its open decisions carry on the questions at the end of this page, and where this folder differs from it, that page holds. Until the owner chooses, [v0.3.0, step by step](../../v030_release_plan.md) stands as it is. [What is current](../README.md) sorts all of v0.3.0's plans.

The owner read options 1 to 3 on the same day, and steered: think what option 1 is with the rules of options 2 and 3 applied; core or plugin; a control plane and a runner with a common core; and no SDK, since Thermite is not put inside other products. [Option 4](option-4-programs-one-core-and-plugins.md) is the answer, and it is the one recommended. [option-4.html](option-4.html) draws it as a page.

## What was asked

- Use v0.3.0 to fix how the code is put together, so that a person finds their way in it and its pieces can be used in other projects.
- One repository with several packages, as small as the job allows, on the conventions of the maintainers' [fxbot](https://github.com/iammrduncan/fxbot).
- A control plane that does most of the work, and a runner plane that does only what needs a device or heavy data, as a data plane does.
- Line up with fxbot early: one design system for both, and Thermy.
- Keep what v0.3.0 has started.

The starting point is the owner's tree, [v030_idea.txt](../../v030_idea.txt).

## What was read

| | fxbot 0.10.0 | Thermite at `623bccfa` |
| --- | --- | --- |
| Packages | 4 npm workspaces: `sdk`, `server`, `ui`, `website` | 1 package (`src/`), with `web/` and `packages/design-system` installed apart |
| Code | `sdk` 8.0k lines, `server` 0.5k, `ui` 10.3k, `website` 1.4k | `src/` 220k lines in 1,204 files: control 100k, the harness 58k, the agents' code 18k, the contracts 18k, the supervisor 16k, shared tools 6k, the command line 5k |
| Tests | None, by choice: behaviour is checked by hand from each phase's checklist | 161k lines, and 24 acceptance scripts (14k lines) |
| Build | None for the server: Node runs the TypeScript source. Only the page is built | `tsc` builds `dist/` for the images |
| Plugins | 13, outside the workspaces, each with a `plugin.json` | None. Four agent programs, three kinds of device and three sources of compute are built in |
| Rules for agents | `AGENTS.md` 73 lines, `CONVENTIONS.md` 54, a package guide 108 | `AGENTS.md` 145 lines, `CONVENTIONS.md` 297 |

fxbot's rules that matter most here, in short:

- Logic, storage and input checks are in the SDK. The server only adds HTTP. The page imports only the SDK's client.
- A new package needs a second real consumer. No abstraction before a second real use.
- A small core that every install runs, and plugins for everything else. The core never names a plugin.
- Files small and on one job. Few dependencies. Plain TypeScript, no classes unless a library needs them.

## What is the same in every option

- **One repository, npm workspaces, one lock file,** packages named `@thermite/<name>`, a `tsconfig.base.json` at the root and one `tsconfig.json` in each package.
- **Two planes.** The control plane holds the door (dashboard, REST, MCP), the record, the agents' loops, the scheduler and the judge's decisions. The runner plane is one light program on a machine: builds, measurements and a worker's experiments on a device. This is [goal 258's design](../../goal-258-design.md), agreed on 2026-11-12. The options change where its code lives, not what it does.
- **PostgreSQL** for the record and **NATS** between the planes.
- **`packages/design-system`** stays as it is, and is the one both products use later, each with its own colours.
- **One image file for each kind of device** (in a `runner-images/` folder in options 1 to 3, in each device's own plugin in option 4), and **`examples/`** with the kits and the campaigns.
- **The settled decisions hold:** agents never judge; the harness owns all research state; measurement, verdicts and promotion are code the agents cannot write. Whether a plugin the owner adds may judge is not settled: [decision 16](../decisions.md#open-decisions).
- **A word changes its meaning.** Today "the harness" is the rig's service that judges. In the owner's tree, a harness is what runs an agent (`fx.ts`, `claude.ts`). The old meaning goes with the rig (goal 276), and the options use the new one.

## The options at a glance

| | [1. The tree as drawn](option-1-the-tree-as-drawn.md) | [2. fxbot's shape](option-2-fxbots-shape.md) | [3. A small core and plugins](option-3-small-core-and-plugins.md) | [4. Programs, one core, and plugins](option-4-programs-one-core-and-plugins.md) |
| --- | --- | --- | --- | --- |
| Packages | 8: `design-system`, `cli`, `ui`, `control`, `runner`, `sdk`, `core`, `website` | 6: `sdk`, `control`, `runner`, `ui`, `website`, `design-system` | Option 2's 6, with a plugin API in `sdk` | 7: `core`, `control`, `runner`, `cli`, `ui`, `design-system`, `website` |
| Where behaviour lives | In `control` and `runner`; shared runtime in `core`; contracts and the client in `sdk` | In `sdk`. `control` and `runner` are thin programs around it | In `sdk`, and in plugins for all that an install may leave out | In `control` and `runner`. `core` holds only what crosses a boundary. Plugins hold what an install may leave out |
| Where the planes show | In the tree: `control`, `runner`, `runner-images` | In two thin packages; the rest is one SDK | As option 2 | In the tree: `control`, `runner`, and one folder of `core` for the bus between them |
| Plugins | `plugins/pi`, for a second agent harness | None at first | Agent harnesses, kinds of device, sources of compute, and more | Three kinds: every agent harness, every kind of device, every source of compute |
| Work beyond the run sheet | The least | Little more than option 1 | The most: a plugin API, kept stable from then on | A plugin API of three interfaces, each made at the step that rebuilds its part |
| Closest to | What the owner drew | fxbot's four packages | fxbot's core-or-plugin rule | The owner's steer |
| Its risk | Two shared packages (`core`, `sdk`) whose line must be kept | One very large package | Hooks made before their second use | One `core` that both a browser and Node load from; a large `control` |

How to get from today's tree to any of them is one question for all three: [the way there](the-way-there.md).

## What I recommend

**[Option 4](option-4-programs-one-core-and-plugins.md), by path B of [the way there](the-way-there.md).**

- **Seven packages from one rule:** a package is a program, or what two programs share. The control plane, the runner, the command line, the app and the website are programs. The core and the design system are shared.
- **No SDK.** What others need of Thermite is a client and MCP to talk to it, and a plugin interface to add to it. Both are small parts of the core.
- **Each boundary has one folder in the core.** `core/api` is the list of actions, and REST, MCP, the command line and the client are all made from it. `core/bus` is everything the control plane and a runner say to each other over NATS. The two planes never import each other.
- **Core or plugin, for three kinds** that each have several real uses today: agent harnesses, kinds of device, sources of compute.
- **Path B** (new code goes into the new packages as each step of the run sheet is built, and the old tree shrinks until it is empty) moves no code that a later step deletes. At least 52k of today's 220k lines are such code: the old dashboard's pages, and what exists only for the rig ([the count](the-way-there.md#what-the-run-sheet-already-removes)).

## Questions for the owner

These continue as rows 1 to 8 of [the open decisions](../decisions.md#open-decisions), where the owner's calls are recorded.

1. **The tree:** option 4, or what to change in it. Its own page ends with [what differs from the tree as drawn](option-4-programs-one-core-and-plugins.md#what-changes-from-the-tree-as-drawn), and with the three things I am least sure of.
2. **Every harness as a plugin,** fx and Claude Code too, with the default as a line of data. That keeps the tree from deciding [goal 260](../../goals/260-fxbot-and-thermite.goal), whose study found six things that do not fit fx yet. Agreed, or is fx in the core?
3. **A device's image file in its plugin,** and no `runner-images/` folder at the top. Agreed?
4. **Thermy:** in `control/agents` at first, and a plugin when a second plugin needs a place in the page. Agreed?
5. **Tests.** fxbot has none. Thermite has 161k lines, and gates a release on them. My proposal is in [the way there](the-way-there.md#tests).
6. **A build step.** fxbot's server runs its TypeScript source. Thermite builds `dist/`. Running the source removes the build from every image but the page's. Wanted?
7. **One manifest for a plugin** that both fxbot and Thermite read ([option 3](option-3-small-core-and-plugins.md#one-manifest-for-both-products)).
8. **The run sheet.** With path B the 35 steps keep their order, and one step is added before step 5. Agreed, or is the order open too?
