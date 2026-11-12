# How Thermite is planned

Thermite's plans are public. These files hold them:

| File | What it holds |
| --- | --- |
| [roadmap.md](roadmap.md) | Every goal, grouped by version, in priority order. One line each. |
| [release-v0.1.0.md](release-v0.1.0.md) | The plan for v0.1.0, the first release: its scope, its goals, its decisions and the steps to ship it. |
| [release-v0.3.0.md](release-v0.3.0.md) | The plan for v0.3.0, the dashboard's refresh and the code's structure behind it: what is decided, what the owner has to decide, its goals and their order. |
| [decisions.md](decisions.md) | Settled decisions that shape the whole product, with dates. |
| [goals/](goals/) | One goal per roadmap item: what it delivers, why, when it is done, its decisions and its progress. |
| [code-clean-up-guide.md](code-clean-up-guide.md) | The guide for the code clean-up of v0.1.1 (goal 125), from the v0.1.1 audit: the map of the code, the themes of change, the rules of shape, the order of work, what to leave, the review guide and the owner's questions. |
| [app-build-plan.md](app-build-plan.md) | The plan for building the dashboard's app from the mockup the owner agreed (2026-11-12): what the mockup needs that Thermite does not have, the choices that set the order, the stages, the new behaviour, and what changes in v0.3.0's plans. Proposed, for the owner's yes. |
| [ui-refresh-guide.md](ui-refresh-guide.md) | The guide for the dashboard's refresh in v0.3.0 (goals 243 to 253), from the review of goal 242: what the review found on every screen, fxbot's UI system, the two designs, the rules for screens, one word for each thing, the new navigation, providers and set-up, the order of work and the owner's questions. |
| [code-structure-guide.md](code-structure-guide.md) | The guide for the work on the code's structure in v0.3.0 (goals 244 and 254 to 257), from the same review: what the clean-up of v0.1.1 fixed, what a change touches today, the findings, the six changes, the rules of shape to add, the order of work, what to leave and the owner's questions. |

The roadmap says what comes next. A goal says what one piece of work is and when it is done. A release plan says how a version ships.

## Goals

A goal is one deliverable that can be checked.

- **File name:** `goals/NNN-name.goal`, such as `goals/178-clean-up-continued.goal`; once verified, `goals/_completed/NNN-name.goal`, such as `goals/_completed/005-sample-project.goal`. The number is the goal's ID. It is never reused, and it does not change when the goal moves to another version.
- **Format:** Markdown with a front-matter block. A goal can be run as an agent task with `/goal Complete docs/plan/goals/NNN-name.goal`.
- **Sections:** What, Why, Done when, Decisions, Open questions, Progress.

### Status

| Status | Meaning |
| --- | --- |
| `PROPOSED` | An idea. It is on the roadmap, but no version has accepted it. |
| `READY` | Accepted into a version. Work can start. |
| `IN_PROGRESS` | Someone works on it now. |
| `BLOCKED` | It waits for a decision or for other work. The goal says what it waits for. |
| `VERIFIED` | Every "Done when" item has evidence. |
| `DROPPED` | It will not be done. The goal says why. |

### Add an idea

1. Write a new goal with the next free number and the status `PROPOSED`.
2. Add one line for it to the roadmap, in the place its priority puts it.
3. The owner accepts it into a version (`READY`) or drops it.

### Record a decision

- Add it to the Decisions section of the goal it affects: the date, who decided, and the decision in plain words.
- If it shapes the whole product, also add it to [decisions.md](decisions.md).
- A decision that changes priority also moves the goal's line in the roadmap.

### Work on a goal

1. Set the status to `IN_PROGRESS` and add a dated line to Progress.
2. Keep Progress short and current: what is done, what is next, what blocks it.
3. When every "Done when" item has evidence (a commit, a test, a check), set the status to `VERIFIED`. Update its line in the roadmap.
4. In the same commit, move the goal's file to [goals/_completed/](goals/_completed/) with `git mv`, and fix every link to it: the roadmap's and the release plan's lines, other goals, the docs pages and code comments that name it. Completed goals live there; open, proposed and dropped goals stay in [goals/](goals/).
5. Detailed work logs that name a particular deployment stay in the maintainers' private notes. A public goal never names hosts, addresses, accounts or private projects.

## Rules for every goal

- **No default caps.** Nothing ends or cuts research short by default: no turn, submission, failure, time or spend limit unless someone configures it.
- **Agents never judge.** Measurement, verdicts and promotion stay in code the agents cannot write.
- **A mockup first.** A new screen, or a real change to one, is mocked up and shown to the owner before it is built. Every form label has a description.
- **Plain words.** Cards, call-outs and reports use Simplified Technical English.
- **Docs follow the code, as you go.** Each commit that changes what Thermite does updates the docs pages that describe it. A goal is not verified until its pages match the code.
- **The owner's OK first:** before paid GPU time, before changing a running deployment, and before anything that is hard to undo.
- **The checks in [AGENTS.md](../../AGENTS.md#checks)** run before each commit.
