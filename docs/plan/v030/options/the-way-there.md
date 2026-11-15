# The way there

How Thermite gets from one `src/` tree to any of the four options. The question is the same for all of them, and it matters more than the choice of tree: v0.3.0 is under way, with 4 of its 35 steps built, and every step must end with the system working.

## What the run sheet already removes

[v0.3.0, step by step](../../v030_release_plan.md) deletes much of today's code whatever the tree is. Moving that code first would be work thrown away.

| What goes | Lines today | At which step |
| --- | --- | --- |
| The old dashboard's pages (`src/control/ui`, `src/control/dashboard`) | 34.5k | 33, the switch |
| Their tests | 22.7k | 33 |
| The rig's own service in the harness: its ledger, its API, its controller (`src/harness/ledger`, `service`, `api`, `controller`, `schema`) | 15.3k | 34, the rig goes; its record moves at 31 |
| The supervisor's relay for a rig (`src/supervisor/relay`, `runners`, `live`, `config`, `kb`) | 2.1k | 34 |
| **At least** | **52k of 220k lines of code, and 23k of 161k lines of tests** | |

More goes if the owner decides it: Pi's glue, Codex and OpenCode with goal 260 (about 3.5k lines for the three programs alone), and the store on SQLite once nobody goes back to it (12.7k).

## Three paths

### A. Move the folders now

One mechanical change: each folder of `src/` moves into its package, imports are rewritten by a script, and nothing else changes. Then the run sheet goes on in the new tree.

- **For:** the new structure is there on the next day. One tree, never two.
- **Against:** it moves the 52k lines that later steps delete, and it gives each folder a place before the step that redesigns it. `src/harness/agents` holds the scheduler and the loops together today; step 31 separates them, and only then is it known which file is the control plane's. It also changes a path in almost every plan, goal and page.
- **Size:** about a week by my estimate, most of it the checks, the images and the docs' paths.

### B. New packages, filled as each step is built (recommended)

The workspaces are set up once. What lives on unchanged moves at once. Everything else moves, or is written new and smaller, in the step of the run sheet that rebuilds it. `src/` shrinks until it is empty, and is then removed.

- **For:** no code is moved that is about to go. New code is written to the new rules from its first line. The system works after every step, and the 35 steps keep their order.
- **Against:** two trees for the rest of v0.3.0, so a rule is needed for where a change goes (below).
- **Size:** a few days for the first step, by my estimate. After it, no step is larger than it was.

### C. A clean tree beside the old

A new repository layout with only what the new model needs. The proven pieces are carried over (the judge's statistics, the broker's wall, the bus's users, the schema). The old tree stays on the released branch and takes fixes.

- **For:** the smallest result, soonest. Nothing old shapes the new.
- **Against:** a long time with nothing that runs a campaign. The tests stop protecting what they test until they are carried over too. It is the opposite of the run sheet's rule that each step is built to its end and looked at. And it sets aside what v0.3.0 has built since 2026-11-12.
- **Size:** not estimated.

## Path B, step by step

**A new step before step 5: the skeleton.** No behaviour changes.

1. `package.json` gets `workspaces`, and the root gets `tsconfig.base.json`.
2. What lives on and is already apart moves: `web/` to `packages/ui`, `docs/_site` to `packages/website`, `kits/` to `examples/kits`, the example contracts to `examples/campaigns`, `scripts/` to its new name. `packages/design-system` stays.
3. The two things that everything else imports move, with a script that rewrites the imports: the contracts (`src/core`, 18k lines) to the package that holds them in the chosen option, and the bus (5.5k lines) to its place. In option 4 both are `packages/core`.
4. `src/` stays where it is, as one more workspace, for what has not moved yet.

**One rule while two trees exist:** `src/` may import a package. A package never imports `src/`. So code moves from the bottom up, and a moved file is never pulled back.

**Then each step fills its package.** In [option 4](option-4-programs-one-core-and-plugins.md)'s names:

| Steps | What is built | Where it lands |
| --- | --- | --- |
| 5, 6 | Search on PostgreSQL, the move | `src/control/store` as now. It was finished there this week, and it moves once, at step 11 |
| 8, 9 | One door for each action; one record for each setting, command and event | `packages/core/api` (the list of actions) and its client; `packages/control/door`; `packages/cli` |
| 10, 11 | A run's tables; the door apart from the record | `packages/control/record` |
| 12 | A run owns its agents | `packages/control/agents` |
| 13 | Machines as a pool | `packages/control/scheduler`; the first `compute-*` plugins, from today's machines, clusters and RunPod |
| 14 to 27 | The screens | `packages/ui`, from parts of `packages/design-system` |
| 29 | One way to run an agent program | `packages/core/plugin/harness.ts`, and a `harness-*` plugin for each program |
| 31 | The agents in the control plane; the runner as one program in one image | `packages/control/agents`, `advisors`, `judge`; `packages/runner`; a `device-*` plugin for each kind of device, with its image file |
| 33 | The switch | The old pages are deleted |
| 34 | The rig goes | What is left of `src/harness` and `src/supervisor` is deleted. `src/` is empty, and is removed |

## Tests

fxbot has no tests, and checks each feature by hand from its phase's checklist. That is not proposed for Thermite: people use Thermite because its verdicts can be trusted, and no checklist finds a wrong rank in a statistics routine.

- **Kept, and moved beside their code:** the tests of what must be right for a result to be trusted. The judge and its statistics, promotion, the wall between a worker and the judge, the record and its migrations on both stores, the bus's permissions, sign-in and roles, the contracts.
- **Gone with their code:** the pages' tests at step 33 (22.7k lines), and the rig's at step 34.
- **For new code:** a test where behaviour can break, written at the door. When each action has one door (step 8), one test of an action covers REST, MCP and the command line.
- **Not written:** tests of a screen's markup. The browser acceptance check and the design system's site cover the look.
- **The acceptance checks** that assume a rig, about 13 of 24, are rewritten at steps 31 and 34, as goal 258's design already says.

## The build

fxbot's server has no build step: Node runs its TypeScript source. Thermite's tests and scripts run that way today; the images and the installed command run a build's output. Without the build, an image copies each package's `src/`, `tsc` only checks types, and the command line's guard against a build older than its source (`src/cli/thermite/fresh.ts`) has nothing to guard. The page, the design system's site and the website keep their builds.

## The rules

Thermite's `AGENTS.md` and `CONVENTIONS.md` are 442 lines against fxbot's 127, and most of the difference is rules that a package boundary makes unnecessary: which part may import which, the order of the folders inside a part, the folder rule.

- **One page of rules for the code,** fxbot's, shared in words by both products: small files on one job, few dependencies, plain TypeScript, no abstraction before a second real use, delete before adding.
- **A package guide** (`packages/AGENTS.md`) with the tree and a "choose the owner" table, as fxbot has.
- **Thermite's own rules stay:** what agents may never do, the public repository's rules, credits, the docs following the code, and the checks.
- **Checks that a boundary replaces go.** The import check shrinks to what a `package.json` can't say. The size check and the loose-ends check stay.

## What stays as it is in every path

- The name of the npm package's command, the compose services' names, the settings' names and the routes. A change of structure changes none of what an installed Thermite shows.
- The design system, and the rule that every component and look is made there.
- One step at a time, each started by the owner, built to its end, then looked at.
